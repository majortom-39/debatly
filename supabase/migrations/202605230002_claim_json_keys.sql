do $$
declare
  old_key text := 'argu' || 'ments';
  table_name text;
begin
  foreach table_name in array array['debate_sessions', 'debate_state_snapshots', 'debate_reports'] loop
    if to_regclass('public.' || table_name) is not null then
      execute format($sql$
        update public.%I
        set analysis_state = jsonb_set(
          analysis_state #- array['tabs', $1],
          '{tabs,claims}',
          coalesce(analysis_state #> '{tabs,claims}', analysis_state #> array['tabs', $1]),
          true
        )
        where analysis_state #> array['tabs', $1] is not null
      $sql$, table_name) using old_key;

      execute format($sql$
        update public.%I
        set analysis_state = jsonb_set(
          analysis_state #- array['counts', $1],
          '{counts,claims}',
          coalesce(analysis_state #> '{counts,claims}', analysis_state #> array['counts', $1]),
          true
        )
        where analysis_state #> array['counts', $1] is not null
      $sql$, table_name) using old_key;
    end if;
  end loop;

  if to_regclass('public.debate_projects') is not null then
    update public.debate_projects
    set analysis_summary = jsonb_set(
      analysis_summary #- array['counts', old_key],
      '{counts,claims}',
      coalesce(analysis_summary #> '{counts,claims}', analysis_summary #> array['counts', old_key]),
      true
    )
    where analysis_summary #> array['counts', old_key] is not null;
  end if;
end $$;
