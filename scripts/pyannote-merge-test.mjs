// =============================================================================
// scripts/pyannote-merge-test.mjs
// Offline test of the Speechmatics-words + pyannote-speakers MERGE.
//   1. Stream the cached WAV to pyannote streaming API -> speaker segments.
//   2. Load cached Speechmatics words, stitch their reset timeline -> continuous.
//   3. Relabel each word by the pyannote speaker whose segment covers its midpoint.
//   4. Re-group into turns; report speaker stats vs Speechmatics' own labels.
// No live server involved. Pyannote streaming is free (beta).
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const API_KEY = process.env.PYANNOTE_API_KEY || "sk_35c26418c9d1427697459a60b24d6ff6";
const audioPath = process.argv[2] || path.join(repoRoot, "Samples", "TEST 3", "Scenario 1 audio.wav");
const speechCache = path.join(repoRoot, ".cache", "scenario1-speechmatics.json");
const outPath = path.join(repoRoot, ".cache", "pyannote-segments.json");
const streamSeconds = Number(process.env.PYA_SECONDS || 1260);

// ---- WAV -> 16k mono float32 ------------------------------------------------
function parseWav(p) {
  const b = fs.readFileSync(p);
  let o = 12, fmt = null, dO = 0, dS = 0;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4);
    const sz = b.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), ba: b.readUInt16LE(body + 12), bps: b.readUInt16LE(body + 14) };
    else if (id === "data") { dO = body; dS = sz; break; }
    o += 8 + sz + (sz % 2);
  }
  return { b, fmt, dO, dS };
}

// Convert to 16k mono float32; return Float32Array of full clip (downmixed).
function toFloat32Mono16k({ b, fmt, dO, dS }, durationSec) {
  const srcFrames = Math.min(Math.floor(durationSec * fmt.sr), Math.floor(dS / fmt.ba));
  const ratio = fmt.sr / 16000;
  const outFrames = Math.floor(srcFrames / ratio);
  const out = new Float32Array(outFrames);
  for (let i = 0; i < outFrames; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(srcFrames, Math.floor((i + 1) * ratio));
    let sum = 0, n = 0;
    for (let s = start; s < end; s += 1) {
      // average channels (downmix) for 16-bit source
      let frame = 0;
      for (let c = 0; c < fmt.ch; c += 1) frame += b.readInt16LE(dO + s * fmt.ba + c * 2) / 32768;
      sum += frame / fmt.ch; n += 1;
    }
    out[i] = Math.max(-1, Math.min(1, n ? sum / n : 0));
  }
  return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("Parsing WAV…");
  const wav = parseWav(audioPath);
  const pcm = toFloat32Mono16k(wav, streamSeconds);
  console.log(`PCM: ${pcm.length} samples (${(pcm.length / 16000).toFixed(1)}s) @16k mono f32`);

  console.log("Creating pyannote stream session…");
  const sess = await fetch("https://api.pyannote.ai/v1/live", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: "{}"
  }).then((r) => r.json());
  if (!sess.url) throw new Error("No stream url from pyannote");

  const segments = []; // { speaker, start, end }
  const openTurns = new Map(); // speaker -> start
  const ws = new WebSocket(sess.url);
  const errors = [];
  ws.on("message", (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === "diarization_speaker_start") openTurns.set(m.data.speaker, m.data.timestamp);
    else if (m.type === "diarization_speaker_end") {
      const st = openTurns.get(m.data.speaker);
      if (st != null) { segments.push({ speaker: m.data.speaker, start: st, end: m.data.timestamp }); openTurns.delete(m.data.speaker); }
    } else if (m.type === "error") errors.push(m.message);
  });

  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  console.log("Connected. Streaming at real-time (100ms chunks)…");
  await delay(800);

  const CHUNK = 1600; // 100ms @16k
  const t0 = Date.now();
  for (let i = 0; i < pcm.length; i += CHUNK) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const slice = pcm.subarray(i, Math.min(pcm.length, i + CHUNK));
    ws.send(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
    if ((i / CHUNK) % 300 === 0) {
      const sentSec = (i / 16000).toFixed(0);
      console.log(`  streamed ${sentSec}s/${streamSeconds}s, segments=${segments.length}`);
    }
    await delay(100);
  }
  ws.send(JSON.stringify({ type: "end_of_stream" }));
  await delay(3000);
  if (ws.readyState === WebSocket.OPEN) ws.close();
  console.log(`Done streaming in ${((Date.now() - t0) / 1000).toFixed(0)}s. pyannote segments: ${segments.length}, errors: ${errors.length}`);
  if (errors.length) console.log("errors:", errors.slice(0, 3));

  fs.writeFileSync(outPath, JSON.stringify({ segments, errors }, null, 2));
  console.log(`Saved pyannote segments -> ${outPath}`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
