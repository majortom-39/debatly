// =============================================================================
// shared/media-url.mjs  —  download audio from a video/media URL via yt-dlp.
// Handles YouTube and the many sites yt-dlp supports, plus direct media links.
// Returns a local file path (bestaudio); the caller runs it through ffmpeg.
// =============================================================================

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ytdl from "youtube-dl-exec";

export async function downloadMediaFromUrl(url, { signal } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("That doesn't look like a valid URL."); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http(s) URLs are supported.");

  const id = randomUUID();
  const outTemplate = path.join(os.tmpdir(), `debatly-dl-${id}.%(ext)s`);
  await ytdl(url, {
    output: outTemplate,
    format: "bestaudio/best",
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    retries: 3,
    ffmpegLocation: ffmpegPath || undefined
  }, signal ? { signal } : undefined);

  // yt-dlp picks the container, so find whatever file it produced for our id.
  const dir = os.tmpdir();
  const produced = fs.readdirSync(dir).find((f) => f.startsWith(`debatly-dl-${id}.`));
  if (!produced) throw new Error("Could not download audio from that URL.");
  return path.join(dir, produced);
}
