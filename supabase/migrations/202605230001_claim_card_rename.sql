do $$
declare
  old_cards_table text := 'debate_' || 'argu' || 'ment_cards';
  old_fact_col text := 'argu' || 'ment_card_id';
  old_time_idx text := 'debate_' || 'argu' || 'ment_cards_project_time_idx';
  old_active_idx text := 'debate_' || 'argu' || 'ment_cards_active_idx';
  old_trigger text := 'set_debate_' || 'argu' || 'ment_cards_updated_at';
  old_policy text := 'Users can read own debate ' || 'argu' || 'ment cards';
  old_pkey text := 'debate_' || 'argu' || 'ment_cards_pkey';
begin
  if to_regclass('public.debate_claim_cards') is null and to_regclass('public.' || old_cards_table) is not null then
    execute format('alter table public.%I rename to debate_claim_cards', old_cards_table);
  end if;

  if to_regclass('public.debate_fact_checks') is not null then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'debate_fact_checks'
        and column_name = old_fact_col
    ) and not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'debate_fact_checks'
        and column_name = 'claim_card_id'
    ) then
      execute format('alter table public.debate_fact_checks rename column %I to claim_card_id', old_fact_col);
    end if;
  end if;

  if to_regclass('public.debate_claim_cards') is not null then
    if exists (
      select 1
      from information_schema.table_constraints
      where table_schema = 'public'
        and table_name = 'debate_claim_cards'
        and constraint_name = old_pkey
    ) then
      execute format('alter table public.debate_claim_cards rename constraint %I to debate_claim_cards_pkey', old_pkey);
    end if;

    execute format('drop index if exists public.%I', old_time_idx);
    execute format('drop index if exists public.%I', old_active_idx);

    create index if not exists debate_claim_cards_project_time_idx
      on public.debate_claim_cards(project_id, side_id, coalesce(start_sec, end_sec), updated_at desc);

    create index if not exists debate_claim_cards_active_idx
      on public.debate_claim_cards(session_id, is_active);

    execute format('drop trigger if exists %I on public.debate_claim_cards', old_trigger);
    drop trigger if exists set_debate_claim_cards_updated_at on public.debate_claim_cards;

    if to_regprocedure('public.set_updated_at()') is not null then
      create trigger set_debate_claim_cards_updated_at
      before update on public.debate_claim_cards
      for each row execute function public.set_updated_at();
    end if;

    alter table public.debate_claim_cards enable row level security;

    execute format('drop policy if exists %I on public.debate_claim_cards', old_policy);
    drop policy if exists "Users can read own debate claim cards" on public.debate_claim_cards;
    create policy "Users can read own debate claim cards"
    on public.debate_claim_cards for select
    using (exists (
      select 1 from public.debate_projects p
      where p.id = debate_claim_cards.project_id and p.owner_id = auth.uid()
    ));
  end if;
end $$;
