-- Inline rename in the lobby: players type their name into their own roster row
-- instead of a modal before joining, so the server needs a way to rewrite one entry.
-- See supabase/schema.sql for the full schema.

-- ── Renaming yourself in the lobby ─────────────────────────────────────────────────
-- Players type their name straight into their roster row, so the name arrives after the
-- seat does (and can change while others watch). Rewrites just this client's entry under
-- a row lock, leaving the rest of the roster — and the seat order — untouched. Only in
-- the lobby: once the race starts, names live in the state, not here. Unknown client or
-- missing game is a no-op (returns the row as it is).
create or replace function public.rename_player(p_code text, p_client_id text, p_name text)
returns public.games
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.games;
begin
  select * into g from public.games where id = p_code for update;
  if not found then
    raise exception 'game_not_found';
  end if;
  if g.status <> 'lobby' then
    return g;
  end if;
  update public.games
     set lobby = (
           select coalesce(jsonb_agg(
             case when e->>'clientId' = p_client_id
                  then jsonb_set(e, '{name}', to_jsonb(p_name))
                  else e end
             order by ord
           ), '[]'::jsonb)
           from jsonb_array_elements(lobby) with ordinality t(e, ord)
         ),
         updated_at = now()
   where id = p_code
   returning * into g;
  return g;
end;
$$;

grant execute on function public.rename_player(text, text, text) to anon, authenticated;
