// =============================================================================
// shared/audio-extract.mjs  —  any audio/video file → 16kHz mono PCM WAV.
// Uses the bundled ffmpeg-static binary (no system install required).
// =============================================================================

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg-static binary not found"));
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let err = "";
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-600)}`))));
  });
}

// Write an uploaded buffer to a temp file so ffmpeg can read it.
export function writeTempFile(buffer, ext = "") {
  const p = path.join(os.tmpdir(), `debatly-in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(p, buffer);
  return p;
}

// Convert any input (audio OR video) to a 16kHz mono 16-bit PCM WAV. Returns the
// output path. ffmpeg pulls the audio track out of videos automatically.
export async function extractWav16kMono(inputPath, { signal } = {}) {
  const outPath = path.join(os.tmpdir(), `debatly-wav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.wav`);
  await runFfmpeg([
    "-i", inputPath,
    "-vn",                 // drop any video stream
    "-ac", "1",            // mono
    "-ar", "16000",        // 16 kHz
    "-c:a", "pcm_s16le",   // 16-bit PCM
    "-y", outPath
  ], signal);
  return outPath;
}

// Best-effort cleanup of temp files.
export function safeUnlink(...paths) {
  for (const p of paths) {
    if (!p) continue;
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}
