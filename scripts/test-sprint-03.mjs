/**
 * SPRINT 03 — Double-Entry Settlement Ledger · Auditoría y estrés
 * ─────────────────────────────────────────────────────────────────────
 * qa-tester · Node puro (node:assert/strict), sin frameworks ni deps.
 * Ejecuta con:  node scripts/test-sprint-03.mjs   (Node >= 24)
 *
 * Flujo:
 *   1. 1,000 usuarios con depósitos ficticios (USD + BTC, deterministas).
 *   2. 10,000 operaciones cruzadas contra el MatchingEngine real:
 *      holds (limit/market, GTC/IOC), calces parciales, ejecuciones
 *      totales y cancelaciones con liberación exacta de retenciones.
 *   3. Auditoría Global de Partida Doble:
 *      - 0 transacciones descuadradas en el journal;
 *      - 0 divergencias memoria ↔ journal;
 *      - Σ balances en el sistema == Σ depósitos iniciales (por asset).
 *   4. Overspend: intento de gastar más de lo disponible → error y
 *      estado previo intacto (sin asientos nuevos).
 *   5. Prueba aislada de comisiones Maker/Taker → FEE_VAULT.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Hook de resolución: "./x" → "./x.ts" (patrón del repo) ───────────
registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative =
      specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.[cm]?[jt]s$|\.json$/.test(specifier);
    if (isRelative && !hasExtension) {
      try {
        return nextResolve(specifier + ".ts", context);
      } catch (err) {
        if (
          err &&
          (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND")
        ) {
          return nextResolve(specifier, context);
        }
        throw err;
      }
    }
    return nextResolve(specifier, context);
  },
});

const { openDatabase } = await import("../src/storage/db.ts");
const { SettlementLedger, BalanceOverflowError } = await import(
  "../src/ledger/ledger.ts"
);
const { MatchingEngine } = await import("../src/engine/matching.ts");

// ── Configuración del experimento ────────────────────────────────────

const USERS = 1_000;
const TOTAL_OPS = 10_000;
const DEPOSIT_USD = 1_000_000n;
const DEPOSIT_BTC = 1_000n;

/** PRNG LCG determinista (Numerical Recipes, 32-bit). */
function createRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000; // [0, 1)
  };
}

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orderbook-sprint03-"));
  let db = null;
  let feeDb = null;

  try {
    db = openDatabase(path.join(tmpDir, "ledger.db"));
    const ledger = new SettlementLedger(db, {
      baseAsset: "BTC",
      quoteAsset: "USD",
      makerFeeBps: 0,
      takerFeeBps: 0,
    });

    // ── 1. Depósitos iniciales ────────────────────────────────────────
    for (let u = 0; u < USERS; u++) {
      const userId = `user-${u}`;
      ledger.deposit(userId, "USD", DEPOSIT_USD);
      ledger.deposit(userId, "BTC", DEPOSIT_BTC);
    }
    const expectedDeposits = {
      USD: DEPOSIT_USD * BigInt(USERS),
      BTC: DEPOSIT_BTC * BigInt(USERS),
    };

    // ── 2. 10,000 operaciones cruzadas ───────────────────────────────
    const engine = new MatchingEngine();
    const rng = createRng(0x5eed03);
    const alive = new Map(); // orderId → { userId, side, price }
    let sequence = 0n;
    let tradesSettled = 0;
    let cancels = 0;
    let holds = 0;

    const settleAndTrack = (res, orderId) => {
      let paidQuote = 0n;
      let filledBase = 0n;
      for (const t of res.trades) {
        ledger.settleTrade(t);
        tradesSettled += 1;
        // Un maker resting llenado por completo ya no existe en el libro:
        // su LOCKED quedó drenado por los settles; fuera del registro vivo.
        if (engine.getOrder(t.makerOrderId) === null) {
          alive.delete(t.makerOrderId);
        }
        const mine = t.makerOrderId === orderId || t.takerOrderId === orderId;
        if (mine) {
          filledBase += t.quantity;
        }
        if (t.takerOrderId === orderId) {
          paidQuote += t.price * t.quantity;
        }
      }
      return { paidQuote, filledBase };
    };

    for (let i = 1; i <= TOTAL_OPS; i++) {
      const roll = rng();
      if (roll < 0.3 && alive.size > 0) {
        // ── CANCEL: libera exactamente la retención restante ──────────
        const ids = [...alive.keys()];
        const orderId = ids[Math.floor(rng() * ids.length)];
        const meta = alive.get(orderId);
        const live = engine.getOrder(orderId);
        assert.notEqual(live, null, `orden viva esperada: ${orderId}`);
        const cancelled = engine.cancelOrder(orderId);
        assert.notEqual(cancelled, null, `cancelación debe existir: ${orderId}`);
        const remaining = live.quantity - live.filledQuantity;
        if (meta.side === "SELL") {
          ledger.releaseFunds(meta.userId, "BTC", remaining, orderId);
        } else {
          ledger.releaseFunds(meta.userId, "USD", remaining * meta.price, orderId);
        }
        alive.delete(orderId);
        cancels += 1;
        continue;
      }

      // ── Orden nueva: hold según lado, calce contra el motor ─────────
      const side = rng() < 0.5 ? "BUY" : "SELL";
      const isLimit = rng() < 0.85;
      const price = 95n + BigInt(Math.floor(rng() * 11)); // 95..105
      const quantity = 1n + BigInt(Math.floor(rng() * 10)); // 1..10
      const userId = `user-${Math.floor(rng() * USERS)}`;
      const orderId = `o-${i}`;

      let holdAmount;
      if (side === "SELL") {
        holdAmount = quantity; // base asset
        ledger.holdFunds(userId, "BTC", holdAmount, orderId);
      } else {
        // BUY: quote a mi precio (market: margen máximo del libro + holgura).
        holdAmount = isLimit ? quantity * price : quantity * 110n;
        ledger.holdFunds(userId, "USD", holdAmount, orderId);
      }
      holds += 1;

      const order = {
        id: orderId,
        sequence: ++sequence,
        traderId: userId,
        side,
        type: isLimit ? "LIMIT" : "MARKET",
        price,
        quantity,
        filledQuantity: 0n,
        timestamp: i,
        timeInForce: isLimit ? (rng() < 0.75 ? "GTC" : "IOC") : "IOC",
        status: "NEW",
      };

      const res = engine.processOrder(order);
      const { paidQuote, filledBase } = settleAndTrack(res, orderId);
      const remaining = quantity - filledBase;

      if (res.remainingOrder !== null) {
        // Descansa en el libro: la retención permanece.
        alive.set(orderId, { userId, side, price });
      } else {
        // No descansa (fill total, MARKET o IOC): liberar el exceso.
        if (side === "SELL") {
          ledger.releaseFunds(userId, "BTC", remaining, orderId);
        } else {
          const excess = holdAmount - paidQuote;
          assert.ok(excess >= 0n, `exceso negativo en ${orderId}`);
          ledger.releaseFunds(userId, "USD", excess, orderId);
        }
      }
    }

    // ── 3. Auditoría Global de Partida Doble ─────────────────────────
    const audit = ledger.audit();
    assert.equal(
      audit.unbalancedTransactions,
      0,
      "ninguna transacción puede quedar descuadrada",
    );
    assert.equal(
      audit.memoryMismatches,
      0,
      `la memoria debe coincidir con el neto del journal por subcuenta: ` +
        JSON.stringify(audit.mismatchDetails, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)),
    );
    for (const { asset, balance, deposits } of audit.byAsset) {
      assert.equal(
        balance,
        deposits,
        `Σ balances (${asset}) debe igualar Σ depósitos iniciales`,
      );
      assert.equal(
        deposits,
        expectedDeposits[asset],
        `depósitos de ${asset} deben coincidir con la configuración`,
      );
    }

    // ── 4. Overspend: la transacción falla y nada cambia ─────────────
    const victim = "user-0";
    const stringifyAudit = (a) =>
      JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    const beforeBalance = ledger.balanceOf(victim, "USD", "AVAILABLE");
    const beforeAudit = stringifyAudit(ledger.audit());
    const beforeRows = db
      .prepare("SELECT COUNT(*) AS c FROM journal_entries")
      .get().c;

    assert.throws(
      () => ledger.holdFunds(victim, "USD", beforeBalance + 1n, "o-overspend"),
      (err) =>
        err instanceof BalanceOverflowError &&
        /insuficientes/.test(err.message),
      "overspend debe lanzar BalanceOverflowError",
    );

    assert.equal(
      ledger.balanceOf(victim, "USD", "AVAILABLE"),
      beforeBalance,
      "overspend no debe alterar saldos",
    );
    assert.equal(
      stringifyAudit(ledger.audit()),
      beforeAudit,
      "overspend no debe alterar la auditoría",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM journal_entries").get().c,
      beforeRows,
      "overspend no debe escribir asientos",
    );

    // ── 5. Comisiones Maker/Taker → FEE_VAULT (prueba aislada) ───────
    feeDb = openDatabase(path.join(tmpDir, "fee.db"));
    const feeLedger = new SettlementLedger(feeDb, {
      baseAsset: "BTC",
      quoteAsset: "USD",
      makerFeeBps: 2,
      takerFeeBps: 5,
    });
    feeLedger.deposit("seller", "BTC", 1_000n);
    feeLedger.deposit("buyer", "USD", 1_000_000n);
    feeLedger.holdFunds("seller", "BTC", 100n, "fs-1");
    // principal = 100 × 100 = 10,000 USD; takerFee = 10,000 × 5 / 10,000 = 5.
    feeLedger.holdFunds("buyer", "USD", 10_005n, "fb-1");
    feeLedger.settleTrade({
      matchId: "m-fee-1",
      makerOrderId: "fs-1",
      takerOrderId: "fb-1",
      price: 100n,
      quantity: 100n,
      timestamp: 1,
    });

    assert.equal(feeLedger.balanceOf("seller", "BTC", "AVAILABLE"), 900n);
    assert.equal(feeLedger.balanceOf("buyer", "BTC", "AVAILABLE"), 100n);
    // Vendedor recibe principal − makerFee = 10,000 − 2 = 9,998.
    assert.equal(feeLedger.balanceOf("seller", "USD", "AVAILABLE"), 9_998n);
    // Comprador: 1,000,000 − 10,005 = 989,995.
    assert.equal(feeLedger.balanceOf("buyer", "USD", "AVAILABLE"), 989_995n);
    // Bóveda: makerFee (2) + takerFee (5) = 7.
    assert.equal(feeLedger.balanceOf("system", "USD", "FEE_VAULT"), 7n);

    const feeAudit = feeLedger.audit();
    assert.equal(feeAudit.unbalancedTransactions, 0);
    assert.equal(feeAudit.memoryMismatches, 0);

    // ── Reporte ───────────────────────────────────────────────────────
    const journalRows = db
      .prepare("SELECT COUNT(*) AS c FROM journal_entries")
      .get().c;
    console.log("════ SPRINT 03 · Double-Entry Settlement Ledger ════");
    console.log(`Usuarios ............. ${USERS} (depósitos USD ${expectedDeposits.USD}n · BTC ${expectedDeposits.BTC}n)`);
    console.log(`Operaciones .......... ${TOTAL_OPS} (holds ${holds} · cancelaciones ${cancels} · trades liquidados ${tradesSettled})`);
    console.log(`Asientos persistidos . ${journalRows} filas en journal_entries`);
    console.log("── Auditoría Global de Partida Doble ──");
    console.log(`  Transacciones descuadradas ... ${audit.unbalancedTransactions} ✓`);
    console.log(`  Divergencias memoria↔journal . ${audit.memoryMismatches} ✓`);
    for (const { asset, balance, deposits } of audit.byAsset) {
      console.log(
        `  ${asset.padEnd(4)} Σ balances ${balance}n == Σ depósitos ${deposits}n ✓`,
      );
    }
    console.log("── Overspend ──");
    console.log(`  hold > disponible ........... BalanceOverflowError ✓`);
    console.log(`  Estado previo intacto ....... saldos + auditoría + asientos ✓`);
    console.log("── Comisiones Maker/Taker ──");
    console.log(`  FEE_VAULT ................... 7n USD (maker 2n + taker 5n) ✓`);
    console.log("════════════════════════════════════════════════════");

    return { audit, tradesSettled, cancels, journalRows };
  } finally {
    if (db !== null) {
      db.close();
    }
    if (feeDb !== null) {
      feeDb.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Entry point ──────────────────────────────────────────────────────

try {
  main();
  console.log("✅ SPRINT 03 · TODAS LAS VERIFICACIONES PASARON (0 descuadres)");
} catch (err) {
  console.error("❌ SPRINT 03 FALLÓ:");
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
}
