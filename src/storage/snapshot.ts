/**
 * Snapshotting del motor para fast recovery (Sprint 02.5).
 *
 * El estado del libro es 100% reconstruible desde el WAL, pero el
 * replay completo de millones de eventos es caro. Un snapshot congela
 * el estado interno del MatchingEngine (órdenes vivas en orden
 * Price-Time, trades y contador de matches) en la tabla `snapshots`;
 * el replay parte de él y solo re-aplica el delta del WAL.
 *
 * ACCESO A INTERNALS (decisión documentada): el engine no expone una
 * API pública de serialización/restauración. Para no ensanchar la
 * superficie del motor en este sprint, este módulo accede a sus campos
 * privados (`_bids`, `_asks`, `_orderMap`, `_trades`, `_matchCounter`)
 * mediante un cast estructural explícito (`EngineInternals`). El
 * contrato se verifica en cada arranque por el test de hardening
 * (estado restaurado bit a bit idéntico al control). Si el engine
 * cambia sus internals, este archivo es el punto único de adaptación.
 */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { MatchingEngine } from "../engine/matching";
import type { Order, Trade } from "../core/types";
import { LimitLevel } from "../core/level";
import type { OrderNode } from "../core/queue";
import { parsePayload, serializePayload } from "./wal";

/** Retención máxima de snapshots en la tabla. */
export const MAX_SNAPSHOTS = 3;

interface SideBookInternals {
  levels: Map<bigint, LimitLevel>;
  prices: bigint[];
}

interface BookEntryInternals {
  order: Order;
  node: OrderNode;
  level: LimitLevel;
}

/** Proyección de los internals privados del MatchingEngine (Sprint 01). */
interface EngineInternals {
  _bids: SideBookInternals;
  _asks: SideBookInternals;
  _orderMap: Map<string, BookEntryInternals>;
  _trades: Trade[];
  _matchCounter: number;
}

function internalsOf(engine: MatchingEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

/** Snapshot persistido (metadatos + estado serializado + hash). */
export interface StoredSnapshot {
  snapshotId: string;
  lastSequence: bigint;
  stateData: string;
  /** SHA-256 de `stateData`; verificado antes de restaurar. */
  stateHash: string;
}

/**
 * Congela el estado exacto del motor (colas de precio y órdenes vivas)
 * en la tabla `snapshots` y elimina los snapshots antiguos reteniendo
 * solo los últimos {@link MAX_SNAPSHOTS}. Devuelve el id del snapshot.
 *
 * Decisión de diseño: el snapshot NO congela el histórico de trades
 * (su fuente de verdad es el WAL/ledger, Sprint 03). Congela el libro
 * (bids/asks/OrderMap) y el `matchCounter` para que el motor
 * restaurado continúe generando matchIds deterministas y sin
 * colisiones.
 *
 * Complejidad: O(M log M) por el ordenamiento determinista de órdenes.
 */
export function takeSnapshot(
  engine: MatchingEngine,
  db: Database.Database,
  lastSequence: bigint,
): string {
  const internals = internalsOf(engine);
  const orders = [...internals._orderMap.values()]
    .map((entry) => entry.order)
    .sort((a, b) => a.id.localeCompare(b.id));
  const stateData = serializePayload({
    orders,
    matchCounter: internals._matchCounter,
  });
  const stateHash = createHash("sha256").update(stateData).digest("hex");

  const snapshotId = randomUUID();
  db.prepare(
    `INSERT INTO snapshots (snapshot_id, last_sequence, state_data, state_hash, created_at)
     VALUES (?, ?, ?, ?, (unixepoch() * 1000))`,
  ).run(snapshotId, Number(lastSequence), stateData, stateHash);

  db.prepare(
    `DELETE FROM snapshots
     WHERE snapshot_id NOT IN (
       SELECT snapshot_id FROM snapshots
       ORDER BY last_sequence DESC, created_at DESC
       LIMIT ${MAX_SNAPSHOTS}
     )`,
  ).run();

  return snapshotId;
}

/** Snapshot más reciente (mayor last_sequence) o null si no hay. */
export function getLatestSnapshot(db: Database.Database): StoredSnapshot | null {
  const row = db
    .prepare(
      "SELECT snapshot_id, last_sequence, state_data, state_hash FROM snapshots ORDER BY last_sequence DESC LIMIT 1",
    )
    .get() as
    | {
        snapshot_id: string;
        last_sequence: number;
        state_data: string;
        state_hash: string;
      }
    | undefined;

  if (row === undefined) {
    return null;
  }
  return {
    snapshotId: row.snapshot_id,
    lastSequence: BigInt(row.last_sequence),
    stateData: row.state_data,
    stateHash: row.state_hash,
  };
}

/**
 * Restaura el estado interno del engine desde un `state_data`
 * serializado. El motor debe estar virgen (responsabilidad del caller:
 * `replayState`). Reconstruye bids/asks con su orden Price-Time
 * (órdenes re-insertadas por `sequence` ascendente), el índice de
 * cancelación O(1) y el contador de matches (continuidad determinista
 * de matchIds). El histórico de trades en RAM se reconstruye solo con
 * replay completo (o desde el ledger en Sprint 03).
 * Complejidad: O(M log L) con M órdenes vivas y L niveles de precio.
 */
export function restoreEngineState(engine: MatchingEngine, stateData: string): void {
  const internals = internalsOf(engine);
  const state = parsePayload(stateData) as unknown as {
    orders: Order[];
    matchCounter: number;
  };

  // Price-Time: la cola de cada nivel queda en orden exacto de llegada.
  const orders = [...state.orders].sort((a, b) =>
    a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0,
  );

  for (const order of orders) {
    const book = order.side === "BUY" ? internals._bids : internals._asks;
    let level = book.levels.get(order.price);
    if (level === undefined) {
      level = new LimitLevel(order.price);
      book.levels.set(order.price, level);
    }
    const node = level.addOrder(order);
    internals._orderMap.set(order.id, { order, node, level });
  }

  // Reconstruye los índices de precios ordenados (igual que _insertPrice).
  for (const book of [internals._bids, internals._asks]) {
    book.prices = [...book.levels.keys()].sort((a, b) => (a < b ? -1 : 1));
  }

  // Continuidad determinista: el motor restaurado retoma el contador
  // de matches sin reutilizar matchIds (el histórico vive en el WAL).
  internals._matchCounter = state.matchCounter;
}
