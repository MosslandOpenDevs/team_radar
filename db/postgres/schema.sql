-- TeamRadar PostgreSQL schema (event-sourcing friendly)
-- Usage:
--   psql "$DATABASE_URL" -f db/postgres/schema.sql

create extension if not exists pgcrypto;

create table if not exists users (
  user_id text primary key,
  display_name text,
  username text,
  global_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  message_id text,
  user_id text references users(user_id) on delete set null,
  display_name text,
  kind text not null check (kind in ('attendance','work')),
  state text,
  summary text,
  attendance_name text,
  channel_id text,
  occurred_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  raw_payload jsonb
);

create unique index if not exists events_message_id_uq on events(message_id) where message_id is not null;
create index if not exists events_kind_occurred_at_idx on events(kind, occurred_at desc);
create index if not exists events_user_occurred_at_idx on events(user_id, occurred_at desc);

create table if not exists user_status_current (
  user_id text primary key references users(user_id) on delete cascade,
  display_name text,
  attendance_state text,
  attendance_name text,
  attendance_raw_text text,
  attendance_channel_id text,
  attendance_message_id text,
  attendance_at timestamptz,
  work_state text,
  work_summary text,
  work_channel_id text,
  work_message_id text,
  work_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists user_work_logs (
  id bigserial primary key,
  user_id text not null references users(user_id) on delete cascade,
  state text,
  summary text,
  channel_id text,
  message_id text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists user_work_logs_user_occurred_idx on user_work_logs(user_id, occurred_at desc);

create table if not exists mappings_attendance_name (
  attendance_name text primary key,
  user_id text not null references users(user_id) on delete cascade,
  display_name text,
  username text,
  global_name text,
  updated_at timestamptz not null default now()
);

create table if not exists mappings_character_selection (
  user_id text primary key references users(user_id) on delete cascade,
  character_sheet text not null,
  updated_at timestamptz not null default now()
);

create table if not exists attendance_by_name_current (
  attendance_name text primary key,
  state text,
  raw_text text,
  channel_id text,
  message_id text,
  occurred_at timestamptz,
  updated_at timestamptz not null default now()
);
