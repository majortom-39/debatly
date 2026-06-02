alter table public.debate_claim_cards
  add column if not exists source_debate_point_id text,
  add column if not exists claim_point_id text;

alter table public.debate_fact_checks
  add column if not exists source_debate_point_id text,
  add column if not exists claim_point_id text;

create index if not exists debate_claim_cards_source_point_idx
  on public.debate_claim_cards(session_id, source_debate_point_id);

create index if not exists debate_fact_checks_source_point_idx
  on public.debate_fact_checks(session_id, source_debate_point_id);
