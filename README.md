# Evidence Router Core

A small extracted part of Thom's Evidence Router project: turn an event history into decisions about which work may run next.

**Status: packaged during APPLY; fresh execution is pending VERIFY.** The decision core and existing tests are copied byte-for-byte from the supplied project. The CLI and demo are new and not yet executed.

## Start here — Windows PowerShell

Open this folder in PowerShell. Node.js and npm are required; there are no third-party dependencies and no npm install step.

```powershell
npm run demo
```

Expected, not yet verified: three tables showing A eligible, then A succeeded while B remains blocked, then A accepted and B eligible. These are synthetic events, not real worker receipts.

To inspect your own single-objective event array:

```powershell
node cli.mjs events.json
```

The CLI prints a JSON projection. Inspect `invalidTransitions` and `definitionProblems`; producing a projection does not certify the event log as valid.

## What exists

- In-memory event replay, dependency decisions, acceptance policies and attempt limits.
- Existing 56 core test declarations, 12 regression test declarations and three probes.
- A console demo and JSON-file CLI.

## What remains outside this package

The live task router, worker dispatch, scheduler, GUI, durable orchestration storage and authenticated approvals. This core cannot execute your queued work. Authority strings are claims, not identity checks. Artifact digest contents are not verified against files. Route and write-scope declarations are not an execution sandbox.

## Verification stage — run only when approved

```powershell
npm test
npm run demo
npm run probe:transitions
npm run probe:authority
npm run probe:bindings
```

Capture actual output and exit codes. Test declarations are not passing results. Probe exit 3 means known-open findings and must not be relabelled PASS. No baseline verifier is needed for this extracted project.

## Put this small project in Git

After VERIFY, from this folder:

```powershell
git init -b main
git add README.md package.json .gitignore cli.mjs demo.mjs SOURCE-PROVENANCE.json .router/objectives prep/astra-review
git diff --cached --stat
git commit -m "Import evidence router decision core"
```

Then connect your chosen Git remote and push. No remote was created and nothing was published during packaging. Public reuse licensing has not been selected; no licence grant is invented here.

## One next milestone

Finish VERIFY for this extracted core and record the results. Then capture the current live router source separately if the goal is a complete operational router repository. Do not rebuild the runtime from historical baseline copies.

`SOURCE-PROVENANCE.json` identifies the supplied archive and unchanged extracted files. Historical paths mentioned in source comments may refer to audit documents retained in the original project, not this minimal package.
