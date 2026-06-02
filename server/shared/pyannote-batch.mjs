// =============================================================================
// shared/pyannote-batch.mjs  —  pyannote.ai BATCH diarization + transcription.
// =============================================================================
//
// For UPLOADED files / video URLs (not live). One job does it all:
//   precision-2 diarization + integrated STT (whisper-large-v3-turbo) + pyannote's
//   own speaker-attribution reconciliation → speaker-tagged turns & words.
//
// Flow:
//   1. uploadMedia()  → POST /v1/media/input (get presigned PUT) → PUT bytes.
//   2. submitDiarize()→ POST /v1/diarize { url: media://..., model, transcription }.
//   3. pollJob()      → GET /v1/jobs/{id} until succeeded/failed/canceled.
//   Output: { diarization:[{speaker,start,end}], turnLevelTranscription:[...],
//             wordLevelTranscription:[...] }.
// =============================================================================

import { randomUUID } from "node:crypto";

const PYANNOTE_BASE = "https://api.pyannote.ai/v1";

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

// 1) Create a temporary storage slot and upload the audio bytes to it.
export async function uploadMedia(apiKey, objectKey, fileBuffer, signal) {
  const mediaUrl = `media://${objectKey}`;
  const createRes = await fetch(`${PYANNOTE_BASE}/media/input`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ url: mediaUrl }),
    signal
  });
  if (!createRes.ok) throw new Error(`pyannote media/input failed: ${createRes.status} ${await createRes.text()}`);
  const { url: presignedUrl } = await createRes.json();
  if (!presignedUrl) throw new Error("pyannote media/input returned no presigned url");

  const putRes = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: fileBuffer,
    signal
  });
  if (!putRes.ok) throw new Error(`pyannote media upload PUT failed: ${putRes.status} ${await putRes.text()}`);
  return mediaUrl;
}

// 2) Submit a diarization (+ optional transcription) job.
export async function submitDiarize(apiKey, mediaUrl, {
  model = "precision-2",
  transcription = true,
  transcriptionModel = "faster-whisper-large-v3-turbo",
  numSpeakers = null,
  minSpeakers = null,
  maxSpeakers = null,
  signal = undefined
} = {}) {
  const body = { url: mediaUrl, model };
  if (transcription) {
    body.transcription = true;
    if (transcriptionModel) body.transcriptionConfig = { model: transcriptionModel };
  }
  if (numSpeakers != null && Number(numSpeakers) >= 1) body.numSpeakers = Number(numSpeakers);
  if (minSpeakers != null && Number(minSpeakers) >= 1) body.minSpeakers = Number(minSpeakers);
  if (maxSpeakers != null && Number(maxSpeakers) >= 1) body.maxSpeakers = Number(maxSpeakers);

  const res = await fetch(`${PYANNOTE_BASE}/diarize`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw new Error(`pyannote diarize failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.jobId) throw new Error(`pyannote diarize returned no jobId: ${JSON.stringify(json)}`);
  return json.jobId;
}

// 3) Poll a job until it reaches a terminal status.
export async function pollJob(apiKey, jobId, { intervalMs = 5000, timeoutMs = 1800000, onStatus = null, signal = undefined } = {}) {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error("aborted");
    const res = await fetch(`${PYANNOTE_BASE}/jobs/${jobId}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!res.ok) throw new Error(`pyannote get-job failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (data.status !== lastStatus) { lastStatus = data.status; if (onStatus) onStatus(data.status, data); }
    if (data.status === "succeeded") return data.output || {};
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(`pyannote job ${data.status}: ${JSON.stringify(data.error || data)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pyannote job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

// Convenience: upload + diarize + transcribe + poll → output object.
export async function diarizeAndTranscribe(apiKey, fileBuffer, {
  objectKey = `debatly-${Date.now().toString(36)}`,
  model = "precision-2",
  transcription = true,
  transcriptionModel = "faster-whisper-large-v3-turbo",
  numSpeakers = null,
  onStage = null,
  pollIntervalMs = 5000,
  pollTimeoutMs = 1800000,
  signal = undefined
} = {}) {
  if (onStage) onStage("uploading");
  const mediaUrl = await uploadMedia(apiKey, objectKey, fileBuffer, signal);
  if (onStage) onStage("submitting");
  const jobId = await submitDiarize(apiKey, mediaUrl, { model, transcription, transcriptionModel, numSpeakers, signal });
  if (onStage) onStage("processing", { jobId });
  const output = await pollJob(apiKey, jobId, {
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
    signal,
    onStatus: (status) => { if (onStage) onStage(`job:${status}`, { jobId }); }
  });
  return { jobId, output };
}

// Map pyannote turn-level transcription → the app's debate turns.
// pyannote turns: { start, end, text, speaker: "SPEAKER_00" }.
// Output turns: { id, speakerId: "Speaker N", text, startSec, endSec, isFinal }.
export function pyannoteTurnsToDebateTurns(turnLevelTranscription = []) {
  const labelMap = new Map();
  const speakerId = (raw) => {
    if (!labelMap.has(raw)) labelMap.set(raw, `Speaker ${labelMap.size + 1}`);
    return labelMap.get(raw);
  };
  // transcript_turns.id is a GLOBAL primary key, so turn ids must be unique across
  // every import — otherwise a new import's "turn-N" collides with an old row and
  // ON CONFLICT silently drops it. Namespace every batch with a random prefix.
  const prefix = randomUUID().slice(0, 8);
  return (turnLevelTranscription || [])
    .filter((t) => t && String(t.text || "").trim())
    .map((t, i) => ({
      id: `turn-${prefix}-${i + 1}`,
      speakerId: speakerId(String(t.speaker || "SPEAKER_00")),
      text: String(t.text || "").trim(),
      startSec: Number(t.start) || 0,
      endSec: Number(t.end) || Number(t.start) || 0,
      isFinal: true
    }));
}
