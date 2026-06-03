-- Public sharing: a per-project share token, and a back-reference on imported
-- copies so importing the same link twice doesn't create duplicates.
-- NOTE: the live persistence layer uses public.projects (see server/store.mjs).
alter table public.projects add column if not exists share_id text;
alter table public.projects add column if not exists source_share_id text;

create unique index if not exists projects_share_id_idx
  on public.projects(share_id) where share_id is not null;

create index if not exists projects_source_share_idx
  on public.projects(owner_id, source_share_id);
