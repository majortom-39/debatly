// =============================================================================
// scripts/replay-pipeline.mjs
// =============================================================================
// Reads a CACHED Speechmatics output (no credits spent) and runs its diarized
// turns through the clean pipeline: 30s packets -> Stabilizer Gate -> Side Builder.
//
// Usage:
//   node --env-file=.env scripts/replay-pipeline.mjs [cacheFile]
// Default cacheFile: .cache/scenario1-speechmatics.json
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPacket, createPipelineState, groupTurnsIntoPackets, PACKET_SECONDS } from "../server/pipeline.mjs";
import { explainScore } from "../server/nodes/scoring-engine.mjs";
import { createTrace } from "../server/shared/trace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cacheFile = process.argv[2] || path.join(repoRoot, ".cache", "scenario1-speechmatics.json");

function loadTurns(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const turns = (raw.finalTurns || []).map((t, i) => ({
    id: t.id || `turn-${i}`,
    speakerId: t.speakerId || "Unknown",
    text: t.text || "",
    startSec: Number(t.startSec ?? t.startMs / 1000 ?? 0),
    endSec: Number(t.endSec ?? t.endMs / 1000 ?? 0)
  })).filter((t) => t.text.trim());
  return turns;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const TAG_ICON = { foundation: "🧱", evidence: "📊", rebuttal: "⚔️", principle: "🎯", precedent: "📜", hypothetical: "🔮" };

async function main() {
  if (!fs.existsSync(cacheFile)) {
    console.error(`Cache file not found: ${cacheFile}`);
    process.exit(1);
  }
  const turns = loadTurns(cacheFile);
  const packets = groupTurnsIntoPackets(turns);
  console.log(`Loaded ${turns.length} diarized turns -> ${packets.length} packets of ${PACKET_SECONDS}s.`);
  console.log(`Unique raw speakers: ${[...new Set(turns.map((t) => t.speakerId))].join(", ")}`);
  console.log("=".repeat(70));

  const state = createPipelineState();
  const trace = createTrace("replay");
  let openedAt = null;
  let prevSnap = snapshot(state); // baseline before anything opens
  const prevPointIds = new Set(); // debate-point ids already shown
  const prevClaimIds = new Set(); // claim ids already shown
  let prevScore = { blue: 0, red: 0 };

  for (let i = 0; i < packets.length; i += 1) {
    const p = packets[i];
    const wasOpen = state.gateOpen;
    await runPacket(state, p, { trace, nextPacket: packets[i + 1] || null });

    if (!wasOpen && state.gateOpen && openedAt === null) {
      openedAt = state.gateOpenedAtSec;
      console.log(`\n🚪 GATE OPENED at packet ${i} (${fmtTime(state.gateOpenedAtSec)})`);
      console.log(`   debator: ${state.debatorSpeakerId}`);
      console.log(`   reason: ${state.gateOpenReason}`);
      if (state.gateBacktrackedToSec != null && state.gateBacktrackedToSec < state.gateOpenedAtSec) {
        console.log(`   ⏪ backtracked true start to ${fmtTime(state.gateBacktrackedToSec)} — realStart: "${(state.realStartQuote || "").slice(0, 60)}"`);
      }
      console.log("");
    }

    const tags = state.junkTags.filter((t) => t.packetId === p.windowId);
    const tagSummary = tags.length ? `  🏷️ ${tags.map((t) => `${t.speakerId}:${t.kind}`).join(", ")}` : "";
    const status = state.gateOpen ? "OPEN " : "shut ";
    console.log(`\n[${status}] PACKET ${String(i).padStart(2)} ${fmtTime(p.startSec)}-${fmtTime(p.endSec)} | speakers heard: [${[...new Set(p.speakerColumns.map((c) => c.speakerId))].join(", ")}]${tagSummary}`);

    if (state.gateOpen) {
      // === THIS IS THE UI SNAPSHOT after this packet ===
      const snap = snapshot(state);
      const diff = diffSnapshots(prevSnap, snap);

      console.log(`   Topic: ${snap.topic || "(forming...)"}${diff.topicChanged ? "  ⟵ updated" : ""}`);

      // Blue side
      console.log(`   🔵 BLUE  position: ${snap.blue.position || "(empty)"}${diff.blue.positionChanged ? "  ⟵ updated" : ""}`);
      if (snap.blue.thesis) console.log(`           thesis: ${snap.blue.thesis}${diff.blue.thesisChanged ? "  ⟵ updated" : ""}`);

      // Red side
      console.log(`   🔴 RED   position: ${snap.red.position || "(empty)"}${diff.red.positionChanged ? "  ⟵ updated" : ""}`);
      if (snap.red.thesis) console.log(`           thesis: ${snap.red.thesis}${diff.red.thesisChanged ? "  ⟵ updated" : ""}`);

      // Speaker assignments, marking new/changed ones
      const speakerLine = Object.entries(snap.speakers).map(([sp, side]) => {
        const mark = diff.newSpeakers.includes(sp) ? "✨" : diff.movedSpeakers.includes(sp) ? "⚠️" : "";
        return `${sp}->${side}${mark}`;
      }).join(", ") || "(none yet)";
      console.log(`   speakers: ${speakerLine}`);
      if (diff.newSpeakers.length) console.log(`            ✨ newly assigned: ${diff.newSpeakers.join(", ")}`);
      if (diff.movedSpeakers.length) console.log(`            ⚠️ switched side: ${diff.movedSpeakers.join(", ")}`);

      // Debate points newly added this packet (by id we haven't seen before)
      const freshPoints = state.debatePoints.filter((p) => !prevPointIds.has(p.pointId));
      if (freshPoints.length) {
        console.log(`   📋 debate points added (${freshPoints.length}):`);
        for (const p of freshPoints) {
          const tagIcon = TAG_ICON[p.tag] || "•";
          console.log(`      [${p.side.toUpperCase()}] ${tagIcon} ${p.tag}: ${p.point}`);
          console.log(`            ⤷ "${(p.quote || "").slice(0, 80)}" — ${p.speakerId}`);
          if (p.opposingQuote) console.log(`            ⚔️ vs "${(p.opposingQuote || "").slice(0, 70)}" — ${p.opposingSpeakerId || "?"}`);
        }
      }
      state.debatePoints.forEach((p) => prevPointIds.add(p.pointId));

      // Claims newly extracted this packet
      const freshClaims = state.claims.filter((c) => !prevClaimIds.has(c.claimId));
      if (freshClaims.length) {
        console.log(`   🔎 claims queued for fact-check (${freshClaims.length}):`);
        for (const c of freshClaims) {
          console.log(`      [${c.side.toUpperCase()}] ${c.claim}`);
          console.log(`            🔍 query: "${c.searchQuery}"`);
        }
      }
      state.claims.forEach((c) => prevClaimIds.add(c.claimId));

      // Live scoreboard after this packet
      if (state.scores?.blue || state.scores?.red) {
        const b = state.scores.blue?.score ?? 0;
        const r = state.scores.red?.score ?? 0;
        const moved = b !== prevScore.blue || r !== prevScore.red;
        console.log(`   📊 SCORE  🔵 ${b}  vs  🔴 ${r}${moved ? "  ⟵ moved" : ""}`);
        prevScore = { blue: b, red: r };
      }

      if (!diff.anyChange && !freshPoints.length && !freshClaims.length) console.log(`   (no change this packet)`);

      prevSnap = snap;
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("FINAL PICTURE:");
  console.log(`  Topic: ${state.topic || "(none)"}`);
  console.log(`  Blue side: ${state.sides.blue.position || "(empty)"}  | thesis: ${state.sides.blue.thesis || "(empty)"}`);
  console.log(`  Red side:  ${state.sides.red.position || "(empty)"}  | thesis: ${state.sides.red.thesis || "(empty)"}`);
  console.log(`  Speaker -> side map:`);
  for (const [sp, v] of Object.entries(state.speakers)) {
    console.log(`    ${sp} -> ${v.side} (${v.confidence}) — ${v.reason}`);
  }
  console.log(`  Gate opened at: ${openedAt !== null ? fmtTime(openedAt) : "NEVER"}`);
  console.log(`  Pre-debate packets (ignored): ${state.preDebatePackets.length}`);
  console.log(`  Junk tags total: ${state.junkTags.length}`);
  const tagKinds = state.junkTags.reduce((acc, t) => { acc[t.kind] = (acc[t.kind] || 0) + 1; return acc; }, {});
  console.log(`  Junk by kind: ${JSON.stringify(tagKinds)}`);

  // DEBATE DESK — exactly how the UI would lay it out: per side, grouped into families.
  for (const side of ["blue", "red"]) {
    const icon = side === "blue" ? "🔵" : "🔴";
    const pts = state.debatePoints.filter((p) => p.side === side);
    console.log(`\n  ${icon} ${side.toUpperCase()} DEBATE DESK — ${pts.length} points in ${state.families[side].length} families:`);
    const ungrouped = pts.filter((p) => !p.familyId);
    for (const fam of state.families[side]) {
      const members = pts.filter((p) => p.familyId === fam.familyId);
      console.log(`     ✉️  ${fam.title}  (${members.length})`);
      for (const p of members) console.log(`         ${TAG_ICON[p.tag] || "•"} ${p.tag}: ${p.point}`);
    }
    if (ungrouped.length) {
      console.log(`     (ungrouped — awaiting next family merge: ${ungrouped.length})`);
      for (const p of ungrouped) console.log(`         ${TAG_ICON[p.tag] || "•"} ${p.tag}: ${p.point}`);
    }
  }
  const tagCounts = state.debatePoints.reduce((acc, p) => { acc[p.tag] = (acc[p.tag] || 0) + 1; return acc; }, {});
  console.log(`\n  Debate points total: ${state.debatePoints.length} | by tag: ${JSON.stringify(tagCounts)}`);

  // CLAIMS + FACT CHECK results
  const FACT_ICON = { verified: "✅", contradicted: "❌", misleading: "⚠️", no_clear_source: "🔍" };
  console.log(`\n  🔎 CLAIMS & FACT CHECK — ${state.claims.length} claims:`);
  for (const side of ["blue", "red"]) {
    const sideClaims = state.claims.filter((c) => c.side === side);
    if (!sideClaims.length) continue;
    console.log(`     ${side === "blue" ? "🔵" : "🔴"} ${side.toUpperCase()}:`);
    for (const c of sideClaims) {
      const icon = FACT_ICON[c.tag] || "⏳";
      console.log(`        ${icon} [${c.tag || c.status}] ${c.claim}`);
      if (c.why) console.log(`            ⤷ ${c.why}`);
      if (c.sources && c.sources.length) console.log(`            📎 ${c.sources.map((s) => s.uri).slice(0, 2).join("  ")}`);
    }
  }
  const factCounts = state.claims.reduce((acc, c) => { const k = c.tag || c.status; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  console.log(`\n  Fact-check tally: ${JSON.stringify(factCounts)} | queue remaining: ${state.factCheckQueue.length + (state.deepCheckQueue ? state.deepCheckQueue.length : 0)}`);

  // INCONSISTENCIES — filed under the side that showed them.
  console.log(`\n  ⚖️ INCONSISTENCIES — ${state.inconsistencies.length}:`);
  for (const side of ["blue", "red"]) {
    const items = state.inconsistencies.filter((x) => x.side === side);
    if (!items.length) continue;
    console.log(`     ${side === "blue" ? "🔵" : "🔴"} ${side.toUpperCase()}:`);
    for (const x of items) {
      console.log(`        [${x.type} · ${x.level}] ${x.why}`);
      console.log(`            ① "${(x.firstQuote || "").slice(0, 75)}" — ${x.firstSpeakerId}`);
      console.log(`            ② "${(x.secondQuote || "").slice(0, 75)}" — ${x.secondSpeakerId}`);
    }
  }
  if (!state.inconsistencies.length) console.log(`     (none flagged — strict by design)`);

  // FINAL SCOREBOARD — transparent, every point traced to a card.
  console.log(`\n  📊 FINAL SCORE`);
  for (const side of ["blue", "red"]) {
    const s = state.scores?.[side];
    if (!s) continue;
    console.log(`     ${side === "blue" ? "🔵 BLUE" : "🔴 RED "}: ${s.score}   (${explainScore(s)})`);
  }
  // Speaker-level breakdown (for later UI)
  for (const side of ["blue", "red"]) {
    const s = state.scores?.[side];
    if (!s || !Object.keys(s.speakers).length) continue;
    console.log(`     ${side === "blue" ? "🔵" : "🔴"} per-speaker: ${Object.entries(s.speakers).map(([sp, v]) => `${sp}:${v.score}`).join(", ")}`);
  }

  const outPath = path.join(repoRoot, ".cache", "replay-result.json");
  fs.writeFileSync(outPath, JSON.stringify({ state, packetCount: packets.length, openedAtSec: openedAt }, null, 2));
  console.log(`\nSaved full result -> ${outPath}`);
}

// Capture the UI-relevant state after a packet: topic, both sides' position+thesis,
// and the speaker->side map.
function snapshot(state) {
  return {
    topic: state.topic || "",
    blue: { position: state.sides.blue.position || "", thesis: state.sides.blue.thesis || "" },
    red: { position: state.sides.red.position || "", thesis: state.sides.red.thesis || "" },
    speakers: Object.fromEntries(Object.entries(state.speakers).map(([sp, v]) => [sp, v.side]))
  };
}

// Compare two snapshots and report what changed (so we can see per-packet updates).
function diffSnapshots(prev, cur) {
  const newSpeakers = [];
  const movedSpeakers = [];
  for (const [sp, side] of Object.entries(cur.speakers)) {
    if (!(sp in prev.speakers)) newSpeakers.push(`${sp}(${side})`);
    else if (prev.speakers[sp] !== side) movedSpeakers.push(`${sp}(${prev.speakers[sp]}→${side})`);
  }
  const topicChanged = prev.topic !== cur.topic;
  const blue = { positionChanged: prev.blue.position !== cur.blue.position, thesisChanged: prev.blue.thesis !== cur.blue.thesis };
  const red = { positionChanged: prev.red.position !== cur.red.position, thesisChanged: prev.red.thesis !== cur.red.thesis };
  const anyChange = topicChanged || blue.positionChanged || blue.thesisChanged || red.positionChanged || red.thesisChanged || newSpeakers.length > 0 || movedSpeakers.length > 0;
  return { topicChanged, blue, red, newSpeakers, movedSpeakers, anyChange };
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
