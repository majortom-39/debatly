# Speechmatics Realtime — reference (diarization, identification, config)

Saved reference for the Speechmatics Realtime API as used by Debatly's live STT.
Endpoint we use: `wss://us.rt.speechmatics.com/v2` (config built in
`server/speechmatics-live-stt-node.mjs`, env-mapped in `server/config.mjs`).

Source pages:
- Realtime diarization: https://docs.speechmatics.com/speech-to-text/realtime/realtime-diarization
- Diarization feature: https://docs.speechmatics.com/speech-to-text/features/diarization
- Speaker identification: https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification
- Audio filtering: https://docs.speechmatics.com/speech-to-text/features/audio-filtering
- Realtime API reference: https://docs.speechmatics.com/api-ref/realtime-transcription-websocket
- Turn detection (EndOfUtterance): https://docs.speechmatics.com/speech-to-text/realtime/turn-detection
- Output / latency: https://docs.speechmatics.com/speech-to-text/realtime/output

---

## Speaker diarization config (`transcription_config.speaker_diarization_config`)

| Param | Type / range | Default | Meaning |
|---|---|---|---|
| `speaker_sensitivity` | float 0–1 | 0.5 | **Higher = more unique speakers** returned. Lower merges similar voices into one. |
| `prefer_current_speaker` | bool | false | When `true`, stays with the previous word's speaker if the new word closely matches → fewer false switches between similar voices. **BUT in fast back-and-forth it over-sticks and merges the next person; can miss short turn changes.** |
| `max_speakers` | int ≥ 2 | no limit | Caps how many speakers can be detected. Set near the real count to stop noise inventing extras. (With enrolled speakers, only applies to *generic* extra speakers.) |
| `get_speakers` | bool | false | If true, returns speaker identifiers at end of transcript (for enrollment). |
| `speakers` | object[] | — | Enrolled speaker labels + identifiers (see Identification below). |

Speaker labels in output: `S1`, `S2`, … (sequential), or `UU` when the speaker
can't be determined (e.g. noise transcribed as speech).

### Punctuation-based correction (built in)
Diarization uses punctuation to fix small mistakes: if 9 words of a sentence are
S1 and 1 is S2, the lone S2 word is corrected to S1. **Only works with
punctuation enabled** — don't disable punctuation. Adjusting punctuation
sensitivity affects diarization accuracy.

### Speaker change detection (legacy) — REMOVED July 2024
`speaker_change` / `channel_and_speaker_change` are gone. Use speaker diarization.

---

## Audio filtering (`transcription_config.audio_filtering_config`)

| Param | Range | Meaning |
|---|---|---|
| `volume_threshold` | float 0–100 (linear, NOT dB) | Silences any 0.01s audio chunk whose RMS is below this **before transcription**. 0 = off, 100 = removes all. |

⚠️ **GOTCHA WE HIT:** a non-zero threshold **silences a quiet mic entirely → empty
transcripts → no transcription at all.** Even `3` wiped out our test mic. **Keep
`volume_threshold=0`** unless the input is confirmed loud (each word carries a
`volume` 0–100 you can use to calibrate). Background filtering only works if the
noise is *significantly quieter* than the speaker.

---

## Speaker identification / enrollment (the robust, stable-label option)

Lets you tag known speakers with stable labels instead of S1/S2.

1. **Enroll:** run diarization on a sample where the speaker is **alone**, then
   `GetSpeakers {final:true}` (or `get_speakers:true`) → server returns
   `SpeakersResult` with `{label, speaker_identifiers}` per speaker.
2. **Identify:** pass those identifiers in the next job via
   `speaker_diarization_config.speakers: [{label, speaker_identifiers:[...]}]`.
   Matching speakers get your label; others get `S#`.

Notes:
- `max_speakers` only caps *generic* (non-enrolled) speakers.
- `speakers_sensitivity` (lower = more likely to match an enrolled speaker).
- Max 50 identifiers total; labels must not look like `S1`/`S2`.

**Why we don't use it for live debates:** enrollment needs each speaker recorded
alone up front, which we don't have for an unscripted 1‑vs‑many debate. It's the
only truly robust fix for label stability, but it's not viable without samples.

---

## Latency / output (`max_delay`, partials)

- `max_delay`: 0.7–4s (default 4). Delay between end of a word and the Final
  result. ~2.0s = best accuracy/latency for most; 0.7–1.5s = fast; 4s = max
  accuracy. We use **2**.
- `max_delay_mode`: `flexible` (default) waits to finish entities for smart
  formatting; `fixed` doesn't.
- `enable_partials: true` → interim `AddPartialTranscript` (<500ms, ~10–25% less
  accurate) before Finals. We use partials.
- `operating_point`: `standard` | `enhanced`. We use **enhanced**.

## Turn detection (`conversation_config`)
- `end_of_utterance_silence_trigger`: 0–2s (0 disables). Server emits an
  `EndOfUtterance` after that much non-speech. Keep it below `max_delay`.
  Recommended 0.5–0.8s for voice AI. (Not currently enabled in Debatly.)

## Key message types
- Client→server: `StartRecognition`, `AddAudio` (binary), `EndOfStream`,
  `SetRecognitionConfig`, `GetSpeakers`, `ForceEndOfUtterance`.
- Server→client: `RecognitionStarted`, `AudioAdded`, `AddPartialTranscript`,
  `AddTranscript` (final; each word has `speaker`, `confidence`, `volume`),
  `EndOfTranscript`, `EndOfUtterance`, `SpeakersResult`, `Info`, `Warning`
  (incl. `speaker_id`), `Error`.

---

## Debatly's current production settings (server `.env`) + rationale

| Setting | Value | Why |
|---|---|---|
| `operating_point` | enhanced | accuracy |
| `diarization` | speaker | per-speaker labels |
| `max_delay` | 2 | good accuracy/latency; avoids single-utterance duration limits on long monologues |
| `enable_partials` | true | live feedback |
| `SPEECHMATICS_SPEAKER_SENSITIVITY` | 0.5 | separate distinct speakers in fast debates (lower merged them) |
| `SPEECHMATICS_PREFER_CURRENT_SPEAKER` | false | switch readily on real speaker changes (true over-stuck and merged people) |
| `SPEECHMATICS_VOLUME_THRESHOLD` | 0 | OFF — any value silenced our quiet mic (no transcription) |
| `SPEECHMATICS_MAX_SPEAKERS` | 10 | cap |

### Lessons learned (so we don't repeat them)
- **Lowering `speaker_sensitivity` to fight noise backfires** — it merges genuinely
  different speakers into one. Keep it ~0.5–0.6 for debates.
- **`prefer_current_speaker=true` helps vs noise but hurts fast debates** (merges
  the next person). For debates, `false`.
- **`volume_threshold` > 0 can kill transcription** on a quiet mic. Leave at 0.
- **No live config silver bullet** for unsupervised many-speaker diarization;
  acoustic diarization will occasionally relabel a speaker. The robust options are
  (a) speaker enrollment (needs samples — not viable live), or (b) app-level
  correction using conversational cues (LLM in the Side Builder).
- **Acoustics dominate:** mic close to speakers, away from keyboards, low reverb.
