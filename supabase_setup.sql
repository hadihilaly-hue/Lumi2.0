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

-- ─── TEACHER PROFILES ─────────────────────────────────────────────────────────

create table teacher_profiles (
  id                   uuid default gen_random_uuid(),
  teacher_email        text not null,
  class_name           text not null,
  subject              text,
  done                 boolean default false,
  teaching_style       text,
  excellence_criteria  text,
  grading_philosophy   text,
  common_mistakes      jsonb default '[]',
  explanation_methods  text,
  key_values           text,
  class_specific_notes text,
  teacher_voice        text,
  messages_json        jsonb default '[]',
  created_at           timestamp with time zone default timezone('utc'::text, now()),
  updated_at           timestamp with time zone default timezone('utc'::text, now()),
  primary key (id),
  unique (teacher_email, class_name)
);

alter table teacher_profiles enable row level security;

-- Teachers can read and write their own profiles
create policy "Teachers manage own profiles" on teacher_profiles
  for all using (teacher_email = (select email from auth.users where id = auth.uid()))
  with check (teacher_email = (select email from auth.users where id = auth.uid()));

-- Students (and anyone authenticated) can read all teacher profiles
-- so app.js can fetch teacher context when tutoring
create policy "Authenticated users can read teacher profiles" on teacher_profiles
  for select using (auth.role() = 'authenticated');

-- Auto-update updated_at
create trigger set_teacher_profiles_updated_at
  before update on teacher_profiles
  for each row
  execute function update_updated_at_column();
