/**
 * Agregador de profundidad L2 (Sprint 04).
 *
 * Consolida las órdenes individuales del `MatchingEngine` en niveles
 * de precio agregados `[price, aggregatedQuantity]`, con bids en orden
 * descendente y asks ascendente, y calcula un checksum CRC32 del
 * estado L2 para que los clientes remotos validen la sincronización de
 * su libro local.
 *
 * ACCESO A INTERNALS (decisión documentada, mismo patrón que
 * storage/snapshot.ts): el motor no expone enumeración pública de
 * órdenes; este módulo lee `_bids`/`_asks` (Map precio → LimitLevel)
 * mediante cast estructural. Si el engine cambia sus internals, este
 * archivo es el punto único de adaptación de la capa API.
 */
import type { MatchingEngine } from "../engine/matching";
import type { LimitLevel } from "../core/level";

/** Nivel de precio agregado del libro L2. */
export interface PriceLevel {
  side: "BUY" | "SELL";
  price: bigint;
  /** Volumen remanente agregado del nivel. */
  quantity: bigint;
}

/** Snapshot de profundidad L2 con checksum de integridad. */
export interface DepthSnapshot {
  bids: PriceLevel[];
  asks: PriceLevel[];
  /** CRC32 hex (8 dígitos) del estado L2 (bids|asks). */
  checksum: string;
  depthLimit: number;
}

interface SideBookInternals {
  levels: Map<bigint, LimitLevel>;
  prices: bigint[];
}

interface EngineInternals {
  _bids: SideBookInternals;
  _asks: SideBookInternals;
}

function internalsOf(engine: MatchingEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

/** Tabla CRC32 (polinomio reflejado 0xEDB88320). */
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

/** CRC32 en hex (8 dígitos, minúsculas) de una cadena UTF-8. */
export function crc32Hex(input: string): string {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc = CRC32_TABLE[(crc ^ input.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/**
 * Checksum canónico de un estado L2: CRC32 de la representación
 * `bids:price:qty|…#asks:price:qty|…` en el MISMO orden en que se
 * publican los niveles (bids desc, asks asc). Función compartida por
 * el servidor y por los clientes que reconstruyen el libro.
 */
export function computeLevelsChecksum(bids: PriceLevel[], asks: PriceLevel[]): string {
  const canonical =
    "bids:" +
    bids.map((l) => `${l.price}:${l.quantity}`).join("|") +
    "#asks:" +
    asks.map((l) => `${l.price}:${l.quantity}`).join("|");
  return crc32Hex(canonical);
}

/** Comparador de precios para ordenar niveles. */
function compareLevels(a: PriceLevel, b: PriceLevel): number {
  return a.price < b.price ? -1 : a.price > b.price ? 1 : 0;
}

export class L2OrderbookAggregator {
  private readonly _engine: MatchingEngine;

  constructor(engine: MatchingEngine) {
    this._engine = engine;
  }

  /**
   * Snapshot de profundidad: consolida el libro en niveles agregados,
   * bids descendentes y asks ascendentes, limitados a `depthLimit`
   * niveles por lado, con checksum CRC32 del estado publicado.
   */
  getDepthSnapshot(depthLimit = 20): DepthSnapshot {
    const internals = internalsOf(this._engine);
    const bids: PriceLevel[] = [];
    const asks: PriceLevel[] = [];
    for (const [price, level] of internals._bids.levels) {
      if (level.totalVolume > 0n) {
        bids.push({ side: "BUY", price, quantity: level.totalVolume });
      }
    }
    for (const [price, level] of internals._asks.levels) {
      if (level.totalVolume > 0n) {
        asks.push({ side: "SELL", price, quantity: level.totalVolume });
      }
    }
    // bids: mayor primero; asks: menor primero.
    bids.sort((a, b) => compareLevels(b, a));
    asks.sort(compareLevels);
    const limitedBids = bids.slice(0, depthLimit);
    const limitedAsks = asks.slice(0, depthLimit);
    return {
      bids: limitedBids,
      asks: limitedAsks,
      checksum: computeLevelsChecksum(limitedBids, limitedAsks),
      depthLimit,
    };
  }

  /** Volumen agregado actual de un nivel (0n si no existe o está vacío). */
  levelQuantity(side: "BUY" | "SELL", price: bigint): bigint {
    const internals = internalsOf(this._engine);
    const book = side === "BUY" ? internals._bids : internals._asks;
    const level = book.levels.get(price);
    return level === undefined ? 0n : level.totalVolume;
  }
}
