-- Clean schema for the new debatly architecture.
create table if not exists public.user_profiles (
  id uuid primary key,
  email text, name text, avatar_url text, provider text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  title text not null default 'Untitled debate',
  topic text,
  status text not null default 'draft',
  speaker_display_names jsonb default '{}'::jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists projects_owner_idx on public.projects (owner_id);
create index if not exists projects_created_idx on public.projects (created_at desc);

create table if not exists public.sessions (
  id uuid primary key,
  project_id uuid references public.projects(id) on delete cascade,
  status text not null default 'recording',
  seq integer default 0,
  started_at timestamptz, ended_at timestamptz,
  duration_ms bigint default 0,
  transcript_turn_count integer default 0,
  analysis jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists sessions_project_idx on public.sessions (project_id);

create table if not exists public.transcript_turns (
  id text primary key,
  session_id uuid references public.sessions(id) on delete cascade,
  project_id uuid,
  speaker_id text, text text,
  start_sec double precision, end_sec double precision,
  created_at timestamptz default now()
);
create index if not exists turns_session_idx on public.transcript_turns (session_id);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  session_id uuid, owner_id uuid,
  report jsonb, duration_ms bigint default 0,
  created_at timestamptz default now()
);
create index if not exists reports_project_idx on public.reports (project_id);
