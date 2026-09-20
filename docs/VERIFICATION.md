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

## GitHub Actions verification

The repository owner supplied a screenshot showing **Tests #1** passed on `main` for commit `9ba8aca` ("Run automated tests with GitHub Actions"). The displayed run duration was 12 seconds.

The [workflow](../.github/workflows/tests.yml) runs `npm test` using Node.js 24 on Ubuntu for every push and pull request, and also supports manual runs. The screenshot confirms the workflow result; the detailed hosted test log was not included in this record. The demo and three probe scripts are covered by the local results above, not by this workflow.

Inspect runs on the [Tests workflow page](https://github.com/FREQUENCITY15/evidence-router-core/actions/workflows/tests.yml). The README badge shows the current result for `main`.

## Repository-history secret scan

On 20 September 2026, Gitleaks 8.30.1 scanned all locally reachable Git history through commit `a9521ba1e44b3bc748b3354b4af6345e62be6d8c`. The checkout was not shallow. A remote-ref check showed only `main`, pointing to that same commit.

- Result: **4 commits scanned, 0 findings, exit code `0`**.
- Scope: `git --log-opts="--all --full-history"`, using the scanner's bundled default rules, full redaction and `--ignore-gitleaks-allow`.
- No repository ignore file or baseline was used. An explicit configuration enabled the bundled default rules.
- The Windows release archive was downloaded from the official [Gitleaks release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) and checked against its published SHA-256 checksum: `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`.

This scan covers the reachable history of this extracted repository at that commit. It does not cover the original source archive, other repositories, deleted remote history, or future commits. Pattern-based scanning cannot establish that all possible secrets are absent.

## Evidence limits and pending checks

- This is a summary of supplied terminal output. Raw transcripts, the tested Git commit and Node.js/npm versions were not archived with this record.
- The five-command results above came from local runs. The separate successful GitHub Actions run covers `npm test` only.
- The demo uses synthetic events; it does not exercise live workers, models or an operational router.
- The JSON-file CLI was not separately executed in this verification sequence.
- The history scan above reported no findings within its stated scope; test results alone do not establish that the repository history is secret-free.

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
