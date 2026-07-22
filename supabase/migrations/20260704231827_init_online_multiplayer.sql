-- Backend schema for Paper Racing's online mode, on Supabase (Postgres + Realtime).
--
-- Apply this once in your project: Supabase Dashboard → SQL Editor → paste and run.
-- After that, set your project URL and anon key in .env (VITE_SUPABASE_URL,
-- VITE_SUPABASE_ANON_KEY) — see .env.example.
--
-- Sync model — "shared state, whoever moves writes it": the game is turn-based and
-- exactly one player is active at a time, so there are no write conflicts. The active
-- player's client applies the move locally and writes the game row; everyone else
-- gets a realtime UPDATE and re-renders.

-- ── Games table ────────────────────────────────────────────────────────────────
create table if not exists public.games (
  id         text primary key,            -- short game code (see generation on the client)
  track      jsonb not null,              -- serialized track + worldW/worldH (written once)
  state      jsonb,                       -- serialized GameState (without track); null before the race starts
  lobby      jsonb not null default '[]', -- roster: [{ "clientId": ..., "name": ... }], index = grid slot
  host_id    text  not null,              -- clientId of the game's creator
  status     text  not null default 'lobby' check (status in ('lobby', 'race', 'over')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Realtime ───────────────────────────────────────────────────────────────────
-- Publish the table over realtime so clients can subscribe to changes on the game row.
alter table public.games replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.games;
exception
  when duplicate_object then null; -- already added
end;
$$;

-- ── Access ─────────────────────────────────────────────────────────────────────
-- A casual game with no authentication: allow the anon role to read/write rows.
-- Tradeoff: knowing the code, someone could in theory interfere with someone else's
-- game. That's acceptable for this game; can be tightened later (short TTL, server-side
-- RPCs for all writes).
grant select, insert, update, delete on public.games to anon, authenticated;

alter table public.games enable row level security;

do $$
begin
  create policy games_read   on public.games for select using (true);
  create policy games_insert on public.games for insert with check (true);
  create policy games_update on public.games for update using (true) with check (true);
  create policy games_delete on public.games for delete using (true);
exception
  when duplicate_object then null;
end;
$$;

-- ── Atomic join ──────────────────────────────────────────────────────────────────
-- Adds a slot to the lobby in a single statement under a row lock — avoids a race
-- between concurrent joins (otherwise last-write-wins would drop a player). Idempotent
-- per clientId.
create or replace function public.join_game(p_code text, p_client_id text, p_name text)
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
  -- Reconnect: the player is already seated (reopened the link / came back after
  -- closing the tab) — return the row as-is, even if the race is already underway.
  if exists (
    select 1 from jsonb_array_elements(g.lobby) e where e->>'clientId' = p_client_id
  ) then
    return g;
  end if;
  -- A new player can only join while the game is still in the lobby.
  if g.status <> 'lobby' then
    raise exception 'game_started';
  end if;
  -- Capacity = the number of the track's starting positions (at most 6).
  if jsonb_array_length(g.lobby) >= jsonb_array_length(g.track->'startPoints') then
    raise exception 'game_full';
  end if;
  update public.games
     set lobby = lobby || jsonb_build_object('clientId', p_client_id, 'name', p_name),
         updated_at = now()
   where id = p_code
   returning * into g;
  return g;
end;
$$;

grant execute on function public.join_game(text, text, text) to anon, authenticated;

-- ── Leaving the lobby ──────────────────────────────────────────────────────────────
-- Removes a slot from the lobby. If the lobby ends up empty afterward, or the host
-- left, deletes the game entirely (during a race we don't remove the slot, to avoid
-- disrupting turn order — the departed player simply doesn't take turns, and the game
-- gets cleaned up by TTL).
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

-- ── Cleanup (TTL) ────────────────────────────────────────────────────────────────
-- Once an hour, delete: finished games (10 minutes after the finish) and abandoned
-- lobbies/races inactive for more than a day (updated_at = last activity).
create extension if not exists pg_cron;

select cron.schedule(
  'paper-racing-cleanup',
  '0 * * * *',
  $$delete from public.games
     where updated_at < now() - interval '1 day'
        or (status = 'over' and updated_at < now() - interval '10 minutes')$$
);
