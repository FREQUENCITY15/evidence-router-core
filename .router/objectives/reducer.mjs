/**
 * P1 — Pure objective/packet state and eligibility reducer.
 *
 * PURITY CONTRACT (tested): every exported function is a pure function of its
 * arguments. No filesystem, no clock, no randomness, no process state, no model
 * calls, no mutation of inputs. `foldEvents` and `reduce` do not mutate the event
 * array or any event object.
 *
 * The reducer is the ONLY place packet state is decided. Dispatch is not an
 * input; it is a derived consequence, which is what makes "A releases B exactly
 * once" checkable by replay rather than by trusting a scheduler.
 *
 * ACCEPTANCE AUTHORITY: only an `assessment_recorded` event with
 * `authority: 'controller' | 'operator'` can move a packet to `accepted`.
 * `model_review_recorded` is retained as advisory evidence and never satisfies a
 * dependency (plan: "Agent prose is not acceptance authority").
 */

import {
  REASON, PACKET_STATES, DEPENDENCY_VERDICTS, PROJECTION_SCHEMA, EVENT_SCHEMA,
  validateEvent, validateObjective, validateWorkPacket, validateInputBinding
} from './contracts.mjs';

const emptyState = (objectiveId) => ({
  objectiveId,
  goal: null,
  nonGoals: [],
  revision: 0,
  approvedPlanRevision: null,
  currentPlanRevision: 0,
  stopped: null,
  packets: new Map(),
  events: [],
  problems: [],
  // Structural problems found in packet definitions. Kept separate from
  // `problems` so definition issues stay visible rather than being dropped.
  definitionProblems: [],
  invalidTransitions: []
});

const packetRecord = (state, packetId) => state.packets.get(packetId);

/**
 * Create a packet record. Only `packet_defined` calls this.
 *
 * Every other handler uses `requirePacket`, so an event naming an undeclared
 * packet can never fabricate one. Before this rule, an advisory review or a
 * dispatch decision for an unknown id silently created a packet that then
 * appeared in the projection and counted toward derived progress.
 */
function createPacket(state, packetId) {
  const rec = {
    packetId,
    objectiveId: state.objectiveId,
    planRevision: null,
    instructions: null,
    dependsOn: [],
    inputs: [],
    routePolicy: null,
    writeScope: null,
    attemptAllowance: null,
    acceptancePolicy: 'controller_deterministic',
    state: 'defined',
    // attempt history: attempt number -> record. Never overwritten.
    attempts: new Map(),
    // seq of the dispatch_decided event that authorised the outstanding attempt.
    decidedSeq: null,
    idempotencyKey: null,
    acceptedAttempt: null,
    acceptedAssessmentRef: null,
    acceptedAssessmentSha256: null,
    lastAssessment: null,
    modelReviews: [],
    explicitlyRejected: false
  };
  state.packets.set(packetId, rec);
  return rec;
}

/**
 * Look up a declared packet, recording an invalid transition when it is absent.
 * Returns null when the event must be refused.
 */
function requirePacket(state, event, packetId) {
  const rec = state.packets.get(packetId);
  if (!rec) {
    noteInvalid(state, event, `references packet '${packetId}', which was never declared by a packet_defined event`);
    return null;
  }
  return rec;
}

/** Deep-ish clone of a packet map so callers can never mutate reducer internals. */
function cloneState(state) {
  const packets = new Map();
  for (const [id, rec] of state.packets) {
    packets.set(id, {
      ...rec,
      // Attempt records AND their nested assessment objects are copied, so a
      // caller holding a clone cannot reach back into the original's evidence.
      attempts: new Map([...rec.attempts].map(([k, v]) => [k, {
        ...v,
        assessment: v.assessment ? { ...v.assessment } : null
      }])),
      modelReviews: rec.modelReviews.map((r) => ({ ...r })),
      dependsOn: [...rec.dependsOn],
      inputs: rec.inputs.map((b) => ({ ...b }))
    });
  }
  return { ...state, packets, events: [...state.events], problems: [...state.problems], invalidTransitions: state.invalidTransitions.map((t) => ({ ...t })) };
}

function note(state, message) {
  state.problems.push(message);
}

function noteInvalid(state, event, message) {
  const text = `seq ${event?.seq ?? '?'} (${event?.kind ?? 'unknown'}): ${message}`;
  state.problems.push(text);
  state.invalidTransitions.push({ seq: event?.seq ?? null, kind: event?.kind ?? null, message });
}

/**
 * Fold an ordered event log into authoritative state.
 *
 * Replay is deterministic and idempotent in the sense that matters: folding the
 * same log twice yields equal state, and honest event repeats do not duplicate
 * attempts or re-release dependants.
 */
export function foldEvents(events, objectiveId) {
  if (!Array.isArray(events)) throw new TypeError('foldEvents: events must be an array');
  const state = emptyState(objectiveId ?? events.find((e) => e?.objectiveId)?.objectiveId ?? null);

  const ordered = [...events];
  let lastSeq = 0;

  for (const raw of ordered) {
    const event = raw;
    if (!event || typeof event !== 'object') { note(state, 'skipped a non-object event'); continue; }

    const v = validateEvent(event);
    if (!v.ok) {
      noteInvalid(state, event, `structurally invalid event: ${v.problems.join('; ')}`);
      continue;
    }
    if (event.objectiveId !== state.objectiveId) {
      // Legacy isolation: an event for another objective (or a legacy item with
      // no objective) is never merged into this objective's state.
      continue;
    }
    if (event.seq <= lastSeq) {
      noteInvalid(state, event, `out-of-order or duplicate seq (last applied seq ${lastSeq})`);
      continue;
    }
    lastSeq = event.seq;
    state.events.push({ seq: event.seq, kind: event.kind, atUtc: event.atUtc });

    switch (event.kind) {
      case 'objective_defined': {
        if (state.goal !== null) {
          // A repeat with identical content is an honest replay; different content
          // is a contradiction.
          if (state.goal !== event.goal) noteInvalid(state, event, 'objective redefined with a different goal');
          break;
        }
        state.goal = event.goal;
        state.nonGoals = Array.isArray(event.nonGoals) ? [...event.nonGoals] : [];
        break;
      }

      case 'packet_defined': {
        const existing = state.packets.get(event.packetId);
        if (existing) {
          noteInvalid(state, event, `packet '${event.packetId}' redefined; use packet_revised (definitions are immutable once recorded)`);
          break;
        }
        const rec = createPacket(state, event.packetId);
        rec.planRevision = Number.isInteger(event.planRevision) ? event.planRevision : state.currentPlanRevision;
        rec.instructions = event.instructions;
        rec.dependsOn = [...event.dependsOn];
        rec.inputs = Array.isArray(event.inputs) ? event.inputs.map((b) => ({ ...b })) : [];
        rec.routePolicy = event.routePolicy ? { ...event.routePolicy } : null;
        rec.writeScope = event.writeScope ? { ...event.writeScope } : null;
        rec.outputContract = event.outputContract ? JSON.parse(JSON.stringify(event.outputContract)) : null;
        rec.attemptAllowance = Number.isInteger(event.attemptAllowance) ? event.attemptAllowance : 2;
        rec.acceptancePolicy = event.acceptancePolicy ?? 'controller_deterministic';
        rec.state = 'defined';
        // Structural problems in the definition are surfaced rather than dropped.
        // The fold previously recorded NOTHING here, so definition problems never
        // reached the projection.
        const packetProblems = validateWorkPacket({
          schema: 'work-packet/1',
          packetId: rec.packetId,
          objectiveId: state.objectiveId,
          planRevision: rec.planRevision,
          instructions: rec.instructions,
          dependsOn: rec.dependsOn,
          inputs: rec.inputs,
          routePolicy: rec.routePolicy,
          writeScope: rec.writeScope,
          outputContract: rec.outputContract,
          attemptAllowance: rec.attemptAllowance,
          acceptancePolicy: rec.acceptancePolicy
        }).problems;
        for (const pr of packetProblems) {
          state.definitionProblems.push({ packetId: rec.packetId, seq: event.seq, problem: pr });
        }
        break;
      }

      case 'plan_approved': {
        if (event.planRevision < state.currentPlanRevision) {
          noteInvalid(state, event, `cannot approve superseded revision ${event.planRevision} (current ${state.currentPlanRevision})`);
          break;
        }
        state.currentPlanRevision = event.planRevision;
        state.approvedPlanRevision = event.planRevision;
        break;
      }

      case 'plan_revised': {
        if (event.planRevision <= state.currentPlanRevision) {
          noteInvalid(state, event, `plan revision must increase (got ${event.planRevision}, current ${state.currentPlanRevision})`);
          break;
        }
        state.currentPlanRevision = event.planRevision;
        // Any prior approval no longer covers the new revision.
        state.approvedPlanRevision = null;
        break;
      }

      case 'packet_revised': {
        const rec = requirePacket(state, event, event.packetId);
        // This was the only `requirePacket` call site without a null guard: a
        // packet_revised for an undeclared id crashed the whole fold, so a single
        // malformed durable-log event would break every projection.
        if (!rec) break;
        if (event.planRevision <= state.currentPlanRevision) {
          noteInvalid(state, event, `packet revision must increase the plan revision (got ${event.planRevision}, current ${state.currentPlanRevision})`);
          break;
        }
        state.currentPlanRevision = event.planRevision;
        state.approvedPlanRevision = null;
        rec.planRevision = event.planRevision;
        if (Array.isArray(event.dependsOn)) rec.dependsOn = [...event.dependsOn];
        if (typeof event.instructions === 'string') rec.instructions = event.instructions;
        // A revised packet can no longer rely on its previous acceptance.
        rec.acceptedAttempt = null;
        rec.acceptedAssessmentRef = null;
        rec.acceptedAssessmentSha256 = null;
        rec.explicitlyRejected = false;
        rec.decidedSeq = null;
        rec.idempotencyKey = null;
        rec.state = 'defined';
        break;
      }

      case 'dispatch_decided': {
        const rec = requirePacket(state, event, event.packetId);
        if (!rec) break;

        // The authoritative gate. A dispatch decision may NOT mutate state
        // without it: before this, a decision for an undeclared packet fabricated
        // one, and a decision under a suspended revision was applied silently.
        const blockers = gateBlockers(state, rec);
        if (blockers.length > 0) {
          noteInvalid(state, event, `dispatch refused for '${event.packetId}': ${blockers[0].detail}`);
          break;
        }
        // The declared plan revision must be the packet's own revision. The
        // earlier revision check compared event.planRevision against
        // rec.planRevision and was dropped during the gate rewrite, which let a
        // dispatch event claim an unapproved revision and have the attempt
        // recorded against it. Restored, and pinned to the packet's revision.
        if (event.planRevision !== rec.planRevision) {
          noteInvalid(state, event, `dispatch_decided declares plan revision ${event.planRevision} but packet '${event.packetId}' is at revision ${rec.planRevision}`);
          break;
        }
        if (rec.acceptedAttempt !== null) {
          noteInvalid(state, event, `dispatch decided for already-accepted packet '${event.packetId}' (attempt ${rec.acceptedAttempt})`);
          break;
        }
        // A settled attempt with no assessment must not be replaced by a new
        // dispatch decision. This guard already lived in the read-only predicate;
        // without it here, the transition path accepted a second attempt for
        // completed-but-unassessed work — the same trust-the-caller class that the
        // shared gate was introduced to close.
        {
          const settledAttempts = [...rec.attempts.values()].filter((a) => a.outcome !== null);
          const lastSettled = settledAttempts.length > 0 ? settledAttempts[settledAttempts.length - 1] : null;
          // An EXPLICITLY REJECTED attempt may be retried within its allowance:
          // that is the bounded repair packet the plan calls for. An unassessed
          // settled attempt may not, because nothing has judged it yet.
          const explicitlyRejected = lastSettled?.assessment != null && lastSettled.assessment.accepted === false;
          if (lastSettled && lastSettled.assessment === null && !explicitlyRejected) {
            noteInvalid(state, event, `packet '${event.packetId}' has attempt ${lastSettled.attempt} settled as '${lastSettled.outcome}' awaiting assessment; accept or reject it before further dispatch`);
            break;
          }
        }
        // Idempotency: the same key is the same decision. A second identical
        // decision must not create a second attempt.
        if (rec.idempotencyKey === event.idempotencyKey) break;
        if (rec.idempotencyKey !== null && rec.idempotencyKey !== event.idempotencyKey && rec.state === 'dispatching') {
          noteInvalid(state, event, `packet '${event.packetId}' already has an outstanding dispatch decision '${rec.idempotencyKey}'`);
          break;
        }

        const nextAttempt = rec.attempts.size + 1;
        // The declared attempt number must match the derived one. It was
        // previously ignored, so attempt identity could silently diverge:
        // dispatch_decided(attempt:5) created attempt 1, and a later
        // attempt_started(attempt:5) was then refused while attempt_started(1)
        // was accepted and bound a run the controller never decided.
        if (event.attempt !== nextAttempt) {
          noteInvalid(state, event, `dispatch_decided declares attempt ${event.attempt} but the derived next attempt for '${event.packetId}' is ${nextAttempt}`);
          break;
        }
        // A decision already recorded under this key, at ANY attempt, is a replay.
        if ([...rec.attempts.values()].some((a) => a.idempotencyKey === event.idempotencyKey)) {
          noteInvalid(state, event, `idempotency key '${event.idempotencyKey}' was already used for an earlier attempt of '${event.packetId}'`);
          break;
        }
        const outstanding = [...rec.attempts.values()].find((a) => a.outcome === null);
        if (outstanding) {
          noteInvalid(state, event, `packet '${event.packetId}' already has an unresolved attempt ${outstanding.attempt}`);
          break;
        }
        if (rec.attemptAllowance !== null && nextAttempt > rec.attemptAllowance) {
          noteInvalid(state, event, `attempt allowance exhausted for '${event.packetId}' (allowance ${rec.attemptAllowance})`);
          break;
        }
        rec.attempts.set(nextAttempt, {
          attempt: nextAttempt,
          planRevision: event.planRevision,
          decidedSeq: event.seq,
          idempotencyKey: event.idempotencyKey,
          runId: null,
          outcome: null,
          assessment: null
        });
        rec.decidedSeq = event.seq;
        rec.idempotencyKey = event.idempotencyKey;
        rec.state = 'dispatching';
        break;
      }

      case 'attempt_started': {
        const rec = requirePacket(state, event, event.packetId);
        if (!rec) break;
        const att = rec.attempts.get(event.attempt);
        if (!att) {
          noteInvalid(state, event, `attempt_started for attempt ${event.attempt} of '${event.packetId}' which was never decided`);
          break;
        }
        if (att.runId !== null && att.runId !== event.runId) {
          noteInvalid(state, event, `attempt ${event.attempt} of '${event.packetId}' already bound to run '${att.runId}'`);
          break;
        }
        if (att.runId === event.runId) {
          // Honest replay of the same receipt: a no-op, NOT a state change.
          // Previously this fell through and reset an ACCEPTED packet to
          // 'dispatched', which silently revoked acceptance and un-released an
          // already-released dependant.
          break;
        }
        att.runId = event.runId;
        // Acceptance outranks attempt lifecycle: a settled acceptance is never
        // downgraded by later attempt bookkeeping.
        if (rec.acceptedAttempt === null) rec.state = 'dispatched';
        break;
      }

      case 'attempt_succeeded':
      case 'attempt_failed': {
        const rec = requirePacket(state, event, event.packetId);
        if (!rec) break;
        const att = rec.attempts.get(event.attempt);
        if (!att) {
          noteInvalid(state, event, `${event.kind} for attempt ${event.attempt} of '${event.packetId}' which was never decided`);
          break;
        }
        if (att.outcome !== null && att.outcome !== event.kind) {
          noteInvalid(state, event, `attempt ${event.attempt} of '${event.packetId}' already settled as '${att.outcome}'`);
          break;
        }
        att.outcome = event.kind;
        // Execution success is NOT acceptance. It only makes assessment possible.
        if (rec.acceptedAttempt === null) {
          rec.state = event.kind === 'attempt_succeeded' ? 'succeeded' : 'failed';
        }
        break;
      }

      case 'assessment_recorded': {
        const rec = requirePacket(state, event, event.packetId);
        if (!rec) break;
        const att = rec.attempts.get(event.attempt);
        if (!att) {
          noteInvalid(state, event, `assessment for attempt ${event.attempt} of '${event.packetId}' which was never decided`);
          break;
        }
        if (att.outcome === null) {
          noteInvalid(state, event, `assessment for attempt ${event.attempt} of '${event.packetId}' before the attempt settled`);
          break;
        }
        // An assessment may only judge an attempt that belongs to the packet's
        // CURRENT plan revision. `packet_revised` clears acceptance precisely so
        // that superseded work cannot release dependants; without this check an
        // assessment naming an attempt whose planRevision had been superseded
        // restored `acceptedAttempt` and released a dependant on the strength of
        // the old plan (found by independent falsification, review round 5).
        if (att.planRevision !== rec.planRevision) {
          noteInvalid(state, event, `assessment for attempt ${event.attempt} of '${event.packetId}' belongs to plan revision ${att.planRevision}, but the packet is at revision ${rec.planRevision}; superseded evidence cannot re-accept work`);
          break;
        }
        // The packet's declared acceptance policy is enforced here, not merely
        // recorded. A packet declaring `operator_explicit` could previously be
        // accepted by a controller-only assessment, which silently discharged a
        // policy the operator had authored (found by independent falsification).
        // The attempt is left UNASSESSED rather than rejected, so it stays blocked
        // awaiting a genuine operator decision instead of looking judged.
        if (event.accepted && rec.acceptancePolicy === 'operator_explicit' && event.authority !== 'operator') {
          noteInvalid(state, event, `packet '${event.packetId}' declares acceptancePolicy 'operator_explicit'; a '${event.authority}' acceptance cannot adopt it`);
          break;
        }
        // Execution success is not acceptance, but acceptance still requires
        // execution success. Accepting a FAILED attempt would let verification
        // contradict execution, so it is refused rather than recorded.
        if (event.accepted && att.outcome !== 'attempt_succeeded') {
          noteInvalid(state, event, `cannot accept attempt ${event.attempt} of '${event.packetId}': it settled as '${att.outcome}', not a successful execution`);
          break;
        }
        const assessment = {
          attempt: event.attempt,
          authority: event.authority,
          accepted: event.accepted,
          ref: event.assessmentRef,
          sha256: event.assessmentSha256,
          atUtc: event.atUtc
        };
        att.assessment = assessment;
        rec.lastAssessment = assessment;

        if (event.accepted) {
          if (rec.acceptedAttempt !== null && rec.acceptedAttempt !== event.attempt) {
            noteInvalid(state, event, `attempt ${event.attempt} of '${event.packetId}' accepted while attempt ${rec.acceptedAttempt} is already accepted; acceptance is immutable`);
            break;
          }
          rec.acceptedAttempt = event.attempt;
          rec.acceptedAssessmentRef = event.assessmentRef;
          rec.acceptedAssessmentSha256 = event.assessmentSha256;
          rec.explicitlyRejected = false;
          rec.state = 'accepted';
        } else {
          rec.explicitlyRejected = true;
          if (rec.acceptedAttempt === null) rec.state = 'rejected';
        }
        break;
      }

      case 'model_review_recorded': {
        const rec = requirePacket(state, event, event.packetId);
        // An advisory review for an undeclared packet grants nothing and must not
        // fabricate a packet record.
        if (!rec) break;
        rec.modelReviews.push({ ref: event.reviewRef, atUtc: event.atUtc });
        // No state change. Advisory evidence only.
        break;
      }

      case 'input_binding_recorded': {
        // `event.packetId` names the CONSUMER; `event.binding.packetId` names the
        // PRODUCER. Both must be declared packets.
        const consumer = requirePacket(state, event, event.packetId);
        if (!consumer) break;
        const producer = requirePacket(state, event, event.binding?.packetId);
        if (!producer) break;
        const bindingProblems = validateInputBinding(event.binding).problems;
        if (bindingProblems.length > 0) {
          noteInvalid(state, event, `malformed input binding: ${bindingProblems.join('; ')}`);
          break;
        }
        consumer.inputs = [...consumer.inputs, { ...event.binding }];
        break;
      }

      case 'objective_stopped': {
        state.stopped = { reason: event.stopReason, atUtc: event.atUtc };
        break;
      }

      case 'objective_resumed': {
        state.stopped = null;
        break;
      }

      default:
        noteInvalid(state, event, `unhandled event kind '${event.kind}'`);
    }
  }

  // Revision consistency: any packet whose revision is behind the current plan
  // revision is stale. Recorded as a fact, not a failure.
  for (const rec of state.packets.values()) {
    rec.stale = isStale(state, rec);
    if (rec.planRevision !== null && rec.planRevision > state.currentPlanRevision) {
      note(state, `packet '${rec.packetId}' declares revision ${rec.planRevision} ahead of the plan revision ${state.currentPlanRevision}`);
    }
  }
  return state;
}

/**
 * Detect packets that are members of, or dependants of, a dependency cycle.
 * Returns a Set of packet ids that must never be dispatched.
 */
export function findCycles(state) {
  const blocked = new Set();
  const color = new Map(); // 0 unvisited, 1 in-stack, 2 done
  const stack = [];
  const visit = (id) => {
    if (color.get(id) === 1) {
      // Found a cycle: every node from the first occurrence of id onward is a member.
      const from = stack.indexOf(id);
      for (let i = from; i < stack.length; i++) blocked.add(stack[i]);
      return;
    }
    if (color.get(id) === 2) return;
    if (!state.packets.has(id)) return;
    color.set(id, 1);
    stack.push(id);
    for (const dep of state.packets.get(id).dependsOn) visit(dep);
    stack.pop();
    color.set(id, 2);
  };
  for (const id of state.packets.keys()) visit(id);

  // Dependants of a cycle member can never resolve either: if C depends on a
  // cyclic B, C is permanently blocked. Propagate transitively.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, rec] of state.packets) {
      if (blocked.has(id)) continue;
      if (rec.dependsOn.some((d) => blocked.has(d))) { blocked.add(id); changed = true; }
    }
  }
  return blocked;
}

/**
 * Is this packet stale relative to the approved plan revision?
 *
 * DERIVED, never read from stored state. `rec.stale` is assigned only in the
 * post-fold pass, so reading it during the fold left `dep.stale === undefined`
 * and the shared gate reported a stale dependency as `accepted`. A dispatch for
 * a packet whose producer was stale was therefore accepted by the fold and
 * refused by `evaluatePacket` — the exact divergence the shared gate exists to
 * prevent (found by independent falsification, review round 5). Both paths now
 * call this function, so their verdicts cannot disagree on staleness.
 */
function isStale(state, rec) {
  return rec.planRevision !== null
    && state.approvedPlanRevision !== null
    && rec.planRevision !== state.approvedPlanRevision;
}

/** Verdict for one dependency edge, from the perspective of the consumer. */
function dependencyVerdict(state, depId) {
  const dep = state.packets.get(depId);
  if (!dep) return { verdict: 'unknown', detail: `dependency '${depId}' is not defined in this objective` };
  if (isStale(state, dep)) return { verdict: 'stale', detail: `dependency '${depId}' is at revision ${dep.planRevision}, not the approved ${state.approvedPlanRevision}` };
  if (dep.acceptedAttempt === null) {
    if (dep.explicitlyRejected) return { verdict: 'rejected', detail: `dependency '${depId}' was assessed and not accepted` };
    return { verdict: 'unresolved', detail: `dependency '${depId}' has no accepted assessment` };
  }
  if (dep.state !== 'accepted') return { verdict: 'unresolved', detail: `dependency '${depId}' acceptance is not authoritatively recorded` };
  return { verdict: 'accepted', detail: `dependency '${depId}' attempt ${dep.acceptedAttempt} accepted by ${dep.lastAssessment?.authority}` };
}

function bindingProblems(state, rec) {
  const problems = [];
  // Only the NEWEST binding for each (producer, artifact path) is evaluated.
  // Bindings are append-only, so every entry ever recorded previously had to stay
  // valid; a producer that failed attempt 1 and was accepted at attempt 2 then
  // wedged every consumer that had bound to the failed attempt, and recording a
  // fresh binding could not release it (proven in review round 5). Earlier entries
  // are retained as history but no longer block. Keyed per artifact path as well
  // as producer, so a consumer may still consume two artifacts from one producer.
  const newest = new Map();
  for (const [i, b] of rec.inputs.entries()) {
    const key = (b && typeof b === 'object' && b.packetId !== undefined && b.artifactPath !== undefined)
      ? `${b.packetId}\u0000${b.artifactPath}`
      : `#${i}`;
    newest.set(key, { i, b });
  }
  for (const { i, b } of newest.values()) {
    const label = `input[${i}]`;
    const producer = state.packets.get(b.packetId);
    if (!producer) { problems.push({ code: REASON.INPUT_BINDING_MISSING, detail: `${label}: producer packet '${b.packetId}' is not defined` }); continue; }
    if (b.planRevision !== producer.planRevision) {
      problems.push({ code: REASON.INPUT_BINDING_STALE, detail: `${label}: bound to revision ${b.planRevision} but producer '${b.packetId}' is at ${producer.planRevision}` });
      continue;
    }
    if (producer.acceptedAttempt === null) {
      problems.push({ code: REASON.INPUT_BINDING_UNVERIFIED, detail: `${label}: producer '${b.packetId}' has no accepted attempt to bind` });
      continue;
    }
    if (b.attempt !== producer.acceptedAttempt || b.assessmentRef !== producer.acceptedAssessmentRef) {
      // A retry must not silently replace a dependant's input.
      problems.push({ code: REASON.INPUT_BINDING_STALE, detail: `${label}: pins attempt ${b.attempt}/${b.assessmentRef} but producer '${b.packetId}' now accepts attempt ${producer.acceptedAttempt}/${producer.acceptedAssessmentRef}` });
    }
  }
  return problems;
}

/**
 * The single authoritative gate.
 *
 * Both `evaluatePacket` (the read-only predicate) and the `dispatch_decided`
 * fold handler call this, so a dispatch decision cannot take a different path to
 * state mutation than the predicate that is supposed to authorise it. This closes
 * the class of defect where the fold applied state changes the predicate would
 * have refused.
 *
 * It does NOT consider attempt bookkeeping (outstanding attempts, allowance),
 * because the dispatch handler must be able to authorise the very next attempt;
 * those checks live in `evaluatePacket`.
 *
 * Returns an array of blockers; empty means the packet passes the gate.
 */
function gateBlockers(state, rec) {
  const blockers = [];
  const packetId = rec.packetId;
  if (state.goal === null) {
    blockers.push({ code: REASON.OBJECTIVE_UNKNOWN, detail: 'objective has no objective_defined event' });
  }
  if (state.approvedPlanRevision === null) {
    blockers.push({ code: REASON.OBJECTIVE_NOT_APPROVED, detail: 'no approved plan revision covers this packet' });
  }
  if (state.stopped) {
    blockers.push({ code: REASON.OBJECTIVE_STOPPED, detail: `objective is stopped: ${state.stopped.reason}` });
  }
  // Checked before acceptance: after a plan edit, an accepted packet is still
  // reported as stale rather than as already-accepted, because the operative
  // obstacle is the missing approval, not the prior acceptance. Reporting
  // "already accepted" here would mislead an operator into believing the work is
  // still covered by an approved revision.
  if (isStale(state, rec)) {
    blockers.push({ code: REASON.PACKET_STALE_REVISION, detail: `packet is at revision ${rec.planRevision}, approved revision is ${state.approvedPlanRevision}` });
  }
  if (findCycles(state).has(packetId)) {
    blockers.push({ code: REASON.DEPENDENCY_CYCLE, detail: 'packet is part of, or depends on, a dependency cycle' });
  }
  // Dependencies and input bindings are part of the SAME gate, so a
  // dispatch_decided event cannot authorise work whose prerequisites are
  // missing. They were previously checked only by the read-only predicate, which
  // let the fold accept a dispatch for a packet with an unresolved dependency.
  for (const d of rec.dependsOn) {
    const v = dependencyVerdict(state, d);
    if (v.verdict !== 'accepted') {
      blockers.push({
        code: {
          unresolved: REASON.DEPENDENCY_UNRESOLVED,
          rejected: REASON.DEPENDENCY_REJECTED,
          stale: REASON.DEPENDENCY_STALE,
          unknown: REASON.DEPENDENCY_UNKNOWN
        }[v.verdict] ?? REASON.DEPENDENCY_UNRESOLVED,
        detail: v.detail
      });
      break;
    }
  }
  const binds = bindingProblems(state, rec);
  if (binds.length > 0) blockers.push({ code: binds[0].code, detail: binds[0].detail });
  return blockers;
}

/**
 * Decide whether ONE packet may be dispatched, and why not.
 *
 * This is the authoritative predicate. It is pure: it reads folded state and the
 * packet definition and returns a verdict. Gate placement in a live path (P3)
 * must call this rather than reimplement it (plan correction #5).
 */
export function evaluatePacket(state, packetId) {
  const rec = state.packets.get(packetId);
  if (!rec) {
    return { packetId, eligible: false, reason: REASON.PACKET_UNKNOWN, detail: `no packet '${packetId}' in this objective`, verdicts: [] };
  }
  const verdicts = rec.dependsOn.map((d) => ({ packetId: d, ...dependencyVerdict(state, d) }));
  const blockers = gateBlockers(state, rec);
  if (blockers.length > 0) {
    return { packetId, eligible: false, reason: blockers[0].code, detail: blockers[0].detail, verdicts };
  }
  if (rec.acceptedAttempt !== null) {
    return { packetId, eligible: false, reason: REASON.ALREADY_ACCEPTED, detail: `attempt ${rec.acceptedAttempt} is already accepted`, verdicts };
  }

  const binds = bindingProblems(state, rec);

  // A resolved attempt with NO assessment must not be re-dispatched. Without this
  // guard, a completed-but-unassessed packet was immediately eligible again and
  // the projection recommended re-running finished work — and execution success
  // would have been silently treated as a licence to retry forever.
  const settled = [...rec.attempts.values()].filter((a) => a.outcome !== null);
  const lastSettled = settled.length > 0 ? settled[settled.length - 1] : null;
  // An explicitly rejected attempt may be retried within its allowance (the
  // bounded repair packet); an unassessed settled attempt may not.
  const lastRejected = lastSettled?.assessment != null && lastSettled.assessment.accepted === false;
  if (lastSettled && lastSettled.assessment === null && !lastRejected) {
    return {
      packetId, eligible: false, reason: REASON.AWAITING_ASSESSMENT,
      detail: `attempt ${lastSettled.attempt} settled as '${lastSettled.outcome}' with no assessment; accept or reject it before further dispatch`,
      verdicts, bindingProblems: binds
    };
  }

  const nextAttempt = rec.attempts.size + 1;
  if (rec.attemptAllowance !== null && nextAttempt > rec.attemptAllowance) {
    return { packetId, eligible: false, reason: REASON.ATTEMPT_ALLOWANCE_EXHAUSTED, detail: `allowance ${rec.attemptAllowance} consumed by ${rec.attempts.size} attempt(s)`, verdicts };
  }
  const outstanding = [...rec.attempts.values()].find((a) => a.outcome === null);
  if (outstanding) {
    return { packetId, eligible: false, reason: REASON.INVALID_STATE, detail: `attempt ${outstanding.attempt} is still unresolved`, verdicts };
  }

  return { packetId, eligible: true, reason: REASON.OK, detail: `all ${verdicts.length} dependency verdict(s) accepted`, verdicts, nextAttempt };
}

/**
 * Deterministic, crash-safe idempotency key for a dispatch decision.
 * The same (objective, plan revision, packet, attempt) always yields the same
 * key, so a crash between decision and receipt re-derives the same decision
 * instead of creating a second one.
 */
export function idempotencyKey({ objectiveId, planRevision, packetId, attempt }) {
  return `dispatch:${objectiveId}:r${planRevision}:${packetId}:a${attempt}`;
}

/**
 * Full read-only projection: state, per-packet eligibility, and the dispatch
 * decisions implied by the events so far. Never mutates its input.
 */
export function reduce(events, options = {}) {
  const state = foldEvents(events, options.objectiveId);
  const cycles = findCycles(state);
  const evaluations = [];
  const dispatchDecisions = [];

  for (const packetId of [...state.packets.keys()].sort()) {
    const rec = state.packets.get(packetId);
    const ev = evaluatePacket(state, packetId);
    evaluations.push({
      packetId,
      eligible: ev.eligible,
      reason: ev.reason,
      detail: ev.detail,
      dependencyVerdicts: ev.verdicts,
      bindingProblems: ev.bindingProblems ?? [],
      state: rec.state,
      planRevision: rec.planRevision,
      // Exposed so a reviewer can observe which definition is in force (a refused
      // redefinition must leave the original standing).
      instructions: rec.instructions,
      dependsOn: [...rec.dependsOn],
      outputContract: rec.outputContract ? JSON.parse(JSON.stringify(rec.outputContract)) : null,
      acceptancePolicy: rec.acceptancePolicy,
      attemptCount: rec.attempts.size,
      attemptAllowance: rec.attemptAllowance,
      acceptedAttempt: rec.acceptedAttempt,
      modelReviews: rec.modelReviews.length
    });
    if (ev.eligible) {
      const key = idempotencyKey({ objectiveId: state.objectiveId, planRevision: state.approvedPlanRevision, packetId, attempt: ev.nextAttempt });
      // A decision already recorded for this exact key is NOT re-emitted. This is
      // the "releases B exactly once" guarantee, expressed as a pure function.
      if (rec.idempotencyKey === key || [...rec.attempts.values()].some((a) => a.idempotencyKey === key)) continue;
      dispatchDecisions.push({
        packetId,
        attempt: ev.nextAttempt,
        planRevision: state.approvedPlanRevision,
        idempotencyKey: key,
        route: rec.routePolicy?.defaultRoute ?? null,
        objectiveId: state.objectiveId
      });
    }
  }

  const accepted = evaluations.filter((e) => e.acceptedAttempt !== null).length;
  const blocked = evaluations.filter((e) => !e.eligible && !e.acceptedAttempt);

  return {
    schema: PROJECTION_SCHEMA,
    objectiveId: state.objectiveId,
    goal: state.goal,
    nonGoals: [...state.nonGoals],
    currentPlanRevision: state.currentPlanRevision,
    approvedPlanRevision: state.approvedPlanRevision,
    stopped: state.stopped,
    packets: evaluations,
    dispatchDecisions,
    blockedReasons: blocked.map((b) => ({ packetId: b.packetId, reason: b.reason, detail: b.detail })),
    cycles: [...cycles].sort(),
    problems: [...state.problems],
    definitionProblems: state.definitionProblems.map((d) => ({ ...d })),
    invalidTransitions: state.invalidTransitions.map((t) => ({ ...t })),
    eventCount: state.events.length,
    // Explicit scope of what an "eligible" verdict actually proves. An input
    // binding pins the producer's accepted attempt and assessment reference; it
    // does NOT verify the artifact digest, because P1 records no producer-side
    // artifact hash to verify against. Stating this in the projection prevents a
    // consumer from reading `eligible` as "the input artifact is verified".
    bindingVerification: {
      verifiesProducerAttempt: true,
      verifiesAssessmentRef: true,
      verifiesArtifactSha256: false,
      note: 'P1 pins producer attempt and assessment reference only. Artifact digest verification requires the producer-side artifact hash that P2 must record; until then a binding sha256 is carried but not checked.'
    },
    progress: {
      // Progress is derived, never stored, and only counts authoritative events.
      defined: evaluations.length,
      accepted,
      blocked: blocked.length,
      dispatches: evaluations.reduce((n, e) => n + e.attemptCount, 0)
    }
  };
}

export const __internal = { emptyState, cloneState, packetRecord, dependencyVerdict, EVENT_SCHEMA, PACKET_STATES, DEPENDENCY_VERDICTS, validateObjective };
