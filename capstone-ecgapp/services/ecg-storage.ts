import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";

type StoredPacket = {
  data: Uint8Array;
  receivedAt: number;
};

const DB_NAME = "ecgapp.db";
const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ecg_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  packet_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ecg_packets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  data BLOB NOT NULL,
  FOREIGN KEY (run_id) REFERENCES ecg_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ecg_packets_run_id ON ecg_packets(run_id);
`;

let dbPromise: Promise<SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabaseAsync(DB_NAME);
  }
  const db = await dbPromise;
  await db.execAsync(CREATE_SCHEMA_SQL);
  return db;
}

export async function saveCalibrationRun(
  runId: string,
  startedAt: number,
  endedAt: number,
  packets: StoredPacket[],
): Promise<void> {
  const db = await getDb();

  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.execAsync("DELETE FROM ecg_packets;");
    await tx.execAsync("DELETE FROM ecg_runs;");

    await tx.runAsync(
      "INSERT INTO ecg_runs (id, started_at, ended_at, packet_count) VALUES (?, ?, ?, ?)",
      runId,
      startedAt,
      endedAt,
      packets.length,
    );

    const statement = await tx.prepareAsync(
      "INSERT INTO ecg_packets (run_id, received_at, data) VALUES (?, ?, ?)",
    );

    try {
      for (const packet of packets) {
        await statement.executeAsync(
          runId,
          packet.receivedAt,
          packet.data,
        );
      }
    } finally {
      await statement.finalizeAsync();
    }
  });
}

export async function getLatestCalibrationRunId(): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM ecg_runs ORDER BY ended_at DESC LIMIT 1",
  );
  return row?.id ?? null;
}

export async function getPacketsForRun(
  runId: string,
): Promise<Uint8Array[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: Uint8Array }>(
    "SELECT data FROM ecg_packets WHERE run_id = ? ORDER BY id ASC",
    runId,
  );
  return rows.map((row) => row.data);
}
