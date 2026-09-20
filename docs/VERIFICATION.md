# Verification record

## September 2026 local verification

These results were observed in PowerShell output supplied by the repository owner during portfolio preparation. All five commands were run from the `evidence-router-core` directory. Each exit code was captured with `$LASTEXITCODE`; `npm test` was repeated to capture its previously omitted exit code.

| Command | Observed result | Exit code |
| --- | --- | --- |
| `npm test` | 68 tests passed; 0 failed, cancelled, skipped or todo | `0` |
| `npm run demo` | A eligible; A succeeded with B blocked; A accepted with B eligible | `0` |
| `npm run probe:transitions` | 14 attacks run, 14 refused, 0 succeeded; `openFindings: []` | `0` |
| `npm run probe:authority` | 8 scenarios run, 0 in-scope failures; `openFindings: []` | `0` |
| `npm run probe:bindings` | A fresh binding released the consumer after a producer retry; both bindings retained | `0` |

The final test run reported a duration of 74.6058 ms. This is a single test-run duration, not a performance benchmark.

The transition probe reported revision label `p1-candidate-6-handover + review round 5 repair`. The authority probe reported `p1-candidate-6-handover + review round 5 repair (5b: binding write path + supersede)`. These are script labels, not verified Git commit identifiers.

## Interpreting the results

The authority report includes positive controls: valid operator acceptance and a fresh binding must succeed. Its generic `refused` field is therefore not a literal description of every scenario. The recorded outcome is eight scenarios with zero in-scope failures.

The binding probe confirms that a rejected producer blocks its consumer, acceptance of a later attempt leaves the earlier binding stale, and a new binding event releases the consumer while retaining both binding records.

No open findings were reported by the transition and authority probes in these runs. That statement applies to their tested scope. If a later probe exits with code `3`, record its known-open findings separately rather than treating that run as passing.

## Evidence limits and pending checks

- This is a summary of supplied terminal output. Raw transcripts, the tested Git commit and Node.js/npm versions were not archived with this record.
- These were local runs, not GitHub Actions runs. A hosted CI result is still pending.
- The demo uses synthetic events; it does not exercise live workers, models or an operational router.
- The JSON-file CLI was not separately executed in this verification sequence.
- A repository-history secret check remains unresolved. These test results do not establish that the repository history is secret-free.

## Reproduce the checks

With Node.js and npm available, run from the repository root in PowerShell:

```powershell
npm test
$LASTEXITCODE
npm run demo
$LASTEXITCODE
npm run probe:transitions
$LASTEXITCODE
npm run probe:authority
$LASTEXITCODE
npm run probe:bindings
$LASTEXITCODE
```

Capture the full output and each exit code. For future records, also capture `git rev-parse HEAD`, `git status --short`, `node --version` and `npm --version` so results can be tied to a specific code state and environment.
