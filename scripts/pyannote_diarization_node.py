#!/usr/bin/env python
"""Local pyannote Community-1 diarization runner.

This script intentionally loads PCM WAV audio itself instead of relying on
torchcodec, which is brittle on some Windows/PyTorch combinations.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time
import warnings
import wave
from fractions import Fraction
from pathlib import Path

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run pyannote Community-1 diarization on a WAV file.")
    parser.add_argument("--audio", required=True, help="Path to a PCM WAV file.")
    parser.add_argument("--out", required=True, help="Path to write diarization JSON.")
    parser.add_argument("--csv", default="", help="Optional path to write exclusive diarization CSV.")
    parser.add_argument("--model", default=os.getenv("PYANNOTE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--sample-rate", type=int, default=int(os.getenv("PYANNOTE_SAMPLE_RATE", DEFAULT_SAMPLE_RATE)))
    parser.add_argument("--device", default=os.getenv("PYANNOTE_DEVICE", "auto"), choices=["auto", "cpu", "cuda"])
    parser.add_argument("--num-speakers", type=int, default=env_int("PYANNOTE_NUM_SPEAKERS"))
    parser.add_argument("--min-speakers", type=int, default=env_int("PYANNOTE_MIN_SPEAKERS"))
    parser.add_argument("--max-speakers", type=int, default=env_int("PYANNOTE_MAX_SPEAKERS"))
    return parser.parse_args()


def env_int(name: str, default: int | None = None) -> int | None:
    value = os.getenv(name, "")
    if not value.strip():
        return default
    return int(value)


def token_from_env() -> str | None:
    for name in ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HUGGINGFACE_HUB_TOKEN", "PYANNOTE_HF_TOKEN"):
        value = os.getenv(name, "").strip()
        if value:
            return value
    return None


def load_pcm_wav_mono(path: Path, target_sample_rate: int) -> tuple[torch.Tensor, dict]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frames = wav.getnframes()
        raw = wav.readframes(frames)

    if sample_width != 2:
        raise ValueError(f"Expected 16-bit PCM WAV, got sample width {sample_width} bytes.")

    samples = np.frombuffer(raw, dtype="<i2")
    if channels > 1:
        samples = samples.reshape(-1, channels).astype(np.float32).mean(axis=1)
    else:
        samples = samples.astype(np.float32)

    samples = samples / 32768.0
    original_duration = float(samples.shape[0] / sample_rate)

    if sample_rate != target_sample_rate:
        ratio = Fraction(target_sample_rate, sample_rate).limit_denominator(1000)
        samples = resample_poly(samples, ratio.numerator, ratio.denominator).astype(np.float32, copy=False)
        sample_rate = target_sample_rate

    waveform = torch.from_numpy(np.ascontiguousarray(samples)).unsqueeze(0)
    metadata = {
        "channels": channels,
        "originalSampleRate": int(wav_rate_or_zero(path)),
        "sampleRate": int(sample_rate),
        "sampleWidthBytes": sample_width,
        "frames": int(frames),
        "durationSec": round(original_duration, 3),
        "resampledSamples": int(waveform.shape[1]),
    }
    return waveform, metadata


def wav_rate_or_zero(path: Path) -> int:
    try:
        with wave.open(str(path), "rb") as wav:
            return int(wav.getframerate())
    except Exception:
        return 0


def select_device(requested: str) -> torch.device:
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("PYANNOTE_DEVICE=cuda requested, but torch.cuda.is_available() is false.")
        return torch.device("cuda")
    if requested == "auto" and torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def annotation_segments(annotation) -> list[dict]:
    if annotation is None:
        return []
    segments: list[dict] = []
    for segment, _track, speaker in annotation.itertracks(yield_label=True):
        start = float(segment.start)
        end = float(segment.end)
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


def write_csv(path: Path, segments: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["start", "end", "duration", "speaker"])
        writer.writeheader()
        writer.writerows(segments)


def main() -> int:
    args = parse_args()
    explicit_min_max = "--min-speakers" in sys.argv or "--max-speakers" in sys.argv
    if args.num_speakers is not None and explicit_min_max:
        raise ValueError("--num-speakers cannot be combined with --min-speakers or --max-speakers.")
    if args.num_speakers is not None:
        args.min_speakers = None
        args.max_speakers = None

    audio_path = Path(args.audio)
    out_path = Path(args.out)
    started = time.time()

    waveform, audio_metadata = load_pcm_wav_mono(audio_path, args.sample_rate)
    device = select_device(args.device)

    pipeline_started = time.time()
    token = token_from_env()
    pipeline = Pipeline.from_pretrained(args.model, token=token) if token else Pipeline.from_pretrained(args.model)
    pipeline.to(device)

    diarization_kwargs = {}
    if args.num_speakers is not None:
        diarization_kwargs["num_speakers"] = args.num_speakers
    else:
        if args.min_speakers is not None:
            diarization_kwargs["min_speakers"] = args.min_speakers
        if args.max_speakers is not None:
            diarization_kwargs["max_speakers"] = args.max_speakers

    run_started = time.time()
    output = pipeline({"waveform": waveform, "sample_rate": audio_metadata["sampleRate"]}, **diarization_kwargs)

    regular_segments = annotation_segments(output.speaker_diarization)
    exclusive_segments = annotation_segments(getattr(output, "exclusive_speaker_diarization", None))

    result = {
        "provider": "pyannote",
        "model": args.model,
        "device": str(device),
        "audio": audio_metadata,
        "settings": {
            "numSpeakers": args.num_speakers,
            "minSpeakers": args.min_speakers if args.num_speakers is None else None,
            "maxSpeakers": args.max_speakers if args.num_speakers is None else None,
            "exclusive": True,
        },
        "timings": {
            "pipelineLoadSec": round(run_started - pipeline_started, 3),
            "diarizationSec": round(time.time() - run_started, 3),
            "totalSec": round(time.time() - started, 3),
        },
        "summary": {
            "regular": summarize_segments(regular_segments),
            "exclusive": summarize_segments(exclusive_segments),
        },
        "speakerDiarization": regular_segments,
        "exclusiveSpeakerDiarization": exclusive_segments,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    if args.csv:
        write_csv(Path(args.csv), exclusive_segments)

    print(json.dumps({
        "out": str(out_path),
        "csv": args.csv or None,
        "device": str(device),
        "audioDurationSec": audio_metadata["durationSec"],
        "exclusiveSpeakerCount": result["summary"]["exclusive"]["speakerCount"],
        "exclusiveSegmentCount": result["summary"]["exclusive"]["segmentCount"],
        "timings": result["timings"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
