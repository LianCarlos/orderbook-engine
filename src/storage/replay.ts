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
import { GENESIS_HASH, parseOrderPayload, writeEventHashInput } from "./wal";
import {
  computeSnapshotStateHash,
  getLatestSnapshot,
  resetEngineState,
  restoreEngineState,
} from "./snapshot";

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
  /** Vía de recuperación: snapshot + delta, o replay limpio desde 0. */
  recovery: "snapshot" | "clean";
  /** Motivo del fallback a replay limpio (null si no hubo fallback). */
  fallbackReason: string | null;
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
 * Desacoplamiento entre snapshot y WAL (Sprint 03.5): el hash de la
 * fila `lastSequence` de events_log no coincide con `wal_anchor_hash`.
 * El replay descarta el snapshot y fuerza un replay limpio desde 0.
 */
export class SnapshotAnchorMismatchError extends ReplayError {
  readonly snapshotId: string;
  readonly lastSequence: bigint;

  constructor(
    snapshotId: string,
    lastSequence: bigint,
    storedAnchor: string,
    actualAnchor: string | null,
  ) {
    super(
      `snapshots: ancla desacoplada en ${snapshotId} para sequence ${lastSequence}: ` +
        `ancla del snapshot ${storedAnchor.slice(0, 16)}…, ` +
        `hash real del WAL ${actualAnchor === null ? "∅ (fila ausente)" : actualAnchor.slice(0, 16) + "…"}`,
    );
    this.name = "SnapshotAnchorMismatchError";
    this.snapshotId = snapshotId;
    this.lastSequence = lastSequence;
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
  // Si el ancla criptográfica se desacopla del WAL, se descarta el
  // snapshot y se fuerza replay limpio desde el evento 0.
  const snapshot = getLatestSnapshot(db);
  let recovery: "snapshot" | "clean" = "clean";
  let fallbackReason: string | null = null;
  let startSequence = 1n;
  let expectedPrevHash = GENESIS_HASH;

  if (snapshot !== null) {
    try {
      // H1: integridad del snapshot — SHA-256(wal_anchor_hash +
      // last_sequence + state_data) verificado ANTES de restaurar.
      const computedStateHash = computeSnapshotStateHash(
        snapshot.walAnchorHash,
        snapshot.lastSequence,
        snapshot.stateData,
      );
      if (computedStateHash !== snapshot.stateHash) {
        throw new SnapshotCorruptionError(
          snapshot.snapshotId,
          `snapshots: state_data alterado en ${snapshot.snapshotId}: ` +
            `hash almacenado ${snapshot.stateHash.slice(0, 16)}…, ` +
            `calculado ${computedStateHash.slice(0, 16)}…`,
        );
      }
      // Anclaje cruzado snapshot↔WAL: el ancla debe coincidir EXACTA
      // con el hash de la fila last_sequence de events_log.
      const anchorRow = db
        .prepare("SELECT hash FROM events_log WHERE sequence = ?")
        .get(Number(snapshot.lastSequence)) as { hash: string } | undefined;
      const actualAnchor = anchorRow === undefined ? null : anchorRow.hash;
      if (actualAnchor === null || actualAnchor === "" || actualAnchor !== snapshot.walAnchorHash) {
        throw new SnapshotAnchorMismatchError(
          snapshot.snapshotId,
          snapshot.lastSequence,
          snapshot.walAnchorHash,
          actualAnchor,
        );
      }

      restoreEngineState(engine, snapshot.stateData);
      recovery = "snapshot";
      startSequence = snapshot.lastSequence + 1n;
      expectedPrevHash = actualAnchor;
    } catch (err) {
      if (err instanceof SnapshotAnchorMismatchError) {
        // Snapshot válido pero desalineado con el WAL: descartarlo y
        // reconstruir desde el evento 0 (motor a estado virgen).
        fallbackReason = `anchor_mismatch (${err.message})`;
        resetEngineState(engine);
        recovery = "clean";
        startSequence = 1n;
        expectedPrevHash = GENESIS_HASH;
      } else {
        // Corrupción real del snapshot: abortar con error tipado.
        throw err;
      }
    }
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
    if (
      eventType !== "ORDER_NEW" &&
      eventType !== "ORDER_CANCEL" &&
      eventType !== "TRADE_MATCH"
    ) {
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
    const hash = createHash("sha256");
    writeEventHashInput(hash, sequence, expectedPrevHash, eventType, payloadJson);
    const computedHash = hash.digest("hex");
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
    } else if (eventType === "ORDER_CANCEL") {
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
    } else {
      // TRADE_MATCH: verificado por la hash chain pero NO re-aplicado —
      // los trades se regeneran determinísticamente al re-ejecutar los
      // ORDER_NEW (el motor es una proyección del flujo de órdenes).
    }
    replayedEvents += 1;
  }

  return {
    replayedEvents,
    durationMs: performance.now() - started,
    recovery,
    fallbackReason,
  };
}

export default replayState;
