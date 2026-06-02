import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const [audioPath, outPath] = process.argv.slice(2);
if (!audioPath || !outPath) {
  console.error("Usage: node --env-file=.env scripts/deepgram_batch_words.mjs <audio.wav> <out.json>");
  process.exit(2);
}

const apiKey = process.env.DEEPGRAM_API_KEY || "";
if (!apiKey.trim()) {
  console.error("DEEPGRAM_API_KEY is not set");
  process.exit(2);
}

const absoluteAudioPath = path.resolve(audioPath);
const absoluteOutPath = path.resolve(outPath);
const stat = fs.statSync(absoluteAudioPath);
const query = new URLSearchParams({
  model: process.env.DEEPGRAM_BATCH_MODEL || "nova-3",
  language: process.env.DEEPGRAM_LANGUAGE || "en",
  punctuate: "true",
  smart_format: "true"
});

const requestOptions = {
  method: "POST",
  hostname: "api.deepgram.com",
  path: `/v1/listen?${query.toString()}`,
  headers: {
    Authorization: `Token ${apiKey}`,
    "Content-Type": "audio/wav",
    "Content-Length": stat.size
  },
  timeout: Number(process.env.DEEPGRAM_BATCH_TIMEOUT_MS || 900_000)
};

const startedAt = Date.now();
const responseText = await new Promise((resolve, reject) => {
  const request = https.request(requestOptions, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Deepgram batch failed with HTTP ${response.statusCode}: ${body.slice(0, 500)}`));
        return;
      }
      resolve(body);
    });
  });
  request.on("timeout", () => request.destroy(new Error("Deepgram batch request timed out")));
  request.on("error", reject);
  fs.createReadStream(absoluteAudioPath).pipe(request);
});

fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
fs.writeFileSync(absoluteOutPath, responseText);

const payload = JSON.parse(responseText);
const alternative = payload?.results?.channels?.[0]?.alternatives?.[0] || {};
console.log(JSON.stringify({
  out: outPath,
  durationSec: payload?.metadata?.duration ?? null,
  wordCount: Array.isArray(alternative.words) ? alternative.words.length : 0,
  transcriptChars: String(alternative.transcript || "").length,
  elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(3))
}));
