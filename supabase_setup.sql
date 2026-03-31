-- ─── LUMI SUPABASE SETUP ──────────────────────────────────────────────────────
-- Run this entire file in: Supabase Dashboard → SQL Editor → New query

-- ─── TABLES ───────────────────────────────────────────────────────────────────

create table profiles (
  id uuid references auth.users on delete cascade,
  name text,
  grade text,
  values_profile jsonb default '{"values":[],"goals":[],"interests":[]}',
  created_at timestamp with time zone default timezone('utc'::text, now()),
  primary key (id)
);

create table conversations (
  id uuid default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  title text,
  messages jsonb default '[]',
  teacher text,
  course text,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  primary key (id)
);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────────────

alter table profiles      enable row level security;
alter table conversations enable row level security;

create policy "Users can only access own profile" on profiles
  for all using (auth.uid() = id);

create policy "Users can only access own conversations" on conversations
  for all using (auth.uid() = user_id);

-- ─── OPTIONAL: AUTO-UPDATE updated_at ─────────────────────────────────────────

create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at
  before update on conversations
  for each row
  execute function update_updated_at_column();
