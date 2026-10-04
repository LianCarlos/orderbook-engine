/**
 * Storage layer: WAL (SQLite better-sqlite3), append-only event log,
 * serialización determinista y replay para reconstrucción del estado.
 *
 * - `db.ts`    → openDatabase (pragmas + esquema events_log / trades_ledger)
 * - `wal.ts`   → WalLogger (append atómico, secuencias monotónicas)
 * - `replay.ts` → replayState (reconstrucción determinista del libro)
 */
export * from "./db";
export * from "./wal";
export * from "./replay";
export * from "./snapshot";
