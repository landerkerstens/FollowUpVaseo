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

-- Toegelaten gebruikers (oude lijst). Blijft bestaan om bij de eerste keer te weten wie al toegang had;
-- sindsdien bepaalt app_users hieronder wie wat mag.
create table if not exists public.allowed_users (
  user_id   uuid primary key references auth.users on delete cascade,
  added_at  timestamptz not null default now()
);
insert into public.allowed_users (user_id)
  select id from auth.users
  where not exists (select 1 from public.allowed_users);

-- Gebruikers met een naam en een rol. Rollen:
--   admin        alles, ook gebruikers beheren
--   editor       alles behalve gebruikers beheren
--   contributor  toevoegen en wijzigen (verwijderen en importeren zijn in de app uitgeschakeld)
--   viewer       alleen lezen (door de databank afgedwongen)
--   none         geen toegang
create table if not exists public.app_users (
  id        uuid primary key references auth.users on delete cascade,
  name      text not null default '',
  role      text not null default 'none' check (role in ('none', 'viewer', 'contributor', 'editor', 'admin')),
  added_at  timestamptz not null default now()
);

-- Eerste keer: wie al toegang had, wordt beheerder. Zet in de app (menu → Gebruikers) daarna
-- iedereen op de juiste rol. Alle andere accounts komen op de lijst zonder toegang.
insert into public.app_users (id, name, role)
  select u.id, split_part(u.email, '@', 1), 'admin'
  from auth.users u join public.allowed_users a on a.user_id = u.id
  where not exists (select 1 from public.app_users);
insert into public.app_users (id, name, role)
  select u.id, split_part(u.email, '@', 1), 'none' from auth.users u
  on conflict (id) do nothing;

-- Een nieuw account (aangemaakt in het Supabase-dashboard) komt vanzelf op de lijst, zonder toegang.
create or replace function public.add_app_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_users (id, name, role)
  values (new.id, split_part(coalesce(new.email, ''), '@', 1), 'none')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists app_user_added on auth.users;
create trigger app_user_added
  after insert on auth.users
  for each row execute function public.add_app_user();

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.app_users where id = auth.uid()), 'none');
$$;
create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() in ('viewer', 'contributor', 'editor', 'admin');
$$;
create or replace function public.can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() in ('contributor', 'editor', 'admin');
$$;

-- Er moet altijd minstens één beheerder overblijven.
create or replace function public.keep_one_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and new.role <> 'admin'
     and not exists (select 1 from public.app_users where role = 'admin' and id <> old.id) then
    raise exception 'laatste beheerder';
  end if;
  return new;
end $$;

drop trigger if exists app_users_keep_admin on public.app_users;
create trigger app_users_keep_admin
  before update on public.app_users
  for each row execute function public.keep_one_admin();

-- Beveiliging: lezen voor wie toegang heeft, schrijven vanaf de rol contributor.
alter table public.app_state enable row level security;
alter table public.app_state_backups enable row level security;
alter table public.app_state_history enable row level security;
alter table public.allowed_users enable row level security;
alter table public.app_users enable row level security;

drop policy if exists "aangemeld lezen" on public.app_state;
drop policy if exists "aangemeld toevoegen" on public.app_state;
drop policy if exists "aangemeld wijzigen" on public.app_state;
drop policy if exists "aangemeld back-ups lezen" on public.app_state_backups;
drop policy if exists "aangemeld historiek lezen" on public.app_state_history;
drop policy if exists "gebruikers lezen" on public.app_users;
drop policy if exists "gebruikers wijzigen" on public.app_users;

create policy "aangemeld lezen" on public.app_state
  for select to authenticated using (public.is_allowed());
create policy "aangemeld toevoegen" on public.app_state
  for insert to authenticated with check (public.can_write());
create policy "aangemeld wijzigen" on public.app_state
  for update to authenticated using (public.can_write()) with check (public.can_write());
create policy "aangemeld back-ups lezen" on public.app_state_backups
  for select to authenticated using (public.is_allowed());
create policy "aangemeld historiek lezen" on public.app_state_history
  for select to authenticated using (public.is_allowed());
-- Iedereen met toegang ziet de namen (voor "ingevoerd door"); je eigen rij zie je altijd.
create policy "gebruikers lezen" on public.app_users
  for select to authenticated using (public.is_allowed() or id = auth.uid());
create policy "gebruikers wijzigen" on public.app_users
  for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

revoke all on public.app_state, public.app_state_backups, public.app_state_history, public.allowed_users, public.app_users from anon;
revoke all on public.allowed_users from authenticated;
revoke all on public.app_users from authenticated;
grant select, update (name, role) on public.app_users to authenticated;
revoke execute on function public.is_allowed(), public.can_write(), public.my_role() from public, anon;
grant execute on function public.is_allowed(), public.can_write(), public.my_role() to authenticated;
revoke execute on function public.add_app_user(), public.keep_one_admin() from public, anon, authenticated;
