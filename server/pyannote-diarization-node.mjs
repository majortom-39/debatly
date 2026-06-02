import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export function createPyannoteDiarizationNodeConfig(config = {}) {
  return {
    pythonPath: config.pyannotePythonPath || process.env.PYANNOTE_PYTHON_PATH || "python",
    scriptPath: config.pyannoteScriptPath || process.env.PYANNOTE_SCRIPT_PATH || path.join(repoRoot, "scripts", "pyannote_diarization_node.py"),
    model: config.pyannoteModel || process.env.PYANNOTE_MODEL || "pyannote/speaker-diarization-community-1",
    sampleRate: Number(config.pyannoteSampleRate || process.env.PYANNOTE_SAMPLE_RATE || 16000),
    device: config.pyannoteDevice || process.env.PYANNOTE_DEVICE || "auto",
    minSpeakers: optionalNumber(config.pyannoteMinSpeakers ?? process.env.PYANNOTE_MIN_SPEAKERS ?? ""),
    maxSpeakers: optionalNumber(config.pyannoteMaxSpeakers ?? process.env.PYANNOTE_MAX_SPEAKERS ?? ""),
    numSpeakers: optionalNumber(config.pyannoteNumSpeakers ?? process.env.PYANNOTE_NUM_SPEAKERS ?? "")
  };
}

export function runPyannoteDiarizationNode(options = {}) {
  const nodeConfig = createPyannoteDiarizationNodeConfig(options.config || {});
  if (!options.audioPath) throw new Error("audioPath is required");
  if (!options.outPath) throw new Error("outPath is required");

  const args = [
    nodeConfig.scriptPath,
    "--audio", options.audioPath,
    "--out", options.outPath,
    "--model", nodeConfig.model,
    "--sample-rate", String(nodeConfig.sampleRate),
    "--device", nodeConfig.device
  ];

  if (options.csvPath) args.push("--csv", options.csvPath);
  if (nodeConfig.numSpeakers) {
    args.push("--num-speakers", String(nodeConfig.numSpeakers));
  } else {
    if (nodeConfig.minSpeakers) args.push("--min-speakers", String(nodeConfig.minSpeakers));
    if (nodeConfig.maxSpeakers) args.push("--max-speakers", String(nodeConfig.maxSpeakers));
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(nodeConfig.pythonPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYANNOTE_METRICS_ENABLED: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const elapsedMs = Date.now() - startedAt;
      if (code !== 0) {
        reject(new Error(`pyannote diarization failed with code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({
        code,
        elapsedMs,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        outPath: options.outPath,
        csvPath: options.csvPath || ""
      });
    });
  });
}

function optionalNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
