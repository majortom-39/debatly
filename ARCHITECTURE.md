# Debately — Architecture & Node Map

> Living document. This is the **target architecture** (what we are building toward) plus a
> **map of the current code** showing what we KEEP, DROP, or PARK. Written in plain language.

---

## 1. The target pipeline (your vision, locked in)

Audio comes in, gets transcribed + diarized, then flows through a chain of nodes. Each node
does ONE job and writes to its OWN ledger (a running notebook it reads back to avoid repeats).

```
 Live audio
    │
    ▼
[1] Speechmatics  ── transcription + diarization (DONE, tuned, do not touch)
    │   raw diarized turns
    ▼
[2] Stabilizer Gate ── "has the debate really started?"
    │   • opens ONCE when it sees a stabilized speaker + real back-and-forth
    │   • after opening it NEVER closes again
    │   • instead it TAGS junk (ads / intro / moderator / off-topic) so
    │     downstream nodes can skip it    ← NEW behavior to build
    │   writes → Stabilized Gate Ledger (transcript + junk tags)
    │   passes diarized transcript forward in 30-sec packets
    ▼
[3] Side Builder ── assigns speakers to Blue / Red, builds each side's thesis
    │   (thesis lives HERE now — no separate Thesis node)
    │   writes → Side Builder Ledger (full diarized transcript + side map + thesis)
    │
    ├──────────────┬──────────────┐
    ▼              ▼              ▼
[4] Debate Point  [5] Claim     [6] Inconsistency
    Builder           Builder        Builder
    (30s packets      (30s packets   (30s packets
     + own ledger)     + own ledger)  + own ledger + can
    │                  │              read Side Builder ledger)
    │                  ▼
    │             [7] Fact Queue ── lines claims up one by one
    │                  ▼
    │             [8] Fact Checker ── Firecrawl, Gemini grounding fallback
    │                  tags each: verified / contradicted / no-source
    ▼
 (later) Clash Builder, Key Moments, Scoring, Report
```

**Key rule:** Claim Builder and Inconsistency Builder branch off the **Side Builder** output
(the side-sorted dialogue), NOT off the Debate Point Builder. Each reads the **30-sec packets**.

---

## 2. Node map of the CURRENT code (`server/index.mjs`, ~12,800 lines)

Legend: ✅ KEEP (reuse the brain) · ❌ DROP (delete) · ⏸ PARK (keep aside, wire later) · 🔧 KEEP-BUT-CHANGE

| # | Node / area | Main functions today | Status | Notes |
|---|---|---|---|---|
| — | Speechmatics live STT | `speechmatics-live-stt-node.mjs`, packaging code in index | ✅ KEEP | Tuned & working. Don't touch. |
| — | Reporter (intake of raw turns) | `recordLiveFinalTurn`, `takeLivePendingBatch`, `recordLiveAnalysisBatch` | ✅ KEEP | The front door for raw diarized turns. |
| — | Cleaner → Transcript Store | `runTranscriptStitcher`, `buildCleanUtterances`, `mergeCleanUtterances` | ❌ DROP | Old node. You said ignore the clean-transcript ledger. |
| 2 | Stabilizer Gate | `maybeTraceLiveGateOpen`, `liveAnalysisCadence`, `buildDialogueWindows`, ready-window logic | 🔧 KEEP-BUT-CHANGE | Opening logic stays. **Add junk-tagging + a real Stabilized Gate Ledger.** Today the "ignore ads/moderator" rules are scattered into each agent prompt — pull them UP into the gate. |
| 3 | Side Builder | `runDirectSideBuilderAgent`, `buildDirectSideBuilderContext`, `applyDirectSideBuilderUpdate`, `applyDirectSideLabels`, `appendSideAssignmentAudit` | 🔧 KEEP-BUT-CHANGE | Reuse the brain. **Fold Thesis Builder's job into this node** (build each side's thesis here). |
| — | Thesis Builder | `runDirectThesisBuilderAgent`, `buildDirectThesisBuilderContext`, `applyDirectThesisBuilderUpdate`, `normalizeThesisUpdateLedger`, all `thesis*` helpers | ❌ DROP | Wrapped into Side Builder. Remove the standalone node. |
| 4 | Debate Point Builder | `runDirectDebatePointBuilderAgent`, `buildLiveDebatePointPacket`, `applyDirectDebatePointBuilderUpdate`, `mergeDebatePointLedger`, `normalizeDebatePointLedger` | ✅ KEEP | Core node, ledger logic is good. Confirm it reads Side Builder output in 30-sec packets. |
| 5 | Claim Builder | `runDirectClaimBuilderAgent`, `buildDirectClaimBuilderContext`, `applyDirectClaimBuilderUpdate` | 🔧 KEEP-BUT-CHANGE | **Re-branch: read Side Builder dialogue, not debate points.** Switch 60s → 30s packets. |
| 6 | Clash Finder | `runDirectClashFinderAgent`, `buildDirectClashFinderContext`, `applyDirectClashFinderUpdate`, `findSimilarDirectClash` | ⏸ PARK | Not in v1 wiring. Keep the code, wire it back later. |
| 7 | Inconsistency Builder | `runDirectInconsistencyFinderAgent`, `buildDirectInconsistencyContext`, `applyDirectInconsistencyFinderUpdate`, `buildConsistencyConflictReceipts` | 🔧 KEEP-BUT-CHANGE | **Re-branch: read Side Builder dialogue + Side Builder ledger, not debate points.** Switch to 30s packets. |
| 8 | Fact Queue + Fact Checker | `verifyDebatePoints`, `queueLiveVerification`, `runLiveVerification`, `selectBalancedVerificationPoints`, `shouldQueueVerification`, `runFirecrawlSearchFactAudit`, `runGroundedFactAudit`, `buildVerificationContext`, `buildFirecrawlSearchQuery` | ✅ KEEP | Firecrawl→Gemini fallback + verified/contradicted/no-source tags already match your design. |
| 9 | Key Moments (deterministic) | `buildDirectLedgerKeyMoments`, `applyDirectKeyMomentsAndScore`, `keyMomentDelta` | ✅ KEEP | Rule-based, not an AI node. Discuss later. |
| 10 | Scoring (deterministic) | all `score*` functions, `appendScoreHistory`, `rescoreDebateState` | ✅ KEEP | Rule-based. Discuss later. |
| 11 | Report | `generateDebateReport`, `runDebateReportAgent`, `buildDeterministicDebateReport`, all `buildReport*` helpers | ✅ KEEP | End-of-debate summary. Discuss later. |
| — | Orchestrator | `runDirectLedgerLivePipeline` (the function that calls every node in order) | 🔧 KEEP-BUT-CHANGE | This is the "wiring" file. Rebuild it clean with the new branch order and no Thesis/Clash in v1. |
| — | Shared plumbing | `generateContentForAgent`, `parseJsonWithLocalRepair`, `createTrace`, `logDeterministicStep`, `normalizeClaimState`, `buildDirectArtifacts`, `buildDirectAnalysisState`, side/quote helpers | ✅ KEEP | Used by many nodes. Must travel with them. |
| — | Persistence (Supabase/Postgres) | `server/db.mjs`, `supabase/migrations/*` | ✅ KEEP | The live DB + ledger tables. |
| — | Old / alternate pipelines | `runLivePipeline`, `analyzeDebateTurn`, `runLiveAnalysis` legacy branches | ❌ DROP | Superseded by the direct-ledger pipeline. |

---

## 3. What actually changes vs. today (the short list)

1. **Gate gets smarter, not stricter** — after opening it tags junk instead of closing. New
   Stabilized Gate Ledger holds transcript + tags. Move the "ignore ads/moderator" rules out of
   the agent prompts and up into the gate.
2. **Claim Builder re-branches** off Side Builder dialogue (not debate points), 30-sec packets.
3. **Inconsistency Builder re-branches** off Side Builder dialogue + ledger, 30-sec packets.
4. **Thesis Builder is removed** — its job moves inside Side Builder.
5. **Clash Builder is parked** — code kept, wired back later.
6. **Cleaner / clean-transcript ledger dropped.**
7. **Packet size 60s → 30s** where it isn't already.

---

## 4. Cleanup status (Phase 1) — DONE

- ✅ Deleted ~370 MB of stale logs + `.bak` files (root logs, `logs/` benchmark dump, the 116 MB trace).
- ✅ `.gitignore` already covers `*.log` / `*.bak` (no change needed).

## 5. Model decision (locked)

- **Every node uses `gemini-3.1-flash-lite` at thinking level `medium`.**
- Defined once in `server/shared/ai.mjs` (`NODE_MODEL`, `NODE_THINKING_LEVEL`).
- A node may override `thinkingLevel` per call (e.g. "high" for a tricky node) without editing shared code, but the default for all is `medium`.
- Note: Gemini 3.x uses `thinkingLevel` (minimal | low | medium | high); the old `thinkingBudget` is 2.5-era only. Thinking cannot be fully turned off on flash-lite.

## 6. Build progress (Phase 3)

Foundation + nodes built **alongside** the old `index.mjs` (old code stays runnable until the new path is proven).

- ✅ `server/shared/ai.mjs` — the one place every node calls the model. Tested.
- ✅ `server/shared/trace.mjs` — flight recorder. Tested.
- ✅ `server/nodes/side-builder.mjs` — Side Builder (sides + positions; thesis emitted as extra output, no separate node). Tested live.
- ✅ `server/nodes/stabilizer-gate.mjs` — Stabilizer Gate. Tested live on the full 21-min Scenario 1 jubilee.
- ✅ `server/nodes/debate-point-builder.mjs` — Debate Point Builder. Tested live (29 real points from Scenario 1).
- ✅ `server/nodes/family-merger.mjs` — Family Merger (groups points into sticky themed envelopes). Tested.
- ✅ `server/nodes/claim-builder.mjs` — Claim Builder (branches off Side Builder; substance-focused, skips show-setup; frames its own searchQuery). Tested.
- ✅ `server/nodes/fact-checker.mjs` — Fact Checker, TWO-STAGE Firecrawl-first + Gemini grounding deep-check. Tested live.
- ✅ `server/nodes/inconsistency-builder.mjs` — Inconsistency Finder (reads point+claim ledgers; strict). Tested live.
- ✅ `server/pipeline.mjs` — the "clerk" wiring connecting the full chain below.
- ✅ `scripts/replay-pipeline.mjs` — replays cached Speechmatics output (free) through the chain.

## 🎉 v1 MVP BACKEND COMPLETE — full chain proven on Scenario 1

```
Speechmatics → Stabilizer Gate → Side Builder → ┬→ Debate Point Builder → Family Merger
   (cached)     (teaser-skip,      (sides +       ├→ Claim Builder → fact-check QUEUE → Fact Checker (2-stage)
                 backtrack, tag)    theses)        └→ Inconsistency Finder
```

### Fact Checker — Firecrawl vs Gemini grounding (tested head-to-head)
- Firecrawl: ~1–1.6s, clean displayable sources. Gemini grounding: ~4–5s, sources buried. → Firecrawl PRIMARY.
- TWO STAGES so "no clear source" is NEVER shown prematurely:
  - tag starts null; status `checking`.
  - Stage 1 (Firecrawl) settles most → verified | contradicted | misleading (FINAL).
  - Unsettled → status `deep_checking` (NO tag) → Stage 2 (Gemini grounding) → final tag (may be `no_clear_source`).
  - `no_clear_source` only ever appears as a FINAL state. Two queues: `factCheckQueue`, `deepCheckQueue`.
  - LIVE NOTE: in production, drain `deepCheckQueue` in the BACKGROUND so slow grounding doesn't block the UI.
- 4 tags: verified / contradicted / misleading / no_clear_source.
- VERDICT JUDGES SUBSTANCE, tolerant of minor drift (wrong outlet name, 1300 vs 1200, "doctors" vs
  "healthcare professionals" = still verified). "misleading" only for MATERIAL distortion. Batch size 3.

### Inconsistency Finder
- Reads debate-point + claim ledgers (NOT raw dialogue). Compares new vs accumulated history.
- type (= the card tag): self-contradiction | double-standard | hypocrisy.
- level (separate): speaker | side. Self-contradiction is speaker-level + same speaker ONLY;
  side-level needs two different speakers. Jubilee guard: different same-side people merely disagreeing
  is NOT an inconsistency. STRICT — rare by design (Scenario 1: flagged exactly 1 real one — Rudy's
  intent-vs-scale self-contradiction).

### Scoring Engine (deterministic — NOT AI) — `server/nodes/scoring-engine.mjs`
- A TRUTH & INTEGRITY score, not a volume score. Does NOT re-judge — just TALLIES the tags the
  other nodes produced. Transparent (every point traces to a card) + stable (same debate → same score).
- Both sides start at 0; can go negative. Recomputed EVERY packet → moves live.
- Points: verified +3 · contradicted −5 · misleading −2 · no_clear_source 0 · inconsistency −4 ·
  debate point +0.5 but CAPPED at 20% of the side's verified base (so volume can't beat truth).
- Per-side + per-speaker breakdown (a weak debater can go negative and drag their side — by design).
- `explainScore(side)` emits the human-readable math for the UI.
- Verified on Scenario 1: Red 30.6 (11 verified) vs Blue 18 (5 verified, Rudy −4 self-contradiction);
  Red's debate-point bonus only ~22% of total → score is truth-driven, not volume-driven. Score moved
  live and DROPPED on bad claims (correct). Speaker 9 went negative (hurt their own side).

### MVP COMPLETE: 3 tabs (Debate Points · Claims · Inconsistencies) + live transparent Blue/Red scorecards
### ⏭ Next options: wire to real UI + Supabase · bring back parked nodes (Clash, Key Moments, Report) · review

### Debate Point Builder + Family Merger (design + verified behavior)
- A good debate point = a STANCE + LOAD-BEARING + SELF-CONTAINED. Card is lean: point, speaker,
  type tag, quote, (opposing quote for rebuttal/hypothetical). NO redundant family/side label —
  the UI already groups by side, and families are envelopes that carry the title.
- Type tags: 🧱 foundation · 📊 evidence · ⚔️ rebuttal · 🎯 principle · 📜 precedent · 🔮 hypothetical.
  - Rebuttal ALWAYS carries the opposing quote it refutes (clerk drops a rebuttal without one).
  - Hypothetical carries the opposing quote ONLY if responding to a specific opposing line.
- OWNERSHIP: a speaker echoing/mocking the opponent's point is NOT credited that point — it becomes
  a rebuttal or is skipped. (Verified: Speaker 6 referencing Speaker 1's "human shields" line was
  logged as a rebuttal OF it, not as Speaker 6's own point.)
- DEDUP by meaning (clerk word-overlap ≥0.7 guard + model ledger dedup). STRENGTHEN existing card
  via updatesPointId instead of duplicating.
- Debate Point Builder runs EVERY open packet (≈1 min). Family Merger runs every 2nd open packet
  (`FAMILY_MERGER_EVERY_N_PACKETS = 2`, ≈2 min), PER SIDE.
- Families are STICKY: the clerk keeps the old familyId + title unless meaningfully different
  (word-overlap ≥0.5 → keep old title). New points float with familyId=null until the next merge.
- State holds `debatePoints[]` and `families: { blue, red }`. The replay script prints the per-packet
  point additions and a final "Debate Desk" grouped by side → family.

## 7. Live test result — Scenario 1 (21-min jubilee "Surrounded", Israel/Gaza)

One-time real Speechmatics pass cached to `.cache/scenario1-speechmatics.json` (398 diarized turns,
14 raw speaker labels). All later tests replay this cache for free. To re-run a Speechmatics pass:
start server with `REQUIRE_LIVE_AUTH=false`, then `node scripts/live-diarization-smoke.mjs`.

Packet design (the "heartbeat"):
- **30-second heartbeat** (`PACKET_SECONDS = 30`) — everything moves every 30s so the UI keeps
  updating; the user never waits a full minute for movement.
- **Stabilizer Gate reads 2 packets** (current + previous ≈ 60s window, `GATE_WINDOW_PACKETS = 2`)
  for its open/teaser decision — wider context where it matters.
- **Downstream nodes (Side Builder, etc.) read 1 packet** (the current 30s).
- Tradeoff: 30s vs 60s ≈ doubles model-call frequency (cost). Deliberate: responsiveness > cost,
  cheap on flash-lite.

Final verified behavior (replay 8, 30s heartbeat):
- Turns are stitched onto ONE continuous timeline first (the live STT clock resets to 0 a few times
  over a long recording — we detect the backward jump and add an offset, else packets get scrambled).
- Gate **stays shut** through the cold-open teaser montage + show intro (2 pre-debate packets ignored).
- Gate **opens at 2:00** on a real sustained argument — judged qualitatively ("holding the floor /
  developing a position"), NOT by counting sentences (brittle across formats).
- Gate **backtracks**: returns `realStartQuote`; the clerk rewinds to the true start (01:00) and
  replays kept pre-debate packets into Side Builder so the opening is not lost. Fuzzy word-overlap
  fallback if exact match misses.
- Gate **never closes**; tags junk (ad/promo/moderator/intro/off-topic) the whole way. Clerk drops
  any tag whose speaker is not actually in that packet.
- Side Builder kept the center speaker (Rudy = raw Speaker 11) consistent across the ENTIRE jubilee
  while challengers rotated in — the key consistency test. Final topic + both side theses accurate.

### Gate guard rails (in `pipeline.mjs`, plain code — not the model)
- **Warm-up hold** (`GATE_WARMUP_HOLD_SECONDS = 60`): gate cannot latch open during the opening window.
- **Lookahead**: gate peeks at the next packet to catch teasers whose intro lands in the following packet.
- **Latch**: once open, always open — model can never re-close it.
