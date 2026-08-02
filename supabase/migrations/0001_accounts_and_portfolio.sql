-- Accounts + cloud portfolio schema (M7).
-- profiles (1:1 auth.users) · folders (a user's grouping) · projects (a saved room).
-- The project `document` is Rust's opaque save envelope; the DB never interprets it.
--
-- Applied to the `spacelab-auth` Supabase project on 2026-08-02. Kept here so the schema
-- is reproducible on a fresh project (via the Supabase CLI or by pasting into the SQL
-- editor). See README "Accounts & cloud portfolio".

-- === Tables ===============================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'Per-user profile and free-form settings, 1:1 with auth.users. Created by a trigger on sign-up.';

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);
create index folders_owner_idx on public.folders(owner);
comment on table public.folders is 'A named grouping of projects within one user''s portfolio.';

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete set null,
  name text not null check (char_length(name) between 1 and 200),
  document jsonb,
  thumbnail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_owner_idx on public.projects(owner);
create index projects_folder_idx on public.projects(folder_id);
comment on table public.projects is 'A saved room. `document` is the opaque save envelope emitted by Rust save_json().';

-- === Triggers =============================================================

-- Keep updated_at honest on every write.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger projects_set_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- Materialise a profile the instant an auth user is created. security definer so it can
-- write public.profiles regardless of the caller; search_path pinned empty per best practice.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- === Row-level security ===================================================

alter table public.profiles enable row level security;
alter table public.folders  enable row level security;
alter table public.projects enable row level security;

-- profiles: read/update your own row only. No insert policy on purpose — the trigger
-- creates it; users never insert profiles directly. (select auth.uid()) so the planner
-- evaluates it once per query, not once per row.
create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- folders: full CRUD, scoped to owner.
create policy "folders_select_own" on public.folders
  for select to authenticated using ((select auth.uid()) = owner);
create policy "folders_insert_own" on public.folders
  for insert to authenticated with check ((select auth.uid()) = owner);
create policy "folders_update_own" on public.folders
  for update to authenticated using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);
create policy "folders_delete_own" on public.folders
  for delete to authenticated using ((select auth.uid()) = owner);

-- projects: full CRUD, scoped to owner.
create policy "projects_select_own" on public.projects
  for select to authenticated using ((select auth.uid()) = owner);
create policy "projects_insert_own" on public.projects
  for insert to authenticated with check ((select auth.uid()) = owner);
create policy "projects_update_own" on public.projects
  for update to authenticated using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);
create policy "projects_delete_own" on public.projects
  for delete to authenticated using ((select auth.uid()) = owner);
