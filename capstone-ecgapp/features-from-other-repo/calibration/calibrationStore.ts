import SQLite from "react-native-sqlite-storage";
import { base64ToBytes, bytesToBase64, sha256Hex } from "./calibrationCodec";

const DB_NAME = "capstone_ecg.db";

const SESSION_TABLE_SQL = `
  create table if not exists calib_session (
    session_id text primary key,
    started_at_ms integer,
    ended_at_ms integer,
    fs integer,
    lead_count integer,
    status text,
    quality_summary_json text
  );
`;

const CHUNK_TABLE_SQL = `
  create table if not exists calib_chunk (
    session_id text,
    chunk_index integer,
    start_ts_ms integer,
    end_ts_ms integer,
    sample_count integer,
    data_b64 text,
    checksum text,
    primary key (session_id, chunk_index)
  );
`;

const BASELINE_TABLE_SQL = `
  create table if not exists baseline_reference (
    baseline_session_id text primary key,
    accepted_at_ms integer,
    fs integer,
    lead_count integer,
    quality_summary_json text,
    signal_start_index integer,
    signal_b64 text,
    signal_sample_count integer,
    notes text
  );
`;

const db = SQLite.openDatabase({ name: DB_NAME, location: "default" });

function executeSql(sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.transaction((tx) => {
      tx.executeSql(
        sql,
        params,
        (_tx, result) => resolve(result),
        (_tx, error) => {
          reject(error);
          return false;
        }
      );
    });
  });
}

export async function initCalibrationTables() {
  await executeSql(SESSION_TABLE_SQL);
  await executeSql(CHUNK_TABLE_SQL);
  await executeSql(BASELINE_TABLE_SQL);
}

export async function clearCalibrationScratch() {
  await executeSql("delete from calib_chunk");
  await executeSql("delete from calib_session");
}

export async function createCalibrationSession({
  fs,
  leadCount,
}: {
  fs: number;
  leadCount: number;
}) {
  const sessionId = `cal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const startedAtMs = Date.now();
  await initCalibrationTables();
  await clearCalibrationScratch();
  await executeSql(
    `insert into calib_session
      (session_id, started_at_ms, ended_at_ms, fs, lead_count, status, quality_summary_json)
      values (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, startedAtMs, null, fs, leadCount, "recording", null]
  );
  return sessionId;
}

export async function appendCalibrationChunk({
  sessionId,
  chunkIndex,
  startTsMs,
  endTsMs,
  sampleCount,
  dataB64,
  checksum,
}: {
  sessionId: string;
  chunkIndex: number;
  startTsMs: number;
  endTsMs: number;
  sampleCount: number;
  dataB64: string;
  checksum?: string | null;
}) {
  await initCalibrationTables();
  await executeSql(
    `insert into calib_chunk
      (session_id, chunk_index, start_ts_ms, end_ts_ms, sample_count, data_b64, checksum)
      values (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, chunkIndex, startTsMs, endTsMs, sampleCount, dataB64, checksum || null]
  );
}

export async function updateCalibrationSession({
  sessionId,
  status,
  endedAtMs,
  qualitySummaryJson,
}: {
  sessionId: string;
  status: string;
  endedAtMs?: number | null;
  qualitySummaryJson?: string | null;
}) {
  await executeSql(
    `update calib_session
      set status = ?, ended_at_ms = ?, quality_summary_json = ?
      where session_id = ?`,
    [status, endedAtMs || null, qualitySummaryJson || null, sessionId]
  );
}

export async function listCalibrationChunks(sessionId: string) {
  const result = await executeSql(
    `select chunk_index, start_ts_ms, end_ts_ms, sample_count, data_b64, checksum
     from calib_chunk where session_id = ? order by chunk_index asc`,
    [sessionId]
  );
  const rows = result.rows;
  const chunks = [];
  for (let i = 0; i < rows.length; i += 1) {
    chunks.push(rows.item(i));
  }
  return chunks;
}

export async function getCalibrationChunkPreview(
  sessionId: string,
  limit = 3
) {
  const result = await executeSql(
    `select chunk_index, sample_count, length(data_b64) as b64_len,
            substr(data_b64, 1, 24) as b64_prefix
     from calib_chunk where session_id = ?
     order by chunk_index desc limit ?`,
    [sessionId, limit]
  );
  const rows = result.rows;
  const items = [];
  for (let i = 0; i < rows.length; i += 1) {
    items.push(rows.item(i));
  }
  return items.reverse();
}

export async function getCalibrationChunkCount(sessionId: string) {
  const result = await executeSql(
    `select count(*) as count from calib_chunk where session_id = ?`,
    [sessionId]
  );
  if (result.rows.length === 0) return 0;
  return result.rows.item(0).count || 0;
}

export async function getCalibrationSession(sessionId: string) {
  const result = await executeSql(
    `select session_id, started_at_ms, ended_at_ms, fs, lead_count, status, quality_summary_json
     from calib_session where session_id = ?`,
    [sessionId]
  );
  if (result.rows.length === 0) return null;
  return result.rows.item(0);
}

export async function deleteCalibrationChunks(sessionId: string) {
  await executeSql("delete from calib_chunk where session_id = ?", [sessionId]);
}

export async function saveBaselineReference({
  baselineSessionId,
  fs,
  leadCount,
  qualitySummaryJson,
  signalStartIndex,
  signalB64,
  signalSampleCount,
  notes,
}: {
  baselineSessionId: string;
  fs: number;
  leadCount: number;
  qualitySummaryJson?: string | null;
  signalStartIndex: number;
  signalB64: string;
  signalSampleCount: number;
  notes?: string | null;
}) {
  await initCalibrationTables();
  await executeSql(
    `insert or replace into baseline_reference
      (baseline_session_id, accepted_at_ms, fs, lead_count, quality_summary_json, signal_start_index, signal_b64, signal_sample_count, notes)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      baselineSessionId,
      Date.now(),
      fs,
      leadCount,
      qualitySummaryJson || null,
      signalStartIndex,
      signalB64,
      signalSampleCount,
      notes || null,
    ]
  );
}

export async function exportCalibrationPayload(sessionId: string) {
  const session = await getCalibrationSession(sessionId);
  if (!session) throw new Error("Calibration session missing");
  const chunks = await listCalibrationChunks(sessionId);
  if (!chunks.length) {
    throw new Error("No calibration chunks found");
  }
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].chunk_index !== i) {
      throw new Error("Calibration chunks are not contiguous");
    }
  }
  const byteParts: Uint8Array[] = [];
  let totalSamples = 0;
  for (const chunk of chunks) {
    const bytes = base64ToBytes(chunk.data_b64);
    byteParts.push(bytes);
    totalSamples += chunk.sample_count;
  }
  const concatenated = concatBytes(byteParts);
  const checksum = sha256Hex(concatenated);
  const dataB64 = bytesToBase64(concatenated);
  return {
    baseline_session_id: sessionId,
    fs: session.fs,
    lead_count: session.lead_count,
    started_at_ms: session.started_at_ms,
    ended_at_ms: session.ended_at_ms,
    total_samples: totalSamples,
    data_b64: dataB64,
    sha256: checksum,
    quality_summary_json: session.quality_summary_json || null,
  };
}

function concatBytes(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
