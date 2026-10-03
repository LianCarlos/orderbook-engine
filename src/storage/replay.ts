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
import type Database from "better-sqlite3";
import { MatchingEngine } from "../engine/matching";
import type { Order } from "../core/types";
import { parseOrderPayload } from "./wal";

/** Fila física de `events_log` (raw mode: array de columnas, sin objetos). */
type EventRow = [sequence: number, event_type: string, payload: string];

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

/**
 * Reconstruye el estado del libro aplicando el WAL completo sobre
 * `engine` (que debe estar virgen). Devuelve métricas de la pasada.
 *
 * @throws {UnknownEventTypeError} si el WAL tiene un event_type desconocido.
 * @throws {ReplayError} si un payload no se puede parsear (corrupción),
 *   con la secuencia ofensora y la causa original.
 */
export function replayState(db: Database.Database, engine: MatchingEngine): ReplayResult {
  const started = performance.now();
  // raw(): filas como arrays (sin crear objetos JS por fila) — el camino
  // caliente del replay cruza el binding C++→JS una vez por fila.
  const select = db
    .prepare<[], EventRow>(
      "SELECT sequence, event_type, payload FROM events_log ORDER BY sequence ASC",
    )
    .raw();

  let replayedEvents = 0;
  for (const row of select.iterate()) {
    const [sequenceValue, eventType, payloadJson] = row;
    const sequence = BigInt(sequenceValue);

    switch (eventType) {
      case "ORDER_NEW": {
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
        break;
      }
      case "ORDER_CANCEL": {
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
        break;
      }
      default:
        throw new UnknownEventTypeError(sequence, eventType);
    }
    replayedEvents += 1;
  }

  return { replayedEvents, durationMs: performance.now() - started };
}

export default replayState;
