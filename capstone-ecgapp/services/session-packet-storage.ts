import * as SQLite from "expo-sqlite";
import { fromByteArray, toByteArray } from "base64-js";

import { concatUint8Arrays } from "@/services/ecg-utils";

type CaptureMeta = {
  sessionId: string;
  recordId: string | null;
  startTimeIso: string | null;
};

type CaptureLoadResult = CaptureMeta & {
  packetCount: number;
  bytes: Uint8Array;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("session_packets.db").then(
      async (db) => {
        await db.execAsync(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS session_captures (
            session_id TEXT PRIMARY KEY NOT NULL,
            record_id TEXT,
            start_time_iso TEXT,
            created_at_ms INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS session_packets (
            session_id TEXT NOT NULL,
            packet_index INTEGER NOT NULL,
            received_at_ms INTEGER NOT NULL,
            payload_base64 TEXT NOT NULL,
            PRIMARY KEY (session_id, packet_index)
          );
          CREATE INDEX IF NOT EXISTS idx_session_packets_session_id
            ON session_packets(session_id);
        `);
        return db;
      },
    );
  }
  return dbPromise;
}

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function beginSessionCapture(params: {
  sessionId: string;
  recordId?: string | null;
  startTimeIso?: string | null;
}): Promise<void> {
  await enqueueWrite(async () => {
    const db = await getDb();
    await db.runAsync(
      "DELETE FROM session_packets WHERE session_id = ?",
      params.sessionId,
    );
    await db.runAsync(
      "DELETE FROM session_captures WHERE session_id = ?",
      params.sessionId,
    );
    await db.runAsync(
      `
        INSERT INTO session_captures (session_id, record_id, start_time_iso, created_at_ms)
        VALUES (?, ?, ?, ?)
      `,
      params.sessionId,
      params.recordId ?? null,
      params.startTimeIso ?? null,
      Date.now(),
    );
  });
  console.log(
    `[SQLITE] begin session capture session_id=${params.sessionId} record_id=${params.recordId ?? "null"}`,
  );
}

export async function setSessionCaptureRecordId(
  sessionId: string,
  recordId: string,
): Promise<void> {
  await enqueueWrite(async () => {
    const db = await getDb();
    await db.runAsync(
      "UPDATE session_captures SET record_id = ? WHERE session_id = ?",
      recordId,
      sessionId,
    );
  });
  console.log(
    `[SQLITE] update session capture session_id=${sessionId} record_id=${recordId}`,
  );
}

export async function appendSessionPacket(params: {
  sessionId: string;
  packetIndex: number;
  receivedAtMs: number;
  bytes: Uint8Array;
}): Promise<void> {
  await enqueueWrite(async () => {
    const db = await getDb();
    await db.runAsync(
      `
        INSERT OR REPLACE INTO session_packets
          (session_id, packet_index, received_at_ms, payload_base64)
        VALUES (?, ?, ?, ?)
      `,
      params.sessionId,
      params.packetIndex,
      params.receivedAtMs,
      fromByteArray(params.bytes),
    );
  });
}

export async function loadSessionCapture(
  sessionId: string,
): Promise<CaptureLoadResult> {
  const db = await getDb();
  const meta = await db.getFirstAsync<{
    session_id: string;
    record_id: string | null;
    start_time_iso: string | null;
  }>(
    `
      SELECT session_id, record_id, start_time_iso
      FROM session_captures
      WHERE session_id = ?
    `,
    sessionId,
  );

  if (!meta) {
    throw new Error(`No persisted session capture found for ${sessionId}`);
  }

  const rows = await db.getAllAsync<{
    payload_base64: string;
  }>(
    `
      SELECT payload_base64
      FROM session_packets
      WHERE session_id = ?
      ORDER BY packet_index ASC
    `,
    sessionId,
  );

  const packets = rows.map((row) => toByteArray(row.payload_base64));
  const bytes = concatUint8Arrays(packets);
  console.log(
    `[SQLITE] load session capture session_id=${sessionId} packet_count=${packets.length} bytes=${bytes.length}`,
  );
  return {
    sessionId: meta.session_id,
    recordId: meta.record_id,
    startTimeIso: meta.start_time_iso,
    packetCount: packets.length,
    bytes,
  };
}

export async function clearSessionCapture(sessionId: string): Promise<void> {
  await enqueueWrite(async () => {
    const db = await getDb();
    await db.runAsync(
      "DELETE FROM session_packets WHERE session_id = ?",
      sessionId,
    );
    await db.runAsync(
      "DELETE FROM session_captures WHERE session_id = ?",
      sessionId,
    );
  });
  console.log(`[SQLITE] clear session capture session_id=${sessionId}`);
}
