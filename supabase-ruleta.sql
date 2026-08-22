-- =====================================================================
-- ssephtiss — supabase-ruleta.sql
-- Este es el script para el proyecto de Supabase NUEVO, separado del
-- fixture. Con esto quedan armadas las 4 tablas que necesita la
-- ruleta: settings (código de acceso), participants (los anotados
-- con !sorteo, con sus chances), winners (historial de ganadores del
-- sorteo actual, para que no vuelvan a salir en la rueda) y prize
-- (el cartel de premio con el pokémon).
-- Ojo: esto SÍ borra esas tablas si ya existían, para dejarlas
-- limpitas — solo lo corro cuando quiero arrancar de cero.
-- =====================================================================

drop table if exists public.participants cascade;
drop table if exists public.winners cascade;
drop table if exists public.settings cascade;
drop table if exists public.prize cascade;

-- ---------- SETTINGS: código de acceso para streamer/mods ----------
create table public.settings (
  id integer primary key default 1,
  streamer_code text not null default 'R34P3R',
  constraint settings_single_row check (id = 1)
);
insert into public.settings (id) values (1);

-- ---------- PARTICIPANTS: los anotados con !sorteo en el chat ----------
-- "chances" es 1 normal, 2 si está suscripto (Twitch no distingue acá
-- entre sub paga, regalada o Prime — todas prenden el mismo badge).
-- "username" es la clave: si escribe !sorteo dos veces no se duplica.
create table public.participants (
  username text primary key,
  chances integer not null default 1 check (chances in (1,2)),
  subscriber boolean not null default false,
  entered_at timestamptz not null default now()
);

-- ---------- WINNERS: historial del sorteo actual ----------
-- Cada vez que gira la ruleta y sale un nombre, se borra de
-- participants y se guarda acá. Así nunca vuelve a salir en la misma
-- tanda de sorteos, aunque tuviera 2 chances.
create table public.winners (
  id bigint generated always as identity primary key,
  username text not null,
  prize_label text,
  won_at timestamptz not null default now()
);

-- ---------- PRIZE: el cartel de premio actual (pokémon) ----------
create table public.prize (
  id integer primary key default 1,
  pokemon_name text,
  prize_label text,
  is_shiny boolean not null default false,
  constraint prize_single_row check (id = 1)
);
insert into public.prize (id) values (1);

-- ---------- Prendo Row Level Security en las 4 ----------
alter table public.settings enable row level security;
alter table public.participants enable row level security;
alter table public.winners enable row level security;
alter table public.prize enable row level security;

-- ---------- Políticas: cualquiera puede leer y escribir ----------
-- Mismo criterio que el fixture: como no hay login de verdad, la
-- única traba para editar es el código, que lo controla script.js.
-- No guardes acá nada más sensible que esto.
create policy "lectura para todos" on public.settings for select using (true);
create policy "escritura para todos" on public.settings for all using (true) with check (true);

create policy "lectura para todos" on public.participants for select using (true);
create policy "escritura para todos" on public.participants for all using (true) with check (true);

create policy "lectura para todos" on public.winners for select using (true);
create policy "escritura para todos" on public.winners for all using (true) with check (true);

create policy "lectura para todos" on public.prize for select using (true);
create policy "escritura para todos" on public.prize for all using (true) with check (true);

-- ---------- Permisos para el rol "anon" (el que usa el sitio) ----------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.settings to anon, authenticated;
grant select, insert, update, delete on public.participants to anon, authenticated;
grant select, insert, update, delete on public.winners to anon, authenticated;
grant select, insert, update, delete on public.prize to anon, authenticated;

-- ---------- Prendo Realtime para que se actualice solo ----------
alter publication supabase_realtime add table public.settings;
alter publication supabase_realtime add table public.participants;
alter publication supabase_realtime add table public.winners;
alter publication supabase_realtime add table public.prize;
