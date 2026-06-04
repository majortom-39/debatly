#!/usr/bin/env python
"""Persistent pyannote diarization worker for live PCM windows.

Protocol: newline-delimited JSON over stdin/stdout. The worker loads the
pyannote pipeline once, then accepts base64 PCM16 mono windows.
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
from fractions import Fraction

import numpy as np
import torch
from scipy.signal import resample_poly

os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")
warnings.filterwarnings("ignore", message=".*torchcodec is not installed correctly.*", category=UserWarning)
warnings.filterwarnings("ignore", message=".*degrees of freedom is <= 0.*", category=UserWarning)
warnings.filterwarnings("ignore", category=UserWarning, module=r"pyannote\.audio\.core\.io")
warnings.filterwarnings("ignore", category=UserWarning, module=r"pyannote\.audio\.models\.blocks\.pooling")

from pyannote.audio import Pipeline  # noqa: E402


DEFAULT_MODEL = "pyannote/speaker-diarization-community-1"
DEFAULT_SAMPLE_RATE = 16_000


def env_int(name: str) -> int | None:
    value = os.getenv(name, "").strip()
    if not value:
        return None
    return int(value)


def token_from_env() -> str | None:
    for name in ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HUGGINGFACE_HUB_TOKEN", "PYANNOTE_HF_TOKEN"):
        value = os.getenv(name, "").strip()
        if value:
            return value
    return None


def select_device(requested: str) -> torch.device:
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("PYANNOTE_DEVICE=cuda requested, but torch.cuda.is_available() is false.")
        return torch.device("cuda")
    if requested == "auto" and torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def write_message(message: dict) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def pcm16_to_waveform(audio_bytes: bytes, sample_rate: int, target_sample_rate: int) -> tuple[torch.Tensor, int, float]:
    if not audio_bytes:
        return torch.zeros((1, 0), dtype=torch.float32), target_sample_rate, 0.0
    samples = np.frombuffer(audio_bytes, dtype="<i2").astype(np.float32) / 32768.0
    original_duration = float(samples.shape[0] / max(1, sample_rate))
    if sample_rate != target_sample_rate and samples.size:
        ratio = Fraction(target_sample_rate, sample_rate).limit_denominator(1000)
        samples = resample_poly(samples, ratio.numerator, ratio.denominator).astype(np.float32, copy=False)
        sample_rate = target_sample_rate
    waveform = torch.from_numpy(np.ascontiguousarray(samples)).unsqueeze(0)
    return waveform, sample_rate, original_duration


def annotation_segments(annotation, offset_sec: float = 0.0) -> list[dict]:
    if annotation is None:
        return []
    segments: list[dict] = []
    for segment, _track, speaker in annotation.itertracks(yield_label=True):
        start = float(segment.start) + offset_sec
        end = float(segment.end) + offset_sec
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            continue
        segments.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "speaker": str(speaker),
        })
    segments.sort(key=lambda item: (item["start"], item["end"], item["speaker"]))
    return segments


def summarize_segments(segments: list[dict]) -> dict:
    by_speaker: dict[str, dict] = {}
    for segment in segments:
        speaker = segment["speaker"]
        entry = by_speaker.setdefault(speaker, {"turns": 0, "durationSec": 0.0})
        entry["turns"] += 1
        entry["durationSec"] += float(segment["duration"])
    for entry in by_speaker.values():
        entry["durationSec"] = round(entry["durationSec"], 3)
    return {
        "speakerCount": len(by_speaker),
        "segmentCount": len(segments),
        "bySpeaker": dict(sorted(by_speaker.items())),
    }


def diarization_kwargs(settings: dict) -> dict:
    num_speakers = settings.get("numSpeakers", env_int("PYANNOTE_NUM_SPEAKERS"))
    min_speakers = settings.get("minSpeakers", env_int("PYANNOTE_MIN_SPEAKERS"))
    max_speakers = settings.get("maxSpeakers", env_int("PYANNOTE_MAX_SPEAKERS"))
    kwargs = {}
    if num_speakers is not None:
        kwargs["num_speakers"] = int(num_speakers)
        return kwargs
    if min_speakers is not None:
        kwargs["min_speakers"] = int(min_speakers)
    if max_speakers is not None:
        kwargs["max_speakers"] = int(max_speakers)
    return kwargs


def main() -> int:
    model_name = os.getenv("PYANNOTE_MODEL", DEFAULT_MODEL)
    target_sample_rate = int(os.getenv("PYANNOTE_SAMPLE_RATE", str(DEFAULT_SAMPLE_RATE)))
    requested_device = os.getenv("PYANNOTE_DEVICE", "auto")

    started = time.time()
    device = select_device(requested_device)
    token = token_from_env()
    pipeline = Pipeline.from_pretrained(model_name, token=token) if token else Pipeline.from_pretrained(model_name)
    pipeline.to(device)
    write_message({
        "type": "ready",
        "model": model_name,
        "device": str(device),
        "sampleRate": target_sample_rate,
        "loadSec": round(time.time() - started, 3),
        "settings": {
            "numSpeakers": env_int("PYANNOTE_NUM_SPEAKERS"),
            "minSpeakers": env_int("PYANNOTE_MIN_SPEAKERS"),
            "maxSpeakers": env_int("PYANNOTE_MAX_SPEAKERS"),
        },
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            if request.get("type") == "stop":
                write_message({"id": request_id, "type": "stopped"})
                return 0
            if request.get("type") != "diarize_pcm16":
                write_message({"id": request_id, "type": "error", "message": "Unknown request type."})
                continue

            run_started = time.time()
            audio_bytes = base64.b64decode(str(request.get("audioBase64") or ""))
            input_sample_rate = int(request.get("sampleRate") or target_sample_rate)
            window_start_sec = float(request.get("windowStartSec") or 0.0)
            waveform, sample_rate, duration_sec = pcm16_to_waveform(audio_bytes, input_sample_rate, target_sample_rate)
            kwargs = diarization_kwargs(request.get("settings") or {})

            if waveform.shape[1] <= 0:
                write_message({
                    "id": request_id,
                    "type": "result",
                    "segments": [],
                    "speakerDiarization": [],
                    "exclusiveSpeakerDiarization": [],
                    "summary": {"regular": summarize_segments([]), "exclusive": summarize_segments([])},
                    "timings": {"diarizationSec": 0.0},
                    "audio": {"durationSec": 0.0, "sampleRate": sample_rate},
                })
                continue

            output = pipeline({"waveform": waveform, "sample_rate": sample_rate}, **kwargs)
            regular_segments = annotation_segments(output.speaker_diarization, window_start_sec)
            exclusive_segments = annotation_segments(getattr(output, "exclusive_speaker_diarization", None), window_start_sec)
            write_message({
                "id": request_id,
                "type": "result",
                "provider": "pyannote",
                "model": model_name,
                "device": str(device),
                "audio": {
                    "durationSec": round(duration_sec, 3),
                    "sampleRate": sample_rate,
                    "bytes": len(audio_bytes),
                },
                "settings": {
                    "numSpeakers": kwargs.get("num_speakers"),
                    "minSpeakers": kwargs.get("min_speakers"),
                    "maxSpeakers": kwargs.get("max_speakers"),
                    "exclusive": True,
                },
                "timings": {"diarizationSec": round(time.time() - run_started, 3)},
                "summary": {
                    "regular": summarize_segments(regular_segments),
                    "exclusive": summarize_segments(exclusive_segments),
                },
                "speakerDiarization": regular_segments,
                "exclusiveSpeakerDiarization": exclusive_segments,
                "segments": exclusive_segments,
            })
        except Exception as error:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            write_message({
                "id": str(locals().get("request", {}).get("id", "")) if isinstance(locals().get("request"), dict) else "",
                "type": "error",
                "message": str(error),
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
