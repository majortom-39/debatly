#!/usr/bin/env python
"""Compare pyannote diarization speaker structure with a DOCX truth transcript.

The provided DOCX transcript has speaker labels but no timestamps, so this
reports count/turn-structure agreement rather than DER.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

from docx import Document


SPEAKER_RE = re.compile(r"\bSpeaker\s+(\d+)\s*:", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare pyannote JSON with DOCX speaker-label truth.")
    parser.add_argument("--diarization", required=True, help="pyannote diarization JSON path.")
    parser.add_argument("--truth-docx", required=True, help="Speaker-labelled DOCX transcript.")
    parser.add_argument("--out", required=True, help="Path to write comparison JSON.")
    return parser.parse_args()


def extract_truth(docx_path: Path) -> dict:
    doc = Document(str(docx_path))
    speaker_sequence: list[str] = []
    paragraph_count = 0
    speaker_context: dict[str, list[str]] = {}

    for paragraph in doc.paragraphs:
      text = " ".join(paragraph.text.split())
      if not text:
          continue
      paragraph_count += 1
      matches = list(SPEAKER_RE.finditer(text))
      for index, match in enumerate(matches):
          speaker = f"Speaker {match.group(1)}"
          speaker_sequence.append(speaker)
          start = match.end()
          end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
          snippet = text[start:end].strip()
          if snippet:
              speaker_context.setdefault(speaker, []).append(snippet[:180])

    merged_sequence = merge_adjacent(speaker_sequence)
    return {
        "paragraphCount": paragraph_count,
        "speakerCount": len(set(speaker_sequence)),
        "turnLabelCount": len(speaker_sequence),
        "mergedTurnCount": len(merged_sequence),
        "speakers": sorted(set(speaker_sequence), key=speaker_sort_key),
        "turnsBySpeaker": dict(sorted(Counter(speaker_sequence).items(), key=lambda item: speaker_sort_key(item[0]))),
        "mergedTurnsBySpeaker": dict(sorted(Counter(merged_sequence).items(), key=lambda item: speaker_sort_key(item[0]))),
        "sequenceHead": speaker_sequence[:40],
        "mergedSequenceHead": merged_sequence[:40],
        "examples": {
            speaker: snippets[:3]
            for speaker, snippets in sorted(speaker_context.items(), key=lambda item: speaker_sort_key(item[0]))
        },
    }


def extract_pyannote(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    segments = payload.get("exclusiveSpeakerDiarization") or payload.get("speakerDiarization") or []
    sequence = [str(segment.get("speaker", "")) for segment in segments if segment.get("speaker")]
    merged_sequence = merge_adjacent(sequence)
    duration_by_speaker: Counter[str] = Counter()
    segment_count_by_speaker: Counter[str] = Counter()
    for segment in segments:
        speaker = str(segment.get("speaker", ""))
        if not speaker:
            continue
        duration_by_speaker[speaker] += float(segment.get("duration") or 0)
        segment_count_by_speaker[speaker] += 1

    return {
        "model": payload.get("model"),
        "device": payload.get("device"),
        "audio": payload.get("audio", {}),
        "settings": payload.get("settings", {}),
        "timings": payload.get("timings", {}),
        "speakerCount": len(set(sequence)),
        "segmentCount": len(sequence),
        "mergedSegmentCount": len(merged_sequence),
        "speakers": sorted(set(sequence)),
        "segmentsBySpeaker": dict(sorted(segment_count_by_speaker.items())),
        "durationSecBySpeaker": {
            speaker: round(duration, 3)
            for speaker, duration in sorted(duration_by_speaker.items())
        },
        "sequenceHead": sequence[:40],
        "mergedSequenceHead": merged_sequence[:40],
    }


def merge_adjacent(sequence: list[str]) -> list[str]:
    merged: list[str] = []
    for item in sequence:
        if not item:
            continue
        if not merged or merged[-1] != item:
            merged.append(item)
    return merged


def speaker_sort_key(label: str) -> tuple[int, str]:
    match = re.search(r"\d+", label)
    return (int(match.group(0)) if match else 10_000, label)


def main() -> int:
    args = parse_args()
    truth = extract_truth(Path(args.truth_docx))
    pyannote = extract_pyannote(Path(args.diarization))
    comparison = {
        "truth": truth,
        "pyannote": pyannote,
        "result": {
            "truthSpeakerCount": truth["speakerCount"],
            "pyannoteSpeakerCount": pyannote["speakerCount"],
            "speakerCountDelta": pyannote["speakerCount"] - truth["speakerCount"],
            "truthMergedTurnCount": truth["mergedTurnCount"],
            "pyannoteMergedSegmentCount": pyannote["mergedSegmentCount"],
            "limitations": [
                "DOCX truth has speaker labels but no timestamps, so exact diarization error rate cannot be computed.",
                "pyannote speaker names are anonymous clusters; this compares structure/counts, not identity names."
            ],
        },
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(comparison, indent=2), encoding="utf-8")
    print(json.dumps(comparison["result"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
