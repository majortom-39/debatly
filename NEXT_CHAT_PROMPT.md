# Paste Into Next Chat

```text
We are working on debatly in C:\Majortom\Proojects\Debate.

First read HANDOFF.md, especially "Latest Active Handoff - 2026-05-26". Also read DEBATE_DESK_ARTIFACT_NOTES.md if you need the current artifact architecture.

Important preferences:
- Be concise and direct.
- Do not inspect/check the browser yourself.
- Do not run broad test suites unless I ask.
- Use cached Speechmatics outputs for benchmark loops unless testing Speechmatics itself.
- Use stable npm run dev:api for live backend tests; do not use npm run dev:api:watch during recording.
- Do not hardcode speaker names, topics, samples, Gaza/Ukraine logic, or debate-specific shortcuts.
- Visible text must say Blue side / Red side, never Side A / Side B.
- Before backend/agent changes inspect server-runtime.log and logs/live-agentic-trace.jsonl.
- Ignore old/live-app/canonical nodes unless I explicitly reintroduce them.
- Do not reveal or print API keys/secrets.

Current live architecture:
Browser mic/media audio -> backend /live WebSocket -> Speechmatics realtime diarization -> Speechmatics final-turn packaging -> Cleaner -> TranscriptStore -> Stabilizer Gate -> Side Builder -> Debate Point Builder -> Thesis Builder -> Claim Builder -> Fact Checker -> Clash Finder -> Inconsistency Finder -> deterministic Key Moments + Score -> Debate Desk + Final Report -> Supabase/Postgres direct-ledger tables.

Current UI tabs:
Debate Points, Claims, Clashes, Key Moments.

Current schema:
analysis_schema_version = 6
architecture = direct_debate_desk_v2
livePipeline = direct-ledger
fast model = gemini-3.1-flash-lite
Google Cloud location must be global.

Current Speechmatics state:
The immediate blocker is live Speechmatics diarization. Latest user tests showed multiple speakers speaking but raw Speechmatics labels collapsing mostly to S1. This happens before Side Builder, so do not start by blaming Side Builder, Claim Builder, Debate Point Builder, or UI.

The live Speechmatics config was restored after a bad sensitivity experiment:
- max_speakers: 10
- max_delay: 1
- end_of_utterance_silence_trigger: 0.5
- no speaker_sensitivity field unless explicitly testing
- no prefer_current_speaker field unless explicitly testing

Start next session by checking server-runtime.log for [speechmatics config], [speechmatics packaging], [speechmatics packaging stats], and [live-session]. Confirm the actual StartRecognition payload has only max_speakers: 10 inside speaker_diarization_config. Only then decide the next Speechmatics live fix. Do not spend Speechmatics credits unless I ask.

Right files:
- server/config.mjs
- server/index.mjs
- server/debate-point-builder.mjs
- server/db.mjs
- src/App.tsx
- src/types.ts
- src/styles.css
- supabase/migrations/202605220001_direct_debate_desk_schema.sql
- supabase/migrations/202605220002_direct_debate_desk_v2.sql
- supabase/migrations/202605220003_direct_clash_plain_verdicts.sql
- supabase/migrations/202605220004_remove_legacy_artifact_table.sql
- supabase/migrations/202605230001_claim_card_rename.sql
- supabase/migrations/202605230002_claim_json_keys.sql
- supabase/migrations/202605240001_debate_point_provenance.sql
- Samples\TEST 3\Scenario 1 audio.wav
- Samples\TEST 3\Scenario 1 transcript.docx
- .benchmarks\speechmatics-diarization-test3\run-scenario1-sensitivity-matrix.mjs
- .benchmarks\speechmatics-scenario1-sensitivity-20260525-232515
```
