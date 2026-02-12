import * as SQLite from "expo-sqlite";

export type SessionType = "baseline" | "run";
export type SessionStatus = "recording" | "ended" | "exported" | "failed";

export interface ScratchSessionInput {
  sessionId: string;
  type: SessionType;
  startedAtMs: number;
  fs: number;
  leadCount: number;
  layout: string;
}

export interface ScratchChunkInput {
  sessionId: string;
  chunkIndex: number;
  startTsMs: number;
  endTsMs: number;
  sampleCount: number;
  dataB64: string;
  checksum?: string | null;
}

export interface ScratchChunkRow extends ScratchChunkInput {}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("ecg.sqlite");
  }
  return dbPromise;
}

export async function initEcgDb(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS scratch_session (
      session_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER NULL,
      fs INTEGER NOT NULL,
      lead_count INTEGER NOT NULL,
      layout TEXT NOT NULL,
      status TEXT NOT NULL,
      gap_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scratch_chunk (
      session_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_ts_ms INTEGER NOT NULL,
      end_ts_ms INTEGER NOT NULL,
      sample_count INTEGER NOT NULL,
      data_b64 TEXT NOT NULL,
      checksum TEXT NULL,
      PRIMARY KEY(session_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS active_baseline (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      baseline_cloud_id TEXT NULL,
      baseline_local_session_id TEXT NULL,
      accepted_at_ms INTEGER NULL
    );

    INSERT OR IGNORE INTO active_baseline (id) VALUES (1);
  `);
}

export async function createScratchSession(
  input: ScratchSessionInput,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO scratch_session
      (session_id, type, started_at_ms, fs, lead_count, layout, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.sessionId,
      input.type,
      input.startedAtMs,
      input.fs,
      input.leadCount,
      input.layout,
      "recording",
    ],
  );
}

export async function insertScratchChunk(
  input: ScratchChunkInput,
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO scratch_chunk
        (session_id, chunk_index, start_ts_ms, end_ts_ms, sample_count, data_b64, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        input.chunkIndex,
        input.startTsMs,
        input.endTsMs,
        input.sampleCount,
        input.dataB64,
        input.checksum ?? null,
      ],
    );
  });
}

export async function listScratchChunks(
  sessionId: string,
): Promise<ScratchChunkRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ScratchChunkRow>(
    `SELECT session_id as sessionId,
            chunk_index as chunkIndex,
            start_ts_ms as startTsMs,
            end_ts_ms as endTsMs,
            sample_count as sampleCount,
            data_b64 as dataB64,
            checksum
     FROM scratch_chunk
     WHERE session_id = ?
     ORDER BY chunk_index ASC`,
    [sessionId],
  );
  return rows;
}

export async function getScratchSession(sessionId: string): Promise<{
  sessionId: string;
  type: SessionType;
  startedAtMs: number;
  endedAtMs: number | null;
  fs: number;
  leadCount: number;
  layout: string;
  status: SessionStatus;
  gapCount: number;
} | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    session_id: string;
    type: SessionType;
    started_at_ms: number;
    ended_at_ms: number | null;
    fs: number;
    lead_count: number;
    layout: string;
    status: SessionStatus;
    gap_count: number;
  }>(
    `SELECT session_id,
            type,
            started_at_ms,
            ended_at_ms,
            fs,
            lead_count,
            layout,
            status,
            gap_count
     FROM scratch_session
     WHERE session_id = ?`,
    [sessionId],
  );
  if (!row) return null;
  return {
    sessionId: row.session_id,
    type: row.type,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    fs: row.fs,
    leadCount: row.lead_count,
    layout: row.layout,
    status: row.status,
    gapCount: row.gap_count,
  };
}

export async function updateGapCount(
  sessionId: string,
  gapCount: number,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE scratch_session SET gap_count = ? WHERE session_id = ?`,
    [gapCount, sessionId],
  );
}

export async function markSessionEnded(
  sessionId: string,
  endedAtMs: number,
  status: SessionStatus = "ended",
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE scratch_session
     SET ended_at_ms = ?, status = ?
     WHERE session_id = ?`,
    [endedAtMs, status, sessionId],
  );
}

export async function clearScratch(sessionId?: string): Promise<void> {
  const db = await getDb();
  if (sessionId) {
    await db.withTransactionAsync(async () => {
      await db.runAsync(`DELETE FROM scratch_chunk WHERE session_id = ?`, [
        sessionId,
      ]);
      await db.runAsync(`DELETE FROM scratch_session WHERE session_id = ?`, [
        sessionId,
      ]);
    });
    return;
  }
  await db.execAsync(`
    DELETE FROM scratch_chunk;
    DELETE FROM scratch_session;
  `);
}

export async function setActiveBaseline(
  baselineCloudId: string | null,
  baselineLocalSessionId: string | null,
  acceptedAtMs: number | null,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE active_baseline
     SET baseline_cloud_id = ?, baseline_local_session_id = ?, accepted_at_ms = ?
     WHERE id = 1`,
    [baselineCloudId, baselineLocalSessionId, acceptedAtMs],
  );
}

export async function getActiveBaseline(): Promise<{
  baselineCloudId: string | null;
  baselineLocalSessionId: string | null;
  acceptedAtMs: number | null;
}> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    baseline_cloud_id: string | null;
    baseline_local_session_id: string | null;
    accepted_at_ms: number | null;
  }>(`SELECT baseline_cloud_id, baseline_local_session_id, accepted_at_ms FROM active_baseline WHERE id = 1`);

  return {
    baselineCloudId: row?.baseline_cloud_id ?? null,
    baselineLocalSessionId: row?.baseline_local_session_id ?? null,
    acceptedAtMs: row?.accepted_at_ms ?? null,
  };
}
