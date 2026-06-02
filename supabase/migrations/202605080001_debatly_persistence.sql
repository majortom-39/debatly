create extension if not exists pgcrypto;

create table if not exists public.debate_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid null references auth.users(id) on delete set null,
  title text not null default 'Untitled debate',
  status text not null default 'draft' check (status in ('draft', 'recording', 'stopped', 'report_ready', 'archived')),
  topic text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_ms bigint not null default 0,
  last_session_id uuid,
  summary jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.debate_sessions (
  id uuid primary key,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  owner_id uuid null references auth.users(id) on delete set null,
  source text not null default 'live',
  status text not null default 'recording' check (status in ('recording', 'stopping', 'stopped', 'report_ready', 'error')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_ms bigint not null default 0,
  transcript_turn_count integer not null default 0,
  analysis_seq integer not null default 0,
  current_debate jsonb not null default '{}'::jsonb,
  score_history jsonb not null default '[]'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transcript_turns (
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  id text not null,
  speaker_id text not null,
  text text not null,
  is_final boolean not null default true,
  at_ms bigint,
  at_ts timestamptz,
  start_sec numeric,
  end_sec numeric,
  words jsonb not null default '[]'::jsonb,
  speaker_source text,
  created_at timestamptz not null default now(),
  primary key (session_id, id)
);

create table if not exists public.debate_state_snapshots (
  id bigserial primary key,
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  seq integer not null default 0,
  source text not null,
  debate_state jsonb not null default '{}'::jsonb,
  score_history jsonb not null default '[]'::jsonb,
  timings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.debate_reports (
  id text primary key,
  session_id uuid references public.debate_sessions(id) on delete set null,
  project_id uuid references public.debate_projects(id) on delete cascade,
  owner_id uuid null references auth.users(id) on delete set null,
  generated_at timestamptz not null default now(),
  report jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists debate_projects_owner_updated_idx on public.debate_projects(owner_id, updated_at desc);
create index if not exists debate_projects_status_updated_idx on public.debate_projects(status, updated_at desc);
create index if not exists debate_sessions_project_started_idx on public.debate_sessions(project_id, started_at desc);
create index if not exists transcript_turns_project_time_idx on public.transcript_turns(project_id, coalesce(start_sec, end_sec), at_ms);
create index if not exists transcript_turns_session_time_idx on public.transcript_turns(session_id, coalesce(start_sec, end_sec), at_ms);
create index if not exists debate_state_snapshots_session_seq_idx on public.debate_state_snapshots(session_id, seq, created_at desc);
create index if not exists debate_reports_project_created_idx on public.debate_reports(project_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_debate_projects_updated_at on public.debate_projects;
create trigger set_debate_projects_updated_at
before update on public.debate_projects
for each row execute function public.set_updated_at();

drop trigger if exists set_debate_sessions_updated_at on public.debate_sessions;
create trigger set_debate_sessions_updated_at
before update on public.debate_sessions
for each row execute function public.set_updated_at();

drop trigger if exists set_debate_reports_updated_at on public.debate_reports;
create trigger set_debate_reports_updated_at
before update on public.debate_reports
for each row execute function public.set_updated_at();

alter table public.debate_projects enable row level security;
alter table public.debate_sessions enable row level security;
alter table public.transcript_turns enable row level security;
alter table public.debate_state_snapshots enable row level security;
alter table public.debate_reports enable row level security;

drop policy if exists "Users can read own debate projects" on public.debate_projects;
create policy "Users can read own debate projects"
on public.debate_projects for select
using (owner_id = auth.uid());

drop policy if exists "Users can insert own debate projects" on public.debate_projects;
create policy "Users can insert own debate projects"
on public.debate_projects for insert
with check (owner_id = auth.uid());

drop policy if exists "Users can update own debate projects" on public.debate_projects;
create policy "Users can update own debate projects"
on public.debate_projects for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Users can delete own debate projects" on public.debate_projects;
create policy "Users can delete own debate projects"
on public.debate_projects for delete
using (owner_id = auth.uid());

drop policy if exists "Users can read own debate sessions" on public.debate_sessions;
create policy "Users can read own debate sessions"
on public.debate_sessions for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_sessions.project_id and p.owner_id = auth.uid()
));

drop policy if exists "Users can read own transcript turns" on public.transcript_turns;
create policy "Users can read own transcript turns"
on public.transcript_turns for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = transcript_turns.project_id and p.owner_id = auth.uid()
));

drop policy if exists "Users can read own debate snapshots" on public.debate_state_snapshots;
create policy "Users can read own debate snapshots"
on public.debate_state_snapshots for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_state_snapshots.project_id and p.owner_id = auth.uid()
));

drop policy if exists "Users can read own debate reports" on public.debate_reports;
create policy "Users can read own debate reports"
on public.debate_reports for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_reports.project_id and p.owner_id = auth.uid()
));
