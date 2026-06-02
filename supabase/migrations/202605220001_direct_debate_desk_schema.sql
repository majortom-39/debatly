alter table public.debate_projects
  add column if not exists analysis_schema_version integer not null default 6,
  add column if not exists analysis_summary jsonb not null default '{}'::jsonb;

alter table public.debate_sessions
  add column if not exists analysis_schema_version integer not null default 6,
  add column if not exists analysis_state jsonb not null default '{}'::jsonb;

alter table public.debate_state_snapshots
  add column if not exists analysis_schema_version integer not null default 6,
  add column if not exists analysis_state jsonb not null default '{}'::jsonb;

alter table public.debate_reports
  add column if not exists analysis_schema_version integer not null default 6,
  add column if not exists analysis_state jsonb not null default '{}'::jsonb;

create table if not exists public.debate_claim_cards (
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  card_id text not null,
  side_id text not null check (side_id in ('side-a', 'side-b')),
  speaker_id text,
  claim text not null,
  quote text,
  fact_status text not null default 'checking' check (fact_status in ('checking', 'verified', 'contradicted', 'no_clear_source', 'cannot_verify')),
  source_query text,
  source_reason text,
  start_sec numeric,
  end_sec numeric,
  at_ms bigint,
  turn_ids jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, card_id)
);

create table if not exists public.debate_fact_checks (
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  check_id text not null,
  claim_card_id text,
  side_id text check (side_id in ('side-a', 'side-b')),
  speaker_id text,
  statement text not null,
  search_query text,
  status text not null default 'checking' check (status in ('checking', 'verified', 'contradicted', 'no_clear_source', 'cannot_verify')),
  provider text,
  sources jsonb not null default '[]'::jsonb,
  explanation text,
  started_at timestamptz,
  completed_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, check_id)
);

create table if not exists public.debate_clash_cards (
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  card_id text not null,
  proposition text not null,
  blue_card_id text,
  red_card_id text,
  blue_speaker_id text,
  red_speaker_id text,
  blue_quote text,
  red_quote text,
  status text not null default 'unanswered' check (status in ('answered', 'unanswered', 'still_developing')),
  verdict text not null default 'still_developing' check (verdict in ('blue_answered_better', 'red_answered_better', 'no_clear_edge', 'still_developing')),
  reason text,
  start_sec numeric,
  end_sec numeric,
  at_ms bigint,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, card_id)
);

create table if not exists public.debate_inconsistency_cards (
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  card_id text not null,
  side_id text not null check (side_id in ('side-a', 'side-b')),
  speaker_id text,
  title text not null,
  summary text,
  first_quote text,
  second_quote text,
  status text not null default 'open' check (status in ('open', 'confirmed')),
  start_sec numeric,
  end_sec numeric,
  at_ms bigint,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, card_id)
);

create table if not exists public.debate_key_moment_cards (
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  card_id text not null,
  side_id text not null check (side_id in ('side-a', 'side-b')),
  kind text not null check (kind in ('source_verified', 'source_contradicted', 'strong_rebuttal', 'weak_response', 'inconsistency', 'unanswered_challenge')),
  impact text not null check (impact in ('positive', 'negative')),
  score_delta integer not null,
  title text not null,
  summary text,
  quote text,
  start_sec numeric,
  end_sec numeric,
  at_ms bigint,
  artifact_ids jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, card_id)
);

create table if not exists public.debate_score_events (
  session_id uuid not null references public.debate_sessions(id) on delete cascade,
  project_id uuid not null references public.debate_projects(id) on delete cascade,
  event_id text not null,
  key_moment_id text,
  side_id text not null check (side_id in ('side-a', 'side-b')),
  side_color text not null check (side_color in ('blue', 'red')),
  category text not null check (category in ('source_verified', 'source_contradicted', 'strong_rebuttal', 'weak_response', 'inconsistency', 'unanswered_challenge')),
  delta integer not null,
  title text not null,
  detail text,
  minute numeric,
  at_ms bigint,
  artifact_ids jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, event_id)
);

create index if not exists debate_claim_cards_project_time_idx on public.debate_claim_cards(project_id, side_id, coalesce(start_sec, end_sec), updated_at desc);
create index if not exists debate_fact_checks_project_status_idx on public.debate_fact_checks(project_id, status, updated_at desc);
create index if not exists debate_clash_cards_project_time_idx on public.debate_clash_cards(project_id, coalesce(start_sec, end_sec), updated_at desc);
create index if not exists debate_inconsistency_cards_project_time_idx on public.debate_inconsistency_cards(project_id, side_id, coalesce(start_sec, end_sec), updated_at desc);
create index if not exists debate_key_moment_cards_project_time_idx on public.debate_key_moment_cards(project_id, side_id, coalesce(start_sec, end_sec), updated_at desc);
create index if not exists debate_score_events_project_time_idx on public.debate_score_events(project_id, side_id, coalesce(minute, 0), updated_at desc);

drop trigger if exists set_debate_claim_cards_updated_at on public.debate_claim_cards;
create trigger set_debate_claim_cards_updated_at
before update on public.debate_claim_cards
for each row execute function public.set_updated_at();

drop trigger if exists set_debate_fact_checks_updated_at on public.debate_fact_checks;
create trigger set_debate_fact_checks_updated_at
before update on public.debate_fact_checks
for each row execute function public.set_updated_at();

drop trigger if exists set_debate_clash_cards_updated_at on public.debate_clash_cards;
create trigger set_debate_clash_cards_updated_at
before update on public.debate_clash_cards
for each row execute function public.set_updated_at();

drop trigger if exists set_debate_inconsistency_cards_updated_at on public.debate_inconsistency_cards;
create trigger set_debate_inconsistency_cards_updated_at
before update on public.debate_inconsistency_cards
for each row execute function public.set_updated_at();

drop trigger if exists set_debate_key_moment_cards_updated_at on public.debate_key_moment_cards;
create trigger set_debate_key_moment_cards_updated_at
before update on public.debate_key_moment_cards
for each row execute function public.set_updated_at();

drop trigger if exists set_debate_score_events_updated_at on public.debate_score_events;
create trigger set_debate_score_events_updated_at
before update on public.debate_score_events
for each row execute function public.set_updated_at();

alter table public.debate_claim_cards enable row level security;
alter table public.debate_fact_checks enable row level security;
alter table public.debate_clash_cards enable row level security;
alter table public.debate_inconsistency_cards enable row level security;
alter table public.debate_key_moment_cards enable row level security;
alter table public.debate_score_events enable row level security;

drop policy if exists "Users can read own debate claim cards" on public.debate_claim_cards;
create policy "Users can read own debate claim cards"
on public.debate_claim_cards for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_claim_cards.project_id and p.owner_id = auth.uid()
));

drop policy if exists "Users can read own debate fact checks" on public.debate_fact_checks;
create policy "Users can read own debate fact checks"
on public.debate_fact_checks for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_fact_checks.project_id and p.owner_id = auth.uid()
));

drop policy if exists "Users can read own debate clash cards" on public.debate_clash_cards;
create policy "Users can read own debate clash cards"
on public.debate_clash_cards for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_clash_cards.project_id and p.owner_id = auth.uid()
));

drop policy if exists "Users can read own debate inconsistency cards" on public.debate_inconsistency_cards;
create policy "Users can read own debate inconsistency cards"
on public.debate_inconsistency_cards for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_inconsistency_cards.project_id and p.owner_id = auth.uid()
));

drop policy if exists "Users can read own debate key moment cards" on public.debate_key_moment_cards;
create policy "Users can read own debate key moment cards"
on public.debate_key_moment_cards for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_key_moment_cards.project_id and p.owner_id = auth.uid()
));

drop policy if exists "Users can read own debate score events" on public.debate_score_events;
create policy "Users can read own debate score events"
on public.debate_score_events for select
using (exists (
  select 1 from public.debate_projects p
  where p.id = debate_score_events.project_id and p.owner_id = auth.uid()
));
