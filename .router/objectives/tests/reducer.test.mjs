/**
 * P1 acceptance tests — focused, in-memory, zero I/O, zero model calls.
 *
 * Coverage is keyed to the P1 gate in prep/08-supervised-orchestration-plan.md:
 *   "Cycles, missing dependencies, stale revisions, invalid state transitions and
 *    legacy isolation tested" plus the first vertical slice:
 *   "accepted A releases B exactly once; unresolved A blocks B; restart does not
 *    duplicate either."
 *
 * Every test asserts on pure reducer behaviour. Nothing here touches the live
 * queue, journal, state, scheduler or filesystem.
 *
 * Run: node --test .router/objectives/tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REASON, validateObjective, validateWorkPacket, validateInputBinding, validateEvent,
  ACCEPTANCE_POLICIES, DEFAULT_ATTEMPT_ALLOWANCE
} from '../contracts.mjs';
import { reduce, foldEvents, evaluatePacket, findCycles, idempotencyKey } from '../reducer.mjs';

// ---------------------------------------------------------------------------
// Fixtures. seq is explicit and ordered; atUtc is fixed so runs are deterministic.
// ---------------------------------------------------------------------------
const OBJ = 'obj-slice-1';

function ev(seq, kind, extra = {}) {
  return { schema: 'objective-event/1', seq, kind, objectiveId: OBJ, atUtc: `2026-09-16T00:00:${String(seq).padStart(2, '0')}Z`, ...extra };
}

const sha = (c) => c.repeat(64).slice(0, 64);

/** objective + approved plan revision 1 + packet A. */
function baseA() {
  return [
    ev(1, 'objective_defined', { goal: 'Deliver the vertical slice', nonGoals: ['no paid worker run'] }),
    ev(2, 'packet_defined', {
      packetId: 'A', planRevision: 1, instructions: 'produce A',
      dependsOn: [], inputs: [], attemptAllowance: 2,
      routePolicy: { defaultRoute: 'flash-off' }, writeScope: { paths: ['out/a.txt'] }, outputContract: { artifacts: [{ name: 'a.txt', required: true }] }
    }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
}

/** A plus B depending on A, at the same approved revision. */
function baseAB() {
  return [
    ...baseA(),
    ev(4, 'packet_defined', {
      packetId: 'B', planRevision: 1, instructions: 'consume A',
      dependsOn: ['A'], inputs: [], attemptAllowance: 2,
      routePolicy: { defaultRoute: 'flash-off' }, writeScope: { paths: ['out/b.txt'] }, outputContract: { artifacts: [{ name: 'b.txt', required: true }] }
    })
  ];
}

/** Drive A to accepted: decide, start, succeed, assess(accepted). */
function acceptA(startSeq, attempt = 1) {
  return [
    ev(startSeq, 'dispatch_decided', {
      packetId: 'A', planRevision: 1, attempt,
      idempotencyKey: idempotencyKey({ objectiveId: OBJ, planRevision: 1, packetId: 'A', attempt })
    }),
    ev(startSeq + 1, 'attempt_started', { packetId: 'A', attempt, runId: `run-A${attempt}` }),
    ev(startSeq + 2, 'attempt_succeeded', { packetId: 'A', attempt }),
    ev(startSeq + 3, 'assessment_recorded', {
      packetId: 'A', attempt, authority: 'controller', accepted: true,
      assessmentRef: `assess-A${attempt}`, assessmentSha256: sha('a')
    })
  ];
}

// ===========================================================================
// 1. FIRST VERTICAL SLICE — the plan's stated milestone
// ===========================================================================

test('slice: unresolved A blocks B; accepted A releases B exactly once', () => {
  // Before A is accepted, B must be blocked with an unresolved dependency.
  const before = reduce(baseAB());
  const bBefore = before.packets.find((p) => p.packetId === 'B');
  assert.equal(bBefore.eligible, false);
  assert.equal(bBefore.reason, REASON.DEPENDENCY_UNRESOLVED);
  assert.deepEqual(before.dispatchDecisions.map((d) => d.packetId), ['A'], 'only A may be dispatched initially');

  // After A is accepted, B becomes eligible and A stays closed.
  const after = reduce([...baseAB(), ...acceptA(5)]);
  const a = after.packets.find((p) => p.packetId === 'A');
  const b = after.packets.find((p) => p.packetId === 'B');
  assert.equal(a.acceptedAttempt, 1);
  assert.equal(a.eligible, false, 'an accepted packet is never re-dispatched');
  assert.equal(a.reason, REASON.ALREADY_ACCEPTED);
  assert.equal(b.eligible, true, 'accepted A releases B');
  assert.equal(b.reason, REASON.OK);
  assert.deepEqual(after.dispatchDecisions.map((d) => d.packetId), ['B']);
  assert.equal(after.dispatchDecisions.length, 1, 'B is released exactly once');
});

test('slice: B is released exactly once even when the decision is replayed', () => {
  const log = [...baseAB(), ...acceptA(5)];
  const first = reduce(log);
  const bDecision = first.dispatchDecisions.find((d) => d.packetId === 'B');
  assert.ok(bDecision, 'B should be released');

  // The controller records the decision AND its receipt, then replays.
  const replayed = reduce([
    ...log,
    ev(9, 'dispatch_decided', { packetId: 'B', planRevision: 1, attempt: 1, idempotencyKey: bDecision.idempotencyKey })
  ]);
  const b = replayed.packets.find((p) => p.packetId === 'B');
  assert.equal(b.attemptCount, 1, 'replay must not create a second attempt');
  assert.equal(replayed.dispatchDecisions.length, 0, 'nothing is re-emitted after the receipt');
});

test('slice: restart (re-fold from the same event log) is deterministic and duplicates nothing', () => {
  const log = [...baseAB(), ...acceptA(5)];
  const a = reduce(log);
  const b = reduce(log);
  assert.deepEqual(a, b, 'folding the same log twice is byte-identical');
  const c = reduce(JSON.parse(JSON.stringify(log)));
  assert.deepEqual(a, c, 'folding a JSON round-trip of the log is identical');
  assert.equal(c.progress.dispatches, 1, 'one dispatch survives a restart');
});

// ===========================================================================
// 2. CYCLES
// ===========================================================================

test('cycle: a mutual dependency is permanently blocked and never dispatched', () => {
  const log = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'X', planRevision: 1, instructions: 'x', dependsOn: ['Y'], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] } }),
    ev(3, 'packet_defined', { packetId: 'Y', planRevision: 1, instructions: 'y', dependsOn: ['X'], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] } }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const out = reduce(log);
  assert.deepEqual(out.cycles, ['X', 'Y']);
  assert.equal(out.dispatchDecisions.length, 0, 'neither member of a cycle is dispatchable');
  for (const id of ['X', 'Y']) {
    assert.equal(out.packets.find((p) => p.packetId === id).reason, REASON.DEPENDENCY_CYCLE);
  }
  // The cycle is reported, not hidden.
  assert.ok(out.blockedReasons.some((b) => b.reason === REASON.DEPENDENCY_CYCLE));
});

test('cycle: a dependant of a cycle is blocked transitively, and a long 3-cycle is found', () => {
  const mk = (id, deps) => ev(100 + id.charCodeAt(0), 'packet_defined', {
    packetId: id, planRevision: 1, instructions: id, dependsOn: deps, inputs: [],
    routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] }
  });
  const log = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    mk('P', ['Q']), mk('Q', ['R']), mk('R', ['P']),
    mk('S', ['P']),            // depends on a cycle member
    mk('T', ['S']),            // depends on a dependant of a cycle
    mk('U', []),               // independent: must still be dispatchable
    ev(200, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const out = reduce(log);
  const byId = Object.fromEntries(out.packets.map((p) => [p.packetId, p]));
  for (const id of ['P', 'Q', 'R', 'S', 'T']) {
    assert.equal(byId[id].eligible, false, `${id} must be blocked`);
    assert.equal(byId[id].reason, REASON.DEPENDENCY_CYCLE, `${id} must report a cycle cause`);
  }
  assert.equal(byId.U.eligible, true, 'an independent packet is unaffected by the cycle');
  assert.deepEqual(out.dispatchDecisions.map((d) => d.packetId), ['U']);
});

test('cycle: self-dependency is detected', () => {
  const log = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'Z', planRevision: 1, instructions: 'z', dependsOn: ['Z'], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] } }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const out = reduce(log);
  assert.deepEqual(out.cycles, ['Z']);
  assert.equal(out.dispatchDecisions.length, 0);
});

// ===========================================================================
// 3. MISSING DEPENDENCIES
// ===========================================================================

test('missing dependency: an undefined prerequisite blocks with a distinct reason', () => {
  const log = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'A', planRevision: 1, instructions: 'a', dependsOn: ['MISSING'], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] } }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const out = reduce(log);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.eligible, false);
  assert.equal(a.reason, REASON.DEPENDENCY_UNKNOWN);
  assert.match(a.detail, /MISSING/);
  assert.equal(out.dispatchDecisions.length, 0);
});

test('missing dependency: an unknown packet id is reported, never silently eligible', () => {
  const out = reduce(baseAB());
  const verdict = evaluatePacket(foldEvents(baseAB(), OBJ), 'NOPE');
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, REASON.PACKET_UNKNOWN);
  assert.ok(out.packets.every((p) => p.packetId !== 'NOPE'));
});

// ===========================================================================
// 4. STALE REVISIONS
// ===========================================================================

test('stale revision: a plan edit invalidates approval and blocks all dependent work', () => {
  const log = [
    ...baseAB(),
    ...acceptA(5),
    // The operator revises the plan. Packets A and B are now at revision 1 while
    // the current plan revision is 2, and no approval covers revision 2.
    ev(9, 'plan_revised', { planRevision: 2 })
  ];
  const out = reduce(log);
  assert.equal(out.currentPlanRevision, 2);
  assert.equal(out.approvedPlanRevision, null, 'a plan edit drops prior approval');
  for (const id of ['A', 'B']) {
    const p = out.packets.find((x) => x.packetId === id);
    assert.equal(p.eligible, false, `${id} must not dispatch under an unapproved revision`);
    assert.equal(p.reason, REASON.OBJECTIVE_NOT_APPROVED);
  }
  assert.equal(out.dispatchDecisions.length, 0, 'stale approval releases nothing');
  assert.equal(out.progress.accepted, 1, 'the historically accepted attempt is still reported as evidence');
});

test('stale revision: approving the new revision restores eligibility without duplicating the old attempt', () => {
  const log = [
    ...baseAB(),
    ...acceptA(5),
    ev(9, 'plan_revised', { planRevision: 2 }),
    ev(10, 'plan_approved', { planRevision: 2, authority: 'operator' })
  ];
  const out = reduce(log);
  const a = out.packets.find((p) => p.packetId === 'A');
  const b = out.packets.find((p) => p.packetId === 'B');
  // A is pinned at revision 1, so it is stale against approved revision 2.
  assert.equal(a.reason, REASON.PACKET_STALE_REVISION);
  assert.equal(b.reason, REASON.PACKET_STALE_REVISION);
  assert.equal(out.dispatchDecisions.length, 0, 'stale packets are not re-released by re-approval alone');
  assert.equal(a.attemptCount, 1, 'the previous revision attempt is never overwritten');
});

test('stale revision: a packet revised past its dependency is stale, not silently accepted', () => {
  const log = [
    ...baseA(),
    ...acceptA(4),
    ev(8, 'packet_revised', { packetId: 'A', planRevision: 2, instructions: 'a v2' }),
    ev(9, 'plan_approved', { planRevision: 2, authority: 'operator' })
  ];
  const out = reduce(log);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.acceptedAttempt, null, 'revising a packet clears its acceptance');
  assert.equal(a.state, 'defined');
  assert.equal(a.eligible, true, 'a revised, approved packet is dispatchable again');
  assert.equal(a.attemptCount, 1, 'the pre-revision attempt history is retained, not overwritten');
  assert.equal(a.attemptAllowance, 2);
});

test('stale revision: a non-monotonic plan revision is refused as an invalid transition', () => {
  const log = [...baseA(), ev(9, 'plan_revised', { planRevision: 1 })];
  const out = reduce(log);
  assert.equal(out.currentPlanRevision, 1, 'state is unchanged by the refused event');
  assert.ok(out.invalidTransitions.some((t) => /must increase/.test(t.message)));
});

test('stale revision: approving a superseded revision is refused', () => {
  const log = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'plan_approved', { planRevision: 3, authority: 'operator' }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const out = reduce(log);
  assert.equal(out.approvedPlanRevision, 3);
  assert.ok(out.invalidTransitions.some((t) => /superseded/.test(t.message)));
});

// ===========================================================================
// 5. INPUT BINDINGS — "a later retry must not silently replace a dependant's input"
// ===========================================================================

test('input binding: a binding pinned to a superseded attempt blocks the consumer', () => {
  const bindTo = (attempt, assessmentRef) => ev(20, 'input_binding_recorded', {
    packetId: 'B',
    binding: {
      packetId: 'A', objectiveId: OBJ, planRevision: 1, attempt,
      artifactPath: 'out/a.txt', sha256: sha('b'), assessmentRef
    }
  });
  const withB = (bindingEvent) => [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'A', planRevision: 1, instructions: 'a', dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] } }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' }),
    ...acceptA(4),
    ev(8, 'packet_defined', { packetId: 'B', planRevision: 1, instructions: 'b', dependsOn: ['A'], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] } }),
    bindingEvent
  ];

  // Correctly pinned at the accepted attempt -> eligible.
  const good = reduce(withB(bindTo(1, 'assess-A1')));
  assert.equal(good.packets.find((p) => p.packetId === 'B').eligible, true);

  // Pinned at an attempt that was never accepted -> blocked, not silently rebound.
  const bad = reduce(withB(bindTo(2, 'assess-A2')));
  const b = bad.packets.find((p) => p.packetId === 'B');
  assert.equal(b.eligible, false);
  assert.equal(b.reason, REASON.INPUT_BINDING_STALE);
});

test('input binding: a malformed binding is rejected structurally', () => {
  const bad = validateInputBinding({ packetId: 'A', planRevision: 1, attempt: 1, artifactPath: 'x', sha256: 'NOTHEX', assessmentRef: 'r' });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /sha256/.test(p)));
  const paths = validateInputBinding({ packetId: 'A', planRevision: 1, attempt: 1, artifactPath: 'x', sha256: sha('a'), assessmentRef: 'r' });
  assert.equal(paths.ok, true, 'a well-formed binding validates');
});

// ===========================================================================
// 6. INVALID STATE TRANSITIONS
// ===========================================================================

test('invalid: an assessment before the attempt settles is refused', () => {
  const log = [
    ...baseAB(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: idempotencyKey({ objectiveId: OBJ, planRevision: 1, packetId: 'A', attempt: 1 }) }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev(7, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: true, assessmentRef: 'r', assessmentSha256: sha('a') })
  ];
  const out = reduce(log);
  assert.equal(out.packets.find((p) => p.packetId === 'A').acceptedAttempt, null, 'acceptance must not precede settlement');
  assert.ok(out.invalidTransitions.some((t) => /before the attempt settled/.test(t.message)));
});

test('invalid: an assessment for an attempt that was never decided is refused', () => {
  const log = [...baseA(), ev(5, 'assessment_recorded', { packetId: 'A', attempt: 7, authority: 'controller', accepted: true, assessmentRef: 'r', assessmentSha256: sha('a') })];
  const out = reduce(log);
  assert.ok(out.invalidTransitions.some((t) => /never decided/.test(t.message)));
  assert.equal(out.packets.find((p) => p.packetId === 'A').acceptedAttempt, null);
});

test('invalid: plan approval authority must be the operator, and model review is not an acceptance authority', () => {
  // A non-operator plan approval event is structurally invalid.
  const notOperator = validateEvent(ev(4, 'plan_approved', { planRevision: 1, authority: 'controller' }));
  assert.equal(notOperator.ok, false);
  assert.ok(notOperator.problems.some((p) => /authority/.test(p)));

  // An assessment claiming model authority is structurally invalid.
  const modelAuth = validateEvent(ev(5, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'model', accepted: true, assessmentRef: 'r', assessmentSha256: sha('a') }));
  assert.equal(modelAuth.ok, false);
  assert.ok(modelAuth.problems.some((p) => /model review is advisory/.test(p)));
});

test('invalid: an unmodelled event kind cannot change authoritative state', () => {
  const log = [
    ...baseAB(),
    ev(5, 'grant_authority_somehow', { packetId: 'B', planRevision: 1 })
  ];
  const out = reduce(log);
  assert.ok(out.invalidTransitions.some((t) => /unrecognised event kind/.test(t.message)));
  // The unknown event itself grants nothing: B is still blocked by its unresolved
  // dependency, and the event produced no attempt of its own.
  assert.equal(out.packets.find((p) => p.packetId === 'B').eligible, false, 'an unknown event grants nothing');
  assert.equal(out.packets.find((p) => p.packetId === 'B').attemptCount, 0);
  // The pre-existing eligibility of A is unaffected: A was already dispatchable
  // from the approved plan and the unknown event neither added nor removed that.
  assert.deepEqual(out.dispatchDecisions.map((d) => d.packetId), ['A']);
});

test('invalid: attempts past the allowance are refused, and a duplicate outstanding attempt is refused', () => {
  const d = (seq, attempt) => ev(seq, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt, idempotencyKey: `k${attempt}` });
  const assess = (seq, attempt) => ev(seq, 'assessment_recorded', { packetId: 'A', attempt, authority: 'controller', accepted: false, assessmentRef: `as${attempt}`, assessmentSha256: sha('f') });
  // Allowance 2: a third dispatch decision must be refused. Each settled attempt
  // is assessed first, because a settled-but-unassessed attempt now correctly
  // blocks re-dispatch (awaiting_assessment).
  const log = [
    ...baseA(),
    d(5, 1), ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' }),
    ev(7, 'attempt_failed', { packetId: 'A', attempt: 1 }), assess(8, 1),
    d(9, 2), ev(10, 'attempt_started', { packetId: 'A', attempt: 2, runId: 'r2' }),
    ev(11, 'attempt_failed', { packetId: 'A', attempt: 2 }), assess(12, 2),
    d(13, 3)
  ];
  const out = reduce(log);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.attemptCount, 2, 'the third decision must not create an attempt');
  assert.equal(a.reason, REASON.ATTEMPT_ALLOWANCE_EXHAUSTED);
  assert.ok(out.invalidTransitions.some((t) => /allowance exhausted/.test(t.message)));

  // Two decisions with different keys while an attempt is outstanding.
  const dup = reduce([
    ...baseA(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 2, idempotencyKey: 'k2' })
  ]);
  assert.equal(dup.packets.find((p) => p.packetId === 'A').attemptCount, 1);
  // The second decision is refused either by the outstanding-decision check or,
  // once that is passed, by the declared-attempt check.
  assert.ok(dup.invalidTransitions.length > 0);
});

test('invalid: acceptance is immutable and cannot be reassigned to a later attempt', () => {
  const log = [
    ...baseA(),
    ...acceptA(5, 1),
    ev(9, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'later', assessmentSha256: sha('c') })
  ];
  const out = reduce(log);
  assert.equal(out.packets.find((p) => p.packetId === 'A').acceptedAttempt, 1, 'an accepted attempt stays accepted');
});

test('invalid: out-of-order and duplicate sequence numbers are refused', () => {
  const log = [
    ...baseA(),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' }) // duplicate seq 3
  ];
  const out = reduce(log);
  assert.ok(out.invalidTransitions.some((t) => /out-of-order or duplicate seq/.test(t.message)));
  assert.equal(out.eventCount, 3, 'only the first three events were applied');
});

test('invalid: objective redefinition with a different goal is refused', () => {
  const log = [...baseA(), ev(9, 'objective_defined', { goal: 'a different goal entirely', nonGoals: [] })];
  const out = reduce(log);
  assert.equal(out.goal, 'Deliver the vertical slice', 'the first goal stands');
  assert.ok(out.invalidTransitions.some((t) => /redefined with a different goal/.test(t.message)));
});

test('invalid: dispatch is refused when the objective is stopped, and resume restores it', () => {
  const stopped = reduce([...baseA(), ev(9, 'objective_stopped', { stopReason: 'STOP sentinel present' })]);
  const a = stopped.packets.find((p) => p.packetId === 'A');
  assert.equal(a.eligible, false);
  assert.equal(a.reason, REASON.OBJECTIVE_STOPPED);
  assert.equal(stopped.dispatchDecisions.length, 0);

  const resumed = reduce([...baseA(), ev(9, 'objective_stopped', { stopReason: 'STOP' }), ev(10, 'objective_resumed', {})]);
  assert.equal(resumed.packets.find((p) => p.packetId === 'A').eligible, true);
  assert.deepEqual(resumed.dispatchDecisions.map((d) => d.packetId), ['A']);
});

// ===========================================================================
// 7. LEGACY ISOLATION
// ===========================================================================

test('legacy: historical items without objective membership never enter a projection', () => {
  const out = reduce(baseAB());
  // A legacy queue row has id/class/title/input/status/attempts/route and no
  // objectiveId. It contributes nothing.
  const legacyItem = { id: 't-001', class: 'format', title: 'Legacy', input: '', status: 'pending', attempts: 0, route: 'flash-off' };
  assert.equal(legacyItem.objectiveId, undefined);
  assert.ok(out.packets.every((p) => p.packetId !== 't-001'));
  assert.equal(out.progress.defined, 2, 'only objective packets are counted');
});

test('legacy: an event for a different objective is ignored, not merged', () => {
  const foreign = {
    schema: 'objective-event/1', seq: 99, kind: 'packet_defined', objectiveId: 'obj-other',
    atUtc: '2026-09-16T00:10:00Z', packetId: 'FOREIGN', planRevision: 1,
    instructions: 'x', dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] }
  };
  const out = reduce([...baseAB(), foreign]);
  assert.ok(out.packets.every((p) => p.packetId !== 'FOREIGN'), 'foreign objective work is not adopted');
  assert.equal(out.invalidTransitions.length, 0, 'isolation is normal, not an error');
});

test('legacy: a projection with no events is empty rather than fabricated', () => {
  const out = reduce([]);
  assert.deepEqual(out.packets, []);
  assert.deepEqual(out.dispatchDecisions, []);
  assert.equal(out.goal, null);
  assert.deepEqual(out.progress, { defined: 0, accepted: 0, blocked: 0, dispatches: 0 });
});

test('legacy: progress reports only authoritative events, so an execution success is not progress', () => {
  const log = [
    ...baseAB(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev(7, 'attempt_succeeded', { packetId: 'A', attempt: 1 })
  ];
  const out = reduce(log);
  assert.equal(out.progress.accepted, 0, 'a succeeded attempt is not accepted work');
  assert.equal(out.progress.dispatches, 1);
  assert.equal(out.packets.find((p) => p.packetId === 'A').state, 'succeeded');
});

// ===========================================================================
// 8. ADVISORY-ONLY MODEL REVIEW
// ===========================================================================

test('advisory: a model review alone never satisfies a dependency', () => {
  const log = [
    ...baseAB(),
    ev(5, 'model_review_recorded', { packetId: 'A', reviewRef: 'pro-review-1' })
  ];
  const out = reduce(log);
  assert.equal(out.packets.find((p) => p.packetId === 'A').acceptedAttempt, null);
  const b = out.packets.find((p) => p.packetId === 'B');
  assert.equal(b.eligible, false);
  assert.equal(b.reason, REASON.DEPENDENCY_UNRESOLVED);
  assert.equal(out.packets.find((p) => p.packetId === 'A').modelReviews, 1, 'the review is retained as evidence');
});

test('advisory: a rejected assessment blocks dependants while the producer may still retry', () => {
  const log = [
    ...baseAB(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' }),
    ev(7, 'attempt_failed', { packetId: 'A', attempt: 1 }),
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'assess-no', assessmentSha256: sha('d') })
  ];
  const out = reduce(log);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.state, 'rejected');
  assert.equal(a.acceptedAttempt, null, 'a rejected assessment is not acceptance');
  // Retry-within-allowance is deliberate: the plan caps repair attempts rather
  // than forbidding them, so a rejected packet with budget left is re-dispatchable.
  assert.equal(a.eligible, true, 'a rejected packet with attempt budget may be retried');
  assert.equal(a.attemptCount, 1);

  // B must NOT be released by A's rejection.
  const b = out.packets.find((p) => p.packetId === 'B');
  assert.equal(b.eligible, false);
  assert.equal(b.reason, REASON.DEPENDENCY_REJECTED);
  assert.deepEqual(out.dispatchDecisions.map((d) => d.packetId), ['A'], 'the retry is for A only; B stays blocked');
  assert.equal(out.progress.accepted, 0, 'a rejected assessment is not progress');
});

test('advisory: a rejected producer that exhausts its allowance leaves dependants permanently blocked', () => {
  const fail = (seq, attempt) => [
    ev(seq, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt, idempotencyKey: `k${attempt}` }),
    ev(seq + 1, 'attempt_started', { packetId: 'A', attempt, runId: `r${attempt}` }),
    ev(seq + 2, 'attempt_failed', { packetId: 'A', attempt }),
    ev(seq + 3, 'assessment_recorded', { packetId: 'A', attempt, authority: 'controller', accepted: false, assessmentRef: `assess-no-${attempt}`, assessmentSha256: sha('e') })
  ];
  const out = reduce([...baseAB(), ...fail(5, 1), ...fail(9, 2)]);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.attemptCount, 2, 'both allowed attempts were consumed');
  assert.equal(a.eligible, false);
  assert.equal(a.reason, REASON.ATTEMPT_ALLOWANCE_EXHAUSTED);
  const b = out.packets.find((p) => p.packetId === 'B');
  assert.equal(b.eligible, false);
  assert.equal(b.reason, REASON.DEPENDENCY_REJECTED, 'B reports the rejected prerequisite, not a generic block');
  assert.equal(out.dispatchDecisions.length, 0, 'nothing is dispatchable once A is exhausted and rejected');
});

// ===========================================================================
// 9. CONTRACT VALIDATION (schemas)
// ===========================================================================

test('contracts: a valid objective and packet validate; the model review policy is not offered', () => {
  const obj = { schema: 'objective/1', objectiveId: 'o1', revision: 0, goal: 'g', nonGoals: ['not x'] };
  assert.equal(validateObjective(obj).ok, true);
  assert.equal(validateObjective({ ...obj, nonGoals: undefined }).ok, false);

  const packet = {
    schema: 'work-packet/1', packetId: 'A', objectiveId: 'o1', planRevision: 1, instructions: 'i',
    dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'flash-off' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] },
    attemptAllowance: 2, acceptancePolicy: 'controller_deterministic'
  };
  assert.equal(validateWorkPacket(packet).ok, true);
  assert.equal(validateWorkPacket({ ...packet, acceptancePolicy: 'model_review' }).ok, false);
  assert.ok(!ACCEPTANCE_POLICIES.includes('model_review'));
  assert.equal(DEFAULT_ATTEMPT_ALLOWANCE, 2);
});

test('contracts: maxActiveWorkers above one is refused in the first milestone', () => {
  const obj = { schema: 'objective/1', objectiveId: 'o1', revision: 0, goal: 'g', nonGoals: [], executionEnvelope: { maxActiveWorkers: 4 } };
  const r = validateObjective(obj);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /maxActiveWorkers/.test(p)));
});

test('contracts: structural validation reports every problem rather than throwing', () => {
  const r = validateWorkPacket({ schema: 'wrong', packetId: '', dependsOn: ['A', 'A'], inputs: [{}], attemptAllowance: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.problems.length >= 5, `expected several problems, got ${r.problems.length}`);
});

test('purity: the reducer does not mutate its input events or packets', () => {
  const log = [...baseAB(), ...acceptA(5)];
  const snapshot = JSON.stringify(log);
  reduce(log);
  assert.equal(JSON.stringify(log), snapshot, 'input event array is untouched');

  const state = foldEvents(log, OBJ);
  assert.ok(state.packets instanceof Map);
  const before = state.packets.get('A').state;
  reduce(log); // a second, independent fold
  assert.equal(state.packets.get('A').state, before, 'a prior fold result is not mutated by a later fold');
});

test('cycles: findCycles is pure and returns an empty set for acyclic graphs', () => {
  const state = foldEvents(baseAB(), OBJ);
  assert.deepEqual([...findCycles(state)], []);
  const once = findCycles(state);
  const twice = findCycles(state);
  assert.deepEqual([...once], [...twice]);
});

// ===========================================================================
// 10. REGRESSIONS — defects found by independent review, now closed.
// Every test in this section failed against the pre-review reducer.
// ===========================================================================

test('regression: a replayed attempt_started must not revoke an accepted packet', () => {
  // Found by independent review as the most severe defect: the original code set
  // state='dispatched' unconditionally, so an honest replay of an attempt receipt
  // silently downgraded an ACCEPTED packet and un-released an already-released
  // dependant, recording nothing.
  // Ordering matters: attempt 1 is assessed BEFORE any retry is considered,
  // because a settled-but-unassessed attempt correctly blocks further dispatch.
  const log = [
    ...baseAB(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' }),
    ev(7, 'attempt_succeeded', { packetId: 'A', attempt: 1 }),
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: true, assessmentRef: 'as1', assessmentSha256: sha('a') }),
    ev(9, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' })
  ];
  const before = reduce(log.slice(0, -1));
  assert.equal(before.packets.find((p) => p.packetId === 'A').state, 'accepted');
  assert.equal(before.packets.find((p) => p.packetId === 'B').eligible, true);

  // Replay the SAME receipt for attempt 1 — the exact event that used to revoke
  // acceptance and un-release B.
  const after = reduce(log);
  const a = after.packets.find((p) => p.packetId === 'A');
  assert.equal(a.state, 'accepted', 'acceptance must survive an attempt-lifecycle event');
  assert.equal(a.acceptedAttempt, 1);
  assert.equal(a.eligible, false, 'an accepted packet remains closed');
  assert.equal(a.reason, REASON.ALREADY_ACCEPTED, 'and reports acceptance, not a stale revision');
  assert.equal(a.attemptCount, 1);
  const b = after.packets.find((p) => p.packetId === 'B');
  assert.equal(b.eligible, true, 'the released dependant stays released');
  assert.equal(b.reason, REASON.OK);
  assert.equal(after.invalidTransitions.length, 0, 'a replayed receipt is a no-op, not an error');
});

test('regression: an attempt_started with a CONFLICTING run for the same attempt is refused', () => {
  const log = [
    ...baseA(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-real' }),
    ev(7, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-impostor' })
  ];
  const out = reduce(log);
  assert.equal(out.packets.find((p) => p.packetId === 'A').attemptCount, 1);
  assert.ok(out.invalidTransitions.some((t) => /already bound to run 'run-real'/.test(t.message)));
});

test('regression: dispatch_decided cannot fabricate an undeclared packet', () => {
  const out = reduce([...baseA(), ev(5, 'dispatch_decided', { packetId: 'PHANTOM', planRevision: 1, attempt: 1, idempotencyKey: 'kp' })]);
  assert.deepEqual(out.packets.map((p) => p.packetId), ['A'], 'no packet is invented');
  assert.equal(out.progress.defined, 1);
  assert.equal(out.progress.dispatches, 0);
  assert.ok(out.invalidTransitions.some((t) => /never declared by a packet_defined event/.test(t.message)));
});

test('regression: an advisory review cannot fabricate an undeclared packet', () => {
  const out = reduce([...baseA(), ev(5, 'model_review_recorded', { packetId: 'GHOST', reviewRef: 'x' })]);
  assert.deepEqual(out.packets.map((p) => p.packetId), ['A']);
  assert.equal(out.progress.defined, 1, 'a ghost packet must not inflate derived progress');
  assert.ok(out.invalidTransitions.some((t) => /never declared/.test(t.message)));
});

test('regression: dispatch_decided must pass the approval gate', () => {
  // Under a suspended approval the decision must be refused, not applied.
  const suspended = reduce([
    ...baseA(),
    ev(5, 'plan_revised', { planRevision: 2 }),
    ev(6, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'kZ' })
  ]);
  assert.equal(suspended.approvedPlanRevision, null);
  assert.equal(suspended.packets.find((p) => p.packetId === 'A').attemptCount, 0, 'no attempt under an unapproved revision');
  assert.equal(suspended.packets.find((p) => p.packetId === 'A').state, 'defined');
  assert.ok(suspended.invalidTransitions.length > 0);

  // Under a stop control likewise.
  const stopped = reduce([
    ...baseA(),
    ev(5, 'objective_stopped', { stopReason: 'STOP sentinel present' }),
    ev(6, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'kY' })
  ]);
  assert.equal(stopped.packets.find((p) => p.packetId === 'A').attemptCount, 0, 'no attempt while stopped');
  assert.ok(stopped.invalidTransitions.some((t) => /objective is stopped/.test(t.message)));
});

test('regression: the declared attempt number must match the derived attempt', () => {
  // The original code ignored event.attempt, so attempt identity could diverge:
  // the attempt was stored under 1 while the event said 5.
  const out = reduce([...baseA(), ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 5, idempotencyKey: 'k5' })]);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.attemptCount, 0, 'the mismatched decision is refused');
  assert.ok(out.invalidTransitions.some((t) => /declares attempt 5 but the derived next attempt/.test(t.message)));
});

test('regression: an idempotency key reused for a later attempt is refused', () => {
  // The old code compared only the most recent key, so re-adding an OLD key
  // created a brand-new attempt. Attempt 3 is refused for the reused key and not
  // merely for exhaustion, because the key check runs first.
  const flat = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'A', planRevision: 1, instructions: 'a', dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] }, attemptAllowance: 2 }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const out = reduce([
    ...flat,
    ev(4, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(5, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' }),
    ev(6, 'attempt_failed', { packetId: 'A', attempt: 1 }),
    ev(7, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'as1', assessmentSha256: sha('f') }),
    ev(8, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 2, idempotencyKey: 'k2' }),
    ev(9, 'attempt_started', { packetId: 'A', attempt: 2, runId: 'r2' }),
    ev(10, 'attempt_failed', { packetId: 'A', attempt: 2 }),
    ev(11, 'assessment_recorded', { packetId: 'A', attempt: 2, authority: 'controller', accepted: false, assessmentRef: 'as2', assessmentSha256: sha('f') }),
    // Reuse of k1 for what would be attempt 3.
    ev(12, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 3, idempotencyKey: 'k1' })
  ]);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.attemptCount, 2, 'the reused key must not create a third attempt');
  assert.ok(out.invalidTransitions.some((t) => /was already used for an earlier attempt/.test(t.message)));
});

test('regression: an idempotency key reused for the SAME attempt is an honest replay', () => {
  const flat = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'A', planRevision: 1, instructions: 'a', dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] }, attemptAllowance: 2 }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const out = reduce([
    ...flat,
    ev(4, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' })
  ]);
  assert.equal(out.packets.find((p) => p.packetId === 'A').attemptCount, 1, 'an exact replay creates nothing');
  assert.equal(out.invalidTransitions.length, 0, 'an exact replay is not an error');
});

test('regression: dispatch_decided for an already-accepted packet is recorded as invalid', () => {
  const out = reduce([
    ...baseA(),
    ...acceptA(5),
    ev(9, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 2, idempotencyKey: 'k-again' })
  ]);
  assert.equal(out.packets.find((p) => p.packetId === 'A').attemptCount, 1);
  assert.ok(
    out.invalidTransitions.some((t) => /already-accepted/.test(t.message)),
    'this used to go to problems[] and never reach invalidTransitions'
  );
});

test('regression: packet redefinition is refused instead of silently overwriting', () => {
  const out = reduce([
    ...baseA(),
    ev(9, 'packet_defined', { packetId: 'A', planRevision: 1, instructions: 'a completely different instruction', dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'other' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] } })
  ]);
  assert.equal(out.packets.find((p) => p.packetId === 'A').instructions, 'produce A', 'the original definition stands');
  assert.ok(out.invalidTransitions.some((t) => /redefined; use packet_revised/.test(t.message)));
});

test('regression: an out-of-policy attemptAllowance cannot buy extra attempts via the event path', () => {
  // A packet declaration must not be able to enlarge its own budget. The event is
  // refused outright, so the packet is never created.
  const out = reduce([
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'Z', planRevision: 1, instructions: 'z', dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] }, attemptAllowance: 100 }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ]);
  assert.deepEqual(out.packets.map((p) => p.packetId), [], 'the over-policy declaration creates no packet');
  assert.match(
    out.invalidTransitions.map((t) => t.message).join(' '),
    /exceeds the plan's initial limit of 2/
  );

  // At the plan's limit the declaration is accepted.
  const ok = reduce([
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'Z', planRevision: 1, instructions: 'z', dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] }, outputContract: { artifacts: [{ name: 'out.txt', required: true }] }, attemptAllowance: 2 }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ]);
  assert.deepEqual(ok.packets.map((p) => p.packetId), ['Z']);
  assert.deepEqual(ok.definitionProblems, []);
});

test('regression: a packet definition with no output contract is refused', () => {
  // The plan lists "declared inputs and output contract" as a work-packet
  // requirement, so a definition without one is refused at the event layer.
  const out = reduce([
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    ev(2, 'packet_defined', { packetId: 'Z', planRevision: 1, instructions: 'z', dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] } })
  ]);
  assert.deepEqual(out.packets.map((p) => p.packetId), [], 'no packet is created without an output contract');
  assert.match(out.invalidTransitions.map((t) => t.message).join(' '), /outputContract/);

  // A malformed output contract is refused too.
  const bad = validateWorkPacket({
    schema: 'work-packet/1', packetId: 'Z', objectiveId: 'o', planRevision: 1, instructions: 'i',
    dependsOn: [], inputs: [], routePolicy: { defaultRoute: 'r' }, writeScope: { paths: [] },
    outputContract: { artifacts: [{ name: 'result.json' }] }, attemptAllowance: 2,
    acceptancePolicy: 'controller_deterministic'
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /reserved by the controller/.test(p)));
});

test('regression: an input binding naming an undeclared producer is refused', () => {
  const out = reduce([
    ...baseA(),
    ev(5, 'input_binding_recorded', {
      packetId: 'A',
      binding: { packetId: 'NOPE', objectiveId: OBJ, planRevision: 1, attempt: 1, artifactPath: 'x', sha256: sha('a'), assessmentRef: 'r' }
    })
  ]);
  assert.deepEqual(out.packets.find((p) => p.packetId === 'A').bindingProblems ?? [], []);
  assert.equal(out.packets.find((p) => p.packetId === 'A').state, 'defined');
  assert.ok(out.invalidTransitions.some((t) => /never declared/.test(t.message)));
});

test('regression: the fold refuses a structurally invalid event (model assessment authority)', () => {
  // Previously only validateEvent was asserted directly; the fold's own refusal
  // path was never exercised.
  const out = reduce([
    ...baseA(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' }),
    ev(7, 'attempt_succeeded', { packetId: 'A', attempt: 1 }),
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'model', accepted: true, assessmentRef: 'r', assessmentSha256: sha('a') })
  ]);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.acceptedAttempt, null, 'a model-authority assessment is refused inside the fold');
  assert.ok(out.invalidTransitions.some((t) => /structurally invalid event/.test(t.message)));
  assert.match(out.invalidTransitions.find((t) => /structurally invalid/.test(t.message)).message, /model review is advisory/);
});

test('regression: a model-authority acceptance is refused, and operator acceptance needs a chain', () => {
  const toSucceeded = [
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' }),
    ev(7, 'attempt_succeeded', { packetId: 'A', attempt: 1 })
  ];
  // Model authority: refused.
  const model = reduce([...baseA(), ...toSucceeded,
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'model', accepted: true, assessmentRef: 'r', assessmentSha256: sha('a') })]);
  assert.equal(model.packets.find((p) => p.packetId === 'A').acceptedAttempt, null);

  // Operator authority WITHOUT the authorization chain: refused (supervisor correction #1).
  const bare = reduce([...baseA(), ...toSucceeded,
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'operator', accepted: true, assessmentRef: 'as', assessmentSha256: sha('a') })]);
  assert.equal(bare.packets.find((p) => p.packetId === 'A').acceptedAttempt, null, 'a bare operator flag is not acceptance');
  assert.match(bare.invalidTransitions.map((t) => t.message).join(' '), /authorization chain/);

  // Operator authority WITH the chain: accepted, and it releases B.
  const chained = reduce([...baseAB(), ...toSucceeded,
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'operator', accepted: true, authorizationRef: 'auth-1', assessmentRef: 'as', assessmentSha256: sha('a') })]);
  assert.equal(chained.packets.find((p) => p.packetId === 'A').acceptedAttempt, 1);
  assert.equal(chained.packets.find((p) => p.packetId === 'B').eligible, true);
});

test('regression: the projection states what a binding actually verifies', () => {
  // S2 from the Pro review: the binding's sha256 is NOT checked, because P1
  // records no producer-side artifact hash. That is documented in the projection
  // so `eligible` is not misread as artifact-level verification.
  const out = reduce(baseAB());
  assert.equal(out.bindingVerification.verifiesProducerAttempt, true);
  assert.equal(out.bindingVerification.verifiesAssessmentRef, true);
  assert.equal(out.bindingVerification.verifiesArtifactSha256, false);
  assert.match(out.bindingVerification.note, /P2 must record/);
});

test('regression: dispatch_decided must declare the packet\'s own plan revision', () => {
  // The earlier revision check was dropped during the shared-gate rewrite, which
  // let a dispatch event claim an unapproved revision and have an attempt
  // recorded against it.
  const out = reduce([...baseA(), ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 2, attempt: 1, idempotencyKey: 'k' })]);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.attemptCount, 0, 'an attempt must not be recorded against a revision the packet does not have');
  assert.equal(a.state, 'defined');
  assert.ok(out.invalidTransitions.some((t) => /declares plan revision 2 but packet 'A' is at revision 1/.test(t.message)));
});

test('regression: dispatch_decided must honour awaiting_assessment', () => {
  // The awaiting-assessment guard lived only in the read-only predicate, so the
  // transition path accepted a second attempt for completed-but-unassessed work.
  const out = reduce([
    ...baseA(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' }),
    ev(7, 'attempt_succeeded', { packetId: 'A', attempt: 1 }),
    ev(8, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 2, idempotencyKey: 'k2' })
  ]);
  const a = out.packets.find((p) => p.packetId === 'A');
  assert.equal(a.attemptCount, 1, 'no second attempt while attempt 1 awaits assessment');
  assert.equal(a.reason, REASON.AWAITING_ASSESSMENT);
  assert.ok(out.invalidTransitions.some((t) => /awaiting assessment/.test(t.message)));

  // But an explicitly REJECTED attempt may be retried within the allowance.
  const retried = reduce([
    ...baseA(),
    ev(5, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 1, idempotencyKey: 'k1' }),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'r1' }),
    ev(7, 'attempt_failed', { packetId: 'A', attempt: 1 }),
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'as1', assessmentSha256: sha('f') }),
    ev(9, 'dispatch_decided', { packetId: 'A', planRevision: 1, attempt: 2, idempotencyKey: 'k2' })
  ]);
  assert.equal(retried.packets.find((p) => p.packetId === 'A').attemptCount, 2, 'a rejected attempt is repairable');
});

test('regression: packet_revised for an undeclared packet does not crash the fold', () => {
  // This was the only requirePacket call site without a null guard; one malformed
  // event in a durable log would have crashed every projection.
  let out;
  assert.doesNotThrow(() => {
    out = reduce([...baseA(), ev(9, 'packet_revised', { packetId: 'GHOST', planRevision: 5, instructions: 'x' })]);
  });
  assert.deepEqual(out.packets.map((p) => p.packetId), ['A']);
  assert.ok(out.invalidTransitions.some((t) => /never declared/.test(t.message)));
});

test('regression: an empty definitionProblems array is exposed, not omitted', () => {
  const out = reduce(baseAB());
  assert.deepEqual(out.definitionProblems, []);
});
