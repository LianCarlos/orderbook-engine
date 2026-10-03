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

-- Log de eventos append-only: fuente de verdad para el replay del libro.
CREATE TABLE IF NOT EXISTS events_log (
  sequence   BIGINT  PRIMARY KEY,                          -- asignada por WalLogger (monotónica global)
  event_type TEXT    NOT NULL,                             -- 'ORDER_NEW' | 'ORDER_CANCEL'
  payload    TEXT    NOT NULL,                             -- JSON del evento (bigints como string)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000) -- ms epoch, lo pone SQLite (nunca el caller)
);

-- Ledger de trades (doble entrada). Solo se crea; se usa en Sprint 03.
CREATE TABLE IF NOT EXISTS trades_ledger (
  match_id       TEXT    PRIMARY KEY,  -- match-1, match-2, … (monotónico del motor)
  maker_order_id TEXT    NOT NULL,
  taker_order_id TEXT    NOT NULL,
  price          BIGINT  NOT NULL,     -- precio en ticks (bigint del dominio)
  quantity       BIGINT  NOT NULL,     -- cantidad calzada (bigint del dominio)
  timestamp      INTEGER NOT NULL      -- marca logística provista por el caller (number)
);

-- === ÍNDICES ===
-- La columna sequence de events_log no necesita índice: PRIMARY KEY ya lo es.
-- Se agregan en Sprint 03 cuando trades_ledger se consuma realmente.
`;

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
  return db;
}

export default openDatabase;
