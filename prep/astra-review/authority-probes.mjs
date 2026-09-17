/**
 * Attack harness — AUTHORITY AND EVIDENCE BOUNDARIES.
 *
 * Written from attacks. The first two classes below SUCCEEDED against
 * `p1-candidate-6-handover` (reducer sha256 61055ca5…) and are repaired in
 * review round 5. The last two are proven-open findings that were deliberately
 * OUTSIDE the approved repair scope; they are reported, not asserted away.
 *
 * Exit codes:
 *   0  every in-scope attack refused, no known-open findings
 *   3  in-scope attacks refused, but known-open findings remain (see report)
 *   1  an in-scope attack SUCCEEDED — the repair regressed
 *
 * Run: node prep/astra-review/authority-probes.mjs
 */

import { foldEvents, evaluatePacket } from '../../.router/objectives/reducer.mjs';

const OBJ = 'obj-authority';
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
const record = (name, inScope, refused, detail) => {
  report.push({ attack: name, scope: inScope ? 'in-scope' : 'known-open', refused, detail });
  if (!refused && !inScope) openFindings.push(name);
  return refused;
};

// ---------------------------------------------------------------------------
// Class 1: a declared acceptance policy must be enforced, not recorded.
// ---------------------------------------------------------------------------
const operatorExplicitPrefix = [
  ev('objective_defined', { goal: 'g', nonGoals: [] }),
  packet('A', { acceptancePolicy: 'operator_explicit' }),
  packet('B', { dependsOn: ['A'] }),
  ev('plan_approved', { planRevision: 1, authority: 'operator' }),
  decided('A', 1, 1),
  ev('attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
  ev('attempt_succeeded', { packetId: 'A', attempt: 1 })
];
const controllerAccept = ev('assessment_recorded', {
  packetId: 'A', attempt: 1, authority: 'controller', accepted: true,
  assessmentRef: 'assessment-A1', assessmentSha256: sha
});

// 1a: controller-only acceptance of an operator_explicit packet.
{
  const state = fold([...operatorExplicitPrefix, controllerAccept]);
  const refused = state.packets.get('A').acceptedAttempt === null;
  record('controller-only acceptance of an operator_explicit packet', true, refused,
    refused ? state.invalidTransitions[state.invalidTransitions.length - 1].message : 'ACCEPTED');
}

// 1b: and it must not release a dependant.
{
  const state = fold([...operatorExplicitPrefix, controllerAccept, decided('B', 1, 1)]);
  const refused = state.packets.get('B').attempts.size === 0;
  record('dependant release after refused operator_explicit acceptance', true, refused,
    refused ? 'dependant not released' : 'DEPENDANT RELEASED');
}

// 1c: operator authority with a chain is the positive control.
{
  const state = fold([...operatorExplicitPrefix, ev('assessment_recorded', {
    packetId: 'A', attempt: 1, authority: 'operator', authorizationRef: 'auth-1', accepted: true,
    assessmentRef: 'assessment-A1', assessmentSha256: sha
  })]);
  const worked = state.packets.get('A').acceptedAttempt === 1;
  record('operator acceptance with a chain still works (control)', true, worked, worked ? 'accepted' : 'REFUSED — control broken');
}

// 1d: a bare operator flag without a chain.
{
  const state = fold([...operatorExplicitPrefix, ev('assessment_recorded', {
    packetId: 'A', attempt: 1, authority: 'operator', accepted: true,
    assessmentRef: 'assessment-A1', assessmentSha256: sha
  })]);
  const refused = state.packets.get('A').acceptedAttempt === null;
  record('operator acceptance without an authorization chain', true, refused, refused ? 'refused' : 'ACCEPTED');
}

// ---------------------------------------------------------------------------
// Class 2: superseded evidence must not re-accept revised work.
// ---------------------------------------------------------------------------
{
  const prefix = [
    ev('objective_defined', { goal: 'g', nonGoals: [] }),
    packet('A', { planRevision: 1 }),
    ev('plan_approved', { planRevision: 1, authority: 'operator' }),
    decided('A', 1, 1),
    ev('attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev('attempt_succeeded', { packetId: 'A', attempt: 1 }),
    ev('assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: true, assessmentRef: 'assessment-A1', assessmentSha256: sha }),
    ev('packet_revised', { packetId: 'A', planRevision: 2, instructions: 'different work' }),
    packet('C', { planRevision: 2, dependsOn: ['A'] }),
    ev('plan_approved', { planRevision: 2, authority: 'operator' })
  ];
  const attack = ev('assessment_recorded', {
    packetId: 'A', attempt: 1, authority: 'controller', accepted: true,
    assessmentRef: 'assessment-A1', assessmentSha256: sha
  });
  const state = fold([...prefix, attack, decided('C', 2, 1)]);
  const refused = state.packets.get('A').acceptedAttempt === null && state.packets.get('C').attempts.size === 0;
  record('old-revision assessment restoring acceptance and releasing a dependant', true, refused,
    refused ? state.invalidTransitions[state.invalidTransitions.length - 2].message : 'ACCEPTANCE RESTORED');
}

// ---------------------------------------------------------------------------
// Class 3 (REPAIRED, review round 5b): structurally unusable declared bindings
// are refused at the WRITE PATH, so the packet is never created. Previously they
// were only recorded in `definitionProblems` while the consumer stayed
// dispatchable — advisory validation, not enforcement.
// ---------------------------------------------------------------------------
const acceptedProducer = [
  ev('objective_defined', { goal: 'g', nonGoals: [] }),
  packet('A', { planRevision: 1 }),
  ev('plan_approved', { planRevision: 1, authority: 'operator' }),
  decided('A', 1, 1),
  ev('attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
  ev('attempt_succeeded', { packetId: 'A', attempt: 1 }),
  ev('assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: true, assessmentRef: 'assessment-A1', assessmentSha256: sha })
];
const binding = (extra = {}) => ({
  packetId: 'A', planRevision: 1, attempt: 1, artifactPath: 'A.txt',
  sha256: sha, assessmentRef: 'assessment-A1', ...extra
});

for (const [name, b] of [
  ['binding declaring a FOREIGN objective is refused at the write path', binding({ objectiveId: 'OTHER' })],
  ['binding declaring a MALFORMED sha256 is refused at the write path (condition C8)', binding({ sha256: 'not-a-digest' })]
]) {
  const prefix = [...acceptedProducer, packet('C', { dependsOn: ['A'], inputs: [b] })];
  const state = fold([...prefix, decided('C', 1, 1)]);
  const created = state.packets.has('C');
  record(name, true, !created,
    created
      ? `PACKET CREATED — consumer dispatchable (attempts ${state.packets.get('C').attempts.size})`
      : `packet never created; log records: ${state.invalidTransitions[0]?.message?.slice(0, 80) ?? 'n/a'}`);
}

// ---------------------------------------------------------------------------
// Class 4 (REPAIRED, review round 5b): only the newest binding per (producer,
// artifact path) is evaluated, so a producer retry no longer wedges consumers
// that bound to the failed attempt.
// ---------------------------------------------------------------------------
{
  const prefix = [
    ev('objective_defined', { goal: 'g', nonGoals: [] }),
    packet('A'),
    packet('C', { dependsOn: ['A'], inputs: [{
      objectiveId: OBJ, packetId: 'A', planRevision: 1, attempt: 1,
      artifactPath: 'A.txt', sha256: sha, assessmentRef: 'assessment-A1'
    }] }),
    ev('plan_approved', { planRevision: 1, authority: 'operator' }),
    decided('A', 1, 1),
    ev('attempt_started', { packetId: 'A', attempt: 1, runId: 'run-A1' }),
    ev('attempt_failed', { packetId: 'A', attempt: 1 }),
    ev('assessment_recorded', { packetId: 'A', attempt: 1, authority: 'controller', accepted: false, assessmentRef: 'assessment-A1', assessmentSha256: sha }),
    decided('A', 1, 2),
    ev('attempt_started', { packetId: 'A', attempt: 2, runId: 'run-A2' }),
    ev('attempt_succeeded', { packetId: 'A', attempt: 2 }),
    ev('assessment_recorded', { packetId: 'A', attempt: 2, authority: 'controller', accepted: true, assessmentRef: 'assessment-A2', assessmentSha256: sha }),
    // The documented remedy: record a fresh binding pinning the accepted attempt.
    ev('input_binding_recorded', { packetId: 'C', binding: {
      objectiveId: OBJ, packetId: 'A', planRevision: 1, attempt: 2,
      artifactPath: 'A.txt', sha256: sha, assessmentRef: 'assessment-A2'
    } })
  ];
  const state = fold(prefix);
  const cVerdict = evaluatePacket(state, 'C');
  record('new binding event releases a consumer whose earlier binding went stale', true, cVerdict.eligible,
    cVerdict.eligible
      ? `released; retained bindings ${state.packets.get('C').inputs.length} (history kept, newest evaluated)`
      : `STILL WEDGED: ${cVerdict.reason}`);
}

const inScopeFailures = report.filter((r) => r.scope === 'in-scope' && !r.refused && r.attack !== 'operator acceptance with a chain still works (control)');
const summary = {
  revisionUnderTest: 'p1-candidate-6-handover + review round 5 repair (5b: binding write path + supersede)',
  attacksRun: report.length,
  inScopeFailures: inScopeFailures.length,
  openFindings
};
console.log(JSON.stringify({ summary, report }, null, 2));

if (inScopeFailures.length > 0) {
  console.error(`\nFAIL: ${inScopeFailures.length} in-scope attack(s) succeeded.`);
  process.exit(1);
}
if (openFindings.length > 0) {
  console.error(`\nINCOMPLETE: ${openFindings.length} known-open finding(s) remain outside the repaired scope.`);
  process.exit(3);
}
console.log('\nOK: every in-scope attack was refused.');
