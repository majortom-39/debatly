alter table public.debate_clash_cards
  drop constraint if exists debate_clash_cards_verdict_check;

update public.debate_clash_cards
set verdict = case
  when verdict in ('blue_answered_better', 'red_answered_better', 'no_clear_edge', 'still_developing') then verdict
  else 'still_developing'
end;

alter table public.debate_clash_cards
  add constraint debate_clash_cards_verdict_check
  check (verdict in ('blue_answered_better', 'red_answered_better', 'no_clear_edge', 'still_developing'));
