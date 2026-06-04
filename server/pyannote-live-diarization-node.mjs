import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export function createPyannoteLiveDiarizationNodeConfig(config = {}) {
  const nodeConfig = {
    enabled: boolValue(config.pyannoteLiveEnabled ?? process.env.PYANNOTE_LIVE_ENABLED ?? "true"),
    pythonPath: config.pyannotePythonPath || process.env.PYANNOTE_PYTHON_PATH || "python",
    scriptPath: config.pyannoteLiveScriptPath || process.env.PYANNOTE_LIVE_SCRIPT_PATH || path.join(repoRoot, "scripts", "pyannote_live_worker.py"),
    model: config.pyannoteModel || process.env.PYANNOTE_MODEL || "pyannote/speaker-diarization-community-1",
    sampleRate: Number(config.pyannoteSampleRate || process.env.PYANNOTE_SAMPLE_RATE || 16000),
    device: config.pyannoteDevice || process.env.PYANNOTE_DEVICE || "auto",
    numSpeakers: optionalNumber(config.pyannoteNumSpeakers ?? process.env.PYANNOTE_NUM_SPEAKERS ?? ""),
    minSpeakers: optionalNumber(config.pyannoteMinSpeakers ?? process.env.PYANNOTE_MIN_SPEAKERS ?? ""),
    maxSpeakers: optionalNumber(config.pyannoteMaxSpeakers ?? process.env.PYANNOTE_MAX_SPEAKERS ?? ""),
    readyTimeoutMs: Number(config.pyannoteLiveReadyTimeoutMs || process.env.PYANNOTE_LIVE_READY_TIMEOUT_MS || 120000),
    requestTimeoutMs: Number(config.pyannoteLiveRequestTimeoutMs || process.env.PYANNOTE_LIVE_REQUEST_TIMEOUT_MS || 180000)
  };
  return {
    ...nodeConfig,
    summary: {
      enabled: nodeConfig.enabled,
      model: nodeConfig.model,
      sampleRate: nodeConfig.sampleRate,
      device: nodeConfig.device,
      numSpeakers: nodeConfig.numSpeakers,
      minSpeakers: nodeConfig.minSpeakers,
      maxSpeakers: nodeConfig.maxSpeakers,
      readyTimeoutMs: nodeConfig.readyTimeoutMs,
      requestTimeoutMs: nodeConfig.requestTimeoutMs
    }
  };
}

export function createPyannoteLiveDiarizationNode(config = {}, hooks = {}) {
  return new PyannoteLiveDiarizationNode(config.summary ? config : createPyannoteLiveDiarizationNodeConfig(config), hooks);
}

class PyannoteLiveDiarizationNode {
  constructor(config, hooks = {}) {
    this.config = config;
    this.hooks = hooks;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.closed = false;
    this.readyInfo = null;
    this.child = null;
    this.readyPromise = this.start();
  }

  start() {
    if (!this.config.enabled) return Promise.resolve(null);
    this.child = spawn(this.config.pythonPath, [this.config.scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYANNOTE_METRICS_ENABLED: "0",
        PYANNOTE_MODEL: this.config.model,
        PYANNOTE_SAMPLE_RATE: String(this.config.sampleRate),
        PYANNOTE_DEVICE: this.config.device,
        ...(this.config.numSpeakers ? { PYANNOTE_NUM_SPEAKERS: String(this.config.numSpeakers) } : {}),
        ...(this.config.minSpeakers ? { PYANNOTE_MIN_SPEAKERS: String(this.config.minSpeakers) } : {}),
        ...(this.config.maxSpeakers ? { PYANNOTE_MAX_SPEAKERS: String(this.config.maxSpeakers) } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.handleStderr(chunk));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code) => {
      this.closed = true;
      this.rejectAll(new Error(`pyannote live worker closed with code ${code}`));
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`pyannote live worker did not become ready within ${this.config.readyTimeoutMs}ms`));
      }, Math.max(1000, this.config.readyTimeoutMs));
      this.readyResolver = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.readyRejecter = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  async diarizePcm16Window({ audioBuffer, sampleRate, windowStartSec = 0, settings = {} }) {
    if (!this.config.enabled) return null;
    if (this.closed || !this.child?.stdin?.writable) throw new Error("pyannote live worker is not writable");
    await this.readyPromise;
    const id = randomUUID();
    const payload = {
      id,
      type: "diarize_pcm16",
      sampleRate: Number(sampleRate || this.config.sampleRate || 16000),
      windowStartSec: Number(windowStartSec || 0),
      settings: {
        numSpeakers: settings.numSpeakers ?? this.config.numSpeakers ?? null,
        minSpeakers: settings.minSpeakers ?? this.config.minSpeakers ?? null,
        maxSpeakers: settings.maxSpeakers ?? this.config.maxSpeakers ?? null
      },
      audioBase64: Buffer.from(audioBuffer || []).toString("base64")
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pyannote live diarization timed out after ${this.config.requestTimeoutMs}ms`));
      }, Math.max(1000, this.config.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  // Send a batch of Speechmatics final words; returns any turns ready to emit.
  async addWords(words = []) {
    return this._request({ type: "add_words", words });
  }

  // Force-flush remaining buffered turns (e.g. on stop).
  async flushTurns(force = true) {
    return this._request({ type: "flush", force: Boolean(force) });
  }

  async _request(message) {
    if (!this.config.enabled) return null;
    if (this.closed || !this.child?.stdin?.writable) throw new Error("pyannote live worker is not writable");
    await this.readyPromise;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pyannote live request '${message.type}' timed out after ${this.config.requestTimeoutMs}ms`));
      }, Math.max(1000, this.config.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...message })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  stop() {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("pyannote live worker stopped"));
    }
    this.pending.clear();
    if (this.child?.stdin?.writable) {
      try {
        this.child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "stop" })}\n`);
      } catch {
        // The process may already be closing.
      }
    }
    setTimeout(() => {
      if (!this.child?.killed) this.child?.kill();
    }, 500).unref?.();
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString();
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleMessageLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleStderr(chunk) {
    this.stderrBuffer += chunk.toString();
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (text) this.hooks.onLog?.({ level: "warn", stage: "stderr", message: text.slice(0, 500) });
    }
  }

  handleMessageLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.hooks.onLog?.({ level: "warn", stage: "parse_error", message: error instanceof Error ? error.message : "worker JSON parse error" });
      return;
    }
    if (message.type === "ready") {
      this.readyInfo = message;
      this.hooks.onLog?.({ level: "info", stage: "ready", message });
      this.readyResolver?.(message);
      return;
    }
    const id = String(message.id || "");
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.type === "error") {
      pending.reject(new Error(message.message || "pyannote live worker error"));
    } else {
      pending.resolve(message);
    }
  }

  rejectAll(error) {
    this.readyRejecter?.(error);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

function boolValue(value) {
  return String(value ?? "").toLowerCase() !== "false";
}

function optionalNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
