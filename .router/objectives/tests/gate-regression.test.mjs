/**
 * P1 gate regression tests — review round 5 (independent falsification).
 *
 * These tests were written FROM attacks, not from the implementation's mental
 * model. Each one failed against the `p1-candidate-6-handover` revision and
 * passes against the repaired revision. The attack harness that produced them is
 * kept separately at `prep/astra-review/`; this file is the durable regression
 * guard so the same three classes cannot return unnoticed.
 *
 * Classes covered:
 *   G1  stale-dependency gate bypass (predicate refused, fold accepted)
 *   G2  order-independence: for every ineligible packet, the fold must refuse a
 *       subsequent dispatch_decided — not just the read-only predicate
 *   G3  a packet declaring `operator_explicit` accepted by a controller-only
 *       assessment
 *   G4  an assessment of a superseded attempt re-accepting revised work
 *
 * In-memory only: no filesystem, no scheduler, no model calls, no sandbox tree.
 *
 * Run: node .router/objectives/tests/gate-regression.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REASON } from '../contracts.mjs';
import { reduce, foldEvents, evaluatePacket, idempotencyKey } from '../reducer.mjs';

const OBJ = 'obj-gate-5';
const sha = (c) => c.repeat(64).slice(0, 64);

const ev = (seq, kind, extra = {}) => ({
  schema: 'objective-event/1', seq, kind, objectiveId: OBJ,
  atUtc: `2026-09-16T00:00:${String(seq).padStart(2, '0')}Z`, ...extra
});

const packet = (seq, packetId, extra = {}) => ev(seq, 'packet_defined', {
  packetId, planRevision: 1, instructions: `produce ${packetId}`, dependsOn: [], inputs: [],
  attemptAllowance: 2, routePolicy: { defaultRoute: 'flash-off' }, writeScope: { paths: [] },
  outputContract: { artifacts: [{ name: `${packetId}.txt`, required: true }] }, ...extra
});

const decided = (seq, packetId, planRevision, attempt) => ev(seq, 'dispatch_decided', {
  packetId, planRevision, attempt,
  idempotencyKey: idempotencyKey({ objectiveId: OBJ, planRevision, packetId, attempt })
});

const accepted = (seq, packetId, attempt, extra = {}) => ev(seq, 'assessment_recorded', {
  packetId, attempt, authority: 'controller', accepted: true,
  assessmentRef: `assessment-${packetId}${attempt}`, assessmentSha256: sha('a'), ...extra
});

/** Drive `packetId` to accepted at attempt 1, starting at seq `s`. */
const driveToAccepted = (s, packetId, planRevision = 1) => [
  decided(s, packetId, planRevision, 1),
  ev(s + 1, 'attempt_started', { packetId, attempt: 1, runId: `run-${packetId}1` }),
  ev(s + 2, 'attempt_succeeded', { packetId, attempt: 1 }),
  accepted(s + 3, packetId, 1)
];

// ---------------------------------------------------------------------------
// G1 — the stale-dependency bypass. This is the defect that falsified the
// "clean gate" claim: `rec.stale` is set only in the post-fold pass, so during
// the fold a stale producer reported `accepted`.
// ---------------------------------------------------------------------------
test('G1 a stale producer blocks the consumer in the fold, not only in the predicate', () => {
  const prefix = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1 }),
    packet(3, 'B', { planRevision: 2, dependsOn: ['A'] }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' }),
    ...driveToAccepted(5, 'A', 1),
    ev(9, 'plan_approved', { planRevision: 2, authority: 'operator' })
  ];

  // The predicate refused this before the repair too; it is the control.
  const predicate = evaluatePacket(foldEvents(prefix, OBJ), 'B');
  assert.equal(predicate.eligible, false);
  assert.equal(predicate.reason, REASON.DEPENDENCY_STALE);

  // The fold must reach the same verdict. Before the repair it recorded attempt 1.
  const attacked = [...prefix, decided(10, 'B', 2, 1)];
  const state = foldEvents(attacked, OBJ);
  assert.equal(state.packets.get('B').attempts.size, 0, 'fold admitted a stale-dependency dispatch');
  assert.ok(state.invalidTransitions.some((t) => /revision 1, not the approved 2/.test(t.message)));
  assert.equal(state.packets.get('A').stale, true);
});

// ---------------------------------------------------------------------------
// G2 — order independence. The bug was a divergence between the read-only
// predicate and the transition path, so test the PROPERTY, not one trace.
// ---------------------------------------------------------------------------
test('G2 whenever the predicate refuses a packet, the fold refuses a dispatch for it', () => {
  const scenarios = {
    'unapproved revision': [
      ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
      packet(2, 'P', { planRevision: 1 })
    ],
    'objective stopped': [
      ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
      packet(2, 'P', { planRevision: 1 }),
      ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' }),
      ev(4, 'objective_stopped', { stopReason: 'operator STOP file' })
    ],
    'unresolved dependency': [
      ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
      packet(2, 'A', { planRevision: 1 }),
      packet(3, 'P', { planRevision: 1, dependsOn: ['A'] }),
      ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' })
    ],
    'unknown dependency': [
      ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
      packet(2, 'P', { planRevision: 1, dependsOn: ['ghost'] }),
      ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
    ],
    'already accepted': [
      ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
      packet(2, 'P', { planRevision: 1 }),
      ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' }),
      ...driveToAccepted(4, 'P', 1)
    ],
    'stale producer at a new approved revision': [
      ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
      packet(2, 'A', { planRevision: 1 }),
      packet(3, 'P', { planRevision: 2, dependsOn: ['A'] }),
      ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' }),
      ...driveToAccepted(5, 'A', 1),
      ev(9, 'plan_approved', { planRevision: 2, authority: 'operator' })
    ],
    'self cycle': [
      ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
      packet(2, 'P', { planRevision: 1, dependsOn: ['P'] }),
      ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
    ]
  };

  for (const [name, prefix] of Object.entries(scenarios)) {
    const target = Object.keys(Object.fromEntries(
      prefix.filter((e) => e.kind === 'packet_defined').map((e) => [e.packetId, true])
    )).pop(); // last declared packet is the attack target
    const before = foldEvents(prefix, OBJ);
    const verdict = evaluatePacket(before, target);
    assert.equal(verdict.eligible, false, `${name}: scenario is supposed to be ineligible`);

    const rec = before.packets.get(target);
    const attacked = [...prefix, decided(prefix.length + 1, target, rec.planRevision, rec.attempts.size + 1)];
    const after = foldEvents(attacked, OBJ);
    assert.equal(
      after.packets.get(target).attempts.size, rec.attempts.size,
      `${name}: fold accepted a dispatch the predicate (${verdict.reason}) refused`
    );
  }
});

// ---------------------------------------------------------------------------
// G3 — a declared acceptance policy must be enforced, not merely recorded.
// ---------------------------------------------------------------------------
test('G3 operator_explicit cannot be discharged by a controller-only acceptance', () => {
  const prefix = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1, acceptancePolicy: 'operator_explicit' }),
    packet(3, 'B', { planRevision: 1, dependsOn: ['A'] }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' }),
    decided(5, 'A', 1, 1),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev(7, 'attempt_succeeded', { packetId: 'A', attempt: 1 })
  ];

  const refused = foldEvents([...prefix, accepted(8, 'A', 1)], OBJ);
  assert.equal(refused.packets.get('A').acceptedAttempt, null, 'controller acceptance adopted an operator_explicit packet');
  assert.ok(refused.invalidTransitions.some((t) => /operator_explicit/.test(t.message)));
  // The attempt stays UNASSESSED, so it remains blocked rather than looking judged.
  assert.equal(refused.packets.get('A').attempts.get(1).assessment, null);
  assert.equal(evaluatePacket(refused, 'A').reason, REASON.AWAITING_ASSESSMENT);

  // A dependant is not released by the refused acceptance.
  const leaked = foldEvents([...prefix, accepted(8, 'A', 1), decided(9, 'B', 1, 1)], OBJ);
  assert.equal(leaked.packets.get('B').attempts.size, 0, 'refused acceptance still released a dependant');

  // The operator path still works, and carries its authorization chain.
  const chained = foldEvents([...prefix, accepted(8, 'A', 1, { authority: 'operator', authorizationRef: 'auth-1' })], OBJ);
  assert.equal(chained.packets.get('A').acceptedAttempt, 1);
  assert.equal(chained.packets.get('A').state, 'accepted');
});

test('G3b operator acceptance without an authorization chain is still refused', () => {
  const events = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1, acceptancePolicy: 'operator_explicit' }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' }),
    decided(4, 'A', 1, 1),
    ev(5, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev(6, 'attempt_succeeded', { packetId: 'A', attempt: 1 }),
    accepted(7, 'A', 1, { authority: 'operator' })
  ];
  const state = foldEvents(events, OBJ);
  assert.equal(state.packets.get('A').acceptedAttempt, null);
  assert.ok(state.invalidTransitions.some((t) => /authorization chain/.test(t.message)));
});

// ---------------------------------------------------------------------------
// G4 — superseded evidence must not re-accept revised work.
// ---------------------------------------------------------------------------
test('G4 an assessment of a superseded attempt cannot restore acceptance', () => {
  const prefix = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1 }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' }),
    ...driveToAccepted(4, 'A', 1),
    ev(8, 'packet_revised', { packetId: 'A', planRevision: 2, instructions: 'different work' }),
    packet(9, 'C', { planRevision: 2, dependsOn: ['A'] }),
    ev(10, 'plan_approved', { planRevision: 2, authority: 'operator' })
  ];

  const before = foldEvents(prefix, OBJ);
  assert.equal(before.packets.get('A').acceptedAttempt, null, 'packet_revised must clear acceptance');
  assert.equal(before.packets.get('A').attempts.get(1).planRevision, 1);

  // The attack: re-state the OLD attempt's acceptance after the revision bump.
  const attacked = foldEvents([...prefix, accepted(11, 'A', 1), decided(12, 'C', 2, 1)], OBJ);
  assert.equal(attacked.packets.get('A').acceptedAttempt, null, 'superseded assessment restored acceptance');
  assert.ok(attacked.invalidTransitions.some((t) => /superseded evidence/.test(t.message)));
  assert.equal(attacked.packets.get('C').attempts.size, 0, 'dependant was released on superseded evidence');
  assert.equal(evaluatePacket(attacked, 'C').reason, REASON.DEPENDENCY_UNRESOLVED);

  // The projection must not present the DEPENDANT as dispatchable. It may still
  // re-dispatch the revised packet A itself — that is correct, because revision 2
  // has never been executed. What must not happen is a decision for C.
  const projection = reduce([...prefix, accepted(11, 'A', 1), decided(12, 'C', 2, 1)], { objectiveId: OBJ });
  assert.equal(projection.dispatchDecisions.filter((d) => d.packetId === 'C').length, 0);
  const cP = projection.packets.find((p) => p.packetId === 'C');
  assert.equal(cP.eligible, false);
  assert.equal(cP.reason, REASON.DEPENDENCY_UNRESOLVED);

  // Recorded behaviour, asserted so it is a decision rather than an accident:
  // the superseded attempt's assessment counts as "assessed" for the revised
  // packet, so A is re-dispatchable at attempt 2 and the old attempt still
  // consumes part of the allowance. Changing that is an allowance-accounting
  // policy call (P3/P5), not part of this repair.
  const aP = projection.packets.find((p) => p.packetId === 'A');
  assert.equal(aP.acceptedAttempt, null);
  assert.equal(A_reDispatchExpectation(aP), 'eligible-at-attempt-2');
});

/** Documents the allowance/revision interaction observed above. */
function A_reDispatchExpectation(aP) {
  return aP.eligible && aP.attemptCount === 1 && aP.attemptAllowance === 2
    ? 'eligible-at-attempt-2'
    : `unexpected:${aP.reason ?? aP.eligible}`;
}

// ---------------------------------------------------------------------------
// Repair-side guard: the earlier closed classes must not have been reopened by
// this repair. These duplicate R1/R2/D1 deliberately — a repair round that
// breaks an earlier fix is exactly how R1 and R3 were introduced.
// ---------------------------------------------------------------------------
test('R-guard: revision mismatch, awaiting_assessment and replay idempotency still hold', () => {
  const prefix = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1 }),
    ev(3, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];

  // R1: a dispatch claiming another revision is refused.
  const wrongRevision = foldEvents([...prefix, decided(4, 'A', 2, 1)], OBJ);
  assert.equal(wrongRevision.packets.get('A').attempts.size, 0);

  // R2: a settled-but-unassessed attempt blocks a second dispatch.
  const settled = [...prefix,
    decided(4, 'A', 1, 1),
    ev(5, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev(6, 'attempt_succeeded', { packetId: 'A', attempt: 1 })
  ];
  assert.equal(evaluatePacket(foldEvents(settled, OBJ), 'A').reason, REASON.AWAITING_ASSESSMENT);
  assert.equal(foldEvents([...settled, decided(7, 'A', 1, 2)], OBJ).packets.get('A').attempts.size, 1);

  // D1: a replayed attempt_started never downgrades an accepted packet.
  const acceptedTrace = [...prefix, ...driveToAccepted(4, 'A', 1)];
  const replayed = foldEvents([...acceptedTrace,
    ev(8, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' })
  ], OBJ);
  assert.equal(replayed.packets.get('A').state, 'accepted');
  assert.equal(replayed.packets.get('A').acceptedAttempt, 1);
});

// ---------------------------------------------------------------------------
// Round 5b — binding write path and supersede-by-newest.
//
// G5/G6: a structurally unusable DECLARED binding is refused at the write path,
// so the packet is never created. Previously it was only recorded in
// `definitionProblems` (advisory) and the packet was created and dispatchable.
// ---------------------------------------------------------------------------
const bindingTo = (producer, extra = {}) => ({
  objectiveId: OBJ, packetId: producer, planRevision: 1, attempt: 1,
  artifactPath: `${producer}.txt`, sha256: sha('b'), assessmentRef: `assessment-${producer}1`, ...extra
});

test('G5 a declared binding naming a foreign objective is refused, so the packet is never created', () => {
  const events = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1 }),
    packet(3, 'C', { dependsOn: ['A'], inputs: [bindingTo('A', { objectiveId: 'OTHER' })] }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const state = foldEvents(events, OBJ);
  assert.equal(state.packets.has('C'), false, 'packet with a foreign-objective binding was created');
  assert.ok(state.invalidTransitions.some((t) => /different objective/.test(t.message)));
  // The refusal is on the event, not a silent drop: it is visible in the log.
  assert.equal(state.packets.has('A'), true);
});

test('G6 a declared binding with a malformed sha256 is refused (condition C8)', () => {
  const events = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1 }),
    packet(3, 'C', { dependsOn: ['A'], inputs: [bindingTo('A', { sha256: 'not-a-digest' })] }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const state = foldEvents(events, OBJ);
  assert.equal(state.packets.has('C'), false, 'packet with a malformed declared digest was created');
  assert.ok(state.invalidTransitions.some((t) => /64 lowercase hex/.test(t.message)));
  // It is no longer merely surfaced: definitionProblems is not the enforcement point.
  assert.equal(state.definitionProblems.length, 0);
});

test('G6b a foreign-objective binding arriving by event is refused too', () => {
  const events = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1 }),
    packet(3, 'C', { planRevision: 1, dependsOn: ['A'] }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' }),
    ev(5, 'input_binding_recorded', { packetId: 'C', binding: bindingTo('A', { objectiveId: 'OTHER' }) })
  ];
  const state = foldEvents(events, OBJ);
  assert.equal(state.packets.get('C').inputs.length, 0, 'foreign-objective binding was recorded');
  assert.ok(state.invalidTransitions.some((t) => /different objective/.test(t.message)));
});

// ---------------------------------------------------------------------------
// G7: the producer-retry wedge. A consumer that bound to a failed attempt must be
// releasable by recording a binding to the newly accepted attempt.
// ---------------------------------------------------------------------------
test('G7 a producer retry does not permanently wedge its consumer', () => {
  const objective = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1, attemptAllowance: 2 }),
    packet(3, 'C', { planRevision: 1, dependsOn: ['A'], inputs: [bindingTo('A')] }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' })
  ];
  const attempt1Rejected = [
    ...objective,
    decided(5, 'A', 1, 1),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev(7, 'attempt_failed', { packetId: 'A', attempt: 1 }),
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'assessment-A1', assessmentSha256: sha('a') })
  ];
  const attempt2Accepted = [
    ...attempt1Rejected,
    decided(9, 'A', 1, 2),
    ev(10, 'attempt_started', { packetId: 'A', attempt: 2, runId: 'run-A2' }),
    ev(11, 'attempt_succeeded', { packetId: 'A', attempt: 2 }),
    ev(12, 'assessment_recorded', { packetId: 'A', attempt: 2, authority: 'controller', accepted: true, assessmentRef: 'assessment-A2', assessmentSha256: sha('a') })
  ];

  // Binding to the failed attempt is correctly stale once attempt 2 is accepted.
  assert.equal(evaluatePacket(foldEvents(attempt2Accepted, OBJ), 'C').reason, REASON.INPUT_BINDING_STALE);

  // The remedy must work: pin the accepted attempt, and the consumer is released.
  const released = foldEvents([...attempt2Accepted,
    ev(13, 'input_binding_recorded', { packetId: 'C', binding: bindingTo('A', { attempt: 2, assessmentRef: 'assessment-A2' }) })
  ], OBJ);
  assert.equal(evaluatePacket(released, 'C').eligible, true, 'consumer stayed wedged after a fresh binding');
  // History is retained, not discarded — only the newest entry per target is judged.
  assert.equal(released.packets.get('C').inputs.length, 2);
});

// ---------------------------------------------------------------------------
// G8: supersede is keyed per (producer, artifact path). Keying per producer alone
// would silently drop a second artifact the consumer legitimately requires.
// ---------------------------------------------------------------------------
test('G8 supersede is keyed per producer AND artifact path', () => {
  const twoArtifacts = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1, attemptAllowance: 2 }),
    packet(3, 'C', { planRevision: 1, dependsOn: ['A'], inputs: [
      bindingTo('A', { artifactPath: 'one.txt' }),
      bindingTo('A', { artifactPath: 'two.txt' })
    ] }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' }),
    decided(5, 'A', 1, 1),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev(7, 'attempt_failed', { packetId: 'A', attempt: 1 }),
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'assessment-A1', assessmentSha256: sha('a') }),
    decided(9, 'A', 1, 2),
    ev(10, 'attempt_started', { packetId: 'A', attempt: 2, runId: 'run-A2' }),
    ev(11, 'attempt_succeeded', { packetId: 'A', attempt: 2 }),
    ev(12, 'assessment_recorded', { packetId: 'A', attempt: 2, authority: 'controller', accepted: true, assessmentRef: 'assessment-A2', assessmentSha256: sha('a') })
  ];

  // Re-pin only the first artifact: the second is still stale, so C stays blocked.
  const oneRepinned = foldEvents([...twoArtifacts,
    ev(13, 'input_binding_recorded', { packetId: 'C', binding: bindingTo('A', { artifactPath: 'one.txt', attempt: 2, assessmentRef: 'assessment-A2' }) })
  ], OBJ);
  assert.equal(evaluatePacket(oneRepinned, 'C').eligible, false, 'a stale second artifact was silently dropped');
  assert.equal(evaluatePacket(oneRepinned, 'C').reason, REASON.INPUT_BINDING_STALE);
});

test('G8b both artifacts re-pinned releases the consumer', () => {
  const events = [
    ev(1, 'objective_defined', { goal: 'g', nonGoals: [] }),
    packet(2, 'A', { planRevision: 1, attemptAllowance: 2 }),
    packet(3, 'C', { planRevision: 1, dependsOn: ['A'], inputs: [
      bindingTo('A', { artifactPath: 'one.txt' }),
      bindingTo('A', { artifactPath: 'two.txt' })
    ] }),
    ev(4, 'plan_approved', { planRevision: 1, authority: 'operator' }),
    decided(5, 'A', 1, 1),
    ev(6, 'attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev(7, 'attempt_failed', { packetId: 'A', attempt: 1 }),
    ev(8, 'assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'assessment-A1', assessmentSha256: sha('a') }),
    decided(9, 'A', 1, 2),
    ev(10, 'attempt_started', { packetId: 'A', attempt: 2, runId: 'run-A2' }),
    ev(11, 'attempt_succeeded', { packetId: 'A', attempt: 2 }),
    ev(12, 'assessment_recorded', { packetId: 'A', attempt: 2, authority: 'controller', accepted: true, assessmentRef: 'assessment-A2', assessmentSha256: sha('a') }),
    ev(13, 'input_binding_recorded', { packetId: 'C', binding: bindingTo('A', { artifactPath: 'one.txt', attempt: 2, assessmentRef: 'assessment-A2' }) }),
    ev(14, 'input_binding_recorded', { packetId: 'C', binding: bindingTo('A', { artifactPath: 'two.txt', attempt: 2, assessmentRef: 'assessment-A2' }) })
  ];
  const state = foldEvents(events, OBJ);
  assert.equal(evaluatePacket(state, 'C').eligible, true, 'consumer not released after both artifacts were re-pinned');
  assert.equal(state.packets.get('C').inputs.length, 4);
});
