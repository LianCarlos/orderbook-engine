/**
 * Motor de liquidación y retenciones de doble entrada (Sprint 03).
 *
 * - `holdFunds`:  AVAILABLE → LOCKED al aceptar una orden. Falla antes
 *   de tocar nada si no hay fondos libres suficientes.
 * - `releaseFunds`: LOCKED → AVAILABLE al cancelar/expirar.
 * - `settleTrade`: liquidación atómica Maker/Taker de cada `Trade` del
 *   motor: el vendedor entrega base asset desde LOCKED al AVAILABLE del
 *   comprador; el comprador entrega quote asset desde LOCKED al
 *   AVAILABLE del vendedor; las comisiones Maker/Taker se deducen hacia
 *   FEE_VAULT (cero por defecto).
 *
 * Persistencia: cada operación graba sus asientos en `journal_entries`
 * (better-sqlite3, sentencias preparadas) dentro de UNA transacción
 * SQLite atómica sobre la MISMA conexión que usa el WAL. La memoria se
 * muta solo después del commit: si el SQL falla, el estado en memoria
 * queda intacto (rollback limpio).
 *
 * Single-threaded por diseño (event loop del motor): sin candados.
 */
import type Database from "better-sqlite3";
import type { Trade } from "../core/types";
import {
  EXTERNAL_ACCOUNT_ID,
  SYSTEM_ACCOUNT_ID,
  type AccountType,
  type EntrySide,
  type LedgerEntry,
} from "./accounts";

type SqliteDatabase = Database.Database;

/** Error base del dominio contable. */
export class LedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LedgerError";
  }
}

/** Desviación de saldo: fondos insuficientes, release excesivo o montos inválidos. */
export class BalanceOverflowError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "BalanceOverflowError";
  }
}

/** Violación de la regla inviolable: Suma(Débitos) != Suma(Créditos) por asset. */
export class UnbalancedTransactionError extends LedgerError {
  readonly asset: string;

  constructor(asset: string, message: string) {
    super(message);
    this.name = "UnbalancedTransactionError";
    this.asset = asset;
  }
}

export interface SettlementLedgerOptions {
  /** Activo base del mercado (ej. "BTC"). Determina el lado SELL en holdFunds. */
  baseAsset: string;
  /** Activo cotizado (ej. "USD"). Determina el lado BUY y las comisiones. */
  quoteAsset: string;
  /** Comisión maker en puntos básicos (por 10,000) sobre el principal en quote. */
  makerFeeBps?: number;
  /** Comisión taker en puntos básicos (por 10,000) sobre el principal en quote. */
  takerFeeBps?: number;
}

/** Resultado de la auditoría de partida doble. */
export interface LedgerAuditResult {
  /** Transacciones donde Σ débitos != Σ créditos en algún asset (debe ser 0). */
  unbalancedTransactions: number;
  /** Subcuentas donde memoria != journal neto (debe ser 0). */
  memoryMismatches: number;
  /** Diagnóstico de las primeras divergencias memoria↔journal. */
  mismatchDetails: Array<{ key: string; journal: bigint; memory: bigint }>;
  byAsset: Array<{
    asset: string;
    /** Σ de saldos en memoria (usuarios + FEE_VAULT). */
    balance: bigint;
    /** Σ de depósitos iniciales según el journal. */
    deposits: bigint;
  }>;
}

type Side = "BUY" | "SELL";
type BalancesByType = Map<AccountType, bigint>;

interface OrderRegistration {
  userId: string;
  asset: string;
  side: Side;
  /** Retención aún no consumida (base o quote según el lado). */
  remaining: bigint;
}

/**
 * Valida la regla inviolable por asset antes de persistir: lanza
 * {@link UnbalancedTransactionError} si algún asset descuadra.
 */
function assertBalanced(entries: readonly LedgerEntry[]): void {
  const byAsset = new Map<string, bigint>();
  for (const entry of entries) {
    const delta = entry.side === "DEBIT" ? entry.amount : -entry.amount;
    byAsset.set(entry.asset, (byAsset.get(entry.asset) ?? 0n) + delta);
  }
  for (const [asset, net] of byAsset) {
    if (net !== 0n) {
      throw new UnbalancedTransactionError(
        asset,
        `transacción descuadrada en ${asset}: débitos − créditos = ${net.toString()}`,
      );
    }
  }
}

export class SettlementLedger {
  private readonly _db: SqliteDatabase;
  private readonly _insertStmt: Database.Statement<
    [string, string, string, string, string, number, string | null, string | null]
  >;
  private readonly _settleStmt: Database.Statement<[string]>;
  private readonly _baseAsset: string;
  private readonly _quoteAsset: string;
  private readonly _makerFeeBps: number;
  private readonly _takerFeeBps: number;

  /** userId → asset → AccountType → saldo (bigint). Solo cuentas reales. */
  private readonly _balances = new Map<string, Map<string, BalancesByType>>();
  /** orderId → registro del hold (usuario, asset bloqueado y lado derivado). */
  private readonly _orders = new Map<string, OrderRegistration>();
  private _txCounter = 0;

  constructor(db: SqliteDatabase, options: SettlementLedgerOptions) {
    this._db = db;
    this._insertStmt = db.prepare<
      [string, string, string, string, string, number, string | null, string | null]
    >(
      `INSERT INTO journal_entries
         (tx_id, user_id, account_type, asset, side, amount, order_id, match_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, (unixepoch() * 1000))`,
    );
    this._settleStmt = db.prepare<[string]>(
      "INSERT INTO settled_trades (match_id) VALUES (?)",
    );
    this._baseAsset = options.baseAsset;
    this._quoteAsset = options.quoteAsset;
    this._makerFeeBps = options.makerFeeBps ?? 0;
    this._takerFeeBps = options.takerFeeBps ?? 0;
  }

  // ── Consultas ──────────────────────────────────────────────────────

  /** Saldo de una subcuenta. O(1). */
  balanceOf(userId: string, asset: string, accountType: AccountType): bigint {
    return this._balances.get(userId)?.get(asset)?.get(accountType) ?? 0n;
  }

  /** Registro del hold de una orden (copia defensiva). */
  orderRegistration(orderId: string): OrderRegistration | undefined {
    const registration = this._orders.get(orderId);
    if (registration === undefined) {
      return undefined;
    }
    return { ...registration };
  }

  // ── Operaciones públicas ───────────────────────────────────────────

  /**
   * Depósito externo: DEBIT usuario (AVAILABLE) / CREDIT EXTERNAL.
   * Para cuentas de activo, DEBIT incrementa el saldo; la contrapartida
   * sintética (liability) vive solo en el journal.
   */
  deposit(userId: string, asset: string, amount: bigint): void {
    if (amount <= 0n) {
      throw new BalanceOverflowError(
        `deposit inválido para ${userId} en ${asset}: ${amount.toString()}`,
      );
    }
    this._commit(
      [
        { accountId: userId, accountType: "AVAILABLE", asset, side: "DEBIT", amount },
        { accountId: EXTERNAL_ACCOUNT_ID, accountType: "AVAILABLE", asset, side: "CREDIT", amount },
      ],
      null,
      null,
    );
  }

  /**
   * Retiene fondos de una orden: AVAILABLE → LOCKED.
   * El lado se deriva del activo bloqueado (base → SELL, quote → BUY).
   * Falla con {@link BalanceOverflowError} ANTES de tocar nada si no
   * hay fondos libres suficientes (la orden jamás llega al libro).
   */
  holdFunds(userId: string, asset: string, amount: bigint, orderId: string): void {
    const side = this._sideOf(asset);
    if (amount <= 0n) {
      throw new BalanceOverflowError(
        `hold inválido para ${orderId}: ${amount.toString()} ${asset}`,
      );
    }
    const available = this.balanceOf(userId, asset, "AVAILABLE");
    if (available < amount) {
      throw new BalanceOverflowError(
        `fondos insuficientes para hold de ${orderId}: ` +
          `necesita ${amount.toString()} ${asset}, disponible ${available.toString()}`,
      );
    }
    if (this._orders.has(orderId)) {
      throw new LedgerError(`orderId ya registrado en el ledger: ${orderId}`);
    }
    this._commit(
      [
        { accountId: userId, accountType: "LOCKED", asset, side: "DEBIT", amount },
        { accountId: userId, accountType: "AVAILABLE", asset, side: "CREDIT", amount },
      ],
      orderId,
      null,
    );
    this._orders.set(orderId, { userId, asset, side, remaining: amount });
  }

  /**
   * Libera retenciones al cancelar/expirar una orden: LOCKED → AVAILABLE.
   * `amount === 0n` es un no-op válido. Falla si LOCKED < amount.
   */
  releaseFunds(userId: string, asset: string, amount: bigint, orderId: string): void {
    if (amount < 0n) {
      throw new BalanceOverflowError(`release negativo para ${orderId}`);
    }
    if (amount === 0n) {
      return;
    }
    const registration = this._orders.get(orderId);
    if (registration !== undefined) {
      if (registration.userId !== userId || registration.asset !== asset) {
        throw new LedgerError(
          `release de ${orderId} no coincide con el hold original ` +
            `(usuario/asset distintos)`,
        );
      }
    }
    const locked = this.balanceOf(userId, asset, "LOCKED");
    if (locked < amount) {
      throw new BalanceOverflowError(
        `release excesivo para ${orderId}: intenta liberar ${amount.toString()} ${asset}, ` +
          `retenidos ${locked.toString()}`,
      );
    }
    this._commit(
      [
        { accountId: userId, accountType: "AVAILABLE", asset, side: "DEBIT", amount },
        { accountId: userId, accountType: "LOCKED", asset, side: "CREDIT", amount },
      ],
      orderId,
      null,
    );
    if (registration !== undefined) {
      registration.remaining -= amount;
      if (registration.remaining <= 0n) {
        this._orders.delete(orderId);
      }
    }
  }

  /**
   * Liquida atómicamente un `Trade` entre Maker y Taker:
   * - Vendedor (SELL): base asset LOCKED → AVAILABLE del comprador.
   * - Comprador (BUY): quote asset LOCKED → AVAILABLE del vendedor
   *   (principal − comisión maker).
   * - Comisiones maker y taker → FEE_VAULT del sistema (quote asset).
   *
   * Todos los asientos viajan en una única transacción SQLite; ante
   * cualquier desviación de saldo lanza {@link BalanceOverflowError} o
   * {@link UnbalancedTransactionError} sin persistir nada.
   */
  settleTrade(trade: Trade): void {
    if (trade.quantity <= 0n || trade.price <= 0n) {
      throw new LedgerError(
        `settleTrade ${trade.matchId}: quantity/price deben ser positivos`,
      );
    }
    const maker = this._orders.get(trade.makerOrderId);
    const taker = this._orders.get(trade.takerOrderId);
    if (maker === undefined || taker === undefined) {
      throw new LedgerError(
        `settleTrade ${trade.matchId}: orden sin hold registrado ` +
          `(maker=${maker === undefined ? "∅" : "ok"}, taker=${taker === undefined ? "∅" : "ok"})`,
      );
    }
    if (maker.side === taker.side) {
      throw new LedgerError(
        `settleTrade ${trade.matchId}: maker y taker con el mismo lado (${maker.side})`,
      );
    }
    const seller = maker.side === "SELL" ? maker : taker;
    const buyer = maker.side === "BUY" ? maker : taker;
    const sellerOrderId = maker.side === "SELL" ? trade.makerOrderId : trade.takerOrderId;
    const buyerOrderId = maker.side === "SELL" ? trade.takerOrderId : trade.makerOrderId;
    const baseAsset = seller.asset;
    const quoteAsset = buyer.asset;

    const principal = trade.quantity * trade.price;
    const makerFee = (principal * BigInt(this._makerFeeBps)) / 10_000n;
    const takerFee = (principal * BigInt(this._takerFeeBps)) / 10_000n;
    const sellerCredit = principal - makerFee;
    const buyerDebit = principal + takerFee;

    // Pre-checks de saldo: cualquier desviación aborta sin persistir.
    if (this.balanceOf(seller.userId, baseAsset, "LOCKED") < trade.quantity) {
      throw new BalanceOverflowError(
        `settleTrade ${trade.matchId}: LOCKED de ${seller.userId} en ${baseAsset} insuficiente`,
      );
    }
    if (this.balanceOf(buyer.userId, quoteAsset, "LOCKED") < buyerDebit) {
      throw new BalanceOverflowError(
        `settleTrade ${trade.matchId}: LOCKED de ${buyer.userId} en ${quoteAsset} insuficiente`,
      );
    }

    const entries: LedgerEntry[] = [
      // Base asset: el vendedor entrega la mercancía desde LOCKED y el
      // comprador la recibe en AVAILABLE (DEBIT incrementa activos).
      { accountId: seller.userId, accountType: "LOCKED", asset: baseAsset, side: "CREDIT", amount: trade.quantity },
      { accountId: buyer.userId, accountType: "AVAILABLE", asset: baseAsset, side: "DEBIT", amount: trade.quantity },
      // Quote asset: el comprador paga desde LOCKED; el vendedor recibe
      // el neto de comisión en AVAILABLE; las comisiones van a FEE_VAULT.
      { accountId: buyer.userId, accountType: "LOCKED", asset: quoteAsset, side: "CREDIT", amount: buyerDebit },
      { accountId: seller.userId, accountType: "AVAILABLE", asset: quoteAsset, side: "DEBIT", amount: sellerCredit },
    ];
    const feeTotal = makerFee + takerFee;
    if (feeTotal > 0n) {
      entries.push({
        accountId: SYSTEM_ACCOUNT_ID,
        accountType: "FEE_VAULT",
        asset: quoteAsset,
        side: "DEBIT",
        amount: feeTotal,
      });
    }
    this._commit(entries, trade.takerOrderId, trade.matchId);

    // Limpieza del registro de holds (anti-fuga): la retención se
    // consume en su propia unidad y el registro muere al agotarse.
    seller.remaining -= trade.quantity;
    if (seller.remaining <= 0n) {
      this._orders.delete(sellerOrderId);
    }
    buyer.remaining -= buyerDebit;
    if (buyer.remaining <= 0n) {
      this._orders.delete(buyerOrderId);
    }
  }

  /**
   * Auditoría global de partida doble:
   * 1. Cada transacción del journal balancea por asset (débitos = créditos).
   * 2. La memoria coincide bit a bit con el neto del journal por subcuenta.
   * 3. Por asset: Σ balances en memoria == Σ depósitos iniciales.
   * Devuelve las métricas; el criterio de salud es todo 0 / balance == deposits.
   */
  audit(): LedgerAuditResult {
    const rows = this._db
      .prepare(
        "SELECT tx_id, user_id, account_type, asset, side, amount FROM journal_entries ORDER BY id",
      )
      .all() as Array<{
      tx_id: string;
      user_id: string;
      account_type: AccountType;
      asset: string;
      side: EntrySide;
      amount: number;
    }>;

    // 1. Balance por transacción y por asset.
    const byTx = new Map<string, Map<string, bigint>>();
    for (const row of rows) {
      let perAsset = byTx.get(row.tx_id);
      if (perAsset === undefined) {
        perAsset = new Map();
        byTx.set(row.tx_id, perAsset);
      }
      const delta = row.side === "DEBIT" ? BigInt(row.amount) : -BigInt(row.amount);
      perAsset.set(row.asset, (perAsset.get(row.asset) ?? 0n) + delta);
    }
    let unbalancedTransactions = 0;
    for (const perAsset of byTx.values()) {
      for (const net of perAsset.values()) {
        if (net !== 0n) {
          unbalancedTransactions += 1;
        }
      }
    }

    // 2. Neto por subcuenta: journal vs memoria.
    const journalNet = new Map<string, bigint>();
    for (const row of rows) {
      if (row.user_id === EXTERNAL_ACCOUNT_ID) {
        continue;
      }
      const key = `${row.user_id}|${row.account_type}|${row.asset}`;
      const delta = row.side === "DEBIT" ? BigInt(row.amount) : -BigInt(row.amount);
      journalNet.set(key, (journalNet.get(key) ?? 0n) + delta);
    }
    const memoryNet = new Map<string, bigint>();
    for (const [userId, assets] of this._balances) {
      for (const [asset, types] of assets) {
        for (const [accountType, amount] of types) {
          if (amount === 0n) {
            continue;
          }
          const key = `${userId}|${accountType}|${asset}`;
          memoryNet.set(key, (memoryNet.get(key) ?? 0n) + amount);
        }
      }
    }
    const allKeys = new Set([...journalNet.keys(), ...memoryNet.keys()]);
    let memoryMismatches = 0;
    const mismatchDetails: LedgerAuditResult["mismatchDetails"] = [];
    for (const key of allKeys) {
      const journalValue = journalNet.get(key) ?? 0n;
      const memoryValue = memoryNet.get(key) ?? 0n;
      if (journalValue !== memoryValue) {
        memoryMismatches += 1;
        if (mismatchDetails.length < 10) {
          mismatchDetails.push({ key, journal: journalValue, memory: memoryValue });
        }
      }
    }

    // 3. Por asset: balance en memoria vs depósitos según el journal.
    const assets = new Set<string>();
    for (const row of rows) {
      assets.add(row.asset);
    }
    const byAsset: LedgerAuditResult["byAsset"] = [];
    for (const asset of assets) {
      let deposits = 0n;
      let balance = 0n;
      for (const [key, value] of journalNet) {
        if (key.endsWith(`|${asset}`)) {
          deposits += value;
        }
      }
      for (const [key, value] of memoryNet) {
        if (key.endsWith(`|${asset}`)) {
          balance += value;
        }
      }
      byAsset.push({ asset, balance, deposits });
    }
    byAsset.sort((a, b) => a.asset.localeCompare(b.asset));

    return { unbalancedTransactions, memoryMismatches, mismatchDetails, byAsset };
  }

  // ── Internos ───────────────────────────────────────────────────────

  /** Deriva el lado de la orden a partir del activo bloqueado. */
  private _sideOf(asset: string): Side {
    if (asset === this._baseAsset) {
      return "SELL";
    }
    if (asset === this._quoteAsset) {
      return "BUY";
    }
    throw new LedgerError(
      `asset ${asset} no es base (${this._baseAsset}) ni quote (${this._quoteAsset})`,
    );
  }

  /**
   * Núcleo transaccional: valida el balance de asientos y la precisión
   * de los montos, registra la liquidación (si aplica) y persiste en
   * `journal_entries` dentro de UNA transacción SQLite. La mutación de
   * memoria ocurre solo tras el commit (si el SQL falla, la memoria
   * queda intacta).
   */
  private _commit(
    entries: LedgerEntry[],
    orderId: string | null,
    matchId: string | null,
  ): void {
    assertBalanced(entries);
    for (const entry of entries) {
      if (entry.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new BalanceOverflowError(
          `monto fuera del rango seguro de precisión: ${entry.amount.toString()} ${entry.asset}`,
        );
      }
    }
    const txId = `tx-${String(++this._txCounter).padStart(6, "0")}`;
    const insert = this._insertStmt;
    const settleStmt = this._settleStmt;
    this._db.transaction(() => {
      if (matchId !== null) {
        // PK única: una liquidación duplicada aborta toda la transacción.
        settleStmt.run(matchId);
      }
      for (const entry of entries) {
        insert.run(
          txId,
          entry.accountId,
          entry.accountType,
          entry.asset,
          entry.side,
          Number(entry.amount),
          orderId,
          matchId,
        );
      }
    })();
    for (const entry of entries) {
      this._applyEntry(entry);
    }
  }

  /** Mutación de memoria de un asiento ya validado y persistido. */
  private _applyEntry(entry: LedgerEntry): void {
    // La contrapartida sintética de los depósitos vive SOLO en el
    // journal (liability externa sin saldo en memoria).
    if (entry.accountId === EXTERNAL_ACCOUNT_ID) {
      return;
    }
    let assets = this._balances.get(entry.accountId);
    if (assets === undefined) {
      assets = new Map();
      this._balances.set(entry.accountId, assets);
    }
    let types = assets.get(entry.asset);
    if (types === undefined) {
      types = new Map();
      assets.set(entry.asset, types);
    }
    const current = types.get(entry.accountType) ?? 0n;
    const next = entry.side === "DEBIT" ? current + entry.amount : current - entry.amount;
    types.set(entry.accountType, next);
  }
}
