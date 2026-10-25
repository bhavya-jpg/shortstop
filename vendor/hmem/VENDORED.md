# Vendored: Meterless H-MEM reference implementation

| Field | Value |
|---|---|
| Upstream | https://github.com/Meterless/Meterless |
| Path | `engines/hmem/reference`, `engines/hmem/conformance` |
| Commit | `1742dec56a66e58eef9dda2d2b865823758ca8cd` (2026-10-19) |
| License | Apache License 2.0 (see `LICENSE` in this folder) |
| Copyright | Copyright 2026 Meterless (as stated in the upstream `LICENSE`) |
| NOTICE file | None upstream at this commit, so none is carried |
| Modifications | None. Files are byte-identical to upstream |

## What was copied

- `reference/src/*.ts`: the H-MEM reference engine. **Unmodified.**
- `reference/test/smoke.test.ts`: the upstream unit tests. **Unmodified.**
- `conformance/runner.ts`, `conformance/vectors/`: the upstream conformance suite. **Unmodified.**
- `AGENTS.md`, `conflict-resolution.md`: the spec, kept so the contract travels with the code.

The folder layout matches upstream, so the conformance runner's default path
(`../reference/src/index.ts`) resolves to this copy.

## How ShortStop uses it

ShortStop does not change engine behavior. `src/memory/precedents.ts` wraps the
public `HMEM` API (`add`, `query`, `feedback`, `store`, `ledger`, `conflicts`)
to store pharmacy-shortage precedents. Any ShortStop-specific logic lives in that
adapter, not in this folder.

## Re-verify

```bash
npm run test:hmem:conformance   # upstream conformance suite against this copy
npm test                        # includes reference/test/smoke.test.ts
```
