-- Baby tracker schema. Run once in Supabase SQL editor.
-- Mirrors the contractions table: shared household scope via tracker_key,
-- public anon read/write (the tracker_key is the secret).

create table if not exists public.baby_events (
  id           uuid primary key,
  tracker_key  text not null,
  type         text not null check (type in (
                 'diaper', 'feed_breast', 'feed_bottle', 'sleep', 'pump'
               )),
  start_at     timestamptz not null,
  end_at       timestamptz,
  duration_ms  integer,
  details      jsonb not null default '{}'::jsonb,
  notes        text,
  manual       boolean not null default false,
  client_id    uuid,
  created_at   timestamptz not null default now()
);

create index if not exists baby_events_key_start_idx
  on public.baby_events (tracker_key, start_at desc);
create index if not exists baby_events_key_type_idx
  on public.baby_events (tracker_key, type);

alter table public.baby_events enable row level security;

drop policy if exists "baby_events anon read"  on public.baby_events;
drop policy if exists "baby_events anon write" on public.baby_events;
drop policy if exists "baby_events anon update" on public.baby_events;
drop policy if exists "baby_events anon delete" on public.baby_events;

create policy "baby_events anon read"   on public.baby_events for select using (true);
create policy "baby_events anon write"  on public.baby_events for insert with check (true);
create policy "baby_events anon update" on public.baby_events for update using (true) with check (true);
create policy "baby_events anon delete" on public.baby_events for delete using (true);

-- Realtime: make sure the table is in the publication so subscriptions work.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'baby_events'
  ) then
    execute 'alter publication supabase_realtime add table public.baby_events';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Babies: identity shared across the contractions + baby_events trackers.
-- One row per child. Stores name and (optional) birth time. Records in the
-- other tables get tagged via baby_id so a household can keep data separated
-- across siblings later.
-- ---------------------------------------------------------------------------

create table if not exists public.babies (
  id           uuid primary key,
  tracker_key  text not null,
  name         text not null,
  birth_at     timestamptz,
  notes        text,
  created_at   timestamptz not null default now()
);

create index if not exists babies_key_idx on public.babies (tracker_key);

alter table public.babies enable row level security;

drop policy if exists "babies anon read"   on public.babies;
drop policy if exists "babies anon write"  on public.babies;
drop policy if exists "babies anon update" on public.babies;
drop policy if exists "babies anon delete" on public.babies;

create policy "babies anon read"   on public.babies for select using (true);
create policy "babies anon write"  on public.babies for insert with check (true);
create policy "babies anon update" on public.babies for update using (true) with check (true);
create policy "babies anon delete" on public.babies for delete using (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'babies'
  ) then
    execute 'alter publication supabase_realtime add table public.babies';
  end if;
end $$;

-- Tag records to a baby. Nullable so existing rows survive; backfill via UI.
alter table public.baby_events  add column if not exists baby_id uuid;
alter table public.contractions add column if not exists baby_id uuid;

create index if not exists baby_events_baby_idx  on public.baby_events  (baby_id);
create index if not exists contractions_baby_idx on public.contractions (baby_id);

-- Light/dark preference, synced alongside the accent (theme) per household.
alter table public.tracker_settings add column if not exists mode text;

-- Which baby widgets are shown (JSON array of keys: diaper, breast, bottle,
-- sleep, pump). Null = show all. Synced per household.
alter table public.tracker_settings add column if not exists baby_trackers jsonb;

-- ---------------------------------------------------------------------------
-- Apple Watch / Shortcuts integration.
-- The web app supplies id/start_at on every insert, but a watch Shortcut
-- (Get Contents of URL) has no way to generate a UUID, so give these columns
-- defaults. Harmless for the web client, which keeps sending its own values.
-- ---------------------------------------------------------------------------
alter table public.baby_events alter column id       set default gen_random_uuid();
alter table public.baby_events alter column start_at set default now();

-- A watch can't easily do date math, so let an "End feed" PATCH set only
-- end_at and have the duration computed server-side. Runs on insert+update;
-- recomputes the same value the web client already sends, so it's a no-op there.
create or replace function public.set_baby_event_duration()
returns trigger language plpgsql as $$
begin
  if new.end_at is not null and new.start_at is not null then
    new.duration_ms := round(extract(epoch from (new.end_at - new.start_at)) * 1000);
  end if;
  return new;
end $$;

drop trigger if exists baby_events_duration on public.baby_events;
create trigger baby_events_duration
  before insert or update on public.baby_events
  for each row execute function public.set_baby_event_duration();
