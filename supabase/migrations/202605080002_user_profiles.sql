create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  provider text,
  preferences jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_profiles_email_idx on public.user_profiles(lower(email));
create index if not exists user_profiles_last_seen_idx on public.user_profiles(last_seen_at desc);

drop trigger if exists set_user_profiles_updated_at on public.user_profiles;
create trigger set_user_profiles_updated_at
before update on public.user_profiles
for each row execute function public.set_updated_at();

alter table public.user_profiles enable row level security;

drop policy if exists "Users can read own profile" on public.user_profiles;
create policy "Users can read own profile"
on public.user_profiles for select
using (id = auth.uid());

drop policy if exists "Users can insert own profile" on public.user_profiles;
create policy "Users can insert own profile"
on public.user_profiles for insert
with check (id = auth.uid());

drop policy if exists "Users can update own profile" on public.user_profiles;
create policy "Users can update own profile"
on public.user_profiles for update
using (id = auth.uid())
with check (id = auth.uid());

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (
    id,
    email,
    full_name,
    avatar_url,
    provider,
    metadata,
    last_seen_at
  )
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    coalesce(new.raw_app_meta_data->>'provider', new.raw_app_meta_data->'providers'->>0),
    jsonb_build_object(
      'app_metadata', coalesce(new.raw_app_meta_data, '{}'::jsonb),
      'user_metadata', coalesce(new.raw_user_meta_data, '{}'::jsonb)
    ),
    now()
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.user_profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.user_profiles.avatar_url),
    provider = coalesce(excluded.provider, public.user_profiles.provider),
    metadata = public.user_profiles.metadata || excluded.metadata,
    last_seen_at = excluded.last_seen_at;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

insert into public.user_profiles (
  id,
  email,
  full_name,
  avatar_url,
  provider,
  metadata,
  last_seen_at
)
select
  id,
  email,
  coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name'),
  coalesce(raw_user_meta_data->>'avatar_url', raw_user_meta_data->>'picture'),
  coalesce(raw_app_meta_data->>'provider', raw_app_meta_data->'providers'->>0),
  jsonb_build_object(
    'app_metadata', coalesce(raw_app_meta_data, '{}'::jsonb),
    'user_metadata', coalesce(raw_user_meta_data, '{}'::jsonb)
  ),
  now()
from auth.users
on conflict (id) do update set
  email = excluded.email,
  full_name = coalesce(excluded.full_name, public.user_profiles.full_name),
  avatar_url = coalesce(excluded.avatar_url, public.user_profiles.avatar_url),
  provider = coalesce(excluded.provider, public.user_profiles.provider),
  metadata = public.user_profiles.metadata || excluded.metadata;
