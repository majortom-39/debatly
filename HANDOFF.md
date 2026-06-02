# debatly Handoff

Last updated: 2026-05-26.

## Root Location

Project root:

```text
C:\Majortom\Proojects\Debate
```

Run commands from this folder.

## What This Project Is

`debatly` is a React + Express live debate-analysis prototype. It records live debates, transcribes and diarizes audio through Speechmatics, analyzes the claim flow with a Vertex Gemini multi-agent pipeline, verifies factual claims with Firecrawl Search plus Gemini-lite, and persists projects/sessions/reports in Supabase/Postgres.

The app must stay topic-agnostic. Do not hardcode the Gaza/Ukraine sample, speaker names, or topic-specific shortcuts. It must support any debate topic, debate lengths up to roughly 1-2 hours, and up to 6 real speakers mapped into only two sides: Blue side and Red side.

Important invariant:

- Side language is used for analysis perspective: `Blue side`, `Red side`.
- Speaker labels are only for attribution: `Speaker 1`, `Speaker 2`, or user-edited speaker display names.
- All visible quotes should be italic.
- AssemblyAI has been removed from active flow.

## Latest Active Handoff - 2026-05-26

Read this section first. It supersedes the older 2026-05-25 and 2026-05-22 notes below where they conflict.

### Current Live Architecture Running In The App

The live app is now on the TEST 4 direct-ledger architecture, schema version `6`, architecture string `direct_debate_desk_v2`.

Current live flow:

```text
Browser mic / media audio
-> backend /live WebSocket
-> Speechmatics realtime diarization
-> Speechmatics final-turn packaging
-> Cleaner
-> TranscriptStore
-> Stabilizer Gate
-> Side Builder
-> Debate Point Builder
-> Thesis Builder
-> Claim Builder
-> Fact Checker
-> Clash Finder
-> Inconsistency Finder
-> deterministic Key Moments + Score
-> Debate Desk + Final Report
-> Supabase/Postgres direct-ledger tables
```

Important shape:

- `Speechmatics -> Cleaner -> Stabilizer Gate -> Side Builder` remains the universal front half.
- `Debate Point Builder` is now the shared post-Side-Builder ledger. It creates side-owned debate points, not fact-check cards.
- `Thesis Builder` updates the Blue side / Red side thesis cards and the featured quote strip from new Debate Points.
- `Claim Builder` reads Debate Points and should only create externally source-checkable factual claims.
- The fact-check queue is internal job state only, not a public tab.
- `Clash Finder` reads Debate Points and finds direct Blue side vs Red side disagreements.
- `Inconsistency Finder` reads Debate Points and finds confirmed important inconsistencies.
- `Key Moments + Score` is deterministic. Score changes only from Key Moments at `+10` or `-10`.
- The visible Debate Desk tabs are currently `Debate Points`, `Claims`, `Clashes`, and `Key Moments`.
- Sources is still internal only; there is no public Sources tab.
- Family Merger, Move Extractor, old canonical artifact generation, Frame Keeper, Issue Grouper, Pressure Point Agent, Evidence Checker, and Card Quality Gate must stay out of the active live path.

### Current Speechmatics State

The immediate live blocker is Speechmatics diarization reliability.

What happened:

- We tested several Speechmatics diarization settings using file streaming from `Samples\TEST 3\Scenario 1 audio.wav`.
- Based on that benchmark, `SPEECHMATICS_SPEAKER_SENSITIVITY` was temporarily added to the live app.
- The user tested live mic/browser usage and diarization became worse: multiple speakers were spoken, but the live transcript often had only one raw Speechmatics speaker.
- Latest live logs showed Speechmatics itself was returning mostly raw `S1` labels before Side Builder saw anything.
- The sensitivity override has now been removed from `.env` and `.env.example`.
- `server/config.mjs` now treats `SPEECHMATICS_SPEAKER_SENSITIVITY` as optional. If unset, the backend omits `speaker_sensitivity` completely.

Current intended live Speechmatics `StartRecognition` shape:

```text
audio_format:
  type: raw
  encoding: pcm_s16le
  sample_rate: 16000

transcription_config:
  language: en
  operating_point: enhanced
  diarization: speaker
  enable_partials: true
  max_delay: 1
  speaker_diarization_config:
    max_speakers: 10
  conversation_config:
    end_of_utterance_silence_trigger: 0.5
```

Do not send `speaker_sensitivity` unless the user explicitly asks for another controlled test.

Do not send `prefer_current_speaker` unless the user explicitly asks for another controlled test.

The stable API was restarted after restoring this config. At handoff time it was running via `npm run dev:api` on `http://127.0.0.1:8787`.

### Most Important Open Problem

The next session should start with Speechmatics live diarization, not Side Builder.

The latest symptom:

- In live app testing, multiple people spoke but raw Speechmatics labels collapsed to one speaker.
- Because raw speaker labels collapsed upstream, Side Builder and all later nodes received bad speaker identity input.
- Do not diagnose this as a Claim Builder, Side Builder, UI, or Debate Point Builder issue until raw Speechmatics labels are proven healthy again.

Required first checks:

1. Inspect `server-runtime.log` for latest `[speechmatics config]`, `[speechmatics packaging]`, `[speechmatics packaging stats]`, and `[live-session]` entries.
2. Inspect `logs/live-agentic-trace.jsonl` only after confirming raw Speechmatics labels are healthy.
3. Confirm the actual Speechmatics payload logged at session start contains only `max_speakers: 10` inside `speaker_diarization_config`.
4. Compare live browser `/live` audio behavior against the file-stream benchmark carefully. The file benchmark is not enough proof for the browser/live path.

Do not spend more Speechmatics credits unless the user asks.

### Right Files To Open First

Core handoff and notes:

- `HANDOFF.md`
- `NEXT_CHAT_PROMPT.md`
- `DEBATE_DESK_ARTIFACT_NOTES.md`

Run scripts:

- `package.json`
  - `npm run dev:api` is the stable backend command.
  - Do not use `npm run dev:api:watch` during recording.

Backend live/STT:

- `server/config.mjs`
  - Speechmatics, Vertex, Firecrawl config.
- `server/index.mjs`
  - `/live` WebSocket starts around the live WebSocket section.
  - Speechmatics `StartRecognition` is built near the `speechmaticsSpeakerDiarizationConfig` block.
  - Raw Speechmatics packaging and stats logs are in this file.
  - `DIRECT_ANALYSIS_SCHEMA_VERSION = 6`.
  - `DIRECT_ANALYSIS_ARCHITECTURE = "direct_debate_desk_v2"`.
  - `runDirectLedgerLivePipeline` is the active pipeline.
- `server/debate-point-builder.mjs`
  - The standalone Debate Point Builder node.
- `server/db.mjs`
  - Direct-ledger persistence and direct table loading.

Frontend:

- `src/App.tsx`
  - `/live` WebSocket creation is in `beginLive`.
  - Debate Desk tabs are `Debate Points`, `Claims`, `Clashes`, `Key Moments`.
  - Direct analysis v6 is preferred over legacy artifacts.
- `src/types.ts`
  - Direct analysis state types.
- `src/styles.css`
  - Debate Desk and card styling.

Database/migrations:

- `supabase/migrations/202605220001_direct_debate_desk_schema.sql`
- `supabase/migrations/202605220002_direct_debate_desk_v2.sql`
- `supabase/migrations/202605220003_direct_clash_plain_verdicts.sql`
- `supabase/migrations/202605220004_remove_legacy_artifact_table.sql`
- `supabase/migrations/202605230001_claim_card_rename.sql`
- `supabase/migrations/202605230002_claim_json_keys.sql`
- `supabase/migrations/202605240001_debate_point_provenance.sql`

Benchmarks and samples:

- `Samples\TEST 3\Scenario 1 audio.wav`
- `Samples\TEST 3\Scenario 1 transcript.docx`
- `.benchmarks\speechmatics-diarization-test3\run-scenario1-sensitivity-matrix.mjs`
- `.benchmarks\speechmatics-scenario1-sensitivity-20260525-232515`

Logs:

- `server-runtime.log`
- `logs/live-agentic-trace.jsonl`
- `dev-api-stdout.log`
- `dev-api-stderr.log`

### Current Node Contracts

Debate Point Builder:

- Input: side-built transcript packets, side context, speaker map, full compact Debate Point ledger.
- Output: side-owned debate points only.
- Must skip moderators, ads, sponsor reads, greetings, filler, unclear fragments, and non-side-owned statements.
- Must include every distinct load-bearing debate point in dense openings.
- Does not require source-checkability.

Thesis Builder:

- Input: latest Debate Points plus thesis/quote history.
- Output: short current Blue side and Red side thesis/topic plus one clean featured quote.
- It may smooth quote boundary roughness only, without changing meaning.

Claim Builder:

- Input: Debate Points.
- Output: only source-checkable factual Claim cards.
- One Claim card creates one internal fact-check job.
- User-visible fact statuses: `checking`, `verified`, `contradicted`, `no clear source`, `cannot verify`.

Fact Checker:

- Internal source-check job runner.
- Firecrawl is primary. Gemini grounding is fallback only when Firecrawl is unavailable/exhausted.
- Final source statuses are locked.

Clash Finder:

- Input: Debate Points and existing Clash ledger.
- Output: direct Blue side vs Red side disagreements on the same specific proposition.
- Plain verdict labels: `Blue side answered better`, `Red side answered better`, `No clear edge`.

Inconsistency Finder:

- Input: Debate Points and existing Inconsistency ledger.
- Output: confirmed important speaker-level or side-level inconsistencies with two quotes and timestamps.
- No public Inconsistency tab; important accepted inconsistencies become Key Moments.

Key Moments + Score:

- Deterministic from final fact-check outcomes, resolved clash outcomes, and confirmed inconsistencies.
- `+10` or `-10` per Key Moment.

### Hard Preferences / Constraints

- Be concise and direct.
- Do not inspect/check the browser yourself.
- Do not run broad test suites unless asked.
- Use cached Speechmatics outputs for benchmark loops unless testing Speechmatics itself.
- Use stable `npm run dev:api` for live backend tests; do not use `npm run dev:api:watch` during recording.
- Do not hardcode speaker names, topics, samples, Gaza/Ukraine logic, or debate-specific shortcuts.
- Visible text must say `Blue side` / `Red side`, never `Side A` / `Side B`.
- Before backend/agent changes inspect `server-runtime.log` and `logs/live-agentic-trace.jsonl`.
- Ignore old/live-app/canonical nodes unless the user explicitly reintroduces them.

## Historical Handoff - 2026-05-25

Active production/live path is TEST 4 direct-ledger only. Keep using the same
front half through Side Builder, then route through Debate Point Builder,
Thesis Builder, Claim Builder, Clash Finder, Inconsistency Finder, Key Moments,
Score, and Debate Desk/Report.

Latest live configuration:

- `analysis_schema_version` is `6`.
- `analysis.architecture` is `direct_debate_desk_v2`.
- `livePipeline` is `direct-ledger`.
- Live fast model is locked to `gemini-3.1-flash-lite`.
- `GOOGLE_CLOUD_LOCATION` must be `global`; this model 404s from `us-central1`.
- Do not reintroduce Family Merger, old canonical/judge agents, or legacy UI
  artifact projection.

Latest verification on 2026-05-25:

- Restarted stable `npm run dev:api` after the global location/model change.
- `/api/config` returned `location:"global"` and
  `vertexFastModel:"gemini-3.1-flash-lite"`.
- Ran cached TEST 4 scenario 3 and 4 replays through the live
  `/api/analyze-batch` API with fact-check search disabled.
- Latest artifact folder:
  `.benchmarks\test4-live-api-s3s4-moderatorfix-gemini-3.1-flash-lite-20260525-015452`
- Scenario 3 final counts: 60 Debate Points, 16 Claims, 6 Clashes,
  0 Inconsistencies, 0 Key Moments. Speaker 1 moderator/context speech is no
  longer assigned to a side; only Speaker 3 is Blue side and Speaker 2 is Red side.
- Scenario 4 final counts: 71 Debate Points, 5 Claims, 5 Clashes,
  0 Inconsistencies, 2 Key Moments.
- Latest trace window had 0 old-node hits, 0 node errors, and all LLM calls used
  `gemini-3.1-flash-lite`.

Latest live fix on 2026-05-25:

- User-reported abortion live run showed no `Speaker 3` in the transcript or
  traces. DB `transcript_turns` for session
  `f0de7c2f-6474-47c2-a056-f214fc935d46` only contained `Speaker 1` and
  `Speaker 2`, so the two-person Red side was collapsed upstream by
  Speechmatics/raw diarization before Side Builder.
- Root config bug found: `.env` had `SPEECHMATICS_PREFER_CURRENT_SPEAKER=false`,
  but backend only sent `prefer_current_speaker` when true. `false` is now sent
  explicitly in `speaker_diarization_config`.
- The same run also exposed a DB migration gap:
  `source_debate_point_id` and `claim_point_id` were missing from
  `debate_claim_cards` / `debate_fact_checks`, causing direct claim/fact-check
  persistence failures. Ran `npm run db:migrate`; migration
  `202605240001_debate_point_provenance.sql` is now applied.
- Restarted stable `npm run dev:api` on port `8787`; `/api/config` is healthy.
- UI now exposes `Debate Points` as the first Debate Desk tab, populated from
  `analysis.internal.debatePoints` with `debate.points` as fallback. Public
  tabs are now `Debate Points`, `Claims`, `Clashes`, and `Key Moments`.
- Side Builder now receives a fuller compact Stabilizer context: full compact
  speaker history, the compact Stabilizer window ledger including held/context
  windows, and expanded speaker-side memory. The frontend types/UI now preserve
  held context windows and show a compact transcript notice when Stabilizer holds
  an ad/sponsor/context segment out of debate analysis.

Important quality note:

- The moderator false-assignment bug was caused by deterministic opposite-side
  assignment using exchange adjacency even when the speaker's own words were
  floor-management. The fix requires the speaker's own direct stance/challenge
  text and expands the moderator/procedural guard.
- Scenario 4 is a multi-speaker/moving-position format; side mapping is more
  lopsided than a clean two-speaker debate, so continue to audit side assignment
  on similar panel formats.

## Previous Active Handoff - 2026-05-22

Current work has moved to the TEST 4 direct-ledger architecture and live app wiring.

Keep the universal live front half:

```text
Speechmatics realtime diarization
-> Cleaner
-> Stabilizer Gate
-> Side Builder
```

After Side Builder, the active live surface is:

```text
Debate Point Builder
-> Thesis Builder

Claim Builder
-> Fact Check Queue / Fact Checker

Clash Finder
Inconsistency Finder

Key Moments
-> Score
-> Debate Desk / Report
```

Key decisions now locked:

- Family Merger is removed from the active TEST 4/live UI path.
- Debate Point Builder is the shared post-Side-Builder ledger for side-owned debate points.
- Thesis Builder runs from each new Debate Point batch and updates the current Blue side / Red side thesis plus the featured quote strip.
- Debate Desk has exactly three tabs: `Claims`, `Clashes`, `Key Moments`.
- Claims contains only source-checkable factual claim cards.
- Fact-check statuses shown to users are only: `checking`, `verified`, `contradicted`, `no clear source`, `cannot verify`.
- Sources is not a separate tab; source evidence lives inside the Claim card.
- Clashes are paired Blue side / Red side cards shown adjacent to each other.
- Inconsistencies are not their own tab; accepted inconsistencies become negative Key Moments.
- Score is based only on Key Moments: each positive Key Moment is `+10`; each costly Key Moment is `-10`.
- The score timeline is time on the x-axis, score on the y-axis, with Key Moment dots.

Live app wiring progress on 2026-05-22:

- Active live analysis now enters `runDirectLedgerLivePipeline`; `/api/analyze-*`,
  `/api/verify-points`, final settle, deterministic report, report context, and
  score timeline no longer call the old canonical/judge path.
- `analysis_schema_version` is now `6`, with architecture
  `direct_debate_desk_v2`.
- Live trace entries include debate-time fields (`debateStartSec`,
  `debateEndSec`, `debateMinute`), packet range, node/stage, counts, and
  decision reason.
- Side Builder writes side-assignment audit events with speaker, side, quote,
  reason, confidence, and debate time.
- Debate Point Builder feeds the downstream TEST 4 nodes through a compact direct ledger.
- Thesis Builder is implemented in `server/index.mjs`. It consumes the new Debate Point batch,
  full compact Debate Point ledger, past thesis/quote ledger, and current batch transcript.
  It writes `analysis.internal.thesisUpdates`, updates `sides[].confirmedThesis`, and updates
  `featuredQuote` for the existing top quote UI.
- A side-thesis projection bug was fixed: `dedupeSideThesisLabels()` returns a sides array,
  so callers must not read `.sides` from its return value.
- Claim Builder output is filtered to standalone externally source-checkable
  factual claims; each valid claim card creates one internal fact-check row.
- Final source statuses remain only: `checking`, `verified`, `contradicted`,
  `no_clear_source`, `cannot_verify`.
- Clashes are direct Blue side vs Red side paired cards with plain verdict labels:
  `Blue side answered better`, `Red side answered better`, or `No clear edge`.
- Inconsistencies remain internal unless they become negative Key Moments.
- Key Moments and score are deterministic from final fact checks, resolved
  clashes, and confirmed inconsistencies only.
- `src/App.tsx` prefers direct `analysis` v6 over legacy canonical artifacts and
  renders exactly three tabs.
- The clash card left ribbon/sleeve styling was removed.
- Supabase/Postgres now has first-class TEST 4 direct-ledger tables:
  `debate_claim_cards`, `debate_fact_checks`, `debate_clash_cards`,
  `debate_inconsistency_cards`, `debate_key_moment_cards`, and
  `debate_score_events`.
- Direct rows are upserted with `is_active`/`archived_at` instead of
  delete-and-reinsert snapshots, so cards should not flash out of existence.
- `debate_side_assignment_events` stores the side-assignment audit trail.
- Project detail loads from active direct tables first when they are present.
- The old `debate_artifacts` ledger is compatibility only; direct tables plus
  direct v6 `analysis_state` are the new backend representation.
- `.env` Firecrawl key was updated for the current local run.

## TEST 4 Debate Point Architecture Update - 2026-05-24

Implemented in code on 2026-05-24; cached scenario replay is still pending by user request.

Implemented context strategy:

- Replace arbitrary recent-history limits such as last 36 / 60 / 90 / 120 items with full compact ledgers.
- A compact ledger item should include only the fields the node needs:
  point/card id, Blue side / Red side, speaker id, point/card text, type, issue/topic label, timestamp, and one short supporting quote.
- Do not send long reasons, raw trace metadata, UI metadata, update history, full transcript blocks, score data, or unrelated source-check data inside compact ledger items.
- The goal of the full compact ledger is not only duplicate prevention. It should also give each node the larger debate memory over time.

Implemented node context:

- Debate Point Builder should receive the current 2-packet side-built transcript, side context, speaker map, and the full compact Debate Point ledger.
- Claim Builder should receive new Debate Points, the full compact Claim ledger, and enough compact Debate Point context for grounding. It probably should not receive transcript windows if Debate Points already contain quote, speaker, side, and timestamp.
- Clash Finder should receive new Debate Points, the full compact Debate Point ledger, the full compact Clash ledger, speaker-side map for validation, and only a tiny recent transcript window when needed for direct exchange flow.
- Inconsistency Finder should receive new Debate Points, the full compact Debate Point ledger, the full compact Inconsistency ledger, and speaker-side map for validation. It probably should not receive transcript windows if Debate Points are clean.

Implemented system prompt changes:

- Debate Point Builder should be stricter about what counts as a debate point: it must be a speaker-owned debatable proposition for that side, not a random sentence, question, vibe, sincerity attack, repeated example, or broad moral/meta comment.
- Debate Point Builder should dedupe against the full compact Debate Point ledger and merge repeated issue restatements instead of creating near-duplicate points.
- Claim Builder should only create externally source-checkable factual claims from Debate Points.
- Claim Builder must reject hypotheticals, conditionals, opinions, predictions without a checkable source basis, moral judgments, vague summaries, definitions unless rewritten as a source-checkable fact, and any card that cannot become a clean search query.
- Claim Builder must preserve attribution exactly from the Debate Point and quote. It must not infer a person, office, organization, or source from nearby context.
- Claim Builder should not receive raw transcript windows unless a specific test proves Debate Points lack enough quote/speaker/side/timestamp context.
- Clash Finder should only create a clash when Blue side and Red side directly address the same specific proposition.
- Clash Finder should not use a broad opening thesis as the answer to every later specific allegation, should not create same-side clashes, and should dedupe repeated clashes around the same proposition.
- Clash Finder should use only plain visible outcomes: `Blue side answered better`, `Red side answered better`, or `No clear edge`.
- Inconsistency Finder should output speaker-level and side-level inconsistencies separately, each confirmed by two quotes with debate timestamps.
- Inconsistency Finder should not treat teammates adding detail or emphasis as an inconsistency unless the side clearly applies incompatible standards or contradicts a prior side-owned point.
- Fact Checker prompts should refer to Claim cards / fact-check jobs, not old `points` language.
- Final Report prompt should be simplified to the three-tab architecture: Claims, Clashes, Key Moments, plus score timeline. It should not reference old issue matrix, burden board, canonical reads, or legacy agent outputs.
- If Gemini 3.x models are used in these nodes, remove old numeric thinking-budget style config and use `thinking_level` defaults or explicit levels instead.

Implemented non-prompt architecture fixes:

- Preserve Debate Point provenance through Claim cards. Every Claim card created from a Debate Point must keep the original Debate Point id, speaker id, side, quote, and timestamp. Do not generate disconnected `pointId` values for Claim cards.
- Keep fact-check rows linked to the Claim card and original Debate Point, so a source result can always be traced back to the exact Debate Point quote.
- Stop moderator/floor-role speakers from becoming Blue side / Red side debaters. Side Builder should classify host/moderator/floor-management speech as context-only unless the speaker makes sustained side-owned debate points.
- Do not allow moderator questions to become Blue side or Red side positions in Clash cards.
- Debate Point Builder now rejects any point from a speaker that is not in the current Blue side / Red side speaker map.
- Full compact Debate Point, Claim, Clash, Inconsistency, and side-assignment ledgers are preserved without arbitrary last-N caps in the active direct-ledger path.
- Gemini 3.x generation config is normalized to avoid old sampling knobs and numeric thinking-budget style config.
- `debate_claim_cards` and `debate_fact_checks` now have first-class `source_debate_point_id` and `claim_point_id` provenance columns via migration `202605240001_debate_point_provenance.sql`.
- Add an audit check in cached/live replays: Claim `pointId` links must resolve to existing Debate Point ids, and moderator/context speakers must not appear as side-owned claim or clash speakers.

Open item to revisit:

- Decide whether the full compact ledgers are still fast enough for 1-2 hour debates. Use the simple full-compact-ledger approach first; only add retrieval/indexing later if latency or prompt size becomes a real bottleneck.

Validation completed:

```text
node --check server/index.mjs
node --check server/db.mjs
npm run check
npm run build
npm run db:migrate
local /api/analyze-batch smoke on PORT=8799 returned direct-ledger v6 with canonical null
```

Thesis Builder validation on 2026-05-25:

```text
node --check server/index.mjs
node --check .benchmarks/run-test4-thesis-only-all5.mjs
node --check .benchmarks/run-test4-thesis-from-debatepoints-all5.mjs
npm run check
```

Latest thesis replay output:

```text
.benchmarks\test4-thesis-from-debatepoints-all5-gemini-2.5-flash-lite-20260525-001129
```

Notes from the thesis replay:

- The node populated thesis updates for all 5 cached scenarios from cached Debate Point ledgers.
- Output quality was generally useful for the current-topic thesis strip.
- Thesis Builder quote handling was tightened on 2026-05-25: it may lightly smooth display quotes
  for repeated STT words, casing, punctuation, and sentence boundaries, but it must also keep
  `rawText` for audit and validation.
- The quote validator checks the raw quote against the current batch and rejects smoothed text that
  introduces new meaningful terms, numbers, names, source terms, or completed missing words.
- Focused replay used scenario 1 only:
  `.benchmarks\test4-thesis-smoothing-ellipsis-guard-scenario1-gemini-2.5-flash-lite-20260525-005049`.
  The repeated-word final quote improved while unsafe over-smoothing was blocked into blank quotes.
- The final side thesis is the latest current topic, not the whole-debate thesis.
- Live app fast model is now locked to `gemini-3.1-flash-lite` in `.env`,
  `.env.example`, and the server config fallback. Do not use
  `gemini-2.5-flash-lite` for the active live TEST 4 UI path.

Side-assignment fix on 2026-05-22:

- Root cause 1: the latest failing live trace still came from an older loaded process using the old canonical path (`Phase Classifier`, `Frame Keeper`, `Evidence Checker`), so the new direct Side Builder code was not actually running for that session.
- Root cause 2: in the clean direct path, an empty `floorState` object was treated as a real floor-classification gate, making every clean turn ineligible and causing Side Builder to skip.
- Root cause 3: fresh Side Builder assignments were still constrained by old point-owned assignment logic; a new speaker could be rejected unless they already had a scored point or assignment confidence above `0.90`.
- Root cause 4: the old first-speaker anchor could flip a valid Red side proposal to Blue side when a two-sided exchange was assigned in the same batch.
- Fix: empty floor state now behaves as no floor state; fresh Side Builder proposals can assign eligible speakers before claim cards exist; same-batch Blue/Red assignments no longer collapse Red to Blue; a deterministic adjacent-exchange rule assigns a new challenger to the opposite established side.
- Verification: focused `/api/analyze-batch` replay on the live API port `8787` assigned Speaker 1 to Blue side, Speaker 2 to Red side, and later Speaker 3 to Red side with the audit reason `Assigned to Red side because this speaker directly challenged an established Blue side speaker.`

## Previous Active Handoff - 2026-05-18

Current work is on the TEST 3 benchmark pipeline only. Older/live-app nodes such as Debate Shape Finder, Issue Grouper, Frame Keeper, Thesis Agent, CanonicalClaimGate, etc. are historical for this workstream and should be ignored unless explicitly reintroduced by the user.

Active test pipeline:

```text
Speechmatics realtime diarization
-> Cleaner
-> Stabilizer Gate
-> Side Builder
-> Move Extractor
-> Claim Builder
-> Family Merger
-> Fact Check Queue Builder
-> Fact Checker input
-> Fact Checker
```

Current packet contracts:

- One packet is always 15 seconds.
- Side Builder receives 2 packets, so 30 seconds.
- Move Extractor receives 4 packets, so 60 seconds, assembled from 2 Side Builder batches.
- Claim Builder receives 4 packets, so 60 seconds.
- Family Merger runs after each Claim Builder batch, using new cards plus existing family state.
- Fact Checker itself has not been run in the current benchmark loop.

Current ownership:

- Speechmatics owns realtime diarized transcript output.
- Cleaner owns cleaned transcript turns.
- Stabilizer Gate owns when debate analysis opens.
- Side Builder owns working topic, `Blue side` / `Red side`, and speaker-to-side mapping.
- Move Extractor owns hidden moves, move tags, and fact-check candidate marking.
- Claim Builder owns visible claim cards from source moves.
- Family Merger owns broad but coherent issue families.
- Fact Check Queue Builder should select factual claims from final families.
- Fact Checker input should format exact claim, quote, side, card, family, and source-move context.
- Fact Checker verifies queued claims.

Important current rule:

- Move Extractor is the primary/owning source for tags: `Claim`, `Evidence`, `Question`, `Concession`, `Challenge`, `Defense`.
- Claim Builder may carry/derive card type from source moves, but should not become an independent tag authority.
- Family Merger only aggregates metadata and preserves provenance.

Current user preferences:

- Be concise and direct.
- Do not inspect/check the browser.
- Do not run broad test suites unless asked.
- Use cached Speechmatics outputs for benchmark loops unless testing Speechmatics itself.
- Use stable `npm run dev:api` for live backend tests; do not use `npm run dev:api:watch` during recording.
- Do not hardcode speaker names, topics, samples, Gaza/Ukraine logic, or debate-specific shortcuts.
- Visible text must say `Blue side` / `Red side`, never `Side A` / `Side B`.
- Before backend/agent changes inspect `server-runtime.log` and `logs/live-agentic-trace.jsonl`.

Current optimized/tested node status:

| Node | Status |
| --- | --- |
| Speechmatics realtime diarization | Done / chosen for now |
| Cleaner | Done |
| Stabilizer Gate | Done |
| Side Builder | Done |
| Move Extractor | Done |
| Claim Builder | Done; minor card cleanup is reserved for later, not current work |
| Family Merger | Done / v12 audited |
| Fact Check Queue Builder | Next node to optimize/audit |
| Fact Checker input | Next node to audit |
| Fact Checker | Not run yet in this benchmark loop |

Latest completed Family Merger verification:

```text
.benchmarks\speechmatics-family-final-lock-v12-all5-20260517-151123
```

This v12 artifact used cached Speechmatics outputs, ran all five TEST 3 scenarios through Family Merger, stopped before Fact Checker execution, and passed `node --check server\speechmatics-opening-stabilizer-benchmark.mjs`.

Final v12 counts:

| Scenario | Cards | Families | Ratio | Audit verdict |
| --- | ---: | ---: | ---: | --- |
| 1 | 36 | 23 | 1.57 | Acceptable, conservative |
| 2 | 34 | 22 | 1.55 | Acceptable, weakest |
| 3 | 26 | 14 | 1.86 | Good |
| 4 | 36 | 24 | 1.50 | Good, cleanest |
| 5 | 23 | 15 | 1.53 | Good enough |

Full v12 audit summary:

- Overall score: about 7.3 / 10.
- Family Merger is safe enough to move on.
- No major catch-all family buckets were found.
- Remaining weakness is conservative over-splitting, especially Scenarios 1, 2, and 4.
- Remaining duplicate/weak-card examples should be reserved for later Claim Builder/card-output polish:
  - Scenario 1: duplicate/similar AI-targeting cards.
  - Scenario 2: one weak/misworded card around genocide criteria/expert consensus.
  - Scenario 3: one weak debate-question-like card.
  - Scenario 4: duplicate clothing-size cards.
  - Scenario 5: duplicate trade-deficit/trade-war cards.
- Do not add a new cleanup/filter node for this now.

Family Merger code changes currently in `server\speechmatics-opening-stabilizer-benchmark.mjs`:

- Final LLM consolidation rejects vague headers and side-thesis/catch-all headers.
- Final LLM consolidation allows over-split pressure only when family count is clearly too high.
- Final LLM consolidation uses temperature `0`.
- Final LLM consolidation allows only one source merge per target per pass.
- Final LLM-created family growth is capped at 6 cards.
- Generic labels such as `actions`, `conduct`, `claims`, `allegations`, `role`, and `policy` are not trusted as merge anchors.
- Meta-credibility / ideology attacks are kept separate from substantive policy-plan families unless the family is truly about that same issue.

Next recommended work:

1. Start with **Fact Check Queue Builder**.
2. Confirm it consumes final Family Merger output, not raw Claim Builder cards.
3. It should create queue items from surviving factual families using candidate source moves/cards.
4. It should not queue every card or every family.
5. It should dedupe repeated factual checks across families/cards.
6. Then audit **Fact Checker input** shape before running the actual Fact Checker.

Suggested command pattern for cached benchmark work:

```powershell
node --env-file=.env server\speechmatics-opening-stabilizer-benchmark.mjs --scenario=all --clip-seconds=1200 --packet-seconds=15 --side-builder-batch-packets=2 --side-builder-batches=all --move-extractor-batch-packets=4 --claim-builder-batch-packets=4 --reuse-speechmatics --llm-setup --llm-side-builder --llm-move-extractor --llm-claim-builder --out-dir=.benchmarks\<new-output-dir>
```

## Previous Active Handoff - 2026-05-16

Current work is on the TEST 3 benchmark pipeline and specifically the `ClaimFamilyMerger` quality.

The current discussed node structure is:

```text
Speechmatics realtime diarization
-> Cleaner
-> Stabilizer Gate
-> Side Builder
-> Move Extractor
-> Claim Builder
-> Family Merger
-> Fact Check Queue Builder
-> Fact Checker input
```

Current node contracts:

- One packet is always 15 seconds.
- Side Builder receives 2 packets, so 30 seconds.
- Move Extractor receives 4 packets, so 60 seconds, assembled from 2 Side Builder batches.
- Claim Builder receives 4 packets, so 60 seconds.
- Claim Builder creates visible claim cards only from genuinely new, speaker-owned debate moves.
- Claim Builder must use selected claim history so it does not keep duplicating the same claim.
- Family Merger should group claim cards into broad but coherent issue families.
- Family Merger may combine Blue side and Red side cards when they are debating the same issue, but it must preserve side-specific card ownership.
- Fact Check Queue Builder comes after Family Merger, so only surviving visible factual families are queued.
- Fact Checker itself is not run in this benchmark.

Current active file:

```text
server\speechmatics-opening-stabilizer-benchmark.mjs
```

User preferences for this work:

- Keep explanations concise and simple.
- Do not use browser inspection; ask the user to verify UI behavior.
- Do not run broad suites unless asked.
- Use cached Speechmatics outputs for these benchmark loops unless explicitly testing Speechmatics.
- Do not hardcode speakers, samples, topics, Gaza/Ukraine logic, or debate-specific shortcuts.
- Visible text must say `Blue side` / `Red side`, never `Side A` / `Side B`.

What has been optimized so far:

- Speechmatics config was benchmarked separately and recommended config is:
  - `operating_point=enhanced`
  - `diarization=speaker`
  - `enable_partials=true`
  - `max_speakers=10`
  - `max_delay=1`
  - `end_of_utterance_silence_trigger=0.5`
  - `speaker_sensitivity` unset/default
  - `prefer_current_speaker=false`
- Stabilizer Gate and Side Builder have already been tested across TEST 3 Scenarios 1-5 and generally match user-provided benchmark starts.
- Move Extractor was added as a hidden-move node.
- Fact-check eligibility is marked on moves/cards, but actual Fact Checker execution remains downstream and is not run in this benchmark.
- Claim Builder was tightened with selected claim history:
  - old card counts were roughly 80-136 cards per scenario;
  - tightened counts are roughly 22-36 cards per 20-minute scenario.
- Family Merger is the current active optimization target.

Family Merger goal:

- Families should be fewer than cards, but not catch-all buckets.
- Rough target shape is about one family per three claim cards, flexible, not a hard product rule.
- More important than the ratio: every family must have one clear issue header that honestly describes every card in it.
- Bad pattern to avoid: merging unrelated subtopics just because they share broad words like `civilian`, `impact`, `weight`, `economic`, or the same named entity.

Important completed benchmark artifacts:

```text
.benchmarks\speechmatics-family-tight-20min-5scenarios
.benchmarks\speechmatics-issue-family-tight-v5-20min-5scenarios
.benchmarks\speechmatics-issue-family-tight-v6-20min-5scenarios
.benchmarks\speechmatics-issue-family-tight-v7-20min-5scenarios
```

Family benchmark progression:

| Artifact | Status | Notes |
| --- | --- | --- |
| `speechmatics-family-tight-20min-5scenarios` | Complete | First tightened family pass. Still too many families: Scenario 1 `35/23`, Scenario 2 `32/21`, Scenario 3 `26/15`, Scenario 4 `31/20`, Scenario 5 `26/16`. |
| `speechmatics-issue-family-tight-v5-20min-5scenarios` | Complete | Hit the desired ratio: Scenario 1 `36/12`, Scenario 2 `34/12`, Scenario 3 `24/8`, Scenario 4 `35/12`, Scenario 5 `24/8`. But manual read showed some bad catch-all merges. |
| `speechmatics-issue-family-tight-v6-20min-5scenarios` | Complete | Fixed catch-all behavior but became too strict: Scenario 1 `36/20`, Scenario 2 `30/14`, Scenario 3 `23/9`, Scenario 4 `36/15`, Scenario 5 `25/17`. |
| `speechmatics-issue-family-tight-v7-20min-5scenarios` | Complete | Better balance but still had some broad deterministic merges: Scenario 1 `34/18`, Scenario 2 `33/15`, Scenario 3 `24/10`, Scenario 4 `35/12`, Scenario 5 `26/11`. |
| `speechmatics-issue-family-tight-v8-20min-5scenarios` | Interrupted / partial | Current code state. Completed scenarios 1-4 only: Scenario 1 `33/13`, Scenario 2 `30/13`, Scenario 3 `25/15`, Scenario 4 `34/15`. Scenario 5 was not run. `summary.json` only reflects the last completed per-scenario run and should not be trusted as all-scenario summary. |

Known family quality observations:

- v5 ratio was good but merged too broadly.
- v6 quality was safer but too many families, especially Scenario 5.
- v7 improved Scenario 5 but still had questionable broad merges:
  - Scenario 1: `Defining genocide` absorbed too much historical/displacement material.
  - Scenario 2: `Genocidal statements and plans` mixed rhetoric, civilian killing examples, human shields, and Hamas civilian targeting.
  - Scenario 4: some weight/body-image families were still broad but mostly understandable as clash families.
  - Scenario 5: `Economic impact of current policies` mixed inflation, immigration, and economic forecasts too broadly.
- Current v8 code changes were intended to address this by:
  - raising live deterministic merge thresholds;
  - not using quote text for family matching;
  - requiring stronger title/issue alignment;
  - making final LLM consolidation accept only single clear issue headers or clean `X vs Y` clash headers;
  - lowering max cards per merged family to avoid catch-all families;
  - fixing side preservation when merging family into family.

Current interrupted test handoff:

The v8 command loop was interrupted by the user after Scenario 4 completed and before Scenario 5 ran. No benchmark `node` process from this run is still active. One unrelated Node/Vite process was observed for `C:\Majortom\Proojects\ProductSense\apps\web`, not this repo.

Partial v8 artifact:

```text
.benchmarks\speechmatics-issue-family-tight-v8-20min-5scenarios
```

Partial v8 status:

| Scenario | Cards | Families | Status |
| --- | ---: | ---: | --- |
| 1 | 33 | 13 | done |
| 2 | 30 | 13 | done |
| 3 | 25 | 15 | done |
| 4 | 34 | 15 | done |
| 5 | n/a | n/a | not run |

Recommended next step:

1. Run Scenario 5 only with current v8 code and cached Speechmatics.
2. Then inspect all v8 family contents, especially Scenario 5.
3. If Scenario 5 still has too many tiny families, loosen only final LLM consolidation validation, not live deterministic same-side matching.
4. Do not add a new filter node; keep this as Family Merger prompt/rule tuning.

Command to resume v8 Scenario 5 only:

```powershell
node --env-file=.env server\speechmatics-opening-stabilizer-benchmark.mjs --scenario=scenario-5 --clip-seconds=1200 --packet-seconds=15 --side-builder-batch-packets=2 --side-builder-batches=all --move-extractor-batch-packets=4 --claim-builder-batch-packets=4 --reuse-speechmatics --llm-setup --llm-side-builder --llm-move-extractor --llm-claim-builder --out-dir=.benchmarks\speechmatics-issue-family-tight-v8-20min-5scenarios
```

Command to rerun all five with current code into a fresh artifact:

```powershell
$src = '.benchmarks\speechmatics-family-tight-20min-5scenarios'; $dst = '.benchmarks\speechmatics-issue-family-tight-v9-20min-5scenarios'; New-Item -ItemType Directory -Force -Path $dst | Out-Null; foreach ($s in 'scenario-1','scenario-2','scenario-3','scenario-4','scenario-5') { New-Item -ItemType Directory -Force -Path (Join-Path $dst $s) | Out-Null; Copy-Item -LiteralPath (Join-Path $src "$s\speechmatics-output.json") -Destination (Join-Path $dst "$s\speechmatics-output.json") -Force }; foreach ($s in 'scenario-1','scenario-2','scenario-3','scenario-4','scenario-5') { node --env-file=.env server\speechmatics-opening-stabilizer-benchmark.mjs --scenario=$s --clip-seconds=1200 --packet-seconds=15 --side-builder-batch-packets=2 --side-builder-batches=all --move-extractor-batch-packets=4 --claim-builder-batch-packets=4 --reuse-speechmatics --llm-setup --llm-side-builder --llm-move-extractor --llm-claim-builder --out-dir=$dst; if ($LASTEXITCODE -ne 0) { throw "benchmark failed for $s" } }
```

Quick artifact inspection command:

```powershell
@'
const fs = require('fs');
const path = require('path');
const out = '.benchmarks/speechmatics-issue-family-tight-v8-20min-5scenarios';
for (const id of ['scenario-1','scenario-2','scenario-3','scenario-4','scenario-5']) {
  const file = path.join(out, id, 'claim-report.json');
  if (!fs.existsSync(file)) { console.log(id, 'missing'); continue; }
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cards = (r.claimOutputs || []).reduce((n,o)=>n+(o.cards?.length||0),0);
  const fam = r.finalFamilies || [];
  console.log(`\n${id}: cards=${cards}, families=${fam.length}`);
  for (const f of fam) console.log(`- ${f.familyId} | ${(f.sides||[]).join(' + ') || f.side} | cards=${(f.cardIds||[]).length} | ${f.title}`);
}
'@ | node -
```

## Previous Active Handoff - 2026-05-15

Latest benchmark now reaches the Fact Checker input queue:

```text
Cleaner -> Stabilizer Gate -> Side Builder -> Move Extractor -> Claim Builder -> Family Merger -> Fact Check Queue Builder -> Fact Checker input
```

Latest artifact folder:

```text
.benchmarks\speechmatics-post-family-factcheck-20min-5scenarios
```

Latest command:

```text
node server\speechmatics-opening-stabilizer-benchmark.mjs --scenario=all --clip-seconds=1200 --packet-seconds=15 --side-builder-batch-packets=2 --side-builder-batches=all --move-extractor-batch-packets=4 --claim-builder-batch-packets=4 --reuse-speechmatics --llm-setup --llm-side-builder --llm-move-extractor --llm-claim-builder --out-dir=.benchmarks\speechmatics-post-family-factcheck-20min-5scenarios
```

Final Scenario 5 was rerun after the all-scenario pass because one late Side Builder batch hit a transient Vertex 429. Final artifacts are clean.

Current node contract:

- One packet is 15 seconds.
- Side Builder receives 2 packets, so 30 seconds.
- Move Extractor receives 4 packets, so 60 seconds, assembled from 2 Side Builder batches.
- Move Extractor creates hidden speaker-owned moves only: `Claim`, `Evidence`, `Question`, `Concession`, `Challenge`, `Defense`.
- Move Extractor only marks fact-check candidates with `factCheckCandidate`, `factCheckCandidateReason`, and `factCheckCandidateQuery`.
- Claim Builder treats hidden moves as primary input and every visible claim card has valid `sourceMoveIds`.
- Claim Builder carries `factCheckCandidate` metadata but does not build the real Fact Check Queue.
- When move input exists, Claim Builder skips cards that cannot be linked back to a hidden move.
- Family Merger preserves `sourceMoveIds`, `factCheckCandidateCardIds`, and `factCheckCandidateMoveIds`.
- Fact Check Queue Builder runs after Family Merger and creates one queue item per surviving factual family.
- Fact Checker itself is not run in this benchmark; no external source search or verification was performed.
- This is still a benchmark harness, not the production `/live` path.

Side Builder refinements added during this pass:

- If one side is already clear and the LLM drafts the missing side header/position plus meaningful evidence turns from a speaker but keeps that speaker `unclear`, the benchmark can promote that speaker to the missing side.
- The evidence-floor check now considers the drafted side header/position plus the evidence turns, not only the assignment reason. This keeps Scenario 4's Red side from drifting late when the LLM under-labels the first opposing speaker.
- A speaker should not be rejected as host/context just because their reason says they are answering a moderator's question. Actual moderator/host role language is still rejected.
- Mechanism-only or personal how-to comments cannot open the missing side unless they contain real counter-pressure. This keeps Scenario 4 from falsely opening Red at 1:38.
- If the missing Red side has substantive counter-pressure evidence such as external constraints, lack of access, poverty, medical, structural, systemic, or environmental limitations, the benchmark can promote that speaker. This restores Scenario 4's real Red start at 2:19.
- This rule is generic and must stay topic-agnostic; do not hardcode scenario, speaker, ad, topic, Gaza/Ukraine, or sample-specific shortcuts.

Latest 20-minute TEST 3 milestones and pipeline results:

| Scenario | Gate | Blue side | Red side | Moves | Move fact-check candidates | Cards | Families | Fact Check Queue | Fit |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1:30 | 1:23 | 1:45 | 152 | 65 | 130 | 113 | 58 | fits |
| 2 | 2:15 | 1:52 | 2:12 | 170 | 81 | 136 | 121 | 71 | fits |
| 3 | 4:15 | 3:57 | 10:02 | 91 | 56 | 84 | 73 | 50 | fits |
| 4 | 1:15 | 0:41 | 2:19 | 127 | 33 | 119 | 109 | 31 | fits |
| 5 | 7:00 | 6:47 | 8:47 | 82 | 51 | 80 | 68 | 45 | fits |

Verification passed for the post-family fact-check benchmark:

- `node --check server\speechmatics-opening-stabilizer-benchmark.mjs`
- all JSON artifacts parse cleanly
- JSONL counts match report objects for Side Builder, Move Extractor, Claim Builder, and Family Merger
- JSONL counts match the Fact Check Queue Builder report
- no Side Builder, Move Extractor, or Claim Builder LLM fallback/error batches in final artifacts
- all Claim Builder cards have valid `sourceMoveIds`
- all Fact Check Queue items link to valid families, representative cards, source cards, and source moves
- Move Extractor and Claim Builder windows are monotonic
- Scenario 4 ad/context window around 5:58-6:58 produced 0 hidden moves, 0 claim cards, and 0 Fact Check Queue items
- no broad npm suite was run

Previous 2026-05-14 Side Builder / Claim Builder benchmark context is below.

Speechmatics TEST 3 full-board benchmark was rerun through Cleaner -> Stabilizer Gate -> Side Builder for scenarios 1-5, first 20 minutes each, using saved Speechmatics realtime output and `server/speechmatics-opening-stabilizer-benchmark.mjs`.

Previous Side Builder artifact folder:

```text
.benchmarks\speechmatics-full-board-test3-20min-packet15-sidebuilder2-optimized2
```

Implemented benchmark refinements:

- Cleaner now carries Speechmatics word timings through cleaned turns, so Side Builder milestones can use real word-level start times instead of chunk interpolation.
- Side Builder treats loaded opening questions as possible first-side evidence when the question itself carries a position by contrasting standards/cases.
- If the first durable speaker is answering an explicit prompt, the side start is the answer start, not a later cue phrase inside the answer.
- Side Builder preserves anchored speaker-to-side assignments unless a later batch explicitly marks a correction.
- Side Builder can promote a drafted missing side when one side is clear and the missing side has substantive speaker-owned evidence.
- Side Builder rejects false early Red milestones from context/setup, question-only turns, clipped fragments, opponent summaries, compatible same-side mechanisms, and solution-only clarifications.

Previous 20-minute TEST 3 Side Builder milestones:

| Scenario | Gate detected / backfill | First side | Second side |
| --- | --- | --- | --- |
| 1 | 1:30 / 1:12 | 1:23 detected 1:42, Blue side: Israel is not committing apartheid or genocide, Speaker 1 | 1:45 detected 2:12, Red side: Israel's policies constitute genocide, Speaker 4 |
| 2 | 2:15 / 2:12 | 1:52 detected 2:42, Blue side: opening question challenges the distinction, Speaker 1 | 2:12 detected 2:42, Red side: Ukraine invasion is genocide, Speaker 2 |
| 3 | 4:15 / 3:57 | 3:57 detected 4:27, Blue side: Hamas's actions on October 7th, Speaker 3 | 10:02 detected 10:27, Red side: Israel's response not justified/proportional, Speaker 2 |
| 4 | 1:15 / 0:41 | 0:41 detected 1:11, Blue side: body weight as individual choice/willpower, Speaker 4/Speaker 5 | 2:19 detected 2:41, Red side: socioeconomic/environmental factors shape body weight, Speaker 6 |
| 5 | 7:00 / 6:47 | 6:47 detected 7:17, Blue side: plan for middle class and working people, Speaker 8 | 8:47 detected 8:47, Red side: tariffs/no sales tax response, Speaker 5 |

Notes:

- One packet means 15 seconds.
- Side Builder batch size is 2 packets, so 30 seconds.
- Claim Builder batch size is 4 packets, so 60 seconds. It runs after Side Builder and creates simple claim cards only; it does not build the thesis, score, fact-check, or merge.
- Family Merger runs after each Claim Builder batch and groups repeated/similar claim cards into durable debate-point families while preserving Blue side / Red side ownership.
- New benchmark artifacts are `claim-builder-output.jsonl`, `claim-family-output.jsonl`, and `claim-report.json`.
- Side Builder builds working topic, Blue/Red headers, and speaker map only. It is not the thesis builder.
- Scenario 4 ad/reserved-segment handling should still reject the BetterHelp-style ad window around 5:58-6:58.
- The benchmark script is still an architecture test harness, not the production `/live` pipeline.
- Previous verification was focused only: `node --check server\speechmatics-opening-stabilizer-benchmark.mjs` and cached 20-minute benchmark reruns. No broad npm suite was run for this harness-only work.

Previous Claim Builder / Family Merger smoke test:

```text
node server/speechmatics-opening-stabilizer-benchmark.mjs --scenario=scenario-2 --clip-seconds=300 --packet-seconds=15 --side-builder-batch-packets=2 --side-builder-batches=4 --claim-builder-batch-packets=4 --reuse-speechmatics --llm-setup --llm-side-builder --llm-claim-builder --out-dir=.benchmarks/speechmatics-claim-pipeline-smoke
```

Result: Scenario 2 produced 2 Claim Builder batches, 14 claim cards, and 11 durable families across Blue side / Red side. Artifact folder: `.benchmarks\speechmatics-claim-pipeline-smoke`.

Previous full Claim Builder / Family Merger benchmark:

```text
node server/speechmatics-opening-stabilizer-benchmark.mjs --scenario=all --clip-seconds=1200 --packet-seconds=15 --side-builder-batch-packets=2 --side-builder-batches=all --claim-builder-batch-packets=4 --reuse-speechmatics --llm-setup --llm-side-builder --llm-claim-builder --out-dir=.benchmarks/speechmatics-claim-pipeline-20min-5scenarios
```

This reused saved Speechmatics output from `.benchmarks\speechmatics-full-board-test3-20min-packet15-sidebuilder2-optimized2`; realtime diarization was not run. Artifact audit passed for all five scenarios: expected JSON/JSONL files exist, parse cleanly, JSONL counts match report objects, time windows are monotonic, and there were no Side Builder or Claim Builder LLM fallback/error batches.

| Scenario | Side history | Claim history | Cards | Families | Fit |
| --- | --- | --- | ---: | ---: | --- |
| 1 | 38 batches, 1:12-20:00 | 19 batches, 1:12-20:00 | 121 | 105 | fits |
| 2 | 36 batches, 2:12-20:00 | 18 batches, 2:12-20:00 | 117 | 103 | fits |
| 3 | 33 batches, 3:57-20:00 | 15 batches, 3:57-19:57 | 78 | 66 | fits |
| 4 | 39 batches, 0:41-20:00 | 20 batches, 0:41-20:00 | 106 | 100 | fits |
| 5 | 27 batches, 6:47-20:00 | 13 batches, 6:47-19:47 | 74 | 64 | fits |

Scenario 4 still rejects the ad/context segment at 5:58-6:56, and zero Claim Builder cards overlap that rejected segment.

## Previous Active Handoff - 2026-05-13

This is the current state after the latest long debugging/refactor pass. Older sections below are still useful, but this section should be read first.

### User Preferences

- Do not inspect/check the browser yourself. Ask the user to verify UI behavior.
- Do not run broad test suites unless the user asks. Focused checks are okay only when the user explicitly asks for verification.
- Before backend/agent changes, inspect `server-runtime.log` and `logs/live-agentic-trace.jsonl`.
- Use `npm run dev` or stable `npm run dev:api` for live tests. Do not use `npm run dev:api:watch` during recording because restarts can kill `/live`.

### Current Workflow Architecture

Universal packet language:

- One packet is always 15 seconds.
- Transcript Cleaner and Speaker Stabilizer work packet-by-packet.
- Side Builder receives a batch of 2 packets, so one Side Builder batch is 30 seconds.
- Side Builder builds only the working topic, `Blue side` / `Red side` headers, and speaker-to-side map. It is not the thesis builder.
- Side Builder milestone logging should mark:
  - gate opened,
  - first side built when a topic/header is recognized with at least one speaker,
  - second side built when the opposing topic/header is recognized with at least one speaker.

The active production path is the current three-layer workflow:

1. **Reporting / Transcript Layer**
   - Speechmatics realtime audio is bridged through backend `/live`.
   - Transcript cleaning/stitching builds durable transcript turns and dialogue windows.
   - This layer should not score, judge, or create UI issue semantics.

2. **Editor Layer**
   - Debate Shape Finder, Speaker Side Resolver, Claim Finder, Challenge Agent, Pressure Point Agent, Double Standard Finder, and Card Quality Gate create or refine canonical debate cards.
   - It should produce topic-agnostic, transcript-backed cards only.
   - It must not hardcode speaker names, topics, Gaza/Ukraine-specific rules, or sample-specific behavior.

3. **Judge Layer**
   - Evidence Checker, Issue Grouper, Frame Keeper, source scoring gate, and scorecard logic finalize durable cards, source trust, issue groups, side thesis labels, featured quote, and score events.
   - Scorecard and report timeline should be based on settled canonical state, not raw live/intermediate model output.

Internal code still uses `side-a` / `side-b` as stable IDs, but no AI/user-visible text should say Side A or Side B. UI and generated prose should display `Blue side` / `Red side`. Speaker labels should remain attribution-only and should dynamically reflect user-edited speaker display names.

### Recent Fixes Already Implemented

- **Early side-collapse / thesis-forming fix:** A live UI test around 10-12 minutes exposed a real backend failure: an unknown early debater could be pushed onto the Red side before the Blue side had any durable anchor, while Blue stayed at `Thesis forming` even though claim cards were already being created. The fix adds an early-side invariant in `server/index.mjs`: a first/only score-bearing debater cannot become Red by fallback or weak classifier hint. Red requires a proven Blue anchor plus opposing debater evidence. If a Red-only collapse is detected, speaker registry, floor state, canonical cards, score ownership, and side thesis state are repaired together.
- **Thesis fallback from accepted claims:** Side thesis display no longer depends only on a completed Frame Keeper pass. If accepted claim cards exist but a durable Frame Keeper thesis is not available yet, the backend derives a conservative proposition-shaped fallback label from accepted claim content so the side panel does not sit indefinitely on `Thesis forming`. Frame Keeper remains the long-term thesis owner.
- **Phase Classifier side hints are now soft:** Phase Classifier can still infer speaker role, phase, speech function, and side hints, but side hints are guarded by the side-anchor invariant. Unknown or early speakers should stay unknown/neutral/Blue-anchored until there is clear debater-role and opposition evidence. This is specifically meant to prevent the old "third speaker becomes Red by exchange position" failure.
- **Source scoring gate:** Source scoring now requires trusted external evidence, not just a raw `verified` status. The intended contract is: source retrieval may verify/challenge evidence, but only the canonical source scoring decision can make it score-bearing or promote an claim to source verified.
- **Thesis refresh:** The legacy Thesis Agent path should not be used. Frame Keeper is the single thesis updater. It has a strict thesis cadence, hard character limits, and rejects incomplete thesis labels instead of silently clipping visible thesis text.
- **Durable scorecard:** Scorecard should be recomputed from durable canonical state after judge-layer merge so Blue/Red score breakdowns do not flicker or disappear.
- **Speaker display names:** User-edited speaker names are persisted and merged into loaded debate state. Manual names are normalized to title/camel-style display. Generated prose in cards/report/chart tooltips should render through `SpeakerLinkedText` or equivalent dynamic normalization.
- **Side/Speaker prose normalization:** UI display normalization handles `Speaker 1`, `Speaker1`, `Speaker one`, `Side A`, `SideA`, `side_a`, and `side-a` style tokens in generated prose. These should display as the current speaker name or Blue/Red side.
- **Report settle/timeline:** Stop/report now drains final transcript chunks, runs the final current judge/editor pass, verifies remaining source checks, then builds the report. The report graph renders final endpoint dots without adding fake "final score" score events.
- **Debate desk UI:** Tag colors/icons were redesigned; impact tags use signal-bar icons; scroll fades were improved; sidebar project duration clock alignment/clickable area were tuned.

Focused checks that passed after the latest report/prose/timeline work:

```text
npm run check
npm run test:debate-report
npm run test:live-cadence
```

Focused checks that passed after the early side-collapse/thesis fix:

```text
node --check server\index.mjs
npm run check
deterministic /api/rescore-debate red-only collapse check
node server\floor-phase-benchmark.mjs "Samples\test 2\transcript.docx" 12 2 --chunk-minutes 4 --checkpoint-dir logs\phase-benchmark-sidefix-final
```

The deterministic API check intentionally fed a Red-only `Speaker 3` point/card/floor hint into `/api/rescore-debate`. The repaired result moved `Speaker 3`, the claim, score, and fallback thesis to Blue together. The 12-minute benchmark on `Samples\test 2` produced no critical side-collapse, no neutral-owned score-bearing cards, and stable non-truncated thesis history. In that transcript, Speaker 2 becomes Blue and Speaker 3 becomes Red by content after opposition evidence appears; do not treat speaker numbers as fixed side identities.

### Speechmatics Diarization Benchmark - TEST 3

The user asked for Speechmatics-only diarization tuning using:

```text
C:\Majortom\Proojects\Debate\Samples\TEST 3\Scenario 1 audio.wav
C:\Majortom\Proojects\Debate\Samples\TEST 3\Scenario 1 transcript.docx
```

Scope was strictly Speechmatics realtime diarization accuracy, not the debate-analysis pipeline, UI, report generation, or agent behavior.

The source audio is about 21 minutes, stereo 44.1 kHz, 16-bit WAV. For app-equivalent realtime testing, it was downmixed/resampled to:

```text
.benchmarks\speechmatics-diarization-test3\scenario1-16k-mono.wav
```

The truth DOCX is inline diarized text rather than timestamped turns. Parsed truth stats:

```text
175 turns
4,402 truth words
8 truth speakers
```

Realtime TEST 3 result with recommended default-style config:

```text
variant: max10-default
diarization=speaker
operating_point=enhanced
enable_partials=true
max_speakers=10
max_delay=1
end_of_utterance_silence_trigger=0.5
speaker_sensitivity unset/default
prefer_current_speaker=false

Word accuracy: 87.80%
Speaker accuracy on matched words: 95.28%
Combined diarized word accuracy: 87.05%
Predicted speakers: 10
Predicted speaker segments: 216
Unknown-speaker words: 0
Runtime: 24m14s for 21m00s audio, realtime factor 1.15x
```

Artifacts:

```text
.benchmarks\speechmatics-diarization-test3\realtime-max10-result.json
.benchmarks\speechmatics-diarization-test3\realtime-max10-segments.txt
```

Realtime TEST 3 result with tuned lower sensitivity and prefer-current:

```text
variant: max10-sens040-prefer
max_speakers=10
speaker_sensitivity=0.40
prefer_current_speaker=true

Word accuracy: 87.89%
Speaker accuracy on matched words: 90.45%
Combined diarized word accuracy: 82.62%
Predicted speakers: 7
Predicted speaker segments: 101
Unknown-speaker words: 0
Runtime: 22m49s for 21m00s audio, realtime factor 1.09x
```

Artifacts:

```text
.benchmarks\speechmatics-diarization-test3\realtime-max10-sens040-prefer-result.json
.benchmarks\speechmatics-diarization-test3\realtime-max10-sens040-prefer-segments.txt
```

Conclusion from TEST 3:

- Use `max_speakers=10` for dynamic debate coverage.
- Leave `speaker_sensitivity` unset/default for now.
- Leave `prefer_current_speaker=false` for now.
- Lower sensitivity plus `prefer_current_speaker=true` reduced duplicate speaker labels but merged real speakers too aggressively, which is worse for debate ownership.
- `max_speakers=10` means "allow up to 10", not "force 10"; it should still handle clean 2-person debates, while giving room for moderator plus multiple debaters.
- Speechmatics default with `max_speakers=10` showed strong speaker accuracy on matched words, but over-split some humans into multiple Speechmatics labels. The product-grade fix should be an app-level durable speaker alias/stability layer on top of Speechmatics, not aggressive Speechmatics sensitivity lowering.
- Keep raw Speechmatics labels/metadata for diagnostics, but do not immediately treat every new `S#` as a durable person or debate-side owner.

### Latest Live Failure Context - Side/Thesis

The user stopped a live UI debate test around 12 minutes because the app showed:

```text
Blue side: Thesis forming, score 0, awaiting assigned speakers
Red side: Thesis forming, score 42, Speaker 2 assigned
```

The user also observed a speaker they expected to be Blue being labeled Red. Relevant failed live session identifiers from traces:

```text
projectId: 2a25fadf-f0e5-4699-8614-16c0498a97ec
sessionId: d13fa598-bbf9-4205-8098-c0beb806398a
```

Trace finding: before the fix, `PhaseClassifier:classified` had `Speaker 1` as `neutral_speaker`, but `Speaker 2` and `Speaker 3` both received Red-side hints. The score/canonical path then allowed Red score-bearing content while Blue had no durable visible anchor. This was the bug; do not reframe it as a UI-only issue.

Expected post-fix behavior:

- A moderator/host/format speaker should become `NEUTRAL_SPEAKER` or remain context-only.
- The first real score-bearing debater should anchor Blue unless there is already proven Blue/Red opposition.
- Red assignment should require clear opposing debater evidence, not speaker order, exchange adjacency, or a weak Phase Classifier side hint.
- If claim cards exist for a side, that side should not remain stuck on `Thesis forming`; use a conservative fallback thesis until Frame Keeper improves it.
- Speaker chips, cards, score movement, floor state, and thesis ownership must move together if an early side repair occurs.

### Debate 27 DB Notes

Debate 27 is saved in the DB:

```text
projectId: 6fa328f8-3b3d-46d5-9a37-89cfee1e5b99
sessionId: 418948e1-7b08-4ead-91d9-e608648dcfe8
status: report_ready
```

Observed Debate 27 canonical issue groups:

- `Intent of Aggressors`: very large group, about 40 cards across claims, clashes, weak spots, sources, double standards, and turning point.
- `Gaza as Unusual Warfare Setting`: Red-side claim group.
- `Hamas Provocation and Shielding`: Red-side claim/source group.
- `Mistakes and Indefensible Acts in War`: Red-side claim/double-standard group.

Important architecture finding: the **Issue Grouper** backend node creates the issue groups in `server/index.mjs` (`applyCurrentIssueGrouping`). `reconcileCurrentLinkedIssueGroups` then propagates groups through linked claims, sources, clashes, weak spots, double standards, and turning points. The frontend `ArtifactColumns` renders the same `issueGroups` ledger in every tab.

Current product concern: issue grouping is probably too broad across every tab. Recommended next-step design is to keep backend issue groups internally for context/reporting, but show collapsible issue sections only in the **Claims** tab. Other tabs should likely render flat by side, sorted by recency/importance, with at most a small related-issue chip if needed. If grouping remains in Claims, consider an claim-only grouping surface so one broad issue like `Intent of Aggressors` does not swallow too many cards.

### Files Recently Touched

- `server/index.mjs`
  - Early side-anchor invariant, Red-only collapse repair, Phase Classifier side-hint guards, speaker registry repair, and fallback thesis derivation from accepted claims.
  - Source scoring gate and canonical source scoring decisions.
  - Frame Keeper thesis cadence and label validation.
  - Durable scorecard/report settle changes.
  - Generated report text cleanup and side-token normalization.
  - Issue Grouper remains the backend creator of issue groups.
- `src/App.tsx`
  - Speaker/side dynamic text normalization.
  - Debate desk tabs, cards, issue section rendering, tag/icon rendering.
  - Score timeline final endpoint dots.
- `src/styles.css`
  - Debate desk tag styles, scrollbar/fade styling, score endpoint node styling, sidebar timing alignment.
- `server/debate-report-smoke.mjs`
  - Report timeline endpoint assertions.
- `server/live-cadence-smoke.mjs`
  - Stop/report cadence and final current judge pass assertions.

### Watchouts

- Do not remove internal `side-a` / `side-b` IDs from data models; they are internal stable identifiers. Only prevent them from reaching visible copy.
- Do not hardcode Debate 27, Mehdi/Walsh, Gaza/Ukraine, or speaker names into logic.
- Do not trust speaker numbers as side identities. Diarization labels are arbitrary and may shift or merge. Side assignment must come from role/stance/ownership evidence.
- Current recommended Speechmatics realtime config from TEST 3: enhanced, speaker diarization, `max_speakers=10`, `max_delay=1`, `end_of_utterance_silence_trigger=0.5`, default speaker sensitivity, `prefer_current_speaker=false`.
- `max_speakers=10` should be paired with app-level speaker alias/stability repair because Speechmatics may over-split one human into multiple `S#` labels.
- Do not allow a first/only score-bearing debater to become Red through fallback. Red needs a Blue anchor and opposition evidence.
- Source cards can be display-worthy but not score-worthy. Keep display status separate from score eligibility.
- Report generation should happen only after user confirms Stop/report and remaining transcript analysis/source checks settle.
- If UI/live behavior seems unchanged after backend edits, restart stable `npm run dev:api` before judging the result.

## Current Architecture

- Frontend: React + Vite.
- Main UI: `src\App.tsx`.
- Styles: `src\styles.css`.
- Shared frontend/backend model types: `src\types.ts`.
- Supabase browser client: `src\supabaseClient.ts`.
- Backend: Express + WebSocket server in `server\index.mjs`.
- Backend auth helpers: `server\auth.mjs`.
- Database adapter: `server\db.mjs`.
- Database migrations: `supabase\migrations`.
- Browser audio worklet: `public\pcm-worklet.js`.
- STT/diarization: Speechmatics Realtime WebSocket, bridged server-side through `/live`.
- Debate intelligence: Vertex Gemini through Google Cloud Application Default Credentials.
- Source retrieval: Firecrawl `/search`, with Gemini-lite verdict pass.
- Persistence: Supabase/Postgres through server-side database functions.

## Critical Run Notes

- Use `npm run dev` or stable `npm run dev:api` for live recording tests.
- Do not use `npm run dev:api:watch` during recording. Node restarts can kill `/live` mid-session.
- `npm run dev:api` runs:

```text
node --env-file=.env server/index.mjs
```

- If live behavior looks stale, restart the stable API before testing. A stale Node process has repeatedly hidden backend fixes.
- Latest backend status: after the Debate 16 stale-session recovery fix, the stable API was restarted and `http://127.0.0.1:8787/api/config` returned `200`. The listener was process `node --env-file=.env server/index.mjs`.
- When Supabase auth and DB are configured, `/live` requires an authenticated browser session. CLI WAV smoke tests need `LIVE_TEST_ACCESS_TOKEN` unless a guarded local bypass is added.
- Do not print or commit `.env` secrets.
- The current folder is not a git repository in this environment, so `git diff/status` may not work.
- User instruction as of the latest session: do not open/check the browser yourself. Ask the user to verify UI behavior in `http://127.0.0.1:5173/#` and report back.

## Current Integrations

### Speechmatics

Speechmatics is the active live STT and diarization provider.

Important env names:

```text
SPEECHMATICS_API_KEY
SPEECHMATICS_REALTIME_URL
SPEECHMATICS_OPERATING_POINT
SPEECHMATICS_MAX_SPEAKERS
SPEECHMATICS_MAX_DELAY
SPEECHMATICS_END_OF_UTTERANCE
SPEECHMATICS_PREFER_CURRENT_SPEAKER
SPEECHMATICS_RECOVERY_BUFFER_MS
SPEECHMATICS_RECONNECT_INITIAL_MS
SPEECHMATICS_RECONNECT_MAX_MS
SPEECHMATICS_HEARTBEAT_MS
```

Current behavior:

- `/live` owns the browser recording session.
- Speechmatics is a reconnectable child session.
- Recoverable Speechmatics close/error events should not stop browser recording.
- Backend emits `stt_status` events and buffers/replays audio during reconnect windows.
- Manual stop sends `EndOfStream`, flushes pending final turns, and then closes `/live`.
- UI should not show raw provider errors in a production-looking way.

### Vertex Gemini

The app uses Google Cloud Vertex AI through ADC.

Important env names:

```text
GOOGLE_CLOUD_PROJECT
GOOGLE_CLOUD_LOCATION
GOOGLE_GENAI_USE_VERTEXAI
VERTEX_MODEL
VERTEX_FAST_MODEL
VERTEX_GROUNDING_MODEL
```

Current expected model family:

```text
VERTEX_MODEL=gemini-2.5-pro
VERTEX_FAST_MODEL=gemini-2.5-flash-lite
VERTEX_GROUNDING_MODEL=gemini-2.5-flash
```

Do not assume newer preview Gemini models are available unless the target Vertex project/region has been verified.

### Firecrawl / Source Checks

Firecrawl Search is the preferred retrieval path. The removed Firecrawl agent endpoint should not be used.

Important env names:

```text
FIRECRAWL_API_KEY
FIRECRAWL_SEARCH_TIMEOUT_MS
FIRECRAWL_SEARCH_LIMIT
FIRECRAWL_EXCLUDED_DOMAINS
```

Current intended source flow:

1. Source candidates are selected from canonical factual claim families, not random transcript fragments.
2. Firecrawl `/search` retrieves external snippets.
3. Gemini-lite decides whether the external evidence supports, disputes, or does not resolve the factual core.
4. Source scoring applies only once per claim family.
5. `unclear`, `needs_context`, `contextual`, and `transcript_only` do not score.

Source-check status:

- Live source checks now have stale-timeout handling so old `checking sources` cards should not sit forever.
- Stop/report includes a final source-settle path for remaining live-timeout checks.
- Source checks still need manual long-run validation because external API latency can vary.

## Supabase / Persistence

Persistence is part of the product flow.

Key files:

```text
server\db.mjs
server\db-migrate.mjs
server\db-smoke.mjs
server\auth.mjs
src\supabaseClient.ts
supabase\migrations\202605080001_debatly_persistence.sql
supabase\migrations\202605080002_user_profiles.sql
```

Useful scripts:

```text
npm run db:migrate
npm run test:db
```

Persistence scope:

- debate projects
- live sessions
- transcript turns
- canonical debate state
- canonical artifact payloads in `debate_artifacts`
- score snapshots/history
- debate reports
- user profiles
- speaker display-name overrides

Implemented persistence changes:

- `/api/debate-report` no longer waits for the full live-session persistence queue before responding.
- Report endpoint persists the final report directly, then flushes old session persistence in the background.
- Artifact snapshot persistence was changed to bulk upsert instead of one DB query per artifact.
- Stop/report status writes are defensive so stale queued writes should not downgrade `report_ready`.
- Speaker display-name edits are persisted into project summary and latest session state.
- `persistDebateReport()` now fills missing `ended_at` on both `debate_sessions` and `debate_projects` when a report is persisted.
- `finalizeStaleRecordingSessions()` recovers stale DB sessions stuck in `recording` after API restart/abandoned live sessions. It marks old sessions stopped, sets `ended_at` from `started_at + duration_ms` when available, and adds recovery diagnostics.
- The API runs stale-session recovery on startup.
- Saved debate queries now select the meaningful session for a project instead of always selecting the newest session. Active recent recording sessions still win, but empty 1-second sessions no longer hide older sessions with transcript/artifacts.
- Reports are now attached to saved debate loads only when the report belongs to the selected session. This prevents an accidental empty stop/report from hiding the real debate state.

### Debate 16 Recovery Note

Debate 16 had two sessions:

- Real session `117bc635-9627-47c4-9438-6b34d0261419`: started `2026-05-11T10:28:36Z`, recovered to stopped, duration `232222ms`, `93` loaded transcript turns, `6` claims, `3` challenges, `4` weak spots.
- Accidental empty session `1f025d11-7556-433c-96f0-b62ec263b803`: started `2026-05-11T11:36:31Z`, received `client_stop` almost immediately, duration `1411ms`, `0` transcript rows, generated empty report `report-e4566451-e0ae-460c-93a5-193597a9a759`.

The root cause of the `1 hour+` display was mixed project/session timestamps plus the empty newer session hiding the real earlier session. Current load result for Debate 16 should be:

```text
title: DEBATE 16
status: stopped
topic: Genocide claims regarding Gaza and Ukraine
sessionId: 117bc635-9627-47c4-9438-6b34d0261419
durationMs: 232222
turns: 93
reportId: null
```

## Project Boot / Sidebar Status

Implemented behavior:

- Signed-in users with saved projects should land on the latest saved project rather than a blank default draft.
- Blank `Untitled debate` is only for users with no saved projects or when explicitly creating a new debate.
- `+ New debate` still creates a new project, places it at the top, and makes it active.
- Supabase `TOKEN_REFRESHED` and duplicate same-user auth callbacks should not reload/flash saved projects.
- Deleting the active project loads the next saved project when one exists, otherwise resets to default draft.
- Active sidebar project has a neutral selected-card treatment and `aria-current`.
- Sidebar has a scalable scroll area with fade treatment; scrollbar styling is still being visually tuned.

Recent UI issue to watch:

- Browser/OS scrollbar rendering on Windows Chrome may ignore some custom button styling depending on native overlay scrollbar settings. The CSS now includes global WebKit button suppression, but manual visual QA is still needed.

## Live Recording Flow

Frontend live mode connects to `/live` with the current Supabase access token and project id when available.

Backend `/live` emits:

- `session_ready`
- `transcript`
- `stt_status`
- `audio_ack`
- `speechmatics_stats`
- `analysis_status`
- `debate_state`

Backend session state stores:

- final transcript turns
- canonical debate state
- analysis queue
- verification queue
- score history
- report status
- persistence ids

Long-run behavior:

- Keep full transcript server-side.
- Send compact recent context plus cumulative canonical side/family memory to agents.
- Run one analysis job per session at a time.
- Coalesce turns while an analysis job is running.
- Keep verification backgrounded and rate-limited.
- Do not let verification order independently swing the score.

## Paste-Ready Prompt For Next Chat

Use this prompt to start the next chat:

```text
We are working on debatly in C:\Majortom\Proojects\Debate.

Please read HANDOFF.md first, especially "Latest Active Handoff - 2026-05-13", before changing code. Also inspect server-runtime.log and logs/live-agentic-trace.jsonl before backend/agent changes.

Project summary:
debatly is a React + Express live debate-analysis prototype. It uses Speechmatics realtime diarization through backend /live, Vertex Gemini through GCP/ADC for the current multi-agent debate pipeline, Firecrawl Search plus Gemini-lite for source checks, and Supabase/Postgres for auth/persistence. AssemblyAI has been removed.

Current architecture:
The active production workflow is the current three-layer path:
1. Reporting/transcript layer: Speechmatics, transcript cleaning/stitching, dialogue windows.
2. Editor layer: Debate Shape Finder, Speaker Side Resolver, Claim Finder, Challenge Agent, Pressure Point Agent, Double Standard Finder, Card Quality Gate.
3. Judge layer: Evidence Checker, Issue Grouper, Frame Keeper, source scoring gate, durable scorecard/report timeline.

Important invariants:
- Do not hardcode speaker names, topics, sample-specific rules, or Gaza/Ukraine-specific logic.
- Internal side IDs can remain side-a/side-b, but visible text must say Blue side / Red side, never Side A / Side B.
- Speaker labels are only for attribution and must dynamically reflect user-edited display names.
- Generated card/report/chart prose that mentions Speaker 1/2 or Side A/B must be normalized in the UI.
- All visible quotes should be italic.
- Debate Highlights/report are generated only after user confirms Stop/report and after remaining transcript analysis/source checks settle.
- Source scoring must require trusted external evidence, not just raw verified status.

User preferences:
- Do not inspect/check the browser yourself. Ask the user to verify UI behavior.
- Do not run broad test suites unless asked. Run focused tests only when explicitly asked.
- Use npm run dev or stable npm run dev:api for live tests. Do not use npm run dev:api:watch during recording because API restarts can kill /live.
- If UI/live behavior seems unchanged after backend edits, restart stable npm run dev:api before judging.

Recent completed fixes:
- Frame Keeper is the single thesis updater; legacy Thesis Agent path should not be used.
- Thesis labels have strict cadence/character limits and incomplete labels are rejected.
- Durable scorecard/report settle path was cleaned so score breakdowns and report timeline are based on settled canonical state.
- Stop/report drains transcript chunks, runs final current judge/editor pass, verifies remaining source checks, then builds report.
- Report graph renders final endpoint dots without fake final score events.
- Speaker display names persist and generated prose is normalized dynamically.
- Tag colors/icons, scrollbar behavior, sidebar timer alignment, and debate desk details were tuned.

Current open product/architecture issue:
Debate 27 in the DB shows Issue Grouper creating broad issue/category families. Project:
projectId: 6fa328f8-3b3d-46d5-9a37-89cfee1e5b99
sessionId: 418948e1-7b08-4ead-91d9-e608648dcfe8
status: report_ready

Issue grouping currently comes from server/index.mjs applyCurrentIssueGrouping, then reconcileCurrentLinkedIssueGroups propagates groups through claims, sources, clashes, weak spots, double standards, and turning points. Frontend ArtifactColumns then renders the same issueGroups across all tabs.

Observed Debate 27 groups:
- Intent of Aggressors: huge group across many tabs/cards.
- Gaza as Unusual Warfare Setting: Red claim.
- Hamas Provocation and Shielding: Red claim/source.
- Mistakes and Indefensible Acts in War: Red claim/double-standard.

Likely next task:
Think architecturally before editing. The product likely should keep backend issueGroups internally for context/reporting, but show collapsible issue groups only in the Claims tab. Other tabs may be better flat by side, sorted by recency/importance, possibly with a small related-issue chip rather than issue section headers. If grouping remains in Claims, consider an claim-only grouping surface so one broad issue does not swallow all cards.

Before implementing anything, explain:
1. Which code path creates issue families.
2. Which code path propagates issueGroupId to non-claim artifacts.
3. Which UI component renders issue headers in every tab.
4. The safest minimal change to show grouping only where it helps without breaking scoring/reporting.

Only then implement if asked.
```

## Canonical Debate Pipeline

The app is now intended to use backend-owned canonical debate state as the source of truth. Agents propose candidates; the deterministic canonical reducer decides what becomes visible, scored, persisted, or reported.

Canonical state lives under:

```text
debate.canonical.version = 2
```

Canonical buckets:

- `claims`
- `clashes`
- `doubleStandards`
- `weakSpots`
- `turningPoints`
- `sources`
- `scoreEvents`
- `issueLedger`

Current Pipeline V2:

1. RawTurnIngestor / RawBatchBuilder
2. Transcript Stitcher, a conservative transcript repair pass only
3. CleanedLedgerReducer
4. Deterministic DialogueWindowBuilder over the rolling four-batch cleaned window
5. SpeakerSideResolver before claim selection
6. ReadyClaimWindowBuilder
7. Debate Point Agent as a CandidateClaimList proposal producer
8. ClaimOwnershipGate decides whether each candidate is owned by the assigned speaker
9. CanonicalClaimGate / reducer with CanonicalDecisionLog
10. Fact Checker: Firecrawl Search + Gemini-lite verdict, running in the background
11. Challenge Agent as clash proposal producer
12. Pressure / Weak Spot proposal producer
13. Double Standard proposal producer
14. Backend thesis resolver plus Thesis Agent candidates
15. Scorecard v4 from resolved family state
16. QuoteSpotlightAgent from the last 60 seconds of cleaned transcript
17. Debate Highlights Agent after confirmed stop/report

Cadence expectations:

- Transcript stitching cadence is about 20 seconds.
- Side resolution and claim proposal cadence is about 40 seconds, with exchange/pattern/final passes allowed to run sooner.
- Exchange/clash/score reconciliation is around 30 seconds.
- Pattern passes for double standards, recurring weak spots, thesis shifts, and turning points run on Fibonacci-style debate minutes: `2, 3, 5, 8, 13, 21, 34, 55, 89`, plus final stop/report.
- Debate Highlights is post-stop only.

Canonical reducer rules now matter more than agent prose:

- Reject reported speech as owned claim unless the current speaker makes their own inference.
- ClaimOwnershipGate runs after CandidateClaimList and before verification/canonical merge. It receives candidate claims, ReadyClaimWindows, nearby cleaned transcript, SpeakerPositionMemory, SpeakerSideRegistry, recent owned claims by speaker, and recent opponent claims by side.
- If a candidate is quoting, mocking, questioning, sarcastically repeating, paraphrasing, or reporting the other side, it cannot become a Claim card.
- Double standards require two owned claims from the same speaker on the same side; opponent echoes cannot become double-standard evidence.
- Treat quoted evidence as support under a family, not a new owned claim.
- Reject vague fragments such as "it goes to motive and intent" unless paired with a complete proposition.
- Reject meta/process talk and off-topic material unless it becomes a sustained new debate topic.
- Merge repeated claims into durable claim families.
- Collapse clashes by family pair and issue bucket.
- Collapse weak spots by side, family, issue type, and missing step.
- Use `CanonicalIssueLedger` as the cross-tab ownership layer: one issue gets one primary visible tab, while weak spots may survive as secondary claim pressure.
- Turning points require a central family state change and a complete quote.

## Side Thesis Status

Visible Blue/Red thesis titles are now owned by one backend resolver, not by every agent/fallback helper.

Current contract:

- `DebateSide.thesisStatus` is either `forming` or `confirmed`.
- The UI should render `side.label` / `side.confirmedThesis` only when `thesisStatus === "confirmed"`.
- Sparse sides stay visually as `Thesis forming`; they must not receive a one-point title.
- The Debate Point Agent receives `ReadyClaimWindows` and compact canonical dedupe memory, but not side thesis labels.
- `applyTopicAndSides()` updates topic only; it no longer writes visible side labels.
- `refreshSideTheses()` can ask the Thesis Agent for candidates, but final visibility is decided by `resolveSideTheses()`.
- `refineDurableLabels()` also goes through `resolveSideTheses()` so final/report paths cannot create a different label rule.
- `compactLabel()` truncates at word boundaries; it should not produce broken fragments such as a trailing `wi`.
- The frontend `mergeSideLabels()` must not preserve stale unconfirmed labels.

Current threshold:

- By default `MIN_SIDE_THESIS_POINTS=1`, so a side can confirm once it has one accepted canonical claim with enough side/quote support.
- Sides with zero accepted canonical claims still remain `Thesis forming`.

## Scoring Status

Scoring has moved away from the old 0-100 seesaw. The visible score is intended to be a fixed-value, resolved-family scorecard:

```text
scorecard.version = 4
scorecard.method = "resolved_family_score"
```

Current visible categories and fixed values:

- `Strong claim`: `+3`
- `Challenge landed`: `+5`
- `Defense held`: `+4`
- `Source backed claim`: `+4`
- `Source weakened claim`: `-5`
- `Double standard`: `-8`
- `Unanswered burden`: `-1`
- `Clear concession`: opponent `+5`, conceding side `-2`

Current category caps per side:

- Strong claim max `+30`
- Challenge landed max `+25`
- Defense held max `+16`
- Source backed max `+16`
- Source weakened max `-15`
- Double standard max `-16`
- Unanswered burden max `-5`

Important scoring rules:

- Scores can go negative.
- Do not clamp side scores to 0.
- No hidden 100-point seesaw should influence the visible score.
- LLM-derived severity/importance/strength may explain cards but should not choose visible point values.
- Source scoring is once per factual family.
- Unanswered burden is deliberately light and capped.
- Score chips should be stable cumulative category totals.

Known score-quality watch item:

- Long-debate runs previously produced unreadable high totals. Current fixed values and caps are intended to prevent 447-style score explosions, but long-run manual validation is still important.

## Speaker Handling

Current requirements:

- Support up to 6 real speakers.
- Speakers map only into Blue side / Red side.
- Do not hardcode speaker names.
- Speaker labels can now be edited by the user.

Implemented speaker label behavior:

- Speaker chips in score cards can be clicked/edited.
- Edited names update all labels for that speaker in real time.
- `Reset to Speaker N` is available.
- Speaker display names persist later through backend project/session updates.
- Transcript, artifacts, score cards, and reports use the display-name resolver.

Speaker/noise behavior:

- There is a stability layer intended to suppress very low-confidence/low-volume one-off speakers caused by crosstalk/background audio.
- This must not force every debate into 2 speakers; it should only hide/merge noise.
- Manual validation is still needed when background audio appears during a live run.

## UI Contract And Current UI Status

Main UI areas:

- Sidebar with logo, new debate, persisted projects, settings, and user/auth area.
- Top hero quote/status strip with light/dark toggle.
- Audio control card with timer, mic test, record/pause/stop controls.
- Score cards for Blue side and Red side.
- Live `Debate Desk`.
- Post-stop `Debate Highlights`.
- Transcript section lower on the page.

Current UI rules:

- Use `Blue side` and `Red side` for side perspective.
- Use speaker labels only for quote attribution.
- All displayed quotes should be italic.
- Do not show raw `Interim` labels in transcript rows.
- Avoid internal labels such as `ANALYST READ`, `QUOTE RECEIPT`, or `Named in the exchange`.
- Avoid decorative color blobs/orbs.
- Keep card surfaces neutral and use side color mainly for borders, dots, and restrained accents.

Implemented UI changes:

- Report receipts / "Named in the exchange" extraction were removed from report rendering.
- Featured quote area is intended to show one strong owned statement from the leading side, at most once per minute, and avoid random/vague transcript fragments.
- Score cards show `Score`, compact category chips, negative values, and no below-card explanatory score text.
- Leading score-card glow/animation was removed after user preference changed.
- Debate Desk tabs render canonical cards.
- Debate Desk card section now has a fixed-height scroll body.
- Debate Desk Blue/Red thesis headers were split outside the scrollable card body.
- Debate Desk scroll body should hand off to main page scroll at top/bottom boundaries.
- Sidebar and Debate Desk scrollbars are being tuned for sleek rounded behavior.
- Settings is now a modal-style workspace panel. Background page scroll should be locked while Settings is open.
- Settings account/logout is accessed through Settings rather than showing a standalone logout affordance in the sidebar account footer.
- Scoring Metrics should be audience-facing, split into wins/losses using the same green/red colors as the score card, and avoid decorative dot/circle markers before headings.
- Share/export menu exists near the theme toggle with report PDF and transcript text download actions.
- PDF export was moved away from `html2canvas`/`jspdf` to a print-window flow because html2canvas produced 0-byte/blank files in local testing. User strongly prefers the PDF to reuse the same app design/components and theme, with no colored edge sleeve cards.

Recent UI issue to watch:

- User disliked side-tinted header fills. Current CSS neutralizes header fill and keeps side identity through border/dot/count color.
- The latest scrollbar implementation moved the Debate Desk scrollbar into an outside rail to avoid Red-column width misalignment.
- Manual browser validation is still pending for scrollbar visuals.
- Manual browser validation is pending for PDF export because the user asked the assistant not to check the browser directly.

## Debate Desk Tabs

Current tabs:

- Claims
- Key Clashes
- Double Standards
- Weak Spots
- Turning Points
- Sources

Current card layout direction:

- For Key Clashes, Double Standards, and Weak Spots, dialogue/quote should appear before explanation.
- Turning Points can keep their current report-style layout.
- Each tab should show canonical counts, not raw proposal counts.

Quality rules:

- Claim cards should be central owned claim families, not every sentence.
- Key Clashes should not repeat the same broad dispute across many cards.
- Weak Spots should be few, linked to central families, and should not punish every unsupported inference before source checks resolve.
- Turning Points must be meaningful debate shifts, not ordinary concessions, score changes, or common-ground closing lines.

## Stop / Report Flow

Current intended behavior:

1. User clicks Stop / Stop & report.
2. Confirmation dialog appears.
3. Closing the dialog keeps recording.
4. User can stop without generating a report.
5. User can stop and generate Debate Highlights.
6. When report generation is chosen, the app shows a loading state.
7. Backend settles remaining transcript analysis and fact checks.
8. Backend runs final canonical reconciliation.
9. Backend generates Debate Highlights from canonical state.
10. Backend persists report directly.
11. Frontend reveals Debate Highlights and scrolls to it.
12. Old live persistence queue can finish in the background.

Report rules:

- Debate Highlights appear only after user confirms report generation.
- Report language should be past tense.
- Use Blue/Red side perspective.
- Resolve quotes from canonical quote IDs, not freeform agent ownership.
- No receipt/name extraction section.
- Report timeline should not invent synthetic "Final score settled" jumps.

## Logs

Primary runtime log:

```text
server-runtime.log
```

Structured trace log:

```text
logs\live-agentic-trace.jsonl
```

Useful markers:

- `[server]`
- `[live-session]`
- `[speechmatics packaging]`
- `[speechmatics packaging stats]`
- `[debatly trace]`
- `[live-score]`
- `[debate-report]`
- `Firecrawl Search:*`
- `Fact Checker Verdict Agent:*`
- source-check stale/timeout logs

Before changing live/backend behavior, inspect:

- `server-runtime.log`
- `logs\live-agentic-trace.jsonl`

For unexpected recording stops, inspect:

- `browser_closed`
- `stop_requested`
- `speechmatics_closed`
- API process restarts
- WebSocket auth rejection
- stale API boot state

For source-check delays, inspect:

- Firecrawl retrieval timing
- Gemini-lite verdict timing
- source queue size
- stale source-check timeout behavior
- final stop/report settle logs

## Samples / Truth Files

Main long sample:

```text
Samples\mehdi-walsh.wav.wav
```

Reference files:

```text
Samples\mehdi-walsh diarized truth full clip.docx
Samples\diarized truth full clip.docx
Samples\mehdi-walsh-16k-mono-first-120s.wav
Samples\diarized truth 120 secs.docx
Samples\mehdi-walsh-reference-diarization.json
```

Benchmark artifacts:

```text
.benchmarks\stt-truth
```

Known benchmark:

```text
node server/truth-docx-flow-smoke.mjs Samples/mehdi-walsh-reference-diarization.json 300 duration:20s --live-cadence
```

WAV live smoke with auth token:

```text
LIVE_TEST_ACCESS_TOKEN=<token> node server/debate-flow-smoke.mjs Samples/mehdi-walsh-16k-mono-first-300s.wav
```

## Verification Commands

Required broad suite when touching live/backend/agent behavior:

```text
npm run check
npm run build
npm run test:agent-routing
npm run test:artifacts
npm run test:claim-correctness
npm run test:six-speaker
npm run test:live-resilience
npm run test:debate-report
npm run test:db
```

Also useful:

```text
npm run test:fact-check-queue
npm run test:live-cadence
npm run test:dialogue-windows
npm run test:speechmatics:truth:batch
npm run test:speechmatics:truth:rt
npm run test:debate-flow
npm run test:meter
npm run test:claim-engine
```

Latest validation status:

- After the side thesis resolver fix, `npm run check` passed.
- After the side thesis resolver fix, `npm run build` passed.
- After the side thesis resolver fix, these targeted tests passed: `npm run test:agent-routing`, `npm run test:artifacts`, `npm run test:claim-correctness`, `npm run test:six-speaker`, `npm run test:live-resilience`, `npm run test:debate-report`, and `npm run test:db`.
- Important: `npm run test:claim-correctness` first failed against a stale API process on port 8787, then passed after restarting stable `npm run dev:api`. Restart the API after backend edits before trusting live/UI validation.
- After the Debate 16 persistence recovery fix, these passed: `npm run check`, `npm run build`, `npm run test:db`, `npm run test:live-resilience`, `npm run test:debate-report`, plus `node --check server/db.mjs` and `node --check server/index.mjs`.
- Debate 16 DB recovery was run once manually and repaired one stale `recording` session.

Current known build note:

- `npm run build` passes but Vite may warn that the main bundle chunk is larger than 500 kB. This is not a failure. Fix later with dynamic imports/code splitting once behavior stabilizes.

## Key Gotchas

- Do not patch logic around a specific topic or the Mehdi/Walsh sample.
- Do not print `.env` secrets.
- Do not use `npm run dev:api:watch` for recording.
- Restart stable API after backend changes before live validation.
- If recording fails immediately, check auth token validation and `/live` rejection.
- If recording stops unexpectedly, check whether the API process restarted.
- If a saved project shows a growing/stale duration, inspect selected session versus project timestamps. Saved/stopped project cards should use persisted `durationMs`, not recompute against `now`.
- If a project opens empty after a real debate, inspect whether a newer empty session/report is hiding an older session with transcript/artifacts.
- If sources stay on `checking`, inspect queue timing and timeout/final-settle logs.
- If a quote or report assigns a statement to the wrong speaker, inspect canonical quote IDs and quote ownership metadata.
- If side thesis labels duplicate or stay generic too long, inspect accepted canonical family count and thesis fallback path.
- If Debate Desk cards explode in count, inspect canonical reducer gates and raw proposal counts separately.

## Suggested Next Work

- Manual browser QA for the latest Debate Desk scroll behavior and scrollbar visuals.
- User should manually verify Debate 16 in the browser after refreshing: it should load session `117bc...`, show about `3m`, and show the recovered claims/clashes/weak spots instead of the empty accidental report.
- User should manually verify PDF export/download because assistant should not use the browser.
- Manual long-run validation after the most recent canonical/scoring/source changes.
- Re-check Debate Desk card quality for Claims, Key Clashes, Weak Spots, and Turning Points.
- Verify source checks settle during live debate and again on Stop/report.
- Verify speaker label edits persist after refresh and appear in report rendering.
- Validate noisy/background speaker handling without breaking real 3-6 speaker debates.
- Split the large frontend bundle after product behavior stabilizes.

## Short Prompt For Next Chat

Use `NEXT_CHAT_PROMPT.md`. It has been refreshed for the active 2026-05-26 direct-ledger architecture and current Speechmatics diarization blocker.
