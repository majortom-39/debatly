#!/usr/bin/env python
"""Evaluate diarization cluster consistency against a speaker-labelled DOCX.

This uses Deepgram word timestamps as a bridge:
DOCX speaker-labelled text -> fuzzy token alignment -> timestamped truth turns
-> overlap with pyannote clusters.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path

from docx import Document


SPEAKER_RE = re.compile(r"\bSpeaker\s+(\d+)\s*:", re.IGNORECASE)
TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate pyannote speaker-cluster consistency.")
    parser.add_argument("--truth-docx", required=True)
    parser.add_argument("--deepgram", required=True)
    parser.add_argument("--diarization", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--min-turn-tokens", type=int, default=3)
    return parser.parse_args()


def normalize_token(token: str) -> str:
    token = token.lower().strip()
    token = token.replace("’", "'")
    token = re.sub(r"[^a-z0-9']", "", token)
    if token.endswith("'s") and len(token) > 3:
        token = token[:-2]
    return token


def tokenize(text: str) -> list[str]:
    return [normalize_token(match.group(0)) for match in TOKEN_RE.finditer(text) if normalize_token(match.group(0))]


def extract_truth_turns(docx_path: Path) -> list[dict]:
    turns: list[dict] = []
    for paragraph in Document(str(docx_path)).paragraphs:
        text = " ".join(paragraph.text.split())
        if not text:
            continue
        matches = list(SPEAKER_RE.finditer(text))
        for index, match in enumerate(matches):
            speaker = f"Speaker {match.group(1)}"
            start = match.end()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            turn_text = text[start:end].strip()
            tokens = tokenize(turn_text)
            if tokens:
                turns.append({
                    "truthSpeaker": speaker,
                    "text": turn_text,
                    "tokens": tokens,
                })
    return turns


def extract_deepgram_words(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    words = payload.get("results", {}).get("channels", [{}])[0].get("alternatives", [{}])[0].get("words", [])
    result = []
    for word in words:
        token = normalize_token(str(word.get("word", "")))
        if not token:
            continue
        result.append({
            "token": token,
            "word": word.get("word", ""),
            "start": float(word.get("start", 0)),
            "end": float(word.get("end", 0)),
        })
    return result


def align_truth_to_words(turns: list[dict], dg_words: list[dict], min_turn_tokens: int) -> tuple[list[dict], dict]:
    truth_tokens = []
    truth_token_meta = []
    for turn_index, turn in enumerate(turns):
        for token_index, token in enumerate(turn["tokens"]):
            truth_tokens.append(token)
            truth_token_meta.append((turn_index, token_index))

    dg_tokens = [word["token"] for word in dg_words]
    matcher = SequenceMatcher(None, truth_tokens, dg_tokens, autojunk=False)
    matched_by_turn: dict[int, list[tuple[int, int]]] = defaultdict(list)
    matched_truth_tokens = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            continue
        for offset in range(i2 - i1):
            truth_index = i1 + offset
            dg_index = j1 + offset
            turn_index, _token_index = truth_token_meta[truth_index]
            matched_by_turn[turn_index].append((truth_index, dg_index))
            matched_truth_tokens += 1

    aligned_turns = []
    for index, turn in enumerate(turns):
        matches = matched_by_turn.get(index, [])
        if len(turn["tokens"]) < min_turn_tokens:
            status = "too_short"
        elif not matches:
            status = "unmatched"
        else:
            status = "aligned"
        if matches:
            dg_indexes = [item[1] for item in matches]
            start = min(dg_words[i]["start"] for i in dg_indexes)
            end = max(dg_words[i]["end"] for i in dg_indexes)
            match_ratio = len(matches) / max(1, len(turn["tokens"]))
        else:
            start = None
            end = None
            match_ratio = 0
        aligned_turns.append({
            "turnIndex": index,
            "truthSpeaker": turn["truthSpeaker"],
            "tokenCount": len(turn["tokens"]),
            "matchedTokens": len(matches),
            "matchRatio": round(match_ratio, 3),
            "start": round(start, 3) if start is not None else None,
            "end": round(end, 3) if end is not None else None,
            "status": status,
            "preview": turn["text"][:180],
        })

    stats = {
        "truthTokenCount": len(truth_tokens),
        "deepgramTokenCount": len(dg_tokens),
        "matchedTruthTokens": matched_truth_tokens,
        "tokenMatchRatio": round(matched_truth_tokens / max(1, len(truth_tokens)), 3),
        "truthTurnCount": len(turns),
        "alignedTurnCount": sum(1 for turn in aligned_turns if turn["status"] == "aligned"),
        "unmatchedTurnCount": sum(1 for turn in aligned_turns if turn["status"] == "unmatched"),
        "tooShortTurnCount": sum(1 for turn in aligned_turns if turn["status"] == "too_short"),
    }
    return aligned_turns, stats


def load_pyannote_segments(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    segments = payload.get("exclusiveSpeakerDiarization") or payload.get("speakerDiarization") or []
    return [
        {
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "speaker": str(segment["speaker"]),
            "duration": float(segment.get("duration") or (float(segment["end"]) - float(segment["start"]))),
        }
        for segment in segments
        if "start" in segment and "end" in segment and "speaker" in segment
    ]


def overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def assign_clusters(aligned_turns: list[dict], segments: list[dict]) -> tuple[list[dict], dict]:
    evaluated = []
    truth_to_cluster_duration: dict[str, Counter] = defaultdict(Counter)
    truth_to_cluster_turns: dict[str, Counter] = defaultdict(Counter)
    cluster_to_truth_duration: dict[str, Counter] = defaultdict(Counter)
    cluster_to_truth_turns: dict[str, Counter] = defaultdict(Counter)

    for turn in aligned_turns:
        if turn["status"] != "aligned" or turn["start"] is None or turn["end"] is None or turn["end"] <= turn["start"]:
            evaluated.append({**turn, "dominantCluster": None, "dominantOverlapSec": 0, "clusterOverlapRatio": 0})
            continue

        overlaps = Counter()
        for segment in segments:
            amount = overlap(turn["start"], turn["end"], segment["start"], segment["end"])
            if amount > 0:
                overlaps[segment["speaker"]] += amount
        total_overlap = sum(overlaps.values())
        if overlaps:
            dominant_cluster, dominant_overlap = overlaps.most_common(1)[0]
            ratio = dominant_overlap / max(0.001, total_overlap)
            truth = turn["truthSpeaker"]
            truth_to_cluster_duration[truth][dominant_cluster] += dominant_overlap
            truth_to_cluster_turns[truth][dominant_cluster] += 1
            cluster_to_truth_duration[dominant_cluster][truth] += dominant_overlap
            cluster_to_truth_turns[dominant_cluster][truth] += 1
        else:
            dominant_cluster = None
            dominant_overlap = 0
            ratio = 0

        evaluated.append({
            **turn,
            "dominantCluster": dominant_cluster,
            "dominantOverlapSec": round(dominant_overlap, 3),
            "clusterOverlapRatio": round(ratio, 3),
            "clusterOverlapsSec": {key: round(value, 3) for key, value in overlaps.most_common()},
        })

    truth_summary = summarize_distribution(truth_to_cluster_duration, truth_to_cluster_turns)
    cluster_summary = summarize_distribution(cluster_to_truth_duration, cluster_to_truth_turns)
    metrics = {
        "evaluatedTurnCount": sum(1 for turn in evaluated if turn.get("dominantCluster")),
        "truthSpeakerCount": len(truth_summary),
        "pyannoteClusterCountUsed": len(cluster_summary),
        "meanTruthSpeakerPurity": round(mean([item["durationPurity"] for item in truth_summary.values()]), 3),
        "minTruthSpeakerPurity": round(min([item["durationPurity"] for item in truth_summary.values()] or [0]), 3),
        "meanClusterPurity": round(mean([item["durationPurity"] for item in cluster_summary.values()]), 3),
        "minClusterPurity": round(min([item["durationPurity"] for item in cluster_summary.values()] or [0]), 3),
    }
    return evaluated, {
        "truthSpeakerConsistency": truth_summary,
        "clusterContamination": cluster_summary,
        "metrics": metrics,
    }


def summarize_distribution(duration_map: dict[str, Counter], turn_map: dict[str, Counter]) -> dict:
    summary = {}
    for source, durations in sorted(duration_map.items(), key=lambda item: speaker_sort_key(item[0])):
        total_duration = sum(durations.values())
        dominant, dominant_duration = durations.most_common(1)[0] if durations else (None, 0)
        turns = turn_map.get(source, Counter())
        total_turns = sum(turns.values())
        summary[source] = {
            "dominant": dominant,
            "durationPurity": round(dominant_duration / max(0.001, total_duration), 3),
            "turnPurity": round((turns.get(dominant, 0) if dominant else 0) / max(1, total_turns), 3),
            "totalOverlapSec": round(total_duration, 3),
            "evaluatedTurns": int(total_turns),
            "distributionSec": {key: round(value, 3) for key, value in durations.most_common()},
            "turnDistribution": dict(turns.most_common()),
        }
    return summary


def speaker_sort_key(label: str) -> tuple[int, str]:
    match = re.search(r"\d+", label)
    return (int(match.group(0)) if match else 10_000, label)


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def main() -> int:
    args = parse_args()
    truth_turns = extract_truth_turns(Path(args.truth_docx))
    dg_words = extract_deepgram_words(Path(args.deepgram))
    aligned_turns, alignment_stats = align_truth_to_words(truth_turns, dg_words, args.min_turn_tokens)
    segments = load_pyannote_segments(Path(args.diarization))
    evaluated_turns, consistency = assign_clusters(aligned_turns, segments)

    result = {
        "alignment": alignment_stats,
        "consistency": consistency,
        "evaluatedTurns": evaluated_turns,
        "notes": [
            "Speaker IDs do not need to match the DOCX labels; only dominant-cluster consistency matters.",
            "This is approximate because timestamps come from Deepgram word alignment, not timestamped human truth.",
        ],
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({
        "out": str(out_path),
        **alignment_stats,
        **consistency["metrics"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
