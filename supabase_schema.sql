-- Supabase schema updates for chunked raw storage + live preview
-- Safe to run multiple times (uses IF NOT EXISTS and additive ALTERs).

create extension if not exists "pgcrypto";

-- ecg_recordings: add new fields required by the refactor plan (do not drop old columns).
alter table public.ecg_recordings add column if not exists session_id text;
alter table public.ecg_recordings add column if not exists session_chunks_prefix text;
alter table public.ecg_recordings add column if not exists packet_count int;
alter table public.ecg_recordings add column if not exists first_ts_ms int;
alter table public.ecg_recordings add column if not exists last_ts_ms int;
alter table public.ecg_recordings add column if not exists effective_sps numeric(10,4);
alter table public.ecg_recordings add column if not exists processing_version text;
alter table public.ecg_recordings add column if not exists status text;

-- Raw session chunks (append-only)
create table if not exists public.ecg_session_chunks (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.ecg_recordings(id) on delete cascade,
  chunk_index int not null,
  object_key text not null,
  byte_length int not null,
  packet_count int not null,
  sample_count int not null,
  first_ts_ms int,
  last_ts_ms int,
  created_at timestamptz not null default now(),
  unique (record_id, chunk_index)
);

create index if not exists ecg_session_chunks_record_id_idx
  on public.ecg_session_chunks (record_id);

-- Live preview cache
create table if not exists public.ecg_live_preview (
  record_id uuid primary key references public.ecg_recordings(id) on delete cascade,
  ch2_preview float4[] not null,
  ch3_preview float4[] not null,
  ch4_preview float4[] not null,
  sample_count int not null,
  last_ts_ms int,
  updated_at timestamptz not null default now()
);

create index if not exists ecg_live_preview_updated_at_idx
  on public.ecg_live_preview (updated_at desc);

-- Processed artifacts table (if not already present)
create table if not exists public.ecg_processed_artifacts (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.ecg_recordings(id) on delete cascade,
  artifact_type text not null,
  object_key text not null,
  byte_length int,
  sample_count int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (record_id, artifact_type)
);

-- RLS: allow anon access (select/insert/update). Adjust if you want to restrict later.
alter table public.ecg_recordings enable row level security;
alter table public.ecg_session_chunks enable row level security;
alter table public.ecg_live_preview enable row level security;
alter table public.ecg_processed_artifacts enable row level security;

drop policy if exists anon_select_ecg_recordings on public.ecg_recordings;
drop policy if exists anon_insert_ecg_recordings on public.ecg_recordings;
drop policy if exists anon_update_ecg_recordings on public.ecg_recordings;

create policy anon_select_ecg_recordings
  on public.ecg_recordings for select
  to anon using (true);

create policy anon_insert_ecg_recordings
  on public.ecg_recordings for insert
  to anon with check (true);

create policy anon_update_ecg_recordings
  on public.ecg_recordings for update
  to anon using (true) with check (true);

drop policy if exists anon_select_ecg_session_chunks on public.ecg_session_chunks;
drop policy if exists anon_insert_ecg_session_chunks on public.ecg_session_chunks;
drop policy if exists anon_update_ecg_session_chunks on public.ecg_session_chunks;

create policy anon_select_ecg_session_chunks
  on public.ecg_session_chunks for select
  to anon using (true);

create policy anon_insert_ecg_session_chunks
  on public.ecg_session_chunks for insert
  to anon with check (true);

create policy anon_update_ecg_session_chunks
  on public.ecg_session_chunks for update
  to anon using (true) with check (true);

drop policy if exists anon_select_ecg_live_preview on public.ecg_live_preview;
drop policy if exists anon_insert_ecg_live_preview on public.ecg_live_preview;
drop policy if exists anon_update_ecg_live_preview on public.ecg_live_preview;

create policy anon_select_ecg_live_preview
  on public.ecg_live_preview for select
  to anon using (true);

create policy anon_insert_ecg_live_preview
  on public.ecg_live_preview for insert
  to anon with check (true);

create policy anon_update_ecg_live_preview
  on public.ecg_live_preview for update
  to anon using (true) with check (true);

drop policy if exists anon_select_ecg_processed_artifacts on public.ecg_processed_artifacts;
drop policy if exists anon_insert_ecg_processed_artifacts on public.ecg_processed_artifacts;
drop policy if exists anon_update_ecg_processed_artifacts on public.ecg_processed_artifacts;

create policy anon_select_ecg_processed_artifacts
  on public.ecg_processed_artifacts for select
  to anon using (true);

create policy anon_insert_ecg_processed_artifacts
  on public.ecg_processed_artifacts for insert
  to anon with check (true);

create policy anon_update_ecg_processed_artifacts
  on public.ecg_processed_artifacts for update
  to anon using (true) with check (true);
