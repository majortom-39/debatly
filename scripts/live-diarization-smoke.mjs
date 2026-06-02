import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const audioPath = process.argv[2] || path.join(repoRoot, "Samples", "TEST 3", "Scenario 1 audio.wav");
const outPath = process.argv[3] || path.join(repoRoot, ".benchmarks", `live-diarization-smoke-${Date.now()}.json`);
const wsUrl = process.env.LIVE_WS_URL || "ws://127.0.0.1:8787/live";
const seconds = Number(process.env.LIVE_DIA_SECONDS || 300);
const chunkBytes = Number(process.env.LIVE_DIA_CHUNK_BYTES || 1600);
const streamSpeed = Math.max(0.1, Number(process.env.LIVE_DIA_STREAM_SPEED || 1));
const waitForHybrid = String(process.env.LIVE_DIA_WAIT_FOR_HYBRID || "false").toLowerCase() === "true";

function parseWav(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a WAV file: ${filePath}`);
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14)
      };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !dataOffset) throw new Error("WAV fmt/data chunks not found");
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV format: ${JSON.stringify(fmt)}`);
  }
  return { buffer, fmt, dataOffset, dataSize };
}

function wavToBrowserPcm16kMono({ buffer, fmt, dataOffset, dataSize }, durationSec) {
  const sourceFrames = Math.min(
    Math.floor(durationSec * fmt.sampleRate),
    Math.floor(dataSize / fmt.blockAlign)
  );
  const ratio = fmt.sampleRate / 16000;
  const outputFrames = Math.floor(sourceFrames / ratio);
  const output = Buffer.alloc(outputFrames * 2);
  for (let index = 0; index < outputFrames; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(sourceFrames, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      const sampleOffset = dataOffset + inputIndex * fmt.blockAlign;
      sum += buffer.readInt16LE(sampleOffset) / 32768;
    }
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), index * 2);
  }
  return output;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function main() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const wav = parseWav(audioPath);
  const pcm = wavToBrowserPcm16kMono(wav, seconds);
  const result = {
    audioPath,
    outPath,
    wsUrl,
    seconds,
    streamSpeed,
    wav: wav.fmt,
    startedAt: new Date().toISOString(),
    sessionId: "",
    messages: [],
    finalTurns: [],
    status: [],
    acks: [],
    errors: []
  };

  const ws = new WebSocket(wsUrl);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    result.messages.push(parsed);
    if (parsed.sessionId && !result.sessionId) result.sessionId = parsed.sessionId;
    if (parsed.type === "transcript" && parsed.turn?.isFinal) result.finalTurns.push(parsed.turn);
    if (parsed.type === "diarization_status" || parsed.type === "ready" || parsed.type === "analysis_status") {
      result.status.push(parsed);
    }
    if (parsed.type === "audio_ack") result.acks.push(parsed);
    if (parsed.type === "error") result.errors.push(parsed);
  });

  await waitForOpen(ws);
  const readyDeadline = Date.now() + Number(process.env.LIVE_DIA_READY_TIMEOUT_MS || (waitForHybrid ? 120000 : 20000));
  while (
    Date.now() < readyDeadline
    && !result.status.some((item) => (
      item.type === "diarization_status"
      && item.status === "ready"
      && (!waitForHybrid || /pyannote/i.test(String(item.message || "")))
    ))
    && !result.errors.length
  ) {
    await delay(100);
  }
  if (result.errors.length) throw new Error(`Live websocket error: ${JSON.stringify(result.errors[0])}`);

  const chunkDurationMs = (chunkBytes / 2 / 16000) * 1000;
  let sentBytes = 0;
  let lastProgressAt = 0;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + chunkBytes));
    ws.send(chunk);
    sentBytes += chunk.length;
    const sentSec = sentBytes / 2 / 16000;
    if (Date.now() - lastProgressAt >= 15000 || sentBytes === pcm.length) {
      lastProgressAt = Date.now();
      console.log(`[live-diarization-smoke] streamed ${sentSec.toFixed(1)}s/${seconds}s, finalTurns=${result.finalTurns.length}`);
    }
    await delay(chunkDurationMs / streamSpeed);
  }
  result.sentBytes = sentBytes;
  result.audioSecondsSent = Number((sentBytes / 2 / 16000).toFixed(3));

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop", elapsedMs: Math.round(result.audioSecondsSent * 1000) }));
  }
  const closeDeadline = Date.now() + 15000;
  while (Date.now() < closeDeadline && ws.readyState === WebSocket.OPEN) {
    await delay(250);
  }
  if (ws.readyState === WebSocket.OPEN) ws.close();

  result.finishedAt = new Date().toISOString();
  result.finalSpeakerCounts = result.finalTurns.reduce((acc, turn) => {
    acc[turn.speakerId] = (acc[turn.speakerId] || 0) + 1;
    return acc;
  }, {});
  result.finalSpeakerSources = result.finalTurns.reduce((acc, turn) => {
    const source = turn.speakerSource || "unknown";
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    outPath,
    sessionId: result.sessionId,
    finalTurns: result.finalTurns.length,
    finalSpeakerCounts: result.finalSpeakerCounts,
    finalSpeakerSources: result.finalSpeakerSources,
    audioSecondsSent: result.audioSecondsSent,
    errors: result.errors
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
