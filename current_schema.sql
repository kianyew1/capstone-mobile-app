create table public.ecg_live_preview (
  record_id uuid not null,
  ch2_preview real[] not null,
  ch3_preview real[] not null,
  ch4_preview real[] not null,
  sample_count integer not null,
  last_ts_ms integer null,
  updated_at timestamp with time zone not null default now(),
  constraint ecg_live_preview_pkey primary key (record_id),
  constraint ecg_live_preview_record_id_fkey foreign KEY (record_id) references ecg_recordings (id) on delete CASCADE
) TABLESPACE pg_default;

create table public.ecg_processed_artifacts (
  id uuid not null default gen_random_uuid (),
  record_id uuid not null,
  artifact_type text not null,
  object_key text not null,
  updated_at timestamp with time zone not null default now(),
  constraint ecg_processed_artifacts_pkey primary key (id),
  constraint ecg_processed_artifacts_record_id_artifact_type_key unique (record_id, artifact_type),
  constraint ecg_processed_artifacts_record_id_fkey foreign KEY (record_id) references ecg_recordings (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists ecg_processed_artifacts_record_id_idx on public.ecg_processed_artifacts using btree (record_id) TABLESPACE pg_default;

create table public.ecg_processed_records (
  record_id uuid not null,
  status text not null default 'queued'::text,
  processing_version text not null,
  updated_at timestamp with time zone not null default now(),
  error_message text null,
  constraint ecg_processed_records_pkey primary key (record_id),
  constraint ecg_processed_records_record_id_fkey foreign KEY (record_id) references ecg_recordings (id) on delete CASCADE,
  constraint ecg_processed_records_status_check check (
    (
      status = any (
        array[
          'queued'::text,
          'processing'::text,
          'ready'::text,
          'error'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists ecg_processed_records_status_idx on public.ecg_processed_records using btree (status) TABLESPACE pg_default;

create table public.ecg_recordings (
  id uuid not null default gen_random_uuid (),
  user_id text not null,
  created_at timestamp with time zone null default now(),
  bucket text not null default 'YOUR_BUCKET_NAME'::text,
  session_object_key text null,
  encoding text not null default 'int16_le'::text,
  sample_rate_hz integer not null default 500,
  channels smallint null default 1,
  sample_count integer not null,
  duration_ms integer not null,
  start_time timestamp with time zone null,
  device_time_us bigint null,
  byte_length integer null,
  sha256 text null,
  device_id text null,
  firmware_version text null,
  notes text null,
  calibration_object_key text not null,
  session_id text null,
  session_chunks_prefix text null,
  packet_count integer null,
  first_ts_ms integer null,
  last_ts_ms integer null,
  effective_sps numeric(10, 4) null,
  processing_version text null,
  status text null,
  constraint ecg_recordings_pkey primary key (id)
) TABLESPACE pg_default;

create index IF not exists ecg_recordings_user_created_idx on public.ecg_recordings using btree (user_id, created_at desc) TABLESPACE pg_default;

create table public.ecg_session_chunks (
  id uuid not null default gen_random_uuid (),
  record_id uuid not null,
  chunk_index integer not null,
  object_key text not null,
  byte_length integer not null,
  packet_count integer not null,
  sample_count integer not null,
  first_ts_ms integer null,
  last_ts_ms integer null,
  created_at timestamp with time zone not null default now(),
  constraint ecg_session_chunks_pkey primary key (id),
  constraint ecg_session_chunks_record_id_chunk_index_key unique (record_id, chunk_index),
  constraint ecg_session_chunks_record_id_fkey foreign KEY (record_id) references ecg_recordings (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists ecg_session_chunks_record_id_idx on public.ecg_session_chunks using btree (record_id) TABLESPACE pg_default;