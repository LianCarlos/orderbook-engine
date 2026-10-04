/**
 * Orquestador transaccional atómico (Sprint 03.5).
 *
 * Acopla de forma indivisible MatchingEngine + WalLogger +
 * SettlementLedger: cada orden se ejecuta en UNA única transacción
 * SQLite que cubre el WAL (ORDER_NEW + TRADE_MATCH), el bloqueo de
 * fondos, el calce en memoria, la liquidación de cada trade y la
 * liberación de remanentes IOC/MARKET.
 *
 * GARANTÍA DE REVERSIÓN: si cualquier paso contable o de persistencia
 * lanza, better-sqlite3 revierte TODA la transacción SQL y el pipeline
 * restaura el estado en RAM (motor + ledger) desde la captura previa.
 *
 * Nota de composición: better-sqlite3 lanza al anidar transacciones;
 * por eso el ledger y el logger operan aquí en modo "raw" (escriben
 * dentro de la transacción abierta sin abrir otra).
 */
import type Database from "better-sqlite3";
import { MatchingEngine, type MatchResult } from "./matching";
import type { Order, Trade } from "../core/types";
import { LimitLevel } from "../core/level";
import type { OrderNode } from "../core/queue";
import { WalLogger } from "../storage/wal";
import { SettlementLedger } from "../ledger/ledger";

export interface ExecutionPipelineOptions {
  baseAsset: string;
  quoteAsset: string;
}

export interface ExecuteOrderOptions {
  /** Monto a retener (quote para BUY, base para SELL). Si se omite, se calcula. */
  holdAmount?: bigint;
  /** Activo del hold (por defecto: quote para BUY, base para SELL). */
  holdAsset?: string;
}

/** Resultado del pipeline: MatchResult + secuencia WAL de la orden. */
export interface PipelineExecutionResult extends MatchResult {
  /** Secuencia de fila WAL del ORDER_NEW de esta orden (clave de correlación del stream). */
  walSequence: bigint;
}

interface SideBookInternals {
  levels: Map<bigint, LimitLevel>;
  prices: bigint[];
}

interface BookEntryInternals {
  order: Order;
  node: OrderNode;
  level: LimitLevel;
}

interface EngineInternals {
  _bids: SideBookInternals;
  _asks: SideBookInternals;
  _orderMap: Map<string, BookEntryInternals>;
  _trades: Trade[];
  _matchCounter: number;
}

/** Captura del estado interno del motor para reversión en RAM. */
interface EngineCapture {
  orders: Order[];
  trades: Trade[];
  matchCounter: number;
}

function internalsOf(engine: MatchingEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

export class ExecutionPipeline {
  private readonly _db: Database.Database;
  private readonly _engine: MatchingEngine;
  private readonly _logger: WalLogger;
  private readonly _ledger: SettlementLedger;
  private readonly _baseAsset: string;
  private readonly _quoteAsset: string;

  constructor(
    db: Database.Database,
    engine: MatchingEngine,
    logger: WalLogger,
    ledger: SettlementLedger,
    options: ExecutionPipelineOptions,
  ) {
    this._db = db;
    this._engine = engine;
    this._logger = logger;
    this._ledger = ledger;
    this._baseAsset = options.baseAsset;
    this._quoteAsset = options.quoteAsset;
  }

  /**
   * Ejecuta una orden de forma indivisible (WAL + hold + calce +
   * liquidación + releases) en UNA transacción SQLite. Ante cualquier
   * excepción, revierte el SQL y restaura el estado en RAM.
   */
  executeOrder(
    order: Order,
    options: ExecuteOrderOptions = {},
  ): PipelineExecutionResult {
    const holdAsset =
      options.holdAsset ?? (order.side === "BUY" ? this._quoteAsset : this._baseAsset);
    const holdAmount = options.holdAmount ?? this._defaultHoldAmount(order);

    const engineCapture = this._captureEngine();
    const ledgerCapture = this._ledger.captureState();
    const loggerCapture = this._logger.captureState();

    let result: MatchResult | undefined;
    let walSequence = 0n;
    try {
      this._db.transaction(() => {
        // 1. WAL: evento de ingreso (append directo dentro de la transacción).
        walSequence = this._logger.appendEvent("ORDER_NEW", order);

        // 2. Bloqueo inicial de fondos.
        if (holdAmount > 0n) {
          this._ledger.holdFundsRaw(order.traderId, holdAsset, holdAmount, order.id);
        }

        // 3. Calce en memoria. La secuencia de fila del WAL es la fuente
        // de verdad del Price-Time (el replay la inyecta igual desde la
        // fila): el libro en vivo y el reconstruido quedan bit a bit.
        result = this._engine.processOrder({ ...order, sequence: walSequence });

        // 4. Por cada trade: WAL + liquidación atómica de saldos.
        let quotePaid = 0n;
        let filledBase = 0n;
        for (const trade of result.trades) {
          this._logger.appendEvent("TRADE_MATCH", trade);
          this._ledger.settleTradeRaw(trade);
          if (trade.takerOrderId === order.id) {
            quotePaid += trade.price * trade.quantity;
          }
          if (trade.makerOrderId === order.id || trade.takerOrderId === order.id) {
            filledBase += trade.quantity;
          }
        }

        // 5. Liberación de remanentes no ejecutados (IOC/MARKET).
        if (result.remainingOrder === null) {
          const remaining = order.quantity - filledBase;
          if (order.side === "SELL") {
            if (remaining > 0n) {
              this._ledger.releaseFundsRaw(order.traderId, holdAsset, remaining, order.id);
            }
          } else if (remaining > 0n) {
            const excess = holdAmount - quotePaid;
            if (excess > 0n) {
              this._ledger.releaseFundsRaw(order.traderId, holdAsset, excess, order.id);
            }
          }
        }
      })();
      return { ...(result as MatchResult), walSequence };
    } catch (err) {
      // Reversión de RAM: SQLite ya revirtió; restauramos motor, ledger
      // y logger (secuencia y hash chain) al snapshot previo.
      this._restoreEngine(engineCapture);
      this._ledger.restoreState(ledgerCapture);
      this._logger.restoreState(loggerCapture);
      throw err;
    }
  }

  /** Monto de hold por defecto según el lado y tipo de la orden. */
  private _defaultHoldAmount(order: Order): bigint {
    if (order.side === "SELL") {
      return order.quantity; // base asset
    }
    if (order.type === "LIMIT") {
      return this._ledger.quoteRequired(order.quantity * order.price);
    }
    // MARKET BUY: peor caso del libro + 10% de holgura.
    const bestAsk = this._engine.bestAsk;
    if (bestAsk === null) {
      return 0n;
    }
    const worst = bestAsk + bestAsk / 10n;
    return this._ledger.quoteRequired(order.quantity * worst);
  }

  /** Captura el estado interno del motor (órdenes vivas, trades, contador). */
  private _captureEngine(): EngineCapture {
    const internals = internalsOf(this._engine);
    return {
      // Copias profundas: processOrder muta in-place las órdenes vivas
      // (filledQuantity/status) durante el intento; la captura debe
      // permanecer inmutable para que la reversión sea exacta.
      orders: [...internals._orderMap.values()].map((entry) => ({ ...entry.order })),
      trades: [...internals._trades],
      matchCounter: internals._matchCounter,
    };
  }

  /**
   * Restaura el motor desde una captura: reconstruye colas Price-Time
   * por sequence ascendente, el índice O(1) de cancelación, el
   * histórico de trades y el contador de matches.
   */
  private _restoreEngine(capture: EngineCapture): void {
    const internals = internalsOf(this._engine);
    internals._bids = { levels: new Map(), prices: [] };
    internals._asks = { levels: new Map(), prices: [] };
    internals._orderMap = new Map();
    internals._trades = [...capture.trades];
    internals._matchCounter = capture.matchCounter;

    const orders = [...capture.orders].sort((a, b) =>
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
    for (const book of [internals._bids, internals._asks]) {
      book.prices = [...book.levels.keys()].sort((a, b) => (a < b ? -1 : 1));
    }
  }
}
