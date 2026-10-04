/**
 * Replay determinista del libro desde el WAL.
 *
 * Lee `events_log` en orden de secuencia (single pass, O(E)), y aplica
 * cada evento sobre un `MatchingEngine` virgen: `ORDER_NEW` →
 * `processOrder`, `ORDER_CANCEL` → `cancelOrder`. El replay NO escribe
 * en la DB (no re-genera eventos) y no depende de relojes ni
 * aleatoriedad: el mismo WAL produce el mismo estado bit a bit.
 *
 * Fuente de verdad de `Order.sequence`: la columna `sequence` de la
 * fila del evento (el logger la asignó). El payload de ORDER_NEW se
 * persiste con `sequence: 0n` (la orden aún no la tenía al serializar)
 * y aquí se inyecta la secuencia real de la fila antes de aplicarla.
 */
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { MatchingEngine } from "../engine/matching";
import type { Order } from "../core/types";
import { GENESIS_HASH, hashEventInput, parseOrderPayload } from "./wal";
import { getLatestSnapshot, restoreEngineState } from "./snapshot";

/**
 * Fila física de `events_log` (raw mode: array de columnas, sin
 * objetos). Incluye las columnas de la hash chain (Sprint 02.5).
 */
type EventRow = [
  sequence: number,
  event_type: string,
  payload: string,
  prev_hash: string,
  hash: string,
];

/** Métricas del replay. */
export interface ReplayResult {
  /** Eventos aplicados desde el WAL. */
  replayedEvents: number;
  /** Duración real de la aplicación en ms (performance.now). */
  durationMs: number;
}

/** Error base del replay: fallo explícito y tipado, nunca silencioso. */
export class ReplayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReplayError";
  }
}

/**
 * El WAL contiene un `event_type` que el replay no conoce: o hay una
 * versión nueva de eventos, o corrupción. Se lanza con contexto de la
 * secuencia ofensora para diagnóstico.
 */
export class UnknownEventTypeError extends ReplayError {
  readonly sequence: bigint;
  readonly eventType: string;

  constructor(sequence: bigint, eventType: string) {
    super(
      `events_log: tipo de evento desconocido "${eventType}" en sequence ${sequence}`,
    );
    this.name = "UnknownEventTypeError";
    this.sequence = sequence;
    this.eventType = eventType;
  }
}

/** Snapshot alterado: el SHA-256 de state_data no coincide (H1). */
export class SnapshotCorruptionError extends ReplayError {
  readonly snapshotId: string;

  constructor(snapshotId: string, message: string) {
    super(message);
    this.name = "SnapshotCorruptionError";
    this.snapshotId = snapshotId;
  }
}

/**
 * Corrupción detectada por la hash chain SHA-256: la restauración
 * ABORTA de inmediato. `sequence` identifica la fila exacta alterada
 * y `kind` distingue enlace roto (`prev_hash`) de contenido alterado
 * (`hash`).
 */
export class WalCorruptionError extends ReplayError {
  readonly sequence: bigint;
  readonly kind: "prev_hash" | "hash";

  constructor(sequence: bigint, kind: "prev_hash" | "hash", message: string) {
    super(message);
    this.name = "WalCorruptionError";
    this.sequence = sequence;
    this.kind = kind;
  }
}

/**
 * Reconstruye el estado del libro con fast recovery y auditoría
 * incondicional de la hash chain:
 *
 * 1. Si existe snapshot, restaura el estado interno del motor desde
 *    `state_data` y solo re-aplica eventos con `sequence >
 *    snapshot.lastSequence`.
 * 2. Sin snapshot, parte de un motor limpio desde `sequence = 1`.
 * 3. Cada fila re-aplicada se verifica contra la cadena SHA-256:
 *    `prev_hash` debe enlazar con el hash esperado y `hash` se
 *    recalcula en caliente. Una discrepancia lanza
 *    {@link WalCorruptionError} con la secuencia exacta alterada y
 *    ABORTA la restauración.
 *
 * @throws {WalCorruptionError} si la hash chain se rompe (tamper).
 * @throws {UnknownEventTypeError} si el WAL tiene un event_type desconocido.
 * @throws {ReplayError} si un payload o un snapshot no se puede parsear.
 */
export function replayState(db: Database.Database, engine: MatchingEngine): ReplayResult {
  const started = performance.now();

  // 1. Fast recovery: el snapshot más reciente es el punto de partida.
  const snapshot = getLatestSnapshot(db);
  let startSequence: bigint;
  let expectedPrevHash = GENESIS_HASH;

  if (snapshot !== null) {
    // H1: integridad del snapshot — SHA-256 de state_data verificado
    // ANTES de restaurar (un snapshot alterado con JSON válido nunca
    // envenena el libro en silencio).
    const computedStateHash = createHash("sha256")
      .update(snapshot.stateData)
      .digest("hex");
    if (computedStateHash !== snapshot.stateHash) {
      throw new SnapshotCorruptionError(
        snapshot.snapshotId,
        `snapshots: state_data alterado en ${snapshot.snapshotId}: ` +
          `hash almacenado ${snapshot.stateHash.slice(0, 16)}…, ` +
          `calculado ${computedStateHash.slice(0, 16)}…`,
      );
    }
    try {
      restoreEngineState(engine, snapshot.stateData);
    } catch (cause) {
      throw new ReplayError(
        `snapshots: state_data corrupto en ${snapshot.snapshotId}: ${(cause as Error).message}`,
        { cause },
      );
    }
    startSequence = snapshot.lastSequence + 1n;
    // Ancla de la cadena: hash del último evento cubierto por el snapshot.
    const anchor = db
      .prepare("SELECT hash FROM events_log WHERE sequence = ?")
      .get(Number(snapshot.lastSequence)) as { hash: string } | undefined;
    if (anchor !== undefined && anchor.hash !== "") {
      expectedPrevHash = anchor.hash;
    }
  } else {
    startSequence = 1n;
  }

  // 2. Delta de eventos con auditoría incondicional de la hash chain.
  // Hot path: iterate() (sin materializar arrays) y Hash nativo por
  // fila (medido: más rápido que reutilizar vía copy()).
  const select = db
    .prepare(
      `SELECT sequence, event_type, payload, prev_hash, hash
       FROM events_log WHERE sequence >= ? ORDER BY sequence ASC`,
    )
    .raw();
  const rows = select.iterate(Number(startSequence)) as unknown as Iterable<EventRow>;

  let replayedEvents = 0;
  for (const row of rows) {
    const [sequenceValue, eventType, payloadJson, storedPrevHash, storedHash] = row;
    const sequence = BigInt(sequenceValue);

    // event_type desconocido: corrupción de esquema/versión. Se evalúa
    // antes que la cadena para conservar UnknownEventTypeError ante
    // filas legacy sin hash.
    if (eventType !== "ORDER_NEW" && eventType !== "ORDER_CANCEL") {
      throw new UnknownEventTypeError(sequence, eventType);
    }

    // Integridad incondicional de la cadena SHA-256.
    if (storedPrevHash !== expectedPrevHash) {
      throw new WalCorruptionError(
        sequence,
        "prev_hash",
        `events_log: prev_hash roto en sequence ${sequence}: ` +
          `esperado ${expectedPrevHash.slice(0, 16)}…, almacenado ${storedPrevHash.slice(0, 16)}…`,
      );
    }
    const computedHash = createHash("sha256")
      .update(hashEventInput(sequence, expectedPrevHash, eventType, payloadJson))
      .digest("hex");
    if (computedHash !== storedHash) {
      throw new WalCorruptionError(
        sequence,
        "hash",
        `events_log: hash inválido en sequence ${sequence}: ` +
          `almacenado ${storedHash.slice(0, 16)}…, calculado ${computedHash.slice(0, 16)}…`,
      );
    }
    expectedPrevHash = storedHash;

    if (eventType === "ORDER_NEW") {
      let order: Record<string, unknown>;
      try {
        order = parseOrderPayload(payloadJson);
      } catch (cause) {
        throw new ReplayError(
          `events_log: payload corrupto en sequence ${sequence}: ${(cause as Error).message}`,
          { cause },
        );
      }
      // La secuencia de la fila es la fuente de verdad (el payload se
      // serializó antes de que el logger asignara la secuencia).
      order.sequence = sequence;
      engine.processOrder(order as unknown as Order);
    } else {
      let cancel: { orderId: string };
      try {
        // Payload mínimo sin bigints: JSON.parse plano.
        cancel = JSON.parse(payloadJson) as { orderId: string };
      } catch (cause) {
        throw new ReplayError(
          `events_log: payload corrupto en sequence ${sequence}: ${(cause as Error).message}`,
          { cause },
        );
      }
      engine.cancelOrder(cancel.orderId);
    }
    replayedEvents += 1;
  }

  return { replayedEvents, durationMs: performance.now() - started };
}

export default replayState;
