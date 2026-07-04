-- Схема бэкенда онлайн-режима Paper Racing для Supabase (Postgres + Realtime).
--
-- Применить один раз в своём проекте: Supabase Dashboard → SQL Editor → вставить и
-- выполнить. После этого прописать URL проекта и anon-ключ в .env (VITE_SUPABASE_URL,
-- VITE_SUPABASE_ANON_KEY) — см. .env.example.
--
-- Модель синхронизации — «общий стейт, ходит — пишет»: игра пошаговая, активен всегда
-- один игрок, поэтому конфликтов записи нет. Клиент активного игрока применяет ход
-- локально и пишет строку игры; остальные получают realtime-UPDATE и перерисовываются.

-- ── Таблица игр ────────────────────────────────────────────────────────────────
create table if not exists public.games (
  id         text primary key,            -- короткий код игры (см. генерацию на клиенте)
  track      jsonb not null,              -- сериализованная трасса + worldW/worldH (пишется один раз)
  state      jsonb,                       -- сериализованный GameState (без track); null до старта
  lobby      jsonb not null default '[]', -- ростер: [{ "clientId": ..., "name": ... }], индекс = место
  host_id    text  not null,              -- clientId создателя игры
  status     text  not null default 'lobby' check (status in ('lobby', 'race', 'over')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Realtime ───────────────────────────────────────────────────────────────────
-- Публикуем таблицу в realtime, чтобы клиенты подписывались на изменения строки игры.
alter table public.games replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.games;
exception
  when duplicate_object then null; -- уже добавлена
end;
$$;

-- ── Доступ ─────────────────────────────────────────────────────────────────────
-- Казуальная игра без аутентификации: разрешаем анонимной роли читать/писать строки.
-- Компромисс: зная код, теоретически можно вмешаться в чужую игру. Для игры это
-- приемлемо; при желании позже ужесточить (короткий TTL, серверные RPC на все записи).
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

-- ── Атомарное присоединение ──────────────────────────────────────────────────────
-- Добавляет место в lobby одним оператором под row-lock — снимает гонку одновременных
-- join'ов (иначе last-write-wins потерял бы игрока). Идемпотентна по clientId.
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
  if g.status <> 'lobby' then
    raise exception 'game_started';
  end if;
  -- Уже в лобби (переоткрыл ссылку) — возвращаем как есть.
  if exists (
    select 1 from jsonb_array_elements(g.lobby) e where e->>'clientId' = p_client_id
  ) then
    return g;
  end if;
  -- Вместимость = число стартовых позиций трассы (не больше 6).
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

-- ── Выход из лобби ───────────────────────────────────────────────────────────────
-- Убирает место из lobby. Если после этого лобби опустело или из лобби вышел хост —
-- удаляет игру целиком (в гонке место не убираем, чтобы не рассыпать порядок ходов —
-- вышедший игрок просто не ходит, а игра дочистится по TTL).
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

-- ── Очистка (TTL) ────────────────────────────────────────────────────────────────
-- Раз в час удаляем: законченные игры (через 10 минут после финиша) и брошенные
-- лобби/гонки, неактивные более суток (updated_at = последняя активность).
create extension if not exists pg_cron;

select cron.schedule(
  'paper-racing-cleanup',
  '0 * * * *',
  $$delete from public.games
     where updated_at < now() - interval '1 day'
        or (status = 'over' and updated_at < now() - interval '10 minutes')$$
);
