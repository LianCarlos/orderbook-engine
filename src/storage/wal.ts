/**
 * Write-Ahead Log del order book sobre SQLite (append-only).
 *
 * - `WalLogger` asigna secuencias monotónicas globales y persiste cada
 *   evento en `events_log`. La secuencia NO sale de relojes ni de
 *   AUTOINCREMENT: sale de un contador en proceso inicializado desde
 *   `MAX(sequence)` de la DB (permite reinicios reales) y siempre
 *   estrictamente creciente.
 * - Serialización determinista: el `payload` solo contiene datos del
 *   dominio (órdenes y ordenIds). Los campos bigint se serializan como
 *   string JSON y el reviver los reconvierte usando la lista EXACTA de
 *   claves del dominio. `created_at` lo pone SQLite, nunca el caller:
 *   nada de relojes ni aleatoriedad dentro del payload.
 */
import Database from "better-sqlite3";

/** Tipos de evento persistidos en el WAL. */
export type EventType = "ORDER_NEW" | "ORDER_CANCEL";

/** Evento pendiente de append (payload crudo, sin serializar). */
export interface WalEventInput {
  type: EventType;
  payload: object;
}

/**
 * Claves bigint del dominio `Order`/`Trade`. Lista EXACTA y exhaustiva:
 * cualquier bigint bajo otra clave es un error de contrato de
 * serialización (se lanza, nunca se silencia).
 */
export const BIGINT_KEYS = [
  "sequence",
  "price",
  "quantity",
  "filledQuantity",
] as const;

const BIGINT_KEY_SET: ReadonlySet<string> = new Set(BIGINT_KEYS);

/**
 * Replacer de `JSON.stringify` para payloads del WAL.
 * Los bigint se serializan como string (`"100"`) de forma estable;
 * un bigint bajo una clave ajena al dominio lanza `TypeError` (evita
 * corromper silenciosamente el formato del WAL).
 */
export function waltReplacer(key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    if (!BIGINT_KEY_SET.has(key)) {
      throw new TypeError(
        `WAL serialization: bigint bajo clave no declarada "${key}". ` +
          `Claves bigint permitidas: ${BIGINT_KEYS.join(", ")}.`,
      );
    }
    return value.toString();
  }
  return value;
}

/**
 * Reviver de `JSON.parse` para payloads del WAL.
 * Reconvierte a bigint los strings bajo las claves exactas del dominio.
 */
export function waltReviver(key: string, value: unknown): unknown {
  if (BIGINT_KEY_SET.has(key) && typeof value === "string") {
    return toBigintOrThrow(key, value);
  }
  return value;
}

/**
 * Convierte un string a bigint con error tipado (contrato compartido
 * por el reviver genérico y el parse especializado de órdenes).
 */
function toBigintOrThrow(key: string, value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(
      `WAL deserialization: "${key}" no es un bigint válido: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * IMPORTANTE (rendimiento): `serializePayload`/`parsePayload` NO usan
 * `waltReplacer`/`waltReviver` con `JSON.stringify`/`JSON.parse`.
 * El bridge callback de V8 invoca JS por CADA propiedad (~2.5 µs por
 * llamada en hardware modesto); con 10k eventos × ~11 claves el replay
 * superaba el umbral del Sprint (741 ms vs < 150 ms). Se usa un walker
 * JS puro con el MISMO contrato de claves (`BIGINT_KEY_SET`), los
 * MISMOS mensajes de error y la MISMA semántica determinista: los
 * `waltReplacer`/`waltReviver` exportados siguen siendo la definición
 * del contrato por-clave; los walkers son su implementación rápida.
 */

/**
 * Convierte los bigint del dominio a string, copiando en profundidad
 * (nunca muta el objeto del caller: el motor en vivo reutiliza la
 * misma referencia del payload después del flush).
 */
function stringifyBigints(value: unknown): unknown {
  if (typeof value === "bigint") {
    // Un bigint "suelto" (raíz o array) no tiene clave declarada.
    throw new TypeError(
      `WAL serialization: bigint sin clave declarada. ` +
        `Claves bigint permitidas: ${BIGINT_KEYS.join(", ")}.`,
    );
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = stringifyBigints(value[i]);
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      const item = rec[key];
      out[key] =
        typeof item === "bigint"
          ? waltReplacer(key, item)
          : stringifyBigints(item);
    }
    return out;
  }
  return value;
}

/**
 * Reconvierte a bigint los strings bajo las claves exactas del dominio,
 * mutando in-place el objeto ya parseado (propiedad del parser, seguro).
 */
function reviveBigints(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      reviveBigints(value[i]);
    }
    return value;
  }
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const item = rec[key];
      if (BIGINT_KEY_SET.has(key) && typeof item === "string") {
        rec[key] = toBigintOrThrow(key, item);
      } else {
        reviveBigints(item);
      }
    }
  }
  return value;
}

/** Serializa un payload de evento a JSON WAL (determinista, bigint → string). */
export function serializePayload(payload: object): string {
  return JSON.stringify(stringifyBigints(payload));
}

/** Parsea un payload JSON del WAL (revive los bigint del dominio). */
export function parsePayload(json: string): unknown {
  return reviveBigints(JSON.parse(json));
}

/**
 * Parsea un payload `ORDER_NEW` sin el walker genérico: solo las 4
 * claves bigint del dominio de una `Order` se revisan y reconvierten
 * (con el mismo error tipado). ~5x más rápido que `parsePayload` en el
 * camino caliente del replay; el contrato de claves exactas no cambia.
 */
export function parseOrderPayload(json: string): Record<string, unknown> {
  const order = JSON.parse(json) as Record<string, unknown>;
  for (const key of BIGINT_KEYS) {
    const value = order[key];
    if (typeof value === "string") {
      order[key] = toBigintOrThrow(key, value);
    }
  }
  return order;
}

/**
 * Logger append-only del WAL.
 *
 * Invariantes:
 * - Una única instancia por conexión/DB por proceso (si se crean dos,
 *   la segunda re-lee `MAX(sequence)` de la DB y continúa; si ambas
 *   coexisten antes de escribir, la monotonicidad deja de estar
 *   garantizada).
 * - Secuencias estrictamente crecientes en proceso: nunca se reutiliza
 *   ni se asigna dos veces.
 * - `appendBatch` es atómico: o persisten todos los eventos del lote o
 *   ninguno (rollback automático de la transacción).
 */
export class WalLogger {
  private readonly _db: Database.Database;
  private readonly _insertStmt: Database.Statement<[number, string, string]>;
  /** Próxima secuencia a asignar (se inicializa desde la DB). */
  private _nextSequence: bigint;

  constructor(db: Database.Database) {
    this._db = db;
    this._insertStmt = db.prepare<[number, string, string]>(
      "INSERT INTO events_log (sequence, event_type, payload) VALUES (?, ?, ?)",
    );
    const row = db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM events_log")
      .get() as { max_sequence: number };
    // Reinicios reales: el contador continúa desde el último evento persistido.
    this._nextSequence = BigInt(row.max_sequence) + 1n;
  }

  /** Última secuencia persistida (0n si el WAL está vacío). */
  get lastSequence(): bigint {
    return this._nextSequence - 1n;
  }

  /**
   * Persiste un evento con la siguiente secuencia monotónica.
   * Devuelve la secuencia asignada.
   */
  appendEvent(type: EventType, payload: object): bigint {
    const sequence = this._nextSequence++;
    this._insertStmt.run(Number(sequence), type, serializePayload(payload));
    return sequence;
  }

  /**
   * Persiste un lote de eventos de forma ATÓMICA (transacción SQLite).
   * Las secuencias se asignan contiguas y en el orden del array.
   * Devuelve la última secuencia asignada; con lote vacío devuelve
   * `lastSequence` (no-op, sin transacción).
   */
  appendBatch(events: WalEventInput[]): bigint {
    if (events.length === 0) {
      return this.lastSequence;
    }
    const insert = this._insertStmt;
    const db = this._db;
    let last = 0n;
    db.transaction((batch: WalEventInput[]) => {
      for (const event of batch) {
        const sequence = this._nextSequence++;
        insert.run(Number(sequence), event.type, serializePayload(event.payload));
        last = sequence;
      }
    })(events);
    return last;
  }
}

export default WalLogger;
