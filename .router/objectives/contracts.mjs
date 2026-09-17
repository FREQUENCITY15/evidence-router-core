/**
 * P1 — Objective / work-packet contract schemas and structural validators.
 *
 * SCOPE (P1): pure, in-memory contract definitions and validation. No I/O, no
 * filesystem, no scheduler, no controller coupling, no model calls.
 *
 * DESIGN CONSTRAINTS taken from prep/08-supervised-orchestration-plan.md:
 *  - Separate execution success, verification and acceptance. Agent prose is not
 *    acceptance authority, so `model_review` NEVER satisfies a dependency.
 *  - Bind review to immutable task/run/attempt and artifact hashes; stale evidence
 *    cannot release dependants.
 *  - Plan edits invalidate prior approval for affected work.
 *  - A packet is eligible only under the approved plan revision, with all
 *    prerequisites authoritatively accepted and verified input bindings.
 *  - Missing, stale, rejected or unresolved dependencies block dispatch.
 *  - Legacy items stay visible as legacy: absence of objective membership is
 *    modelled explicitly and is not an error.
 *
 * EVIDENCE VS INFERENCE: these validators report structural facts about the input
 * they are given ("field X is absent", "reference points at revision Y while the
 * plan is at Z"). They never assert that a plan is *correct* or that work is
 * *safe*; that is an operator decision.
 */

/** Schema version for persisted objective documents. Bumping this is a breaking change. */
export const OBJECTIVE_SCHEMA = 'objective/1';
export const PACKET_SCHEMA = 'work-packet/1';
export const EVENT_SCHEMA = 'objective-event/1';
export const PROJECTION_SCHEMA = 'objective-projection/1';

/** Maximum attempts a packet may be dispatched for before supervisor triage. */
export const DEFAULT_ATTEMPT_ALLOWANCE = 2;

/**
 * Acceptance policies.
 *  - controller_deterministic: acceptance is decided by a deterministic
 *    controller assessment. This is the only policy that can release dependants.
 *  - operator_explicit: a human operator decision is required in addition.
 * Both are controller/operator authority. `model_review` is deliberately absent:
 * model review is advisory and can never be an acceptance policy (plan §"Audit
 * synthesis", supervisor correction #2).
 */
export const ACCEPTANCE_POLICIES = Object.freeze(['controller_deterministic', 'operator_explicit']);

/**
 * Packet lifecycle states. `accepted` is the ONLY state that satisfies a
 * dependant. `dispatching` exists so a crash between decision and receipt is
 * visible rather than silently re-decided.
 */
export const PACKET_STATES = Object.freeze([
  'defined', 'eligible', 'dispatching', 'dispatched', 'succeeded', 'failed', 'accepted', 'rejected'
]);

/** Dependency verdicts, most severe first. */
export const DEPENDENCY_VERDICTS = Object.freeze([
  'accepted', 'unresolved', 'rejected', 'stale', 'unknown'
]);

/** Reason codes an eligibility decision can carry. Stable strings for tests and UI. */
export const REASON = Object.freeze({
  OK: 'eligible',
  OBJECTIVE_UNKNOWN: 'objective_unknown',
  OBJECTIVE_NOT_APPROVED: 'objective_not_approved',
  OBJECTIVE_STOPPED: 'objective_stopped',
  PACKET_UNKNOWN: 'packet_unknown',
  PACKET_STALE_REVISION: 'packet_stale_revision',
  PLAN_REVISION_MISMATCH: 'plan_revision_mismatch',
  DEPENDENCY_UNRESOLVED: 'dependency_unresolved',
  DEPENDENCY_REJECTED: 'dependency_rejected',
  DEPENDENCY_STALE: 'dependency_stale',
  DEPENDENCY_UNKNOWN: 'dependency_unknown',
  DEPENDENCY_CYCLE: 'dependency_cycle',
  ATTEMPT_ALLOWANCE_EXHAUSTED: 'attempt_allowance_exhausted',
  INPUT_BINDING_MISSING: 'input_binding_missing',
  INPUT_BINDING_UNVERIFIED: 'input_binding_unverified',
  INPUT_BINDING_STALE: 'input_binding_stale',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  ALREADY_ACCEPTED: 'already_accepted',
  AWAITING_ASSESSMENT: 'awaiting_assessment',
  INVALID_STATE: 'invalid_state_transition'
});

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isRevision = (v) => Number.isInteger(v) && v >= 0;

/**
 * An immutable content reference used for dependency handoff.
 *
 * Deliberately NOT a path and NOT a validator name. Plan supervisor correction #4:
 * do not generalise `contentContract` into arbitrary paths or validators. A
 * binding pins the producer attempt, the accepted assessment and the file digest,
 * so a later retry cannot silently replace a dependant's input.
 */
export function validateInputBinding(binding, path = 'binding', expectedObjectiveId = undefined) {
  const problems = [];
  if (!isPlainObject(binding)) {
    return { ok: false, problems: [`${path}: must be an object`] };
  }
  if (!isNonEmptyString(binding.packetId)) problems.push(`${path}.packetId: required non-empty string`);
  if (!isRevision(binding.planRevision)) problems.push(`${path}.planRevision: required non-negative integer`);
  if (!Number.isInteger(binding.attempt) || binding.attempt < 1) problems.push(`${path}.attempt: required integer >= 1`);
  if (!isNonEmptyString(binding.artifactPath)) problems.push(`${path}.artifactPath: required non-empty string`);
  if (!isNonEmptyString(binding.sha256)) problems.push(`${path}.sha256: required non-empty string`);
  else if (!/^[0-9a-f]{64}$/.test(binding.sha256)) problems.push(`${path}.sha256: must be 64 lowercase hex characters`);
  if (!isNonEmptyString(binding.assessmentRef)) problems.push(`${path}.assessmentRef: required non-empty string`);
  // `objectiveId` stays optional (P1 does not require it), but when a binding
  // names an objective it must be THIS one. Previously only the declared-input
  // path checked it, and only when the rest of the binding was well formed, so a
  // binding pointing at another objective's packet could be recorded and the
  // consumer dispatched anyway (review round 5).
  if (expectedObjectiveId !== undefined && binding.objectiveId !== undefined && binding.objectiveId !== expectedObjectiveId) {
    problems.push(`${path}.objectiveId: binding belongs to a different objective ('${binding.objectiveId}')`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * A work packet: the unit of bounded, dispatchable work.
 *
 * `writeScope` is declarative. P1 records it but does not enforce it; enforcement
 * belongs to the authoritative reservation boundary (P3, plan correction #5).
 */
export function validateWorkPacket(packet, path = 'packet') {
  const problems = [];
  if (!isPlainObject(packet)) return { ok: false, problems: [`${path}: must be an object`] };
  if (packet.schema !== PACKET_SCHEMA) problems.push(`${path}.schema: must be '${PACKET_SCHEMA}'`);
  if (!isNonEmptyString(packet.packetId)) problems.push(`${path}.packetId: required non-empty string`);
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(packet.packetId)) problems.push(`${path}.packetId: must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}`);
  if (!isNonEmptyString(packet.objectiveId)) problems.push(`${path}.objectiveId: required non-empty string`);
  if (!isRevision(packet.planRevision)) problems.push(`${path}.planRevision: required non-negative integer`);
  if (!isNonEmptyString(packet.instructions)) problems.push(`${path}.instructions: required non-empty string`);
  if (!Array.isArray(packet.dependsOn)) problems.push(`${path}.dependsOn: required array`);
  else {
    if (packet.dependsOn.some((d) => !isNonEmptyString(d))) problems.push(`${path}.dependsOn: every entry must be a non-empty packet id string`);
    if (new Set(packet.dependsOn).size !== packet.dependsOn.length) problems.push(`${path}.dependsOn: duplicate entries are not allowed`);
    if (packet.dependsOn.includes(packet.packetId)) problems.push(`${path}.dependsOn: a packet may not depend on itself`);
  }
  if (!Array.isArray(packet.inputs)) problems.push(`${path}.inputs: required array (may be empty)`);
  else packet.inputs.forEach((b, i) => {
    problems.push(...validateInputBinding(b, `${path}.inputs[${i}]`, packet.objectiveId).problems);
  });
  if (!isPlainObject(packet.routePolicy)) problems.push(`${path}.routePolicy: required object`);
  else {
    if (!isNonEmptyString(packet.routePolicy.defaultRoute)) problems.push(`${path}.routePolicy.defaultRoute: required non-empty string`);
    if (packet.routePolicy.escalationRoute !== undefined && packet.routePolicy.escalationRoute !== null && !isNonEmptyString(packet.routePolicy.escalationRoute)) {
      problems.push(`${path}.routePolicy.escalationRoute: must be a non-empty string when present`);
    }
  }
  if (!isPlainObject(packet.writeScope)) problems.push(`${path}.writeScope: required object`);
  else if (!Array.isArray(packet.writeScope.paths)) problems.push(`${path}.writeScope.paths: required array`);
  // The plan lists "declared inputs AND output contract" as work-packet
  // requirements. Its absence was a genuine modelling gap, not an optional
  // omission, so it is validated here.
  problems.push(...validateOutputContract(packet.outputContract, `${path}.outputContract`).problems);
  if (!Number.isInteger(packet.attemptAllowance) || packet.attemptAllowance < 1) problems.push(`${path}.attemptAllowance: required integer >= 1`);
  else if (packet.attemptAllowance > DEFAULT_ATTEMPT_ALLOWANCE) {
    // Recorded, not rejected: a larger allowance is a policy decision, but it must
    // be visible because the plan caps initial repair attempts at two.
    problems.push(`${path}.attemptAllowance: exceeds the plan's initial limit of ${DEFAULT_ATTEMPT_ALLOWANCE}`);
  }
  if (!ACCEPTANCE_POLICIES.includes(packet.acceptancePolicy)) {
    problems.push(`${path}.acceptancePolicy: must be one of ${ACCEPTANCE_POLICIES.join(', ')} (model review is advisory and is not an acceptance policy)`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The output contract: what a packet must produce.
 *
 * A packet declares the artifacts it will emit as regular expressions or literal
 * names inside its artifact directory, plus whether at least one is required.
 * This is a DECLARATION for the acceptance policy to check; P1 does not enforce
 * the file system.
 */
export function validateOutputContract(contract, path = 'outputContract') {
  const problems = [];
  if (!isPlainObject(contract)) {
    return { ok: false, problems: [`${path}: required object declaring at least one artifact`] };
  }
  if (!Array.isArray(contract.artifacts)) problems.push(`${path}.artifacts: required array`);
  else {
    if (contract.artifacts.length === 0) problems.push(`${path}.artifacts: must declare at least one artifact`);
    contract.artifacts.forEach((a, i) => {
      if (!isPlainObject(a)) { problems.push(`${path}.artifacts[${i}]: must be an object`); return; }
      if (!isNonEmptyString(a.name)) problems.push(`${path}.artifacts[${i}].name: required non-empty string`);
      else if (/[\\/:*?"<>|]/.test(a.name)) problems.push(`${path}.artifacts[${i}].name: must be a bare file name, not a path`);
      else if (a.name === 'result.json') problems.push(`${path}.artifacts[${i}].name: 'result.json' is reserved by the controller`);
      if (a.required !== undefined && typeof a.required !== 'boolean') problems.push(`${path}.artifacts[${i}].required: must be a boolean when present`);
    });
    const names = contract.artifacts.filter((a) => isPlainObject(a) && isNonEmptyString(a.name)).map((a) => a.name);
    if (new Set(names).size !== names.length) problems.push(`${path}.artifacts: duplicate artifact names are not allowed`);
  }
  if (contract.requireAtLeastOne !== undefined && typeof contract.requireAtLeastOne !== 'boolean') {
    problems.push(`${path}.requireAtLeastOne: must be a boolean when present`);
  }
  return { ok: problems.length === 0, problems };
}

/** An objective: stable identity, goal, non-goals, revision and envelope. */
export function validateObjective(objective, path = 'objective') {
  const problems = [];
  if (!isPlainObject(objective)) return { ok: false, problems: [`${path}: must be an object`] };
  if (objective.schema !== OBJECTIVE_SCHEMA) problems.push(`${path}.schema: must be '${OBJECTIVE_SCHEMA}'`);
  if (!isNonEmptyString(objective.objectiveId)) problems.push(`${path}.objectiveId: required non-empty string`);
  if (!isRevision(objective.revision)) problems.push(`${path}.revision: required non-negative integer`);
  if (!isNonEmptyString(objective.goal)) problems.push(`${path}.goal: required non-empty string`);
  if (!Array.isArray(objective.nonGoals)) problems.push(`${path}.nonGoals: required array (may be empty; an objective must state what it is not)`);
  else if (objective.nonGoals.some((g) => !isNonEmptyString(g))) problems.push(`${path}.nonGoals: every entry must be a non-empty string`);
  if (objective.approvedPlanRevision !== null && objective.approvedPlanRevision !== undefined && !isRevision(objective.approvedPlanRevision)) {
    problems.push(`${path}.approvedPlanRevision: must be null or a non-negative integer`);
  }
  if (objective.executionEnvelope !== undefined && objective.executionEnvelope !== null) {
    const e = objective.executionEnvelope;
    if (!isPlainObject(e)) problems.push(`${path}.executionEnvelope: must be an object or null`);
    else {
      if (e.maxActiveWorkers !== undefined && (!Number.isInteger(e.maxActiveWorkers) || e.maxActiveWorkers < 1)) {
        problems.push(`${path}.executionEnvelope.maxActiveWorkers: must be an integer >= 1 when present`);
      }
      if (e.maxActiveWorkers !== undefined && e.maxActiveWorkers > 1) {
        problems.push(`${path}.executionEnvelope.maxActiveWorkers: exceeds 1, which the first milestone does not support`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Structural validation of one event. Unknown event kinds are rejected rather
 * than ignored: an unmodelled event must never silently change authoritative
 * state.
 */
export function validateEvent(event, path = 'event') {
  const problems = [];
  if (!isPlainObject(event)) return { ok: false, problems: [`${path}: must be an object`] };
  if (event.schema !== undefined && event.schema !== EVENT_SCHEMA) problems.push(`${path}.schema: must be '${EVENT_SCHEMA}' when present`);
  if (!isNonEmptyString(event.kind)) problems.push(`${path}.kind: required non-empty string`);
  if (!Number.isInteger(event.seq) || event.seq < 1) problems.push(`${path}.seq: required integer >= 1`);
  if (!isNonEmptyString(event.objectiveId)) problems.push(`${path}.objectiveId: required non-empty string`);
  if (!isNonEmptyString(event.atUtc)) problems.push(`${path}.atUtc: required non-empty string`);
  switch (event.kind) {
    case 'objective_defined':
      if (!isNonEmptyString(event.goal)) problems.push(`${path}.goal: required for objective_defined`);
      break;
    case 'packet_defined':
      if (!isNonEmptyString(event.packetId)) problems.push(`${path}.packetId: required for packet_defined`);
      if (!isNonEmptyString(event.instructions)) problems.push(`${path}.instructions: required for packet_defined`);
      if (!Array.isArray(event.dependsOn)) problems.push(`${path}.dependsOn: required array for packet_defined`);
      // Declared inputs are validated HERE, not only at fold time. Structural
      // problems used to be recorded in `definitionProblems`, which is advisory:
      // the consumer stayed dispatchable while the projection reported a problem
      // at the same time. A binding that cannot be used (missing pin, malformed
      // digest, or naming another objective) must not enter the durable log at
      // all (review round 5, condition C8).
      if (event.inputs !== undefined) {
        if (!Array.isArray(event.inputs)) problems.push(`${path}.inputs: must be an array when present`);
        else event.inputs.forEach((b, i) => {
          problems.push(...validateInputBinding(b, `${path}.inputs[${i}]`, event.objectiveId).problems);
        });
      }
      if (event.acceptancePolicy !== undefined && !ACCEPTANCE_POLICIES.includes(event.acceptancePolicy)) {
        problems.push(`${path}.acceptancePolicy: must be one of ${ACCEPTANCE_POLICIES.join(', ')}`);
      }
      problems.push(...validateOutputContract(event.outputContract, `${path}.outputContract`).problems);
      // The plan caps initial repair attempts at two. An event that simply
      // declares a larger allowance must not be able to buy itself more attempts
      // silently, so an over-policy allowance is refused here rather than only
      // being noted.
      if (event.attemptAllowance !== undefined) {
        if (!Number.isInteger(event.attemptAllowance) || event.attemptAllowance < 1) {
          problems.push(`${path}.attemptAllowance: must be an integer >= 1 when present`);
        } else if (event.attemptAllowance > DEFAULT_ATTEMPT_ALLOWANCE) {
          problems.push(`${path}.attemptAllowance: ${event.attemptAllowance} exceeds the plan's initial limit of ${DEFAULT_ATTEMPT_ALLOWANCE}; a larger allowance needs a new operator approval, not a packet declaration`);
        }
      }
      break;
    case 'plan_approved':
      if (!isRevision(event.planRevision)) problems.push(`${path}.planRevision: required for plan_approved`);
      if (!isNonEmptyString(event.authority)) problems.push(`${path}.authority: required for plan_approved`);
      else if (event.authority !== 'operator') problems.push(`${path}.authority: plan approval authority must be 'operator'`);
      break;
    case 'plan_revised':
    case 'packet_revised':
      if (!isRevision(event.planRevision)) problems.push(`${path}.planRevision: required for ${event.kind}`);
      if (event.kind === 'packet_revised' && !isNonEmptyString(event.packetId)) problems.push(`${path}.packetId: required for packet_revised`);
      break;
    case 'dispatch_decided':
      if (!isNonEmptyString(event.packetId)) problems.push(`${path}.packetId: required for dispatch_decided`);
      if (!isNonEmptyString(event.idempotencyKey)) problems.push(`${path}.idempotencyKey: required for dispatch_decided`);
      if (!Number.isInteger(event.attempt) || event.attempt < 1) problems.push(`${path}.attempt: required integer >= 1 for dispatch_decided`);
      break;
    case 'attempt_started':
      if (!isNonEmptyString(event.packetId)) problems.push(`${path}.packetId: required for attempt_started`);
      if (!Number.isInteger(event.attempt) || event.attempt < 1) problems.push(`${path}.attempt: required integer >= 1 for attempt_started`);
      if (!isNonEmptyString(event.runId)) problems.push(`${path}.runId: required for attempt_started`);
      break;
    case 'attempt_succeeded':
    case 'attempt_failed':
      if (!isNonEmptyString(event.packetId)) problems.push(`${path}.packetId: required for ${event.kind}`);
      if (!Number.isInteger(event.attempt) || event.attempt < 1) problems.push(`${path}.attempt: required integer >= 1 for ${event.kind}`);
      break;
    case 'assessment_recorded':
      if (!isNonEmptyString(event.packetId)) problems.push(`${path}.packetId: required for assessment_recorded`);
      if (!Number.isInteger(event.attempt) || event.attempt < 1) problems.push(`${path}.attempt: required integer >= 1 for assessment_recorded`);
      if (!isNonEmptyString(event.assessmentRef)) problems.push(`${path}.assessmentRef: required for assessment_recorded`);
      if (!isNonEmptyString(event.assessmentSha256)) problems.push(`${path}.assessmentSha256: required for assessment_recorded`);
      else if (!/^[0-9a-f]{64}$/.test(event.assessmentSha256)) problems.push(`${path}.assessmentSha256: must be 64 lowercase hex characters`);
      if (event.authority !== 'controller' && event.authority !== 'operator') {
        problems.push(`${path}.authority: acceptance authority must be 'controller' or 'operator' (model review is advisory)`);
      }
      // Supervisor correction #1: adopting an OPERATOR override requires the
      // matching authorization chain. Deterministic controller acceptance does
      // not. An operator acceptance with no authorization reference is therefore
      // a bare flag and is refused.
      if (event.authority === 'operator' && !isNonEmptyString(event.authorizationRef)) {
        problems.push(`${path}.authorizationRef: an operator acceptance requires the matching authorization chain reference`);
      }
      if (event.authority === 'controller' && event.authorizationRef !== undefined && event.authorizationRef !== null && !isNonEmptyString(event.authorizationRef)) {
        problems.push(`${path}.authorizationRef: must be a non-empty string when present`);
      }
      if (typeof event.accepted !== 'boolean') problems.push(`${path}.accepted: required boolean for assessment_recorded`);
      break;
    case 'model_review_recorded':
      // Advisory by construction: recorded, never authoritative.
      if (!isNonEmptyString(event.packetId)) problems.push(`${path}.packetId: required for model_review_recorded`);
      if (!isNonEmptyString(event.reviewRef)) problems.push(`${path}.reviewRef: required for model_review_recorded`);
      break;
    case 'objective_stopped':
      if (!isNonEmptyString(event.stopReason)) problems.push(`${path}.stopReason: required for objective_stopped`);
      break;
    case 'objective_resumed':
      break;
    case 'input_binding_recorded':
      if (!isNonEmptyString(event.packetId)) problems.push(`${path}.packetId: required for input_binding_recorded`);
      else {
        const r = validateInputBinding({ ...event.binding, packetId: event.binding?.packetId }, `${path}.binding`, event.objectiveId);
        problems.push(...r.problems);
      }
      break;
    default:
      problems.push(`${path}.kind: unrecognised event kind '${event.kind}' — an unmodelled event must not change authoritative state`);
  }
  return { ok: problems.length === 0, problems };
}
