# Database and Storage Setup

This document is the handover reference for the Supabase side of the project.

The application stack does not work from code alone. The backend expects a Supabase project with specific REST tables and one storage bucket already available.

Read this together with:

- `README.md`
- `QUICK_START.md`
- `backend/README.md`
- `schema.sql`

## First step for a new client database

Apply `schema.sql` in the Supabase SQL editor first. That file is the authoritative bootstrap for the current codebase.

## What Supabase is used for

The backend uses Supabase for two different concerns:

1. relational metadata tables accessed through the Supabase REST API,
2. object storage for raw binaries, processed JSON artifacts, manifests, and generated PNGs.

## Required environment variables

The backend reads these values from `backend/.env` or the process environment.

Required:

- `SUPABASE_URL` or `EXPO_PUBLIC_SUPABASE_URL`
- `SUPABASE_ANON_KEY` or `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_STORAGE_BUCKET` or `EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET`

Optional:

- `BASE_URL`

Example:

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_STORAGE_BUCKET=ecg-data
BASE_URL=http://127.0.0.1:8001
```

## Tables the backend expects

The backend reads or writes these tables:

- `ecg_recordings`
- `ecg_session_chunks`
- `ecg_live_preview`
- `ecg_processed_records`
- `ecg_processed_artifacts`

These names are not optional. They are hardcoded in `backend/supabase.py` and `backend/app.py`.

## What each table is used for

### `ecg_recordings`

Primary record per capture pair.

Used for:

- calibration object key
- session object key
- user identifier
- sample rate / duration / sample count
- upload metadata
- record lookup from the review web

Typical fields referenced by code:

- `id`
- `user_id`
- `bucket`
- `session_object_key`
- `calibration_object_key`
- `encoding`
- `sample_rate_hz`
- `channels`
- `sample_count`
- `duration_ms`
- `elapsed_time_ms`
- `effective_sps`
- `byte_length`
- `status`
- `start_time`
- `notes`
- `created_at`

### `ecg_session_chunks`

Stores metadata for live-uploaded session chunks.

Used for:

- `record_id`
- `chunk_index`
- `object_key`
- chunk byte/sample counts
- timestamps

The session ID is not stored as its own database column in the current codebase. It is encoded into the uploaded chunk `object_key` path.

Conflict target expected by the backend:

- `record_id,chunk_index`

### `ecg_live_preview`

Stores the latest preview arrays for the live web dashboard.

Used for:

- `record_id`
- `ch2_preview`
- `ch3_preview`
- `ch4_preview`
- `sample_count`
- `elapsed_time_ms`
- `updated_at`

Conflict target expected by the backend:

- `record_id`

### `ecg_processed_records`

Tracks overall processing state for a record.

Used for:

- `record_id`
- `status`
- `processing_version`
- `updated_at`
- `error_message`

Conflict target expected by the backend:

- `record_id`

### `ecg_processed_artifacts`

Maps processed artifact types to storage object keys.

Used for:

- `record_id`
- `artifact_type`
- `object_key`
- `processing_version`
- `updated_at`

Conflict target expected by the backend:

- `record_id,artifact_type`

## Storage bucket expectations

The backend expects exactly one configured bucket, named by `SUPABASE_STORAGE_BUCKET`.

The backend writes these object-key families into that bucket:

- `calibration/<run_id>.bin`
- `session/<session_id>.bin`
- `processed/<record_id>/*.json`
- `review-static/<record_id>/manifest.json`
- `review-static/<record_id>/windows/window_XXXX/*.png`

The review web depends directly on the static review files under `review-static/`.

## Minimal setup checklist for a new client environment

1. Create a Supabase project.
2. Create the storage bucket that will hold ECG data and review artifacts.
3. Create the five tables listed above.
4. Ensure the table/column names match the backend expectations exactly.
5. Ensure the anon key used by the backend has permission to read/write the tables and bucket used in development.
6. Put the Supabase values into `backend/.env`.
7. Start the backend and confirm `GET /health` works.
8. Run one calibration and one session end-to-end.
9. Verify a new `ecg_recordings.id` can be loaded from `ecg-review-web`.

## Practical validation queries

Once the system is running, these are the first things to check in Supabase.

### Latest recording row

```sql
select id, created_at, calibration_object_key, session_object_key
from public.ecg_recordings
order by created_at desc
limit 5;
```

### Latest live preview rows

```sql
select record_id, sample_count, updated_at
from public.ecg_live_preview
order by updated_at desc
limit 5;
```

### Processed record status

```sql
select record_id, status, processing_version, updated_at, error_message
from public.ecg_processed_records
order by updated_at desc
limit 10;
```

### Processed artifact keys

```sql
select record_id, artifact_type, object_key, updated_at
from public.ecg_processed_artifacts
order by updated_at desc
limit 20;
```

## What is intentionally not documented here

The included `schema.sql` is intended to be the exact bootstrap for a new client setup based on the current codebase.

What still remains a conscious tradeoff is security hardening: the current backend uses the anon key, so `schema.sql` applies broad RLS and storage policies to keep the existing code working. If the client wants tighter production security, the backend should be moved to the Supabase service-role key and the policies should be narrowed accordingly.
