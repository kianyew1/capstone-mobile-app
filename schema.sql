-- schema.sql
--
-- Apply this in the Supabase SQL editor for a new client environment.
-- It creates the relational tables expected by backend/app.py and backend/supabase.py,
-- creates the storage bucket used by the backend, and adds permissive policies that
-- match the current codebase assumption of using the Supabase anon key from the backend.
--
-- This is intentionally pragmatic, not hardened. If the client wants stricter security,
-- the backend should be moved to the service-role key and the policies should be narrowed.

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Core recording rows
-- -----------------------------------------------------------------------------
create table if not exists public.ecg_recordings (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  bucket text,
  session_object_key text,
  calibration_object_key text,
  encoding text,
  sample_rate_hz integer,
  channels integer,
  sample_count integer,
  duration_ms integer,
  elapsed_time_ms integer,
  effective_sps double precision,
  byte_length integer,
  status text,
  start_time timestamptz,
  notes jsonb,
  created_at timestamptz not null default timezone('Asia/Singapore', now())
);

create index if not exists idx_ecg_recordings_created_at
  on public.ecg_recordings (created_at desc);

create index if not exists idx_ecg_recordings_user_id
  on public.ecg_recordings (user_id);

-- -----------------------------------------------------------------------------
-- Chunk metadata rows for live session upload
-- -----------------------------------------------------------------------------
create table if not exists public.ecg_session_chunks (
  record_id uuid not null references public.ecg_recordings(id) on delete cascade,
  chunk_index integer not null,
  object_key text not null,
  byte_length integer,
  packet_count integer,
  sample_count integer,
  elapsed_time_ms integer,
  created_at timestamptz not null default timezone('Asia/Singapore', now()),
  primary key (record_id, chunk_index)
);

create index if not exists idx_ecg_session_chunks_created_at
  on public.ecg_session_chunks (created_at desc);

-- -----------------------------------------------------------------------------
-- Latest live preview row per recording
-- -----------------------------------------------------------------------------
create table if not exists public.ecg_live_preview (
  record_id uuid primary key references public.ecg_recordings(id) on delete cascade,
  ch2_preview jsonb not null default '[]'::jsonb,
  ch3_preview jsonb not null default '[]'::jsonb,
  ch4_preview jsonb not null default '[]'::jsonb,
  sample_count integer not null default 0,
  elapsed_time_ms integer not null default 0,
  updated_at timestamptz not null default timezone('Asia/Singapore', now())
);

create index if not exists idx_ecg_live_preview_updated_at
  on public.ecg_live_preview (updated_at desc);

-- -----------------------------------------------------------------------------
-- Processing state rows
-- -----------------------------------------------------------------------------
create table if not exists public.ecg_processed_records (
  record_id uuid primary key references public.ecg_recordings(id) on delete cascade,
  status text not null,
  processing_version text not null,
  updated_at timestamptz not null default timezone('Asia/Singapore', now()),
  error_message text
);

create index if not exists idx_ecg_processed_records_updated_at
  on public.ecg_processed_records (updated_at desc);

-- -----------------------------------------------------------------------------
-- Processed artifact pointers
-- -----------------------------------------------------------------------------
create table if not exists public.ecg_processed_artifacts (
  record_id uuid not null references public.ecg_recordings(id) on delete cascade,
  artifact_type text not null,
  object_key text not null,
  processing_version text not null,
  updated_at timestamptz not null default timezone('Asia/Singapore', now()),
  primary key (record_id, artifact_type)
);

create index if not exists idx_ecg_processed_artifacts_updated_at
  on public.ecg_processed_artifacts (updated_at desc);

create index if not exists idx_ecg_processed_artifacts_object_key
  on public.ecg_processed_artifacts (object_key);

-- -----------------------------------------------------------------------------
-- Storage bucket
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('ecg-data', 'ecg-data', false)
on conflict (id) do nothing;

-- If the client prefers a different bucket name, they must:
-- 1) change the bucket name above,
-- 2) set SUPABASE_STORAGE_BUCKET to match,
-- 3) keep the storage policies below aligned.

-- -----------------------------------------------------------------------------
-- Row-level security strategy
-- -----------------------------------------------------------------------------
-- The current backend uses the anon key rather than the service-role key.
-- To keep handover friction low, enable RLS and add broad policies.
-- This mirrors the current code assumptions; it is not a production-hardening pass.

alter table public.ecg_recordings enable row level security;
alter table public.ecg_session_chunks enable row level security;
alter table public.ecg_live_preview enable row level security;
alter table public.ecg_processed_records enable row level security;
alter table public.ecg_processed_artifacts enable row level security;

-- Drop-and-recreate style keeps reruns idempotent enough for Supabase SQL editor use.
drop policy if exists "ecg_recordings_read" on public.ecg_recordings;
drop policy if exists "ecg_recordings_write" on public.ecg_recordings;
drop policy if exists "ecg_session_chunks_read" on public.ecg_session_chunks;
drop policy if exists "ecg_session_chunks_write" on public.ecg_session_chunks;
drop policy if exists "ecg_live_preview_read" on public.ecg_live_preview;
drop policy if exists "ecg_live_preview_write" on public.ecg_live_preview;
drop policy if exists "ecg_processed_records_read" on public.ecg_processed_records;
drop policy if exists "ecg_processed_records_write" on public.ecg_processed_records;
drop policy if exists "ecg_processed_artifacts_read" on public.ecg_processed_artifacts;
drop policy if exists "ecg_processed_artifacts_write" on public.ecg_processed_artifacts;

create policy "ecg_recordings_read"
  on public.ecg_recordings
  for select
  to anon, authenticated
  using (true);

create policy "ecg_recordings_write"
  on public.ecg_recordings
  for all
  to anon, authenticated
  using (true)
  with check (true);

create policy "ecg_session_chunks_read"
  on public.ecg_session_chunks
  for select
  to anon, authenticated
  using (true);

create policy "ecg_session_chunks_write"
  on public.ecg_session_chunks
  for all
  to anon, authenticated
  using (true)
  with check (true);

create policy "ecg_live_preview_read"
  on public.ecg_live_preview
  for select
  to anon, authenticated
  using (true);

create policy "ecg_live_preview_write"
  on public.ecg_live_preview
  for all
  to anon, authenticated
  using (true)
  with check (true);

create policy "ecg_processed_records_read"
  on public.ecg_processed_records
  for select
  to anon, authenticated
  using (true);

create policy "ecg_processed_records_write"
  on public.ecg_processed_records
  for all
  to anon, authenticated
  using (true)
  with check (true);

create policy "ecg_processed_artifacts_read"
  on public.ecg_processed_artifacts
  for select
  to anon, authenticated
  using (true);

create policy "ecg_processed_artifacts_write"
  on public.ecg_processed_artifacts
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- -----------------------------------------------------------------------------
-- Storage policies for the ecg-data bucket
-- -----------------------------------------------------------------------------
drop policy if exists "ecg_storage_read" on storage.objects;
drop policy if exists "ecg_storage_write" on storage.objects;

create policy "ecg_storage_read"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'ecg-data');

create policy "ecg_storage_write"
  on storage.objects
  for all
  to anon, authenticated
  using (bucket_id = 'ecg-data')
  with check (bucket_id = 'ecg-data');
