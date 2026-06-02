# `server/nodes/` — one file per node

Each file here is ONE node in the live pipeline. A node does one job, reads its
own ledger to avoid repeats, and is wired together by `server/pipeline.mjs`.

**Every node uses the same brain:** `gemini-3.1-flash-lite` at thinking level
`medium` — defined once in [`../shared/ai.mjs`](../shared/ai.mjs). A node never
re-implements how to call the model; it just calls `runAgent(...)`.

## The v1 chain (active)

| File | Node | Job |
|---|---|---|
| `stabilizer-gate.mjs` | Stabilizer Gate | Decide when the debate has really started. Opens once, never closes again — instead TAGS junk (ads / intro / moderator / off-topic) so downstream nodes skip it. |
| `side-builder.mjs` | Side Builder | Sort speakers into Blue / Red and build each side's thesis (thesis lives here — there is no separate Thesis node). |
| `debate-point-builder.mjs` | Debate Point Builder | Pull out the genuinely good arguments, avoiding repeats. |
| `claim-builder.mjs` | Claim Builder | Pull out externally checkable factual claims. **Branches off Side Builder dialogue**, 30-sec packets. |
| `inconsistency-builder.mjs` | Inconsistency Builder | Catch hypocrisy / double standards. **Branches off Side Builder dialogue + ledger**, 30-sec packets. |
| `fact-queue.mjs` | Fact Queue | Line checkable claims up one at a time. |
| `fact-checker.mjs` | Fact Checker | Check each claim (Firecrawl → Gemini grounding fallback). Tag: verified / contradicted / no-source. |

## Parked (in `_parked/`, not wired in v1)

Clash Finder, Key Moments, Scoring, Report. Code kept; wired back later.

## The shape of a node

Every node file exports one main function and keeps its prompt + thinking config
at the top, so its "intelligence" is easy to find and tune:

```
runX({ ...inputs, trace }) -> parsed result
```

State-mutation (applying results to the debate state) is NOT the node's job —
that lives in the pipeline/state layer, so a node stays a pure brain.
