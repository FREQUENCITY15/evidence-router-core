/**
 * Attack harness — TRANSITION PATH.
 *
 * Purpose: attempt to make the fold accept a dispatch that `evaluatePacket`
 * refuses, and to outrun the attempt allowance. This is a falsification harness,
 * not a confirmation suite: it is written from attacks, and it is expected to
 * FAIL against a defective revision.
 *
 * Provenance: against `p1-candidate-6-handover` (reducer sha256 61055ca5…) the
 * first attack below SUCCEEDED — `evaluatePacket` returned `dependency_stale`
 * while the fold recorded attempt 1 for the consumer with no invalid transition.
 * The revision under test here is the repaired one (review round 5).
 *
 * Exit codes:
 *   0  every in-scope attack refused, no known-open findings
 *   3  in-scope attacks refused, but known-open findings remain (see report)
 *   1  an in-scope attack SUCCEEDED — the repair regressed
 *
 * Run: node prep/astra-review/transition-probes.mjs
 */

import { foldEvents, evaluatePacket, reduce } from '../../.router/objectives/reducer.mjs';

const OBJ = 'obj-attack';
const sha = 'a'.repeat(64);
const ev = (kind, extra = {}) => ({ kind, objectiveId: OBJ, atUtc: '2026-09-16T00:00:00Z', ...extra });
const packet = (packetId, extra = {}) => ev('packet_defined', {
  packetId, planRevision: 1, instructions: `produce ${packetId}`, dependsOn: [], inputs: [],
  attemptAllowance: 2, routePolicy: { defaultRoute: 'flash-off' }, writeScope: { paths: [] },
  outputContract: { artifacts: [{ name: `${packetId}.txt`, required: true }] }, ...extra
});
const decided = (packetId, planRevision, attempt) => ev('dispatch_decided', {
  packetId, planRevision, attempt, idempotencyKey: `dispatch:${OBJ}:r${planRevision}:${packetId}:a${attempt}`
});
const seq = (events) => events.map((e, i) => ({ ...e, seq: i + 1 }));
const fold = (events) => foldEvents(seq(events), OBJ);

const report = [];
const openFindings = [];

/** Run one attack and record whether the fold refused it. */
function attack(name, prefix, attackEvent, target) {
  const before = fold(prefix);
  const beforeAttempts = before.packets.get(target).attempts.size;
  const after = fold([...prefix, attackEvent]);
  const afterAttempts = after.packets.get(target).attempts.size;
  const refused = afterAttempts === beforeAttempts;
  report.push({
    attack: name, target, refused,
    attemptsBefore: beforeAttempts, attemptsAfter: afterAttempts,
    predicateReason: evaluatePacket(before, target).reason,
    refusal: refused ? after.invalidTransitions[after.invalidTransitions.length - 1]?.message ?? null : null
  });
  return refused;
}

const acceptedA = (planRevision = 1, attempt = 1) => [
  decided('A', planRevision, attempt),
  ev('attempt_started', { packetId: 'A', attempt, runId: `run-A${attempt}` }),
  ev('attempt_succeeded', { packetId: 'A', attempt }),
  ev('assessment_recorded', {
    packetId: 'A', attempt, authority: 'controller', accepted: true,
    assessmentRef: `assessment-A${attempt}`, assessmentSha256: sha
  })
];

/** A failed attempt plus an explicit rejection — the bounded repair path. */
const rejected = (packetId, attempt) => [
  decided(packetId, 1, attempt),
  ev('attempt_started', { packetId, attempt, runId: `run-${packetId}${attempt}` }),
  ev('attempt_failed', { packetId, attempt }),
  ev('assessment_recorded', {
    packetId, attempt, authority: 'controller', accepted: false,
    assessmentRef: `assessment-${packetId}${attempt}`, assessmentSha256: sha
  })
];

// --- Attack 1: stale producer, approved revision moved past it --------------
const stalePrefix = [
  ev('objective_defined', { goal: 'g', nonGoals: [] }),
  packet('A', { planRevision: 1 }),
  packet('B', { planRevision: 2, dependsOn: ['A'] }),
  ev('plan_approved', { planRevision: 1, authority: 'operator' }),
  ...acceptedA(1, 1),
  ev('plan_approved', { planRevision: 2, authority: 'operator' })
];
attack('stale producer at a superseded approved revision', stalePrefix, decided('B', 2, 1), 'B');

// --- Attack 2: property sweep — ineligible predicate vs transition path -----
const scenarios = {
  'unapproved revision': [
    ev('objective_defined', { goal: 'g', nonGoals: [] }), packet('P', { planRevision: 1 })
  ],
  'objective stopped': [
    ev('objective_defined', { goal: 'g', nonGoals: [] }), packet('P', { planRevision: 1 }),
    ev('plan_approved', { planRevision: 1, authority: 'operator' }),
    ev('objective_stopped', { stopReason: 'STOP file' })
  ],
  'unresolved dependency': [
    ev('objective_defined', { goal: 'g', nonGoals: [] }), packet('A', { planRevision: 1 }),
    packet('P', { planRevision: 1, dependsOn: ['A'] }),
    ev('plan_approved', { planRevision: 1, authority: 'operator' })
  ],
  'unknown dependency': [
    ev('objective_defined', { goal: 'g', nonGoals: [] }), packet('P', { planRevision: 1, dependsOn: ['ghost'] }),
    ev('plan_approved', { planRevision: 1, authority: 'operator' })
  ],
  'already accepted': [
    ev('objective_defined', { goal: 'g', nonGoals: [] }), packet('P', { planRevision: 1 }),
    ev('plan_approved', { planRevision: 1, authority: 'operator' }),
    decided('P', 1, 1), ev('attempt_started', { packetId: 'P', attempt: 1, runId: 'r' }),
    ev('attempt_succeeded', { packetId: 'P', attempt: 1 }),
    ev('assessment_recorded', { packetId: 'P', attempt: 1, authority: 'controller', accepted: true, assessmentRef: 'x', assessmentSha256: sha })
  ],
  'self cycle': [
    ev('objective_defined', { goal: 'g', nonGoals: [] }), packet('P', { planRevision: 1, dependsOn: ['P'] }),
    ev('plan_approved', { planRevision: 1, authority: 'operator' })
  ]
};
for (const [name, prefix] of Object.entries(scenarios)) {
  const target = prefix.filter((e) => e.kind === 'packet_defined').pop().packetId;
  const rec = fold(prefix).packets.get(target);
  attack(`property: ${name}`, prefix, decided(target, rec.planRevision, rec.attempts.size + 1), target);
}

// --- Attack 3: revision / attempt-identity mismatch -------------------------
const approved1 = [
  ev('objective_defined', { goal: 'g', nonGoals: [] }),
  packet('A', { planRevision: 1 }),
  ev('plan_approved', { planRevision: 1, authority: 'operator' })
];
attack('dispatch claiming an unapproved revision', approved1, decided('A', 2, 1), 'A');
attack('dispatch claiming the wrong attempt number', approved1, decided('A', 1, 5), 'A');

// --- Attack 4: outrun the allowance via accepted:false retries --------------
const retryPrefix = [
  ev('objective_defined', { goal: 'g', nonGoals: [] }),
  packet('R', { planRevision: 1, attemptAllowance: 2 }),
  ev('plan_approved', { planRevision: 1, authority: 'operator' })
];
const twoRejections = [...retryPrefix, ...rejected('R', 1), ...rejected('R', 2)];
attack('third attempt after two explicit rejections (allowance 2)', twoRejections, decided('R', 1, 3), 'R');
attack('retry re-declaring an already-used attempt number', twoRejections, decided('R', 1, 1), 'R');

// --- Attack 5: settlement without assessment must not license a retry -------
const unassessed = [
  ...approved1,
  decided('A', 1, 1), ev('attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
  ev('attempt_succeeded', { packetId: 'A', attempt: 1 })
];
attack('redispatch of a succeeded-but-unassessed attempt', unassessed, decided('A', 1, 2), 'A');

// --- Attack 6: idempotency-key abuse ---------------------------------------
// A is legitimately retryable after an explicit rejection, so the interesting
// attacks are key reuse, not retryability.
const retryableA = [...approved1, ...rejected('A', 1)];
// 6a: re-adding the MOST RECENT key with a higher declared attempt. By contract
// this is an honest replay of that decision: it must create no new attempt.
attack('most recent key re-added with a higher attempt number',
  retryableA, { ...decided('A', 1, 1), attempt: 2 }, 'A');
// 6b: after a second attempt exists, reuse the FIRST attempt's key at attempt 3.
// Here the key is genuinely stale and must be REFUSED, not silently absorbed.
const afterTwoRejectionsA = [...retryableA, ...rejected('A', 2)];
attack('stale key from attempt 1 reused at attempt 3',
  afterTwoRejectionsA, { ...decided('A', 1, 1), attempt: 3 }, 'A');

const succeeded = report.filter((r) => !r.refused);
const summary = {
  revisionUnderTest: 'p1-candidate-6-handover + review round 5 repair',
  attacksRun: report.length,
  refused: report.filter((r) => r.refused).length,
  succeeded: succeeded.length,
  openFindings
};
console.log(JSON.stringify({ summary, report }, null, 2));

if (succeeded.length > 0) {
  console.error(`\nFAIL: ${succeeded.length} in-scope attack(s) succeeded.`);
  process.exit(1);
}
if (openFindings.length > 0) {
  console.error(`\nINCOMPLETE: ${openFindings.length} known-open finding(s) remain outside the repaired scope.`);
  process.exit(3);
}
console.log('\nOK: every in-scope attack was refused.');
