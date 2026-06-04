#!/usr/bin/env python
"""Live speaker diarization worker (Utterr online-clustering engine).

This replaces the per-window full-pipeline worker with a STATEFUL streaming
engine: it keeps persistent speaker profiles (voice fingerprints) across the
whole session, so a speaker keeps the same label for the entire debate instead
of being re-diarized independently every window.

Pipeline per session (one worker process == one live session):
  Silero VAD  ->  pyannote/wespeaker embedding  ->  online profile clustering

Protocol (unchanged, newline-delimited JSON over stdin/stdout) so the existing
Node `PyannoteLiveDiarizationNode` keeps working without changes:
  in : {"id","type":"diarize_pcm16","sampleRate","windowStartSec","audioBase64",...}
  out: {"id","type":"result","segments":[{start,end,duration,speaker}],
        "exclusiveSpeakerDiarization":[...], "speakerDiarization":[...],
        "summary":{...}, "timings":{...}, "audio":{...}}
  in : {"id","type":"stop"}  -> out: {"id","type":"stopped"}

Node sends overlapping rolling windows (a tail buffer of the last N seconds).
This worker tracks absolute time and only consumes the NEW audio past what it
has already processed, so overlapping windows are not double-counted. Returned
segment times are ABSOLUTE seconds (aligned to the audio/Speechmatics timeline),
so Node does not add any offset.
"""

from __future__ import annotations

import base64
import json
import math
import os
import sys
import time
import traceback
import warnings
from collections import deque
from fractions import Fraction

import numpy as np
import torch

os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")
warnings.filterwarnings("ignore", message=".*torchcodec is not installed correctly.*")
warnings.filterwarnings("ignore", category=UserWarning, module=r"pyannote\.audio\.core\.io")
warnings.filterwarnings("ignore", category=UserWarning, module=r"pyannote\.audio\.models\.blocks\.pooling")
warnings.filterwarnings("ignore", message=".*degrees of freedom is <= 0.*")


# --- Tunables (env-overridable, defaults are Utterr's proven live settings) ----
def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


SAMPLE_RATE = env_int("PYANNOTE_SAMPLE_RATE", 16_000)
WINDOW_SECONDS = env_float("DIA_WINDOW_SECONDS", 1.5)
STEP_SECONDS = env_float("DIA_STEP_SECONDS", 0.5)
ASSIGN_THRESHOLD = env_float("DIA_ASSIGN_THRESHOLD", 0.30)
UPDATE_THRESHOLD = env_float("DIA_UPDATE_THRESHOLD", 0.44)
PENDING_CLUSTER_DISTANCE = env_float("DIA_PENDING_CLUSTER_DISTANCE", 0.80)
MIN_NEW_SPEAKER_WINDOWS = env_int("DIA_MIN_NEW_SPEAKER_WINDOWS", 6)
MAX_PROFILE_EMBEDDINGS = env_int("DIA_MAX_PROFILE_EMBEDDINGS", 220)
MAX_SPEAKERS = env_int("DIA_MAX_SPEAKERS", 20)
VAD_THRESHOLD = env_float("DIA_VAD_THRESHOLD", 0.5)
NEW_SPEAKER_RECHECK_THRESHOLD = env_float("DIA_NEW_SPEAKER_RECHECK_THRESHOLD", 0.55)
# How much recent audio to keep buffered for windowing (profiles persist beyond this).
KEEP_SECONDS = env_float("DIA_KEEP_SECONDS", 45.0)
# Word -> speaker assignment / turn building (Utterr's live settings).
LABEL_DELAY_SECONDS = env_float("DIA_LABEL_DELAY_SECONDS", 2.0)
WORD_TURN_MERGE_GAP_SECONDS = env_float("DIA_WORD_TURN_MERGE_GAP_SECONDS", 0.8)
TRANSCRIPT_MIN_PROFILE_WINDOWS = env_int("DIA_TRANSCRIPT_MIN_PROFILE_WINDOWS", 3)
MAX_FLUSH_WAIT_SECONDS = env_float("DIA_MAX_FLUSH_WAIT_SECONDS", 8.0)
PUNCTUATION_ATTACH = {".", ",", "?", "!", ":", ";", "%", ")", "]", "}"}


def append_word_token(text: str, token: str, result_type: str) -> str:
    token = token.strip()
    if not token:
        return text
    if not text:
        return token
    if result_type == "punctuation" or token in PUNCTUATION_ATTACH:
        return f"{text}{token}"
    if text.endswith(("(", "[", "{", "$", "#")):
        return f"{text}{token}"
    return f"{text} {token}"


def word_gap(previous_end, start) -> float:
    if previous_end is None or start is None:
        return 0.0
    try:
        return float(start) - float(previous_end)
    except (TypeError, ValueError):
        return 0.0

DEFAULT_EMBED_MODEL = os.getenv("PYANNOTE_EMBED_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")


def l2_normalize(vector: np.ndarray) -> np.ndarray:
    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if norm <= 1e-12:
        return vector
    return vector / norm


def write_message(message: dict) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def token_from_env():
    for name in ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HUGGINGFACE_HUB_TOKEN", "PYANNOTE_HF_TOKEN"):
        value = os.getenv(name, "").strip()
        if value:
            return value
    return None


def select_device(requested: str) -> torch.device:
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("PYANNOTE_DEVICE=cuda requested, but CUDA is unavailable.")
        return torch.device("cuda")
    if requested == "auto" and torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def pcm16_to_float_mono(audio_bytes: bytes, sample_rate: int) -> np.ndarray:
    """Decode little-endian PCM16 mono to float32 [-1, 1] at SAMPLE_RATE."""
    if not audio_bytes:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(audio_bytes, dtype="<i2").astype(np.float32) / 32768.0
    if sample_rate != SAMPLE_RATE and samples.size:
        ratio = Fraction(SAMPLE_RATE, sample_rate).limit_denominator(1000)
        from scipy.signal import resample_poly

        samples = resample_poly(samples, ratio.numerator, ratio.denominator).astype(np.float32, copy=False)
    return np.ascontiguousarray(np.clip(np.nan_to_num(samples, copy=False), -1.0, 1.0))


# ------------------------------------------------------------------------------
# Diarization engine (models loaded once)
# ------------------------------------------------------------------------------
class DiarizationEngine:
    def __init__(self) -> None:
        requested_device = os.getenv("PYANNOTE_DEVICE", "auto")
        self.device = select_device(requested_device)
        self.embed_model = DEFAULT_EMBED_MODEL
        self._load_vad()
        self._load_embedder()

    def _load_vad(self) -> None:
        # Prefer the pip package; fall back to torch.hub (both ship Silero VAD).
        try:
            from silero_vad import load_silero_vad, get_speech_timestamps

            self.vad_model = load_silero_vad()
            self._get_speech_ts = get_speech_timestamps
            return
        except Exception:
            pass
        model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
            onnx=False,
        )
        self.vad_model = model
        self._get_speech_ts = utils[0]

    def _load_embedder(self) -> None:
        from pyannote.audio import Inference, Model

        token = token_from_env()
        try:
            model = Model.from_pretrained(self.embed_model, use_auth_token=token or False)
        except TypeError:
            # Older/newer pyannote signature uses `token=`.
            model = Model.from_pretrained(self.embed_model, token=token) if token else Model.from_pretrained(self.embed_model)
        model = model.to(self.device)
        self.embedding_inference = Inference(model, window="whole", device=self.device)

    def is_speech(self, audio: np.ndarray) -> bool:
        if audio.shape[0] < int(0.4 * SAMPLE_RATE):
            return False
        with torch.no_grad():
            timestamps = self._get_speech_ts(
                torch.from_numpy(audio.astype(np.float32)),
                self.vad_model,
                threshold=VAD_THRESHOLD,
                sampling_rate=SAMPLE_RATE,
                min_speech_duration_ms=150,
                min_silence_duration_ms=120,
                speech_pad_ms=80,
            )
        return len(timestamps) > 0

    def embed(self, audio: np.ndarray) -> np.ndarray:
        waveform = torch.from_numpy(audio.astype(np.float32)).unsqueeze(0)
        with torch.no_grad():
            embedding = self.embedding_inference({"waveform": waveform, "sample_rate": SAMPLE_RATE})
        return l2_normalize(np.asarray(embedding, dtype=np.float32).reshape(-1))


class Profile:
    __slots__ = ("label", "embeddings")

    def __init__(self, label: str) -> None:
        self.label = label
        self.embeddings = deque(maxlen=MAX_PROFILE_EMBEDDINGS)

    def centroid(self) -> np.ndarray:
        return l2_normalize(np.mean(np.stack(self.embeddings, axis=0), axis=0))

    def add(self, embedding: np.ndarray) -> None:
        self.embeddings.append(embedding)


class PendingWindow:
    __slots__ = ("start", "end", "embedding")

    def __init__(self, start: float, end: float, embedding: np.ndarray) -> None:
        self.start = start
        self.end = end
        self.embedding = embedding


# ------------------------------------------------------------------------------
# Stateful session: absolute-time streaming online clustering
# ------------------------------------------------------------------------------
class StreamingSession:
    def __init__(self, engine: DiarizationEngine) -> None:
        self.engine = engine
        self.buffer = np.zeros(0, dtype=np.float32)
        self.buffer_start_abs = 0.0  # absolute time of buffer[0]
        self.cursor_abs = None       # next window start to process (absolute)
        self.profiles: list[Profile] = []
        self.pending: list[PendingWindow] = []
        # timeline: list of (start_abs, end_abs, label) for assigned speech windows
        self.timeline: list[tuple[float, float, str]] = []
        self.coverage_end_abs = 0.0   # how far diarization has looked (absolute sec)
        self.last_speaker = "Unknown"
        # buffered Speechmatics word batches awaiting label-delay flush
        self.pending_chunks: list[dict] = []

    @property
    def buffer_end_abs(self) -> float:
        return self.buffer_start_abs + self.buffer.shape[0] / SAMPLE_RATE

    def ingest(self, samples: np.ndarray, window_start_abs: float, window_end_abs: float) -> None:
        """Append only the audio newer than what we've already buffered."""
        if samples.size == 0:
            return
        if self.buffer.size == 0:
            self.buffer = samples.copy()
            self.buffer_start_abs = window_start_abs
            if self.cursor_abs is None:
                self.cursor_abs = window_start_abs
            self._trim()
            return

        current_end = self.buffer_end_abs
        if window_end_abs <= current_end + 1e-6:
            return  # nothing new
        if window_start_abs > current_end + 0.1:
            # Gap (Node trimmed its buffer / we missed audio). Jump forward.
            self.buffer = samples.copy()
            self.buffer_start_abs = window_start_abs
            if self.cursor_abs is None or self.cursor_abs < window_start_abs:
                self.cursor_abs = window_start_abs
            self._trim()
            return
        # Take the tail of `samples` past current_end.
        offset = int(round((current_end - window_start_abs) * SAMPLE_RATE))
        offset = max(0, min(offset, samples.shape[0]))
        new_samples = samples[offset:]
        if new_samples.size:
            self.buffer = np.concatenate([self.buffer, new_samples])
        self._trim()

    def _trim(self) -> None:
        max_samples = int(KEEP_SECONDS * SAMPLE_RATE)
        if self.buffer.shape[0] <= max_samples:
            return
        drop = self.buffer.shape[0] - max_samples
        self.buffer = self.buffer[drop:]
        self.buffer_start_abs += drop / SAMPLE_RATE
        if self.cursor_abs is not None and self.cursor_abs < self.buffer_start_abs:
            self.cursor_abs = self.buffer_start_abs

    def process(self) -> None:
        """Run sliding windows over freshly available buffered audio."""
        if self.cursor_abs is None:
            return
        while self.cursor_abs + WINDOW_SECONDS <= self.buffer_end_abs + 1e-6:
            start_abs = self.cursor_abs
            end_abs = start_abs + WINDOW_SECONDS
            local_start = int(round((start_abs - self.buffer_start_abs) * SAMPLE_RATE))
            local_end = local_start + int(round(WINDOW_SECONDS * SAMPLE_RATE))
            if local_start < 0:
                self.cursor_abs += STEP_SECONDS
                continue
            window = self.buffer[local_start:local_end]
            if window.shape[0] >= int(WINDOW_SECONDS * SAMPLE_RATE * 0.8):
                self._process_window(window, start_abs, end_abs)
            self.coverage_end_abs = max(self.coverage_end_abs, end_abs)
            self.cursor_abs += STEP_SECONDS

    def _process_window(self, audio: np.ndarray, start: float, end: float) -> None:
        if not self.engine.is_speech(audio):
            return
        embedding = self.engine.embed(audio)
        if embedding is None:
            return
        label = self._assign(start, end, embedding)
        if label not in {"Pending", "Silence"}:
            self.timeline.append((start, end, label))
            self.last_speaker = label
        self._promote_pending()

    def _assign(self, start: float, end: float, embedding: np.ndarray) -> str:
        if not self.profiles:
            return self._new_profile([embedding]).label
        profile, similarity = self._best_profile(embedding)
        if profile is not None and similarity >= ASSIGN_THRESHOLD:
            if similarity >= UPDATE_THRESHOLD:
                profile.add(embedding)
            return profile.label
        self.pending.append(PendingWindow(start, end, embedding))
        return "Pending"

    def _best_profile(self, embedding: np.ndarray):
        if not self.profiles:
            return None, -1.0
        scores = [(profile, float(np.dot(profile.centroid(), embedding))) for profile in self.profiles]
        return max(scores, key=lambda item: item[1])

    def _new_profile(self, embeddings: list[np.ndarray]) -> Profile:
        profile = Profile(f"Speaker {len(self.profiles) + 1}")
        for embedding in embeddings:
            profile.add(embedding)
        self.profiles.append(profile)
        return profile

    def _promote_pending(self) -> None:
        if len(self.pending) < MIN_NEW_SPEAKER_WINDOWS or len(self.profiles) >= MAX_SPEAKERS:
            return
        embeddings = np.stack([p.embedding for p in self.pending], axis=0)
        if len(self.pending) == MIN_NEW_SPEAKER_WINDOWS:
            distances = 1.0 - np.matmul(embeddings, embeddings.T)
            upper = distances[np.triu_indices_from(distances, k=1)]
            cluster_indices = list(range(len(self.pending))) if float(np.mean(upper)) <= PENDING_CLUSTER_DISTANCE else []
        else:
            from sklearn.cluster import AgglomerativeClustering

            clustering = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=PENDING_CLUSTER_DISTANCE,
                metric="cosine",
                linkage="average",
            )
            labels = clustering.fit_predict(embeddings)
            counts = {label: int(np.sum(labels == label)) for label in set(labels)}
            best_label = max(counts, key=counts.get)
            cluster_indices = [i for i, label in enumerate(labels) if label == best_label]
            if len(cluster_indices) < MIN_NEW_SPEAKER_WINDOWS:
                cluster_indices = []

        if not cluster_indices:
            if len(self.pending) > 24:
                self.pending = self.pending[-12:]
            return

        promoted = [self.pending[i] for i in cluster_indices]
        promoted_embeddings = [item.embedding for item in promoted]
        promoted_centroid = l2_normalize(np.mean(np.stack(promoted_embeddings, axis=0), axis=0))
        profile, profile_similarity = self._best_profile(promoted_centroid)
        if profile is not None and profile_similarity >= NEW_SPEAKER_RECHECK_THRESHOLD:
            for embedding in promoted_embeddings:
                profile.add(embedding)
        else:
            profile = self._new_profile(promoted_embeddings)

        keep = set(cluster_indices)
        self.pending = [item for i, item in enumerate(self.pending) if i not in keep]
        self.last_speaker = profile.label
        for item in promoted:
            self.timeline.append((item.start, item.end, profile.label))

    def segments_in(self, window_start: float, window_end: float) -> list[dict]:
        """Merge timeline windows into segments overlapping [start, end]."""
        if not self.timeline:
            return []
        ordered = sorted(self.timeline, key=lambda item: (item[0], item[1]))
        merged: list[list] = []
        for start, end, label in ordered:
            if merged and merged[-1][2] == label and start <= merged[-1][1] + STEP_SECONDS + 1e-6:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end, label])
        out = []
        for start, end, label in merged:
            if end <= window_start or start >= window_end:
                continue
            if not math.isfinite(start) or not math.isfinite(end) or end <= start:
                continue
            out.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
                "speaker": label,
            })
        return out

    def speaker_summary(self) -> dict:
        by_speaker = {p.label: {"windows": len(p.embeddings)} for p in self.profiles}
        return {"speakerCount": len(self.profiles), "bySpeaker": by_speaker}

    # --- Utterr word -> speaker assignment (always picks a diarized speaker) ----
    def _stable_speakers(self) -> set:
        return {p.label for p in self.profiles if len(p.embeddings) >= TRANSCRIPT_MIN_PROFILE_WINDOWS}

    def _speaker_candidates(self) -> list[tuple[float, float, str]]:
        return [(s, e, l) for (s, e, l) in self.timeline if l not in {"Silence", "Pending"}]

    def _dominant_speaker(self, start: float, end: float, candidates) -> str | None:
        if end <= start:
            return None
        totals: dict[str, float] = {}
        for seg_start, seg_end, label in candidates:
            overlap = max(0.0, min(end, seg_end) - max(start, seg_start))
            if overlap > 0.0:
                totals[label] = totals.get(label, 0.0) + overlap
        if not totals:
            return None
        return max(totals.items(), key=lambda kv: kv[1])[0]

    def speaker_at(self, start, end) -> str:
        if start is None and end is None:
            return self.last_speaker
        if start is None:
            midpoint = float(end)
        elif end is None:
            midpoint = float(start)
        else:
            midpoint = (float(start) + float(end)) / 2.0

        all_candidates = self._speaker_candidates()
        if not all_candidates:
            return self.last_speaker
        stable = self._stable_speakers()
        stable_candidates = [c for c in all_candidates if c[2] in stable]
        candidates = stable_candidates or all_candidates

        if start is not None and end is not None:
            dominant = self._dominant_speaker(float(start), float(end), candidates)
            if dominant is not None:
                return dominant

        covering = [c for c in candidates if c[0] <= midpoint <= c[1]]
        if covering:
            return covering[-1][2]

        nearest = min(candidates, key=lambda c: min(abs(midpoint - c[0]), abs(midpoint - c[1])))
        return nearest[2]

    def build_turns(self, words: list[dict]) -> list[dict]:
        """Assign each Speechmatics word to a diarized speaker and merge into turns."""
        starts = [w["start"] for w in words if w.get("start") is not None]
        ends = [w["end"] for w in words if w.get("end") is not None]
        chunk_speaker = self.speaker_at(min(starts) if starts else None, max(ends) if ends else None)

        turns: list[dict] = []
        current: dict | None = None
        previous_word_speaker: str | None = None

        def close_current() -> None:
            nonlocal current
            if current is not None and str(current.get("text") or "").strip():
                turns.append(current)
            current = None

        for word in words:
            result_type = word.get("type") or "word"
            if result_type == "punctuation" and current is not None:
                speaker = str(current.get("speaker") or previous_word_speaker or chunk_speaker or "Unknown")
            else:
                speaker = self.speaker_at(word.get("start"), word.get("end"))
                if speaker in {"Silence", "Pending"} or not speaker:
                    speaker = previous_word_speaker or chunk_speaker or "Unknown"

            token = str(word.get("text") or "").strip()
            if not token:
                continue

            if result_type == "punctuation" and current is not None:
                current["text"] = append_word_token(str(current.get("text") or ""), token, result_type)
                if word.get("end") is not None:
                    current["end"] = word.get("end")
                continue

            gap = word_gap(current.get("end") if current else None, word.get("start"))
            if current is not None and current.get("speaker") == speaker and gap <= WORD_TURN_MERGE_GAP_SECONDS:
                current["text"] = append_word_token(str(current.get("text") or ""), token, result_type)
                if word.get("end") is not None:
                    current["end"] = word.get("end")
                current["word_count"] = int(current.get("word_count") or 0) + 1
            else:
                close_current()
                current = {
                    "speaker": speaker,
                    "start": word.get("start"),
                    "end": word.get("end"),
                    "text": token,
                    "word_count": 1,
                }

            if result_type != "punctuation":
                previous_word_speaker = speaker

        close_current()
        for turn in turns:
            turn["start"] = round(float(turn["start"]), 3) if turn.get("start") is not None else None
            turn["end"] = round(float(turn["end"]), 3) if turn.get("end") is not None else None
        return turns

    def queue_words(self, words: list[dict]) -> None:
        clean = [w for w in words if str(w.get("text") or "").strip()]
        if not clean:
            return
        ends = [w["end"] for w in clean if w.get("end") is not None]
        starts = [w["start"] for w in clean if w.get("start") is not None]
        marker = max(ends) if ends else (max(starts) if starts else None)
        self.pending_chunks.append({"words": clean, "marker": marker, "queued_at": time.time()})

    def flush_turns(self, force: bool = False) -> list[dict]:
        ready: list[dict] = []
        keep: list[dict] = []
        now = time.time()
        for chunk in self.pending_chunks:
            marker = chunk.get("marker")
            diarization_ready = marker is None or self.coverage_end_abs >= float(marker) + LABEL_DELAY_SECONDS
            waited_too_long = now - float(chunk.get("queued_at", now)) >= MAX_FLUSH_WAIT_SECONDS
            if force or diarization_ready or waited_too_long:
                ready.append(chunk)
            else:
                keep.append(chunk)
        self.pending_chunks = keep
        out: list[dict] = []
        for chunk in ready:
            out.extend(self.build_turns(chunk["words"]))
        return out


def main() -> int:
    started = time.time()
    engine = DiarizationEngine()
    session = StreamingSession(engine)
    write_message({
        "type": "ready",
        "engine": "utterr-online-clustering",
        "embedModel": engine.embed_model,
        "device": str(engine.device),
        "sampleRate": SAMPLE_RATE,
        "loadSec": round(time.time() - started, 3),
        "settings": {
            "windowSeconds": WINDOW_SECONDS,
            "stepSeconds": STEP_SECONDS,
            "assignThreshold": ASSIGN_THRESHOLD,
            "minNewSpeakerWindows": MIN_NEW_SPEAKER_WINDOWS,
        },
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = None
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            kind = request.get("type")
            if kind == "stop":
                write_message({"id": request_id, "type": "stopped"})
                return 0
            if kind == "reset":
                session = StreamingSession(engine)
                write_message({"id": request_id, "type": "reset_done"})
                continue
            if kind == "add_words":
                session.queue_words(list(request.get("words") or []))
                turns = session.flush_turns(force=False)
                write_message({"id": request_id, "type": "turns", "turns": turns, "coverageEndSec": round(session.coverage_end_abs, 3)})
                continue
            if kind == "flush":
                turns = session.flush_turns(force=bool(request.get("force")))
                write_message({"id": request_id, "type": "turns", "turns": turns, "coverageEndSec": round(session.coverage_end_abs, 3)})
                continue
            if kind != "diarize_pcm16":
                write_message({"id": request_id, "type": "error", "message": "Unknown request type."})
                continue

            run_started = time.time()
            audio_bytes = base64.b64decode(str(request.get("audioBase64") or ""))
            input_sample_rate = int(request.get("sampleRate") or SAMPLE_RATE)
            window_start_sec = float(request.get("windowStartSec") or 0.0)
            samples = pcm16_to_float_mono(audio_bytes, input_sample_rate)
            duration_sec = samples.shape[0] / SAMPLE_RATE if samples.size else 0.0
            window_end_sec = window_start_sec + duration_sec

            if samples.size:
                session.ingest(samples, window_start_sec, window_end_sec)
                session.process()

            # Coverage advanced -> flush any word batches that are now diarization-ready.
            turns = session.flush_turns(force=False)
            segments = session.segments_in(window_start_sec, window_end_sec)
            write_message({
                "id": request_id,
                "type": "result",
                "turns": turns,
                "coverageEndSec": round(session.coverage_end_abs, 3),
                "provider": "utterr",
                "engine": "utterr-online-clustering",
                "device": str(engine.device),
                "audio": {
                    "durationSec": round(duration_sec, 3),
                    "sampleRate": SAMPLE_RATE,
                    "bytes": len(audio_bytes),
                },
                "timings": {"diarizationSec": round(time.time() - run_started, 3)},
                "summary": {"regular": session.speaker_summary(), "exclusive": session.speaker_summary()},
                "speakerDiarization": segments,
                "exclusiveSpeakerDiarization": segments,
                "segments": segments,
            })
        except Exception as error:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            rid = ""
            if isinstance(request, dict):
                rid = str(request.get("id", ""))
            write_message({"id": rid, "type": "error", "message": str(error)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
