// =============================================================================
// batch-ingest.mjs  —  uploaded file / video URL → full report (offline batch).
// =============================================================================
//
// Pipeline (mirrors the live path, minus the streaming):
//   1. Get a local media file (uploaded buffer, or downloaded from a URL).
//   2. ffmpeg → 16kHz mono WAV.
//   3. pyannote precision-2 + integrated whisper → speaker-attributed turns
//      (diarization + transcription + reconciliation in ONE job; no merge step).
//   4. Run the SAME clean node pipeline (gate → sides → points → claims →
//      fact-check → inconsistencies → scoring) via analyzeLive(flush).
//   5. report-builder → persist as a normal project the UI can open.
//
// Jobs are tracked in-memory with a stage + progress so the UI can poll.
// =============================================================================

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { extractWav16kMono, writeTempFile, safeUnlink } from "./shared/audio-extract.mjs";
import { diarizeAndTranscribe, pyannoteTurnsToDebateTurns } from "./shared/pyannote-batch.mjs";
import { createLiveAnalysisState, analyzeLive } from "./live-runner.mjs";
import { runReportBuilder } from "./nodes/report-builder.mjs";
import { downloadMediaFromUrl } from "./shared/media-url.mjs";
import { sendEmail, reportReadyEmail, isEmailConfigured } from "./shared/email.mjs";
import {
  createPersistedLiveSession,
  persistTranscriptTurn,
  persistDebateStateSnapshot,
  persistDebateReport,
  markSessionStopped,
  updateDebateProjectTitle
} from "./store.mjs";

const jobs = new Map(); // jobId -> { id, status, stage, progress, projectId, error, title, createdAt, abort, ... }

// Thrown when a job is canceled; handled quietly (not a real failure).
class CanceledError extends Error { constructor() { super("Canceled"); this.canceled = true; } }
function ensureLive(job) { if (job.canceled) throw new CanceledError(); }

const STAGES = {
  queued: { label: "Queued", progress: 4 },
  fetching: { label: "Fetching media", progress: 12 },
  extracting: { label: "Extracting audio", progress: 22 },
  diarizing: { label: "Diarizing & transcribing", progress: 40 },
  analyzing: { label: "Analyzing the debate", progress: 70 },
  reporting: { label: "Generating the report", progress: 90 },
  done: { label: "Done", progress: 100 },
  error: { label: "Failed", progress: 100 },
  canceled: { label: "Canceled", progress: 100 }
};

function setStage(job, stage, extra = {}) {
  const meta = STAGES[stage] || { label: stage, progress: job.progress || 0 };
  job.status = stage === "done" ? "done" : stage === "error" ? "error" : stage === "canceled" ? "canceled" : "running";
  job.stage = stage;
  job.stageLabel = meta.label;
  job.progress = meta.progress;
  Object.assign(job, extra);
  job.updatedAt = Date.now();
  console.log(`[ingest] ${job.id.slice(0, 8)} ${stage} ${JSON.stringify(extra)}`);
}

export function getIngestJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) return null;
  return {
    jobId: j.id, status: j.status, stage: j.stage, stageLabel: j.stageLabel,
    progress: j.progress, projectId: j.projectId || null, title: j.title || "",
    error: j.error || null, emailWhenDone: Boolean(j.emailWhenDone), emailConfigured: isEmailConfigured()
  };
}

// Cancel: stop everything in-flight (download/pyannote/ffmpeg) and drop the job.
export function cancelIngestJob(jobId) {
  const j = jobs.get(jobId);
  if (!j || j.status === "done" || j.status === "canceled") return false;
  j.canceled = true;
  try { j.abort?.abort(); } catch { /* ignore */ }
  setStage(j, "canceled");
  // Forget it shortly after so polls return 404/idle.
  setTimeout(() => jobs.delete(jobId), 30000);
  return true;
}

// "Notify me when done": keep running, and email the user on completion.
export function requestIngestEmail(jobId) {
  const j = jobs.get(jobId);
  if (!j) return false;
  j.emailWhenDone = true;
  return true;
}

// Public entry: uploaded file (Buffer).
export function startIngestFromFile({ buffer, filename = "upload", ownerId = null, ownerEmail = null }) {
  const ext = path.extname(filename) || "";
  const inputPath = writeTempFile(buffer, ext);
  const title = deriveTitle(filename);
  const job = newJob(title, ownerId, ownerEmail);
  runFileJob(job, inputPath).catch((err) => failJob(job, err));
  return job.id;
}

// Public entry: media/video URL.
export function startIngestFromUrl({ url, ownerId = null, ownerEmail = null }) {
  const job = newJob(deriveTitleFromUrl(url), ownerId, ownerEmail);
  runUrlJob(job, url).catch((err) => failJob(job, err));
  return job.id;
}

function newJob(title, ownerId = null, ownerEmail = null) {
  const id = randomUUID();
  const job = {
    id, status: "running", stage: "queued", stageLabel: STAGES.queued.label, progress: STAGES.queued.progress,
    projectId: null, error: null, title, ownerId, ownerEmail, emailWhenDone: false,
    canceled: false, abort: new AbortController(), createdAt: Date.now(), updatedAt: Date.now()
  };
  jobs.set(id, job);
  return job;
}

async function runUrlJob(job, url) {
  setStage(job, "fetching");
  let inputPath = null;
  try {
    ensureLive(job);
    inputPath = await downloadMediaFromUrl(url, { signal: job.abort.signal });
    await processToReport(job, inputPath);
  } finally {
    safeUnlink(inputPath);
  }
}

async function runFileJob(job, inputPath) {
  try {
    await processToReport(job, inputPath);
  } finally {
    safeUnlink(inputPath);
  }
}

function failJob(job, err) {
  if (job.canceled || err?.canceled || /abort/i.test(err?.message || "")) {
    console.log(`[ingest] ${job.id.slice(0, 8)} canceled`);
    if (job.status !== "canceled") setStage(job, "canceled");
    setTimeout(() => jobs.delete(job.id), 30000);
    return;
  }
  console.error(`[ingest] ${job.id.slice(0, 8)} failed:`, err?.stack || err?.message || err);
  setStage(job, "error", { error: err instanceof Error ? err.message : String(err) });
}

// The actual end-to-end work.
async function processToReport(job, inputPath) {
  if (!config.pyannoteApiKey) throw new Error("PYANNOTE_API_KEY is not set on the server.");
  const ownerId = job.ownerId;

  // 1) Audio → 16k mono wav.
  ensureLive(job);
  setStage(job, "extracting");
  const wavPath = await extractWav16kMono(inputPath, { signal: job.abort.signal });
  let projectId = null;
  let sessionId = null;
  try {
    ensureLive(job);
    const wavBuffer = fs.readFileSync(wavPath);

    // 2) pyannote precision-2 + whisper → speaker-attributed turns.
    setStage(job, "diarizing");
    const { output } = await diarizeAndTranscribe(config.pyannoteApiKey, wavBuffer, {
      objectKey: `debatly-${job.id}`,
      model: config.pyannoteBatchModel,
      transcription: true,
      transcriptionModel: config.pyannoteBatchTranscriptionModel,
      signal: job.abort.signal,
      onStage: (s) => { job.pyannoteStage = s; job.updatedAt = Date.now(); }
    });
    ensureLive(job);
    const turns = pyannoteTurnsToDebateTurns(output.turnLevelTranscription || []);
    if (!turns.length) throw new Error("No speech was found in this file.");
    const durationMs = Math.round(Math.max(0, ...turns.map((t) => Number(t.endSec) || 0)) * 1000);

    // 3) Create project + session, persist transcript.
    projectId = randomUUID();
    sessionId = randomUUID();
    await createPersistedLiveSession({ sessionId, projectId, startedAt: Date.now(), ownerId });
    for (const turn of turns) {
      await persistTranscriptTurn({ sessionId, projectId, turn });
    }

    // 4) Run the full clean pipeline over all turns (flush = process everything).
    ensureLive(job);
    setStage(job, "analyzing", { projectId });
    const state = createLiveAnalysisState();
    const payload = await analyzeLive(state, turns, { flush: true });
    await persistDebateStateSnapshot({ sessionId, projectId, seq: 1, analysis: payload, transcriptTurnCount: turns.length, durationMs });

    // 5) Report.
    ensureLive(job);
    setStage(job, "reporting", { projectId });
    const report = await runReportBuilder({ payload, transcriptTurns: turns, durationMs, sessionId });
    await persistDebateReport({ report, sessionId, projectId, ownerId, durationMs });
    await markSessionStopped({ sessionId, projectId, endedAt: Date.now(), durationMs, status: "report_ready" });

    // Title from the debate topic, if we got one.
    const topicTitle = compactTitle(payload?.topic || report?.topic || job.title);
    if (topicTitle) await updateDebateProjectTitle(projectId, topicTitle, { ownerId });

    setStage(job, "done", { projectId, title: topicTitle || job.title });

    // Email the user if they asked to be notified.
    if (job.emailWhenDone && job.ownerEmail) {
      const mail = reportReadyEmail({ title: topicTitle || job.title, projectId });
      void sendEmail({ to: job.ownerEmail, ...mail });
    }
  } finally {
    safeUnlink(wavPath);
  }
}

function deriveTitle(filename) {
  const base = String(filename || "").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return compactTitle(base) || "Uploaded debate";
}
function deriveTitleFromUrl(url) {
  try { const u = new URL(url); return compactTitle(`${u.hostname.replace(/^www\./, "")} debate`); }
  catch { return "Linked debate"; }
}
function compactTitle(t) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length <= 54 ? s : `${s.slice(0, 51).trim()}...`;
}
