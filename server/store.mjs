// =============================================================================
// store.mjs  —  CLEAN persistence layer for the new architecture.
// =============================================================================
//
// Replaces the old 1994-line db.mjs. Exports the SAME function names index.mjs
// imports, but backed by a SIMPLE new schema that stores the clean `analysis`
// payload (from live-runner.mjs) instead of the old debate-state shape.
//
// Schema (public):
//   user_profiles    (id uuid pk, email, name, avatar_url, provider, ...)
//   projects         (id uuid pk, owner_id, title, topic, status, timestamps)
//   sessions         (id uuid pk, project_id, status, started/ended, duration_ms,
//                     transcript_turn_count, analysis jsonb)   ← the live payload
//   transcript_turns (id, session_id, project_id, speaker_id, text, start/end, seq)
//   reports          (id, project_id, session_id, owner_id, report jsonb, created_at)
// =============================================================================

import pg from "pg";
import { config } from "./config.mjs";

const DATABASE_URL = process.env.DATABASE_URL || "";
const DEFAULT_PROJECT_TITLE = "Untitled debate";

let pool = null;

export function isDatabaseConfigured() {
  return Boolean(DATABASE_URL);
}

export function getDatabaseConfigStatus() {
  return { configured: isDatabaseConfigured() };
}

function getPool() {
  if (!isDatabaseConfigured()) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: String(process.env.DATABASE_SSL || "true").toLowerCase() !== "false" ? { rejectUnauthorized: false } : false,
      max: Number(process.env.DATABASE_POOL_MAX || 8),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });
    // CRITICAL: an idle pooled connection can be dropped by the DB/network
    // (e.g. Supabase idle timeout -> "read ECONNRESET"). node-postgres surfaces
    // that as an 'error' event on the Pool; with no listener Node treats it as an
    // unhandled error and kills the whole API process. Swallow + log it instead so
    // the next query just grabs a fresh connection.
    pool.on("error", (err) => {
      console.error("[store] idle pg client error (recovered, pool stays up):", err?.message || err);
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const p = getPool();
  if (!p) return { rows: [] };
  return p.query(sql, params);
}

export async function closeDatabase() {
  if (pool) { await pool.end(); pool = null; }
}

// --- User profiles -----------------------------------------------------------
export async function upsertUserProfile(user = {}) {
  if (!isDatabaseConfigured() || !user?.id) return;
  await query(
    `insert into public.user_profiles (id, email, name, avatar_url, provider, updated_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (id) do update set
       email = excluded.email, name = excluded.name,
       avatar_url = excluded.avatar_url, provider = excluded.provider, updated_at = now()`,
    [user.id, user.email || "", user.name || "", user.avatarUrl || "", user.provider || ""]
  );
}

// --- Projects ----------------------------------------------------------------
export async function createDraftDebateProject({ ownerId = null, title = DEFAULT_PROJECT_TITLE } = {}) {
  if (!isDatabaseConfigured()) return null;
  const { rows } = await query(
    `insert into public.projects (owner_id, title, status) values ($1,$2,'draft') returning *`,
    [ownerId, title || DEFAULT_PROJECT_TITLE]
  );
  return rows[0] ? rowToProjectSummary(rows[0]) : null;
}

export async function createPersistedLiveSession({ sessionId, projectId, startedAt, ownerId = null } = {}) {
  if (!isDatabaseConfigured() || !sessionId || !projectId) return;
  // Ensure the project row exists (the live session may start before any draft).
  await query(
    `insert into public.projects (id, owner_id, title, status)
     values ($1,$2,$3,'recording')
     on conflict (id) do update set status='recording', updated_at=now()`,
    [projectId, ownerId, DEFAULT_PROJECT_TITLE]
  );
  await query(
    `insert into public.sessions (id, project_id, status, started_at)
     values ($1,$2,'recording', to_timestamp($3/1000.0))
     on conflict (id) do nothing`,
    [sessionId, projectId, Number(startedAt || Date.now())]
  );
}

export async function persistTranscriptTurn({ sessionId, projectId, turn }) {
  if (!isDatabaseConfigured() || !sessionId || !turn?.id) return;
  await query(
    `insert into public.transcript_turns (id, session_id, project_id, speaker_id, text, start_sec, end_sec)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set text = excluded.text`,
    [turn.id, sessionId, projectId, turn.speakerId || "", turn.text || "", Number(turn.startSec ?? 0), Number(turn.endSec ?? 0)]
  );
  await query(
    `update public.sessions set transcript_turn_count = transcript_turn_count + 1, updated_at = now() where id = $1`,
    [sessionId]
  );
}

// Store the clean live `analysis` payload on the session.
export async function persistDebateStateSnapshot({ sessionId, projectId, seq, analysis, transcriptTurnCount = 0, durationMs = 0 }) {
  if (!isDatabaseConfigured() || !sessionId) return;
  await query(
    `update public.sessions
       set analysis = $2::jsonb, seq = $3, transcript_turn_count = greatest(transcript_turn_count, $4),
           duration_ms = greatest(duration_ms, $5), updated_at = now()
     where id = $1`,
    [sessionId, JSON.stringify(analysis || null), Number(seq || 0), Number(transcriptTurnCount || 0), Number(durationMs || 0)]
  );
  // Keep the project topic in sync for the sidebar.
  if (projectId && analysis?.topic) {
    await query(`update public.projects set topic = $2, updated_at = now() where id = $1 and (topic is null or topic = '')`, [projectId, analysis.topic]);
  }
}

export async function markSessionStopped({ sessionId, projectId, endedAt, durationMs = 0, status = "stopped" }) {
  if (!isDatabaseConfigured() || !sessionId) return;
  await query(
    `update public.sessions set status=$2, ended_at=to_timestamp($3/1000.0), duration_ms=greatest(duration_ms,$4), updated_at=now() where id=$1`,
    [sessionId, status, Number(endedAt || Date.now()), Number(durationMs || 0)]
  );
  if (projectId) {
    await query(`update public.projects set status=$2, updated_at=now() where id=$1`, [projectId, status === "report_ready" ? "report_ready" : "stopped"]);
  }
}

export async function finalizeStaleRecordingSessions({ olderThanMinutes = 5 } = {}) {
  if (!isDatabaseConfigured()) return { sessions: 0, projects: 0 };
  const { rowCount } = await query(
    `update public.sessions set status='stopped', ended_at=now(), updated_at=now()
     where status='recording' and coalesce(updated_at, started_at) < now() - ($1 || ' minutes')::interval`,
    [String(Math.max(1, olderThanMinutes))]
  );
  return { sessions: rowCount || 0, projects: 0 };
}

export async function persistDebateReport({ report, sessionId, projectId, ownerId = null, durationMs = 0 }) {
  if (!isDatabaseConfigured() || !projectId) return;
  // One report per project: drop any prior report so re-generations don't pile up.
  await query(`delete from public.reports where project_id=$1`, [projectId]);
  await query(
    `insert into public.reports (project_id, session_id, owner_id, report, duration_ms)
     values ($1,$2,$3,$4::jsonb,$5)`,
    [projectId, sessionId || null, ownerId, JSON.stringify(report || {}), Number(durationMs || 0)]
  );
  await query(`update public.projects set status='report_ready', updated_at=now() where id=$1`, [projectId]);
}

// --- Project loading (shape matched to what the frontend expects) ------------
export async function listDebateProjects({ limit = 30, ownerId = null } = {}) {
  if (!isDatabaseConfigured()) return [];
  const { rows } = await query(
    `select p.*,
            s.id as session_id, s.status as session_status, s.started_at as session_started_at,
            s.ended_at as session_ended_at, s.duration_ms as session_duration_ms,
            s.transcript_turn_count, s.analysis,
            r.report as latest_report
       from public.projects p
       left join lateral (
         select * from public.sessions s where s.project_id = p.id
         order by s.started_at desc nulls last limit 1
       ) s on true
       left join lateral (
         select r.report from public.reports r where r.project_id = p.id
         order by r.created_at desc limit 1
       ) r on true
      where p.status <> 'archived' and ($2::uuid is null or p.owner_id = $2::uuid)
      order by p.created_at desc
      limit $1`,
    [Math.max(1, Math.min(100, Number(limit || 30))), ownerId || null]
  );
  return rows.map(rowToProjectSummary);
}

export async function getDebateProject(projectId, { ownerId = null } = {}) {
  if (!isDatabaseConfigured() || !projectId) return null;
  const { rows } = await query(
    `select p.*,
            s.id as session_id, s.status as session_status, s.started_at as session_started_at,
            s.ended_at as session_ended_at, s.duration_ms as session_duration_ms,
            s.transcript_turn_count, s.analysis, s.seq,
            r.report as latest_report
       from public.projects p
       left join lateral (
         select * from public.sessions s where s.project_id = p.id
         order by s.started_at desc nulls last limit 1
       ) s on true
       left join lateral (
         select r.report from public.reports r where r.project_id = p.id
         order by r.created_at desc limit 1
       ) r on true
      where p.id = $1 and ($2::uuid is null or p.owner_id = $2::uuid)
      limit 1`,
    [projectId, ownerId || null]
  );
  if (!rows[0]) return null;
  const summary = rowToProjectSummary(rows[0]);
  return {
    project: summary,
    analysis: rows[0].analysis || null,
    transcriptTurns: await loadTranscriptTurns(rows[0].session_id),
    report: rows[0].latest_report || null
  };
}

async function loadTranscriptTurns(sessionId) {
  if (!sessionId) return [];
  const { rows } = await query(
    `select id, speaker_id, text, start_sec, end_sec from public.transcript_turns where session_id=$1 order by start_sec asc, id asc`,
    [sessionId]
  );
  return rows.map((r) => ({ id: r.id, speakerId: r.speaker_id, text: r.text, startSec: Number(r.start_sec), endSec: Number(r.end_sec), isFinal: true }));
}

export async function updateDebateProjectTitle(projectId, title, { ownerId = null } = {}) {
  if (!isDatabaseConfigured() || !projectId) return null;
  const { rows } = await query(
    `update public.projects set title=$2, updated_at=now() where id=$1 and ($3::uuid is null or owner_id=$3::uuid) returning *`,
    [projectId, title || DEFAULT_PROJECT_TITLE, ownerId || null]
  );
  return rows[0] ? rowToProjectSummary(rows[0]) : null;
}

export async function updateDebateProjectSpeakerDisplayNames(projectId, speakerDisplayNames = {}, { ownerId = null } = {}) {
  if (!isDatabaseConfigured() || !projectId) return null;
  const { rows } = await query(
    `update public.projects set speaker_display_names=$2::jsonb, updated_at=now() where id=$1 and ($3::uuid is null or owner_id=$3::uuid) returning *`,
    [projectId, JSON.stringify(speakerDisplayNames || {}), ownerId || null]
  );
  return rows[0] ? rowToProjectSummary(rows[0]) : null;
}

export async function deleteDebateProject(projectId, { ownerId = null } = {}) {
  if (!isDatabaseConfigured() || !projectId) return false;
  const { rowCount } = await query(
    `update public.projects set status='archived', updated_at=now() where id=$1 and ($2::uuid is null or owner_id=$2::uuid)`,
    [projectId, ownerId || null]
  );
  return rowCount > 0;
}

// --- Row → summary the frontend sidebar consumes -----------------------------
function rowToProjectSummary(row) {
  const sessionDuration = Number(row.session_duration_ms || 0);
  const startedAt = row.session_started_at ? new Date(row.session_started_at).getTime() : (row.created_at ? new Date(row.created_at).getTime() : null);
  const endedAt = row.session_ended_at ? new Date(row.session_ended_at).getTime() : null;
  const analysis = row.analysis || null;
  return {
    id: row.id,
    title: row.title || DEFAULT_PROJECT_TITLE,
    status: row.status || row.session_status || "draft",
    topic: row.topic || analysis?.topic || "",
    startedAt,
    endedAt,
    durationMs: sessionDuration,
    sessionId: row.session_id || null,
    transcriptTurnCount: Number(row.transcript_turn_count || 0),
    analysis,
    speakerDisplayNames: row.speaker_display_names || {},
    report: row.latest_report || null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null
  };
}
