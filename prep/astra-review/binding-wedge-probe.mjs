// Does a fresh input binding release a consumer whose earlier binding went stale?
//
// Provenance: against `p1-candidate-6-handover` the answer was NO. Bindings are
// append-only and every retained entry had to stay valid, so a producer that
// failed attempt 1 and was accepted at attempt 2 permanently wedged every
// consumer bound to the failed attempt — the intended bounded-repair path.
// Contract doc §2.4 claimed the opposite.
//
// Repaired in review round 5b (binding option B): only the newest binding per
// (producer, artifact path) is evaluated. This probe now asserts RELEASE, and
// exits non-zero if the wedge returns.
import { foldEvents, evaluatePacket } from '../../.router/objectives/reducer.mjs';

const OBJ = 'obj-wedge';
const sha = (c) => c.repeat(64).slice(0, 64);
const ev = (kind, extra = {}) => ({ kind, objectiveId: OBJ, atUtc: '2026-09-16T00:00:00Z', ...extra });
const packet = (packetId, extra = {}) => ev('packet_defined', {
  packetId, planRevision: 1, instructions: `produce ${packetId}`, dependsOn: [], inputs: [],
  attemptAllowance: 2, routePolicy: { defaultRoute: 'flash-off' }, writeScope: { paths: [] },
  outputContract: { artifacts: [{ name: `${packetId}.txt`, required: true }] }, ...extra
});
const decided = (packetId, attempt) => ev('dispatch_decided', {
  packetId, planRevision: 1, attempt,
  idempotencyKey: `dispatch:${OBJ}:r1:${packetId}:a${attempt}`
});
const binding = (consumer, attempt, ref) => ev('input_binding_recorded', {
  packetId: consumer,
  binding: {
    objectiveId: OBJ, packetId: 'A', planRevision: 1, attempt,
    artifactPath: 'A.txt', sha256: sha('b'), assessmentRef: ref
  }
});

const seq = (events) => events.map((e, i) => ({ ...e, seq: i + 1 }));
const fold = (events) => foldEvents(seq(events), OBJ);
const verdict = (events, target) => {
  const v = evaluatePacket(fold(events), target);
  return { eligible: v.eligible, reason: v.reason, detail: v.detail };
};

// C binds A's FIRST attempt by declaration. D declares no inputs and is bound
// later over the event path — the control that isolates the cause.
const C_INPUT = {
  objectiveId: OBJ, packetId: 'A', planRevision: 1, attempt: 1,
  artifactPath: 'A.txt', sha256: sha('b'), assessmentRef: 'assessment-A1'
};

const objective = [
  ev('objective_defined', { goal: 'g', nonGoals: [] }),
  packet('A', { planRevision: 1, attemptAllowance: 2 }),
  packet('C', { dependsOn: ['A'], inputs: [C_INPUT] }),
  packet('D', { dependsOn: ['A'] }),
  ev('plan_approved', { planRevision: 1, authority: 'operator' })
];

// A attempt 1: fails and is explicitly rejected (the bounded repair path).
const attempt1Rejected = [
  ...objective,
  decided('A', 1),
  ev('attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
  ev('attempt_failed', { packetId: 'A', attempt: 1 }),
  ev('assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'assessment-A1', assessmentSha256: sha('a') })
];

// A attempt 2: succeeds and is accepted. A's accepted attempt is now 2.
const attempt2Accepted = [
  ...attempt1Rejected,
  decided('A', 2),
  ev('attempt_started', { packetId: 'A', attempt: 2, runId: 'run-A2' }),
  ev('attempt_succeeded', { packetId: 'A', attempt: 2 }),
  ev('assessment_recorded', { packetId: 'A', attempt: 2, authority: 'controller', accepted: true, assessmentRef: 'assessment-A2', assessmentSha256: sha('a') })
];

// The documented remedy for C: record a new binding pinning the accepted attempt.
const withNewBinding = [...attempt2Accepted, binding('C', 2, 'assessment-A2')];

// The control: D never held a stale binding, so binding it now must release it.
const dWithBinding = [...attempt2Accepted, binding('D', 2, 'assessment-A2')];

const cRecord = fold(withNewBinding).packets.get('C');

console.log(JSON.stringify({
  c_beforeProducerRetry: verdict(attempt1Rejected, 'C'),
  c_afterProducerAcceptedAttempt2: verdict(attempt2Accepted, 'C'),
  c_afterNewBindingEvent: verdict(withNewBinding, 'C'),
  c_bindingsRetained: cRecord.inputs.map((b) => `a${b.attempt}/${b.assessmentRef}`),
  control_d_afterFirstBinding: verdict(dWithBinding, 'D'),
  contractClaim: '§2.4: a stale binding is released by "a new binding event, not a silent re-point"',
  finding: verdict(withNewBinding, 'C').eligible
    ? 'new binding released the consumer'
    : 'WEDGE REGRESSED: new binding did not release the consumer'
}, null, 2));

if (!verdict(withNewBinding, 'C').eligible) {
  console.error('\nFAIL: producer retry wedged its consumer again.');
  process.exit(1);
}
if (!verdict(dWithBinding, 'D').eligible) {
  console.error('\nFAIL: control failed — a first binding did not release a clean consumer.');
  process.exit(1);
}
console.log('\nOK: a fresh binding releases a consumer whose earlier binding went stale.');
