-- Leaving once a race exists: mark the seat instead of dropping it, so a departed
-- player stops riding along in the next race. See supabase/schema.sql for the full schema.

-- ── Leaving the lobby or the race ──────────────────────────────────────────────────
-- In the lobby a seat is removed outright (no grid positions exist yet, so the shift is
-- safe), and the game is deleted when the host leaves or the lobby empties.
--
-- Once the race has started, the seat may NOT be removed: `lobby` is positional — its
-- index is the player's grid slot, and clients read their own seat by that index — so
-- dropping an entry would shift everyone below it onto the wrong cars. Instead the entry
-- is flagged `left`. The running race is unaffected (the departed player simply doesn't
-- take turns), while the rematch — which is built from this roster — can now tell who is
-- gone and leave them out.
create or replace function public.leave_game(p_code text, p_client_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.games;
begin
  select * into g from public.games where id = p_code for update;
  if not found then
    return;
  end if;
  if g.status <> 'lobby' then
    update public.games
       set lobby = (
             select coalesce(
                      jsonb_agg(
                        case when e->>'clientId' = p_client_id
                             then e || jsonb_build_object('left', true)
                             else e end
                        order by ord
                      ),
                      '[]'::jsonb
                    )
             from jsonb_array_elements(g.lobby) with ordinality t(e, ord)
           ),
           updated_at = now()
     where id = p_code;
    return;
  end if;
  if p_client_id = g.host_id then
    delete from public.games where id = p_code;
    return;
  end if;
  update public.games
     set lobby = (
           select coalesce(jsonb_agg(e), '[]'::jsonb)
           from jsonb_array_elements(lobby) e
           where e->>'clientId' <> p_client_id
         ),
         updated_at = now()
   where id = p_code;
  delete from public.games where id = p_code and jsonb_array_length(lobby) = 0;
end;
$$;

grant execute on function public.leave_game(text, text) to anon, authenticated;
