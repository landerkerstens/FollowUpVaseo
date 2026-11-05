-- FollowUp Vaseo – databank in Supabase
-- Plak dit in Supabase → SQL Editor → New query → Run.

-- Alle data van de app (ziekenhuizen, contacten, contactmomenten) staat als één JSON-document.
create table if not exists public.app_state (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- Dagelijkse kopie van het document, zodat je altijd kan terugkeren.
create table if not exists public.app_state_backups (
  id          text not null,
  day         date not null default current_date,
  data        jsonb not null,
  saved_at    timestamptz not null default now(),
  primary key (id, day)
);

create or replace function public.backup_app_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_state_backups (id, day, data, saved_at)
  values (new.id, current_date, new.data, now())
  on conflict (id, day) do update set data = excluded.data, saved_at = excluded.saved_at;
  return new;
end $$;

drop trigger if exists app_state_backup on public.app_state;
create trigger app_state_backup
  after insert or update on public.app_state
  for each row execute function public.backup_app_state();

-- Historiek: de vorige versie blijft bewaard, maximaal één kopie per 10 minuten.
create table if not exists public.app_state_history (
  seq       bigserial primary key,
  id        text not null,
  data      jsonb not null,
  saved_at  timestamptz not null default now(),
  saved_by  uuid
);
create index if not exists app_state_history_saved on public.app_state_history (id, saved_at desc);

create or replace function public.history_app_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.app_state_history
                 where id = old.id and saved_at > now() - interval '10 minutes') then
    insert into public.app_state_history (id, data, saved_by) values (old.id, old.data, old.updated_by);
  end if;
  -- Bewaartermijn: verwijderde gegevens blijven niet eindeloos in oude kopieën staan.
  delete from public.app_state_history where saved_at < now() - interval '90 days';
  delete from public.app_state_backups where day < current_date - 365;
  return new;
end $$;

drop trigger if exists app_state_history on public.app_state;
create trigger app_state_history
  before update on public.app_state
  for each row execute function public.history_app_state();

-- Wie sloeg het laatst op? Niet door de app in te vullen, dus betrouwbaar.
create or replace function public.stamp_app_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists app_state_stamp on public.app_state;
create trigger app_state_stamp
  before insert or update on public.app_state
  for each row execute function public.stamp_app_state();

-- Toegelaten gebruikers. Bij de eerste keer komen alle bestaande accounts op de lijst;
-- een account dat daarna bijkomt, moet je hier zelf toevoegen.
create table if not exists public.allowed_users (
  user_id   uuid primary key references auth.users on delete cascade,
  added_at  timestamptz not null default now()
);
insert into public.allowed_users (user_id)
  select id from auth.users
  where not exists (select 1 from public.allowed_users);

create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed_users where user_id = auth.uid());
$$;

-- Beveiliging: enkel toegelaten gebruikers mogen lezen en schrijven.
alter table public.app_state enable row level security;
alter table public.app_state_backups enable row level security;
alter table public.app_state_history enable row level security;
alter table public.allowed_users enable row level security;

drop policy if exists "aangemeld lezen" on public.app_state;
drop policy if exists "aangemeld toevoegen" on public.app_state;
drop policy if exists "aangemeld wijzigen" on public.app_state;
drop policy if exists "aangemeld back-ups lezen" on public.app_state_backups;
drop policy if exists "aangemeld historiek lezen" on public.app_state_history;

create policy "aangemeld lezen" on public.app_state
  for select to authenticated using (public.is_allowed());
create policy "aangemeld toevoegen" on public.app_state
  for insert to authenticated with check (public.is_allowed());
create policy "aangemeld wijzigen" on public.app_state
  for update to authenticated using (public.is_allowed()) with check (public.is_allowed());
create policy "aangemeld back-ups lezen" on public.app_state_backups
  for select to authenticated using (public.is_allowed());
create policy "aangemeld historiek lezen" on public.app_state_history
  for select to authenticated using (public.is_allowed());

revoke all on public.app_state, public.app_state_backups, public.app_state_history, public.allowed_users from anon;
revoke all on public.allowed_users from authenticated;
revoke execute on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated;
