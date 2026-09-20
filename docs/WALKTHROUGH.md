# Two-minute walkthrough: success still leaves B blocked

Run `npm run demo` from the repository root. It prints all three tables at once. Keep the output visible and point to each table as you move through the script below. The timings are approximate and allow for pauses.

## 0:00–0:25 — Introduce the decision

“Evidence Router Core decides when dependent work is eligible to proceed.

Imagine task A prepares some data and task B uses it to make a report. That's an illustration; this demo only records synthetic events. It doesn't process data or run an agent.

The question is: when A says it has finished, should B be allowed to start?”

## 0:25–0:45 — Point to table 1

“The plan is approved. A is eligible, but B is blocked because it depends on A.

The output gives us a reason: `dependency_unresolved`. We can see which work is waiting and why.”

## 0:45–1:15 — Point to table 2

“Now an event says A succeeded. Notice that B is still blocked.

A's reason is `awaiting_assessment`. The system has a record of execution success, but it hasn't recorded acceptance of that result.

This distinction matters because a task can finish without producing a result that meets the requirements. Letting B continue immediately could carry an unchecked result into the next stage.”

## 1:15–1:40 — Point to table 3

“Next, the demo adds an accepted assessment for A's attempt, using the controller authority allowed by this packet's policy.

A becomes `accepted`, and B's eligibility changes to `true`.

The acceptance event releases the dependency block. B hasn't actually run; the core has decided it may proceed.”

## 1:40–2:00 — Explain the boundary

“These decisions come from replaying the event history, so we can inspect how the state was reached.

The demo supplies the assessment itself. A real integration would need to check the result and authenticate whoever supplies the approval.

What this example demonstrates is a specific rule: dependent work waits for recorded acceptance, even after its prerequisite reports success.”

## Details to keep handy

- Demo source: [demo.mjs](../demo.mjs).
- The success event is `attempt_succeeded`; acceptance arrives in `assessment_recorded` with `accepted: true`.
- This example uses controller acceptance. Separate tests cover the operator-only policy.
- The assessment reference and digest are synthetic. This demo does not verify artifact contents or authenticate an approver.
- For test, probe and hosted workflow results, see the [verification record](VERIFICATION.md).
