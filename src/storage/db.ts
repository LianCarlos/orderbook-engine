/**
 * Apertura y configuración de la base de datos SQLite del WAL.
 *
 * better-sqlite3 es síncrono y expone una única conexión por proceso;
 * los consumidores deben tratar la conexión devuelta como un recurso
 * exclusivo (sin compartirla entre workers). Para Next.js, envolver en
 * un singleton `globalThis` si se usa dentro de rutas (ver patrón en
 * `sqlite-best-practices`); `next.config.ts` ya declara
 * `serverExternalPackages: ["better-sqlite3"]`.
 *
 * Pragmas aplicados en cada apertura (idempotentes):
 * - `journal_mode = WAL`  → readers no bloquean al writer (append del logger).
 * - `synchronous = NORMAL` → durabilidad suficiente para un WAL local sin
 *   el costo de FULL; recomendado por SQLite en combinación con WAL.
 * - `temp_store = MEMORY`  → páginas temporales en RAM, no en disco.
 *
 * El esquema se crea con `CREATE TABLE IF NOT EXISTS` (idempotente) y NO
 * usa AUTOINCREMENT: las secuencias las asigna el `WalLogger`, no SQLite.
 */
import Database from "better-sqlite3";

/**
 * Esquema físico del WAL (Sprint 02). `trades_ledger` solo se crea aquí;
 * su uso (doble entrada del ledger) llega en Sprint 03.
 *
 * Notas de diseño:
 * - `sequence BIGINT PRIMARY KEY` sin AUTOINCREMENT: el logger asigna
 *   secuencias monotónicas explícitas (control total + replay exacto).
 * - `created_at INTEGER DEFAULT (unixepoch() * 1000)`: default DINÁMICO
 *   evaluado por SQLite en cada INSERT (milisegundos epoch). Nunca usar
 *   literales congelados en generadores de migración (lección aprendida
 *   con drizzle-kit: `.default()` congela el timestamp en el SQL).
 */
const SCHEMA_SQL = `
-- === TABLAS ===

-- Log de eventos append-only con hash chain SHA-256 (Sprint 02.5):
-- cada fila enlaza con el hash de la anterior (prev_hash) y publica el
-- suyo (hash), calculado por WalLogger como
-- SHA256(<sequence>|<prev_hash>|<event_type>|<payload>).
CREATE TABLE IF NOT EXISTS events_log (
  sequence   BIGINT  PRIMARY KEY,                          -- asignada por WalLogger (monotónica global)
  event_type TEXT    NOT NULL,                             -- 'ORDER_NEW' | 'ORDER_CANCEL'
  payload    TEXT    NOT NULL,                             -- JSON del evento (bigints como string)
  prev_hash  TEXT    NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000', -- hash de la fila anterior
  hash       TEXT    NOT NULL DEFAULT '',                  -- SHA-256 de esta fila (verificado en replay)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000) -- ms epoch, lo pone SQLite (nunca el caller)
);

-- Ledger de trades (doble entrada). Creada en Sprint 02; el
-- SettlementLedger (Sprint 03) registra aquí los asientos de cada
-- operación financiera dentro de la MISMA conexión/transacción SQLite
-- que usa el WAL.
CREATE TABLE IF NOT EXISTS trades_ledger (
  match_id       TEXT    PRIMARY KEY,  -- match-1, match-2, … (monotónico del motor)
  maker_order_id TEXT    NOT NULL,
  taker_order_id TEXT    NOT NULL,
  price          BIGINT  NOT NULL,     -- precio en ticks (bigint del dominio)
  quantity       BIGINT  NOT NULL,     -- cantidad calzada (bigint del dominio)
  timestamp      INTEGER NOT NULL      -- marca logística provista por el caller (number)
);

-- Journal de asientos de doble entrada (Sprint 03). Append-only por
-- operación; cada transacción (tx_id) balancea por asset: Σ débitos ==
-- Σ créditos (regla inviolable verificada por SettlementLedger.audit).
-- Red de seguridad SQLite: CHECKs de dominio, triggers que abortan
-- UPDATE/DELETE, y settled_trades como registro único por liquidación.
CREATE TABLE IF NOT EXISTS journal_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id        TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  account_type TEXT    NOT NULL CHECK (account_type IN ('AVAILABLE', 'LOCKED', 'FEE_VAULT')),
  asset        TEXT    NOT NULL,
  side         TEXT    NOT NULL CHECK (side IN ('DEBIT', 'CREDIT')),
  amount       BIGINT  NOT NULL CHECK (amount > 0),
  order_id     TEXT,              -- orden del dominio que originó el asiento
  match_id     TEXT,              -- match del motor (solo asientos de liquidación)
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_journal_tx ON journal_entries(tx_id);

-- Registro único de liquidaciones: la PK impide liquidar dos veces el
-- mismo match a nivel de base de datos (falla toda la transacción).
CREATE TABLE IF NOT EXISTS settled_trades (
  match_id   TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Append-only: ni el código ni un actor externo pueden alterar el
-- journal o el registro de liquidaciones sin abortar.
CREATE TRIGGER IF NOT EXISTS trg_journal_no_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_journal_no_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_settled_no_update
BEFORE UPDATE ON settled_trades
BEGIN
  SELECT RAISE(ABORT, 'settled_trades is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_settled_no_delete
BEFORE DELETE ON settled_trades
BEGIN
  SELECT RAISE(ABORT, 'settled_trades is append-only');
END;

-- Snapshots del estado del libro para fast recovery (Sprint 02.5).
-- takeSnapshot congela órdenes vivas + matchCounter en state_data;
-- el replay parte del más reciente y aplica solo el delta.
-- state_hash = SHA-256(state_data): integridad verificada antes de
-- restaurar (fail-closed si el snapshot fue alterado).
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id   TEXT    PRIMARY KEY,  -- uuid generado al tomar el snapshot
  last_sequence BIGINT  NOT NULL,     -- última secuencia del WAL cubierta por el snapshot
  state_data    TEXT    NOT NULL,     -- estado serializado (bigints como string)
  state_hash    TEXT    NOT NULL DEFAULT '', -- SHA-256 de state_data
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- === ÍNDICES ===
-- La columna sequence de events_log no necesita índice: PRIMARY KEY ya lo es.
-- Se agregan en Sprint 03 cuando trades_ledger se consuma realmente.
`;

/**
 * Migración en caliente de esquemas previos al Sprint 02.5: agrega las
 * columnas de hardening a `events_log` (hash chain) y `snapshots`
 * (state_hash). Las filas legacy quedan con hash `''` y el replay las
 * detecta como cadena rota / snapshot corrupto (fail-closed) en lugar
 * de aceptar datos no auditables.
 */
function ensureHardeningColumns(db: Database.Database): void {
  const eventColumns = db
    .prepare("PRAGMA table_info(events_log)")
    .all() as Array<{ name: string }>;
  const eventNames = new Set(eventColumns.map((column) => column.name));
  if (!eventNames.has("prev_hash")) {
    db.exec(
      `ALTER TABLE events_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT '${GENESIS_HASH_SQL}'`,
    );
  }
  if (!eventNames.has("hash")) {
    db.exec("ALTER TABLE events_log ADD COLUMN hash TEXT NOT NULL DEFAULT ''");
  }

  const snapshotColumns = db
    .prepare("PRAGMA table_info(snapshots)")
    .all() as Array<{ name: string }>;
  const snapshotNames = new Set(snapshotColumns.map((column) => column.name));
  if (!snapshotNames.has("state_hash")) {
    db.exec(
      "ALTER TABLE snapshots ADD COLUMN state_hash TEXT NOT NULL DEFAULT ''",
    );
  }
}

/** Génesis (64 ceros hex) como default SQL para la migración. */
const GENESIS_HASH_SQL = "0".repeat(64);

/**
 * Abre (o crea) la base SQLite del WAL en `path` y aplica los pragmas
 * y el esquema. Devuelve la conexión lista para ser usada por el
 * `WalLogger` y el replay.
 *
 * @param path Ruta del archivo `.db` (o `":memory:"`; en memoria el
 *   pragma WAL no aplica y SQLite lo ignora sin error).
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.exec(SCHEMA_SQL);
  ensureHardeningColumns(db);
  return db;
}

export default openDatabase;
