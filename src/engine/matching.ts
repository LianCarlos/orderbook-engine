import type { Order, Side, Trade } from "../core/types";
import { LimitLevel } from "../core/level";
import type { OrderNode } from "../core/queue";

/**
 * Resultado de `processOrder`: los trades generados por el calce y la
 * orden remanente (copia) que descansa en el libro, o `null` si fue
 * ejecutada por completo o su remanente fue descartado (MARKET/IOC).
 */
export interface MatchResult {
  trades: Trade[];
  remainingOrder: Order | null;
}

/** Entrada del índice de órdenes vivas: habilita cancelación y consulta O(1). */
interface BookEntry {
  order: Order;
  node: OrderNode;
  level: LimitLevel;
}

/**
 * Un lado del libro: niveles indexados por precio (Map) y precios
 * ordenados ascendentemente para best O(1) y recorrido determinista.
 */
interface SideBook {
  levels: Map<bigint, LimitLevel>;
  /** Precios en orden ascendente. En bids el best es el último; en asks, el primero. */
  prices: bigint[];
}

/**
 * Motor de calce Price-Time del order book.
 *
 * Estructuras internas:
 * - `bids` y `asks`: niveles de precio (`LimitLevel`) con cola FIFO
 *   (`DoublyLinkedList`) por nivel, garantizando prioridad Price-Time.
 * - Índice de niveles: **fallback documentado** — `Map<bigint, LimitLevel>`
 *   + array de precios ordenado con búsqueda binaria (skip list
 *   determinista sería el upgrade). Cero `Date.now`/`Math.random`:
 *   el comportamiento es totalmente determinista para el WAL.
 * - `orderMap`: `Map<orderId, { order, node, level }>` para
 *   cancelación/consulta O(1).
 *
 * Contabilidad de volumen (única fuente de verdad en la capa core):
 * `DoublyLinkedList.fill` aplica fills parciales de forma atómica
 * (`filledQuantity += qty` junto con `totalVolume -= qty`), por lo que
 * `engine.totalVolume` es la Σ de `LimitLevel.totalVolume` de bids y
 * asks, sin contador duplicado en el motor.
 */
export class MatchingEngine {
  private _bids: SideBook = { levels: new Map(), prices: [] };
  private _asks: SideBook = { levels: new Map(), prices: [] };
  private _orderMap = new Map<string, BookEntry>();
  private _trades: Trade[] = [];
  private _matchCounter = 0;

  constructor() {}

  /**
   * Procesa una orden entrante contra el libro (Price-Time Priority).
   *
   * No muta el objeto del caller: trabaja sobre una copia defensiva.
   * `quantity <= 0n` se rechaza sin tocar el libro. El cruce respeta el
   * Maker Price (precio de la pasiva) y genera `Trade`s inmutables con
   * `matchId` monotónico (`match-1`, `match-2`, …).
   *
   * Complejidad: O(k + log L + L) en el peor caso (k = makers calzados,
   * L = niveles del lado contrario; el término L proviene del splice en
   * el array de precios). Mejores escenarios: O(1) por trade calzado.
   */
  processOrder(order: Order): MatchResult {
    const incoming: Order = { ...order };
    if (incoming.quantity <= 0n) {
      return { trades: [], remainingOrder: null };
    }

    const trades: Trade[] = [];
    let remaining = incoming.quantity - incoming.filledQuantity;
    const opposite = incoming.side === "BUY" ? this._asks : this._bids;

    while (remaining > 0n) {
      const bestPrice = this._bestPrice(opposite, incoming.side);
      if (bestPrice === null || !this._crosses(incoming, bestPrice)) {
        break;
      }
      const level = opposite.levels.get(bestPrice);
      if (level === undefined) {
        break;
      }
      const node = level.queue.head;
      if (node === null) {
        break;
      }

      const maker = node.order;
      const makerRemaining = maker.quantity - maker.filledQuantity;
      const matchQty = remaining < makerRemaining ? remaining : makerRemaining;

      const trade: Trade = Object.freeze({
        matchId: `match-${++this._matchCounter}`,
        makerOrderId: maker.id,
        takerOrderId: incoming.id,
        price: maker.price,
        quantity: matchQty,
        timestamp: incoming.timestamp,
      });
      trades.push(trade);
      this._trades.push(trade);

      level.fill(node, matchQty);
      if (maker.filledQuantity === maker.quantity) {
        level.queue.remove(node);
        this._orderMap.delete(maker.id);
        if (level.isEmpty()) {
          this._removeLevel(opposite, maker.price);
        }
      } else {
        maker.status = "PARTIALLY_FILLED";
      }

      incoming.filledQuantity += matchQty;
      remaining -= matchQty;
    }

    if (remaining === 0n) {
      return { trades, remainingOrder: null };
    }
    if (incoming.type !== "LIMIT" || incoming.timeInForce !== "GTC") {
      return { trades, remainingOrder: null };
    }

    const resting: Order = {
      ...incoming,
      status: trades.length > 0 ? "PARTIALLY_FILLED" : "NEW",
    };
    this._insertResting(resting);
    return { trades, remainingOrder: { ...resting } };
  }

  /**
   * Cancela una orden viva por id. Devuelve una copia con
   * `status: "CANCELLED"`, o `null` si la orden no existe (idempotente).
   *
   * Complejidad: O(1); si el nivel queda vacío, O(log L + L) por la
   * remoción del precio en el array ordenado.
   */
  cancelOrder(orderId: string): Order | null {
    const entry = this._orderMap.get(orderId);
    if (entry === undefined) {
      return null;
    }
    entry.level.removeOrder(entry.node);
    this._orderMap.delete(orderId);
    if (entry.level.isEmpty()) {
      this._removeLevel(this._bookOf(entry.order.side), entry.order.price);
    }
    return { ...entry.order, status: "CANCELLED" };
  }

  /** Mejor precio de compra (mayor bid) o null. O(1). */
  get bestBid(): bigint | null {
    if (this._bids.prices.length === 0) {
      return null;
    }
    return this._bids.prices[this._bids.prices.length - 1];
  }

  /** Mejor precio de venta (menor ask) o null. O(1). */
  get bestAsk(): bigint | null {
    if (this._asks.prices.length === 0) {
      return null;
    }
    return this._asks.prices[0];
  }

  /**
   * Volumen restante total del libro (bids + asks): Σ de
   * `level.totalVolume` de todos los niveles vivos. Única fuente de
   * verdad: la contabilidad incremental de la capa core.
   * O(L), L = niveles vivos.
   */
  get totalVolume(): bigint {
    let total = 0n;
    for (const level of this._bids.levels.values()) {
      total += level.totalVolume;
    }
    for (const level of this._asks.levels.values()) {
      total += level.totalVolume;
    }
    return total;
  }

  /** Histórico acumulado de trades, en orden determinista de calce. */
  get trades(): readonly Trade[] {
    return this._trades;
  }

  /** Copia de la orden viva con el id dado, o null si no existe. O(1). */
  getOrder(orderId: string): Order | null {
    const entry = this._orderMap.get(orderId);
    return entry === undefined ? null : { ...entry.order };
  }

  /**
   * Mejor precio del lado contrario para un taker dado: menor ask si el
   * taker compra, mayor bid si vende. O(1).
   */
  private _bestPrice(book: SideBook, takerSide: Side): bigint | null {
    if (book.prices.length === 0) {
      return null;
    }
    return takerSide === "BUY"
      ? book.prices[0]
      : book.prices[book.prices.length - 1];
  }

  /**
   * ¿El taker cruza contra el mejor precio contrario? MARKET cruza
   * siempre que exista contraparte; LIMIT exige precio de cruce
   * (BUY ≥ bestAsk, SELL ≤ bestBid). O(1).
   */
  private _crosses(order: Order, oppositeBest: bigint): boolean {
    if (order.type === "MARKET") {
      return true;
    }
    return order.side === "BUY"
      ? order.price >= oppositeBest
      : order.price <= oppositeBest;
  }

  /**
   * Inserta una orden resting en su lado, creando el nivel si no
   * existe. El objeto almacenado es compartido por `orderMap` y el nodo
   * de la cola (única referencia viva; los callers reciben copias).
   *
   * Complejidad: O(1) amortizado; O(log L + L) si el nivel es nuevo.
   */
  private _insertResting(order: Order): void {
    const book = this._bookOf(order.side);
    let level = book.levels.get(order.price);
    if (level === undefined) {
      level = new LimitLevel(order.price);
      book.levels.set(order.price, level);
      this._insertPrice(book.prices, order.price);
    }
    const node = level.addOrder(order);
    this._orderMap.set(order.id, { order, node, level });
  }

  /** Elimina un nivel vacío del índice. O(log L + L) por el splice. */
  private _removeLevel(book: SideBook, price: bigint): void {
    book.levels.delete(price);
    let lo = 0;
    let hi = book.prices.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (book.prices[mid] === price) {
        book.prices.splice(mid, 1);
        return;
      }
      if (book.prices[mid] < price) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
  }

  /** Inserta un precio manteniendo el orden ascendente (búsqueda binaria). O(log L + L). */
  private _insertPrice(prices: bigint[], price: bigint): void {
    let lo = 0;
    let hi = prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (prices[mid] < price) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    prices.splice(lo, 0, price);
  }

  /** Libro correspondiente a un lado de la orden. O(1). */
  private _bookOf(side: Side): SideBook {
    return side === "BUY" ? this._bids : this._asks;
  }
}
