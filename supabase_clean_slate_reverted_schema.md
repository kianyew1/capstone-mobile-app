# Supabase Schema Repair for Reverted Stable Backend

Use this in Supabase SQL Editor for the current reverted backend in `backend/app.py` and `backend/supabase.py`.

This version is additive and safe for partially existing tables. It fixes missing columns such as `bucket` on `ecg_recordings`, which the reverted backend still expects.

Before running:
- Replace every `capstone_ecg` below if your actual bucket name is different.
- Keep that bucket name consistent with `EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET`.

```sql
begin;

create extension if not exists pgcrypto;

-- =========================================================
-- ecg_recordings
-- =========================================================
alter table public.ecg_recordings
  add column if not exists user_id text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists bucket text,
  add column if not exists session_object_key text,
  add column if not exists encoding text default 'ads1298_24be_mv',
  add column if not exists sample_rate_hz integer default 500,
  add column if not exists channels smallint default 3,
  add column if not exists sample_count integer default 0,
  add column if not exists duration_ms integer default 0,
  add column if not exists start_time timestamptz,
  add column if not exists byte_length integer,
  add column if not exists notes text,
  add column if not exists calibration_object_key text,
  add column if not exists packet_count integer,
  add column if not exists elapsed_time_ms integer,
  add column if not exists effective_sps numeric(10,4),
  add column if not exists status text;

update public.ecg_recordings
set
  bucket = coalesce(bucket, 'capstone_ecg'),
  session_object_key = coalesce(session_object_key, 'pending'),
  encoding = coalesce(encoding, 'ads1298_24be_mv'),
  sample_rate_hz = coalesce(sample_rate_hz, 500),
  channels = coalesce(channels, 3),
  sample_count = coalesce(sample_count, 0),
  duration_ms = coalesce(duration_ms, 0)
where
  bucket is null
  or session_object_key is null
  or encoding is null
  or sample_rate_hz is null
  or channels is null
  or sample_count is null
  or duration_ms is null;

create index if not exists ecg_recordings_user_created_idx
  on public.ecg_recordings (user_id, created_at desc);

create index if not exists ecg_recordings_created_idx
  on public.ecg_recordings (created_at desc);

-- =========================================================
-- ecg_session_chunks
-- =========================================================
create table if not exists public.ecg_session_chunks (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.ecg_recordings(id) on delete cascade,
  chunk_index integer not null,
  object_key text not null,
  byte_length integer not null,
  packet_count integer not null,
  sample_count integer not null,
  elapsed_time_ms integer,
  created_at timestamptz not null default now(),
  constraint ecg_session_chunks_record_id_chunk_index_key unique (record_id, chunk_index)
);

alter table public.ecg_session_chunks
  add column if not exists record_id uuid,
  add column if not exists chunk_index integer,
  add column if not exists object_key text,
  add column if not exists byte_length integer,
  add column if not exists packet_count integer,
  add column if not exists sample_count integer,
  add column if not exists elapsed_time_ms integer,
  add column if not exists created_at timestamptz default now();

create index if not exists ecg_session_chunks_record_id_idx
  on public.ecg_session_chunks (record_id);

-- =========================================================
-- ecg_live_preview
-- =========================================================
create table if not exists public.ecg_live_preview (
  record_id uuid primary key references public.ecg_recordings(id) on delete cascade,
  ch2_preview real[] not null default '{}'::real[],
  ch3_preview real[] not null default '{}'::real[],
  ch4_preview real[] not null default '{}'::real[],
  sample_count integer not null default 0,
  elapsed_time_ms integer,
  updated_at timestamptz not null default now()
);

alter table public.ecg_live_preview
  add column if not exists ch2_preview real[] default '{}'::real[],
  add column if not exists ch3_preview real[] default '{}'::real[],
  add column if not exists ch4_preview real[] default '{}'::real[],
  add column if not exists sample_count integer default 0,
  add column if not exists elapsed_time_ms integer,
  add column if not exists updated_at timestamptz default now();

create index if not exists ecg_live_preview_updated_at_idx
  on public.ecg_live_preview (updated_at desc);

-- =========================================================
-- ecg_processed_records
-- =========================================================
create table if not exists public.ecg_processed_records (
  record_id uuid primary key references public.ecg_recordings(id) on delete cascade,
  status text not null default 'queued',
  processing_version text not null,
  updated_at timestamptz not null default now(),
  error_message text,
  constraint ecg_processed_records_status_check
    check (status = any (array['queued','processing','ready','error']))
);

alter table public.ecg_processed_records
  add column if not exists status text default 'queued',
  add column if not exists processing_version text,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists error_message text;

create index if not exists ecg_processed_records_status_idx
  on public.ecg_processed_records (status);

-- =========================================================
-- ecg_processed_artifacts
-- =========================================================
create table if not exists public.ecg_processed_artifacts (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.ecg_recordings(id) on delete cascade,
  artifact_type text not null,
  object_key text not null,
  updated_at timestamptz not null default now(),
  constraint ecg_processed_artifacts_record_id_artifact_type_key unique (record_id, artifact_type)
);

alter table public.ecg_processed_artifacts
  add column if not exists record_id uuid,
  add column if not exists artifact_type text,
  add column if not exists object_key text,
  add column if not exists updated_at timestamptz default now();

create index if not exists ecg_processed_artifacts_record_id_idx
  on public.ecg_processed_artifacts (record_id);

commit;
```
