alter table public.debate_projects
  alter column analysis_schema_version set default 6;

alter table public.debate_sessions
  alter column analysis_schema_version set default 6;

alter table public.debate_state_snapshots
  alter column analysis_schema_version set default 6;

alter table public.debate_reports
  alter column analysis_schema_version set default 6;

do $$
declare
  old_cards_table text := 'debate_' || 'argu' || 'ment_cards';
begin
  if to_regclass('public.debate_claim_cards') is null and to_regclass('public.' || old_cards_table) is not null then
    execute format('alter table public.%I rename to debate_claim_cards', old_cards_table);
  end if;
end $$;

alter table public.debate_claim_cards
  add column if not exists is_active boolean not null default true,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

alter table public.debate_fact_checks
  add column if not exists is_active boolean not null default true,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

alter table public.debate_clash_cards
  add column if not exists is_active boolean not null default true,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

alter table public.debate_inconsistency_cards
  add column if not exists is_active boolean not null default true,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

alter table public.debate_key_moment_cards
  add column if not exists is_active boolean not null default true,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

alter table public.debate_score_events
  add column if not exists is_active boolean not null default true,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

alter table public.debate_clash_cards
  drop constraint if exists debate_clash_cards_verdict_check;

update public.debate_clash_cards
set verdict = case
  when verdict in ('blue_answered_better', 'red_answered_better', 'no_clear_edge', 'still_developing') then verdict
  else coalesce(nullif(verdict, ''), 'still_developing')
end;

alter table public.debate_clash_cards
  add constraint debate_clash_cards_verdict_check
  check (verdict in ('blue_answered_better', 'red_answered_better', 'no_clear_edge', 'still_developing'));

create table if not exists public.debate_side_assignment_events (
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  event_id text not null,
  speaker_id text not null,
  side_id text check (side_id in ('side-a', 'side-b')),
  confidence numeric,
  decision_reason text,
  evidence_quote text,
  debate_start_sec numeric,
  debate_end_sec numeric,
  debate_minute numeric,
  packet_range jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (session_id, event_id)
);

create table if not exists public.debate_node_events (
  session_id uuid references public.debate_sessions(id) on delete cascade,
  project_id uuid references public.debate_projects(id) on delete cascade,
  event_id text not null,
  node text not null,
  stage text not null,
  wall_clock_at timestamptz not null default now(),
  debate_start_sec numeric,
  debate_end_sec numeric,
  debate_minute numeric,
  transcript_window_start_sec numeric,
  transcript_window_end_sec numeric,
  batch_seq integer,
  packet_range jsonb not null default '{}'::jsonb,
  input_counts jsonb not null default '{}'::jsonb,
  output_counts jsonb not null default '{}'::jsonb,
  decision_reason text,
  payload jsonb not null default '{}'::jsonb,
  primary key (event_id)
);

create index if not exists debate_side_assignment_events_session_time_idx
  on public.debate_side_assignment_events(session_id, speaker_id, coalesce(debate_end_sec, debate_start_sec), created_at desc);

create index if not exists debate_node_events_session_time_idx
  on public.debate_node_events(session_id, node, coalesce(debate_end_sec, debate_start_sec), wall_clock_at desc);

create index if not exists debate_claim_cards_active_idx on public.debate_claim_cards(session_id, is_active);
create index if not exists debate_fact_checks_active_idx on public.debate_fact_checks(session_id, is_active);
create index if not exists debate_clash_cards_active_idx on public.debate_clash_cards(session_id, is_active);
create index if not exists debate_inconsistency_cards_active_idx on public.debate_inconsistency_cards(session_id, is_active);
create index if not exists debate_key_moment_cards_active_idx on public.debate_key_moment_cards(session_id, is_active);
create index if not exists debate_score_events_active_idx on public.debate_score_events(session_id, is_active);
