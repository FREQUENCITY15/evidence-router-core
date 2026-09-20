# Evidence Router Core

[![Tests](https://github.com/FREQUENCITY15/evidence-router-core/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/FREQUENCITY15/evidence-router-core/actions/workflows/tests.yml)

**Evidence-driven decision core for bounded LLM/agent orchestration.**

A dependency-free JavaScript core that replays an event history to determine which work may run next, which work is blocked, and why. It models plan approval, dependencies, acceptance policies and retry limits for supervised agent workflows.

**Verified September 2026:** 68 automated tests passed; the synthetic demo and all three probe scripts completed with exit code `0`. Transition and authority probes reported no open findings within their tested scope. See the [verification record](docs/VERIFICATION.md) for results and limits.

## The problem it addresses

In an agent workflow, a task reporting success is only one part of deciding whether dependent work can proceed. Its result may still need acceptance, its plan may have changed, or a consumer may reference an earlier attempt.

Evidence Router Core makes those decisions explicit and reproducible. Each unit of work, called a **packet**, has dependencies and a bounded attempt allowance. Replaying the recorded events produces its state, eligibility and reason for being blocked. Model reviews remain advisory; acceptance follows the declared controller or operator policy.

## Try the demo

With Node.js and npm available, open the repository folder and run:

```sh
npm run demo
```

There are no third-party dependencies and no installation step. The demo uses synthetic events without workers, model calls, network access or file writes.

It follows two packets, where B depends on A:

| Recorded event | Packet A | Can B run? |
| --- | --- | --- |
| Plan approved | Ready to run | No: A has not been accepted |
| A succeeds | Awaiting assessment | No: success alone does not release B |
| A is accepted | Accepted | Yes: its dependency is satisfied |

Run the automated tests with:

```sh
npm test
```

## Engineering decisions demonstrated

- **Deterministic replay:** the same event history produces the same decisions without clocks, randomness or model calls in the core.
- **Explicit acceptance:** execution success and acceptance are separate states; operator-only acceptance cannot be supplied by a controller alone.
- **Stale-evidence handling:** plan revisions and producer retries can block dependent work. A fresh binding event can update the consumer's input reference while preserving history.
- **Bounded retries and replay handling:** attempt allowances and idempotency checks prevent invalid redispatch decisions in the tested scenarios.
- **Inspectable refusals:** missing dependencies, cycles, stale references and invalid transitions produce reasons that callers can inspect.

The tests cover these rules, including regression cases for undeclared packets, conflicting attempts and superseded assessments. The probes exercise additional transition, authority and binding scenarios.

## How the code fits together

The core validates event structure, folds the history into state, and derives a projection containing packet eligibility and diagnostic information. The demo and CLI are small callers of that core.

| File | Responsibility |
| --- | --- |
| [contracts.mjs](.router/objectives/contracts.mjs) | Schemas, structural validation and reason codes |
| [reducer.mjs](.router/objectives/reducer.mjs) | Event replay, packet state and eligibility decisions |
| [tests](.router/objectives/tests/) | 56 core tests and 12 gate regression tests |
| [demo.mjs](demo.mjs) | Three-stage acceptance-gating example |
| [cli.mjs](cli.mjs) | JSON-file input and projection output |
| [probes](prep/astra-review/) | Transition, authority and stale-binding checks |

To inspect your own JSON array of events for a single objective:

```sh
node cli.mjs events.json
```

Supply your own `events.json`; see [demo.mjs](demo.mjs) for event construction. Inspect `invalidTransitions` and `definitionProblems` in the output: producing a projection does not certify that the event history is valid. The CLI was not part of the five-command verification record.

## Scope and limits

This repository contains an in-memory decision core. Integrating it into an operational agent system would require worker dispatch, a scheduler, durable event storage and authenticated approvals.

Authority fields are claims supplied in events, not identity checks. Artifact digests are checked structurally and by reference; the core does not verify file contents. Route and write-scope declarations do not provide an execution sandbox. Passing the tests and probes establishes the recorded results within their tested scope, not a general safety guarantee.

## Verification

Run the same five checks used for the September 2026 verification:

```sh
npm test
npm run demo
npm run probe:transitions
npm run probe:authority
npm run probe:bindings
```

The [verification record](docs/VERIFICATION.md) documents each result. [GitHub Actions](https://github.com/FREQUENCITY15/evidence-router-core/actions/workflows/tests.yml) runs `npm test` on every push and pull request using Node.js 24 on Ubuntu. Its first run passed for commit `9ba8aca`. The demo and probes were verified locally; a repository-history secret check remains pending.

## Provenance and reuse

This core was extracted from the Evidence Router project. [SOURCE-PROVENANCE.json](SOURCE-PROVENANCE.json) records the source archive and hashes of the extracted core, tests and probes. Historical paths in source comments may refer to audit documents outside this package.

A public reuse licence has not yet been selected. The package retains `"private": true` to prevent accidental npm publication; this does not control GitHub repository visibility.
