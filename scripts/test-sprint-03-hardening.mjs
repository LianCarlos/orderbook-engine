/**
 * SPRINT 03.5 — Hardening & Pipeline Unification · Estrés y fallas
 * ─────────────────────────────────────────────────────────────────────
 * qa-tester · Node puro (node:assert/strict), sin frameworks ni deps.
 * Ejecuta con:  node scripts/test-sprint-03-hardening.mjs   (Node >= 24)
 *
 * Prueba 1 · Inyección de error contable:
 *   Taker sin saldo para pagar la comisión en medio de un calce → la
 *   transacción SQL completa se revierte, el WAL no registra el trade
 *   y los saldos del Maker quedan intactos.
 *
 * Prueba 2 · Snapshot anchor failure:
 *   wal_anchor_hash alterado en SQLite → replayState detecta el
 *   desacoplamiento, descarta el snapshot y reconstruye desde el WAL
 *   histórico (replay limpio desde 0).
 *
 * Prueba 3 · Latencia estable:
 *   20,000 órdenes transaccionadas (WAL + Engine + Ledger); el P99 no
 *   debe mostrar picos de GC (criterio relativo robusto).
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
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
const { WalLogger } = await import("../src/storage/wal.ts");
const { SettlementLedger, BalanceOverflowError } = await import(
  "../src/ledger/ledger.ts"
);
const { MatchingEngine } = await import("../src/engine/matching.ts");
const { ExecutionPipeline } = await import("../src/engine/pipeline.ts");
const { replayState } = await import("../src/storage/replay.ts");
const { takeSnapshot } = await import("../src/storage/snapshot.ts");

// ── Helpers ───────────────────────────────────────────────────────────

function createRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000; // [0, 1)
  };
}

function makeOrder(id, side, type, price, quantity, tif, traderId, seq) {
  return {
    id,
    sequence: BigInt(seq),
    traderId,
    side,
    type,
    price,
    quantity,
    filledQuantity: 0n,
    timestamp: Number(seq),
    timeInForce: tif,
    status: "NEW",
  };
}

/** Canónico del libro: órdenes vivas + profundidad + agregados. */
function buildCanonical(engineState, emittedIds) {
  const orders = [];
  for (const id of emittedIds) {
    const o = engineState.getOrder(id);
    if (o !== null) {
      orders.push({
        id: o.id,
        side: o.side,
        type: o.type,
        price: o.price,
        quantity: o.quantity,
        filledQuantity: o.filledQuantity,
        sequence: o.sequence,
        timeInForce: o.timeInForce,
        status: o.status,
      });
    }
  }
  orders.sort((a, b) => a.id.localeCompare(b.id));

  const depthBy = new Map();
  for (const o of orders) {
    const remaining = o.quantity - o.filledQuantity;
    const level =
      depthBy.get(`${o.side}|${o.price}`) ??
      { side: o.side, price: o.price, volume: 0n };
    level.volume += remaining;
    depthBy.set(`${o.side}|${o.price}`, level);
  }
  const levels = [...depthBy.values()]
    .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0))
    .map((l) => ({ side: l.side, price: l.price, volume: l.volume }));

  return {
    orders,
    levels,
    bestBid: engineState.bestBid,
    bestAsk: engineState.bestAsk,
    totalVolume: engineState.totalVolume,
  };
}

function stableStringify(value) {
  if (typeof value === "bigint") {
    return `"${value.toString()}n"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stringifyAudit(a) {
  return JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

// ── Motor del experimento ────────────────────────────────────────────

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orderbook-sprint035-"));
  const dbs = [];

  try {
    // ═══ Prueba 1 · Inyección de error contable ═══════════════════
    const db1 = openDatabase(path.join(tmpDir, "atomic.db"));
    dbs.push(db1);
    const logger1 = new WalLogger(db1);
    const ledger1 = new SettlementLedger(db1, {
      baseAsset: "BTC",
      quoteAsset: "USD",
      makerFeeBps: 0,
      takerFeeBps: 5, // 5 puntos básicos: la comisión que el taker no podrá pagar
    });
    const engine1 = new MatchingEngine();
    const pipeline1 = new ExecutionPipeline(db1, engine1, logger1, ledger1, {
      baseAsset: "BTC",
      quoteAsset: "USD",
    });

    ledger1.deposit("maker", "BTC", 1_000n);
    ledger1.deposit("taker", "USD", 1_000_000n);

    // Maker descansa: SELL 100 @ 100 (GTC) con hold de 100 BTC.
    pipeline1.executeOrder(
      makeOrder("m-1", "SELL", "LIMIT", 100n, 100n, "GTC", "maker", 1),
    );

    const before = {
      walRows: count(db1, "events_log"),
      journalRows: count(db1, "journal_entries"),
      settledRows: count(db1, "settled_trades"),
      makerLocked: ledger1.balanceOf("maker", "BTC", "LOCKED"),
      makerAvailable: ledger1.balanceOf("maker", "BTC", "AVAILABLE"),
      takerAvailable: ledger1.balanceOf("taker", "USD", "AVAILABLE"),
      audit: stringifyAudit(ledger1.audit()),
    };

    // Taker BUY LIMIT 100 @ 100 qty 100: principal 10,000 + takerFee 5
    // = 10,005; el hold inyectado cubre solo el principal.
    assert.throws(
      () =>
        pipeline1.executeOrder(
          makeOrder("t-1", "BUY", "LIMIT", 100n, 100n, "IOC", "taker", 2),
          { holdAmount: 10_000n },
        ),
      (err) => err instanceof BalanceOverflowError,
      "la comisión impagable debe lanzar BalanceOverflowError",
    );

    // Reversión TOTAL: WAL, journal y settled_trades sin cambios.
    assert.equal(count(db1, "events_log"), before.walRows,
      "el WAL no debe registrar la orden fallida ni el trade");
    assert.equal(count(db1, "journal_entries"), before.journalRows,
      "el journal no debe registrar asientos del intento fallido");
    assert.equal(count(db1, "settled_trades"), before.settledRows,
      "no debe persistirse la liquidación fallida");

    // Saldos intactos.
    assert.equal(ledger1.balanceOf("maker", "BTC", "LOCKED"), before.makerLocked);
    assert.equal(ledger1.balanceOf("maker", "BTC", "AVAILABLE"), before.makerAvailable);
    assert.equal(ledger1.balanceOf("taker", "USD", "AVAILABLE"), before.takerAvailable);
    assert.equal(stringifyAudit(ledger1.audit()), before.audit,
      "la auditoría del ledger debe ser idéntica a la previa");

    // Motor en RAM restaurado.
    const makerAfter = engine1.getOrder("m-1");
    assert.notEqual(makerAfter, null);
    assert.equal(makerAfter.status, "NEW");
    assert.equal(makerAfter.filledQuantity, 0n);
    assert.equal(engine1.bestAsk, 100n);
    assert.equal(engine1.totalVolume, 100n);

    // Regresión del logger tras el rollback: la siguiente orden debe
    // continuar la hash chain sin huecos ni eslabones fantasma.
    assert.equal(logger1.lastSequence, 1n, "sin huecos de secuencia tras el rollback");
    pipeline1.executeOrder(
      makeOrder("t-2", "BUY", "LIMIT", 99n, 1n, "IOC", "taker", 3),
    );
    assert.equal(logger1.lastSequence, 2n, "la orden posterior al rollback toma la secuencia 2");
    const freshAfterRollback = new MatchingEngine();
    const replayAfterRollback = replayState(db1, freshAfterRollback);
    assert.equal(
      replayAfterRollback.replayedEvents,
      Number(logger1.lastSequence),
      "replay íntegro tras el rollback (cadena sin roturas)",
    );
    assert.notEqual(
      freshAfterRollback.getOrder("m-1"),
      null,
      "el estado reconstruido contiene al maker original",
    );

    // ═══ Prueba 2 · Snapshot anchor failure ════════════════════════
    const db2 = openDatabase(path.join(tmpDir, "anchor.db"));
    dbs.push(db2);
    const logger2 = new WalLogger(db2);
    const ledger2 = new SettlementLedger(db2, {
      baseAsset: "BTC",
      quoteAsset: "USD",
    });
    let engine2 = new MatchingEngine();
    const pipeline2 = new ExecutionPipeline(db2, engine2, logger2, ledger2, {
      baseAsset: "BTC",
      quoteAsset: "USD",
    });

    ledger2.deposit("user-0", "USD", 1_000_000_000n);
    ledger2.deposit("user-0", "BTC", 1_000_000n);

    const rng2 = createRng(0x0a2c3e);
    const emittedIds = [];
    const TOTAL = 200;
    for (let i = 1; i <= TOTAL; i++) {
      const id = `o-${i}`;
      const side = rng2() < 0.5 ? "BUY" : "SELL";
      const price = 95n + BigInt(Math.floor(rng2() * 11));
      const quantity = 1n + BigInt(Math.floor(rng2() * 10));
      const order = makeOrder(
        id, side, "LIMIT", price, quantity,
        rng2() < 0.75 ? "GTC" : "IOC", "user-0", i,
      );
      emittedIds.push(id);
      pipeline2.executeOrder(order);
    }
    const lastSeq = logger2.lastSequence;
    // El WAL del pipeline registra ORDER_NEW + TRADE_MATCH: la
    // secuencia final es el total de eventos (órdenes + trades).
    assert.ok(
      lastSeq >= BigInt(TOTAL),
      `el WAL debe contener al menos ${TOTAL} eventos, tiene ${lastSeq}`,
    );
    assert.equal(lastSeq, BigInt(count(db2, "events_log")));

    const snapshotId = takeSnapshot(engine2, db2, lastSeq);
    const control = stableStringify(buildCanonical(engine2, emittedIds));

    // Tamper del ancla: nuevo anchor falso + state_hash recalculado
    // (el snapshot queda internamente íntegro pero desacoplado del WAL).
    const row = db2
      .prepare("SELECT last_sequence, state_data FROM snapshots WHERE snapshot_id = ?")
      .get(snapshotId);
    const fakeAnchor = "f".repeat(64);
    const fakeStateHash = createHash("sha256")
      .update(fakeAnchor + String(row.last_sequence) + row.state_data)
      .digest("hex");
    db2
      .prepare(
        "UPDATE snapshots SET wal_anchor_hash = ?, state_hash = ? WHERE snapshot_id = ?",
      )
      .run(fakeAnchor, fakeStateHash, snapshotId);

    engine2 = null;
    const freshEngine = new MatchingEngine();
    const replayResult = replayState(db2, freshEngine);
    assert.equal(
      replayResult.recovery,
      "clean",
      "el snapshot desacoplado debe forzar replay limpio desde 0",
    );
    assert.ok(
      replayResult.fallbackReason !== null &&
        replayResult.fallbackReason.startsWith("anchor_mismatch"),
      `fallbackReason debe indicar anchor_mismatch: ${replayResult.fallbackReason}`,
    );
    assert.equal(replayResult.replayedEvents, Number(lastSeq));
    assert.equal(
      stableStringify(buildCanonical(freshEngine, emittedIds)),
      control,
      "el estado reconstruido desde el WAL histórico debe ser bit a bit idéntico",
    );

    // ═══ Prueba 3 · Latencia estable ════════════════════════════════
    const db3 = openDatabase(path.join(tmpDir, "latency.db"));
    dbs.push(db3);
    const logger3 = new WalLogger(db3);
    const ledger3 = new SettlementLedger(db3, {
      baseAsset: "BTC",
      quoteAsset: "USD",
    });
    const engine3 = new MatchingEngine();
    const pipeline3 = new ExecutionPipeline(db3, engine3, logger3, ledger3, {
      baseAsset: "BTC",
      quoteAsset: "USD",
    });

    for (let u = 0; u < 1_000; u++) {
      ledger3.deposit(`user-${u}`, "USD", 10_000_000n);
      ledger3.deposit(`user-${u}`, "BTC", 100_000n);
    }

    const rng3 = createRng(0x0d15ea5e);
    const latencies = [];
    const LATENCY_OPS = 20_000;
    for (let i = 1; i <= LATENCY_OPS; i++) {
      const side = rng3() < 0.5 ? "BUY" : "SELL";
      const isLimit = rng3() < 0.85;
      const price = 95n + BigInt(Math.floor(rng3() * 11));
      const quantity = 1n + BigInt(Math.floor(rng3() * 10));
      const user = `user-${Math.floor(rng3() * 1_000)}`;
      const order = makeOrder(
        `p3-${i}`, side, isLimit ? "LIMIT" : "MARKET", price, quantity,
        isLimit ? (rng3() < 0.75 ? "GTC" : "IOC") : "IOC", user, i,
      );
      const t0 = performance.now();
      pipeline3.executeOrder(order);
      latencies.push(performance.now() - t0);
    }

    latencies.sort((a, b) => a - b);
    const percentile = (q) => latencies[Math.floor(LATENCY_OPS * q) - 1];
    const p50 = percentile(0.5);
    const p99 = percentile(0.99);
    const p999 = percentile(0.999);
    const max = latencies[LATENCY_OPS - 1];

    // Criterio de colas patológicas (detección de picos de GC): la
    // latencia base está dominada por el fsync de cada transacción
    // SQLite; un GC pause severo dispara exponencialmente la cola.
    assert.ok(
      p999 <= Math.max(12 * p99, 5.0),
      `P99.9 con pico de GC: ${p999.toFixed(3)} ms vs 12×P99=${(12 * p99).toFixed(3)} ms`,
    );
    assert.ok(
      max <= Math.max(30 * p99, 10.0),
      `máximo con pico de GC: ${max.toFixed(3)} ms vs 30×P99=${(30 * p99).toFixed(3)} ms`,
    );

    const audit3 = ledger3.audit();
    assert.equal(audit3.unbalancedTransactions, 0);
    assert.equal(audit3.memoryMismatches, 0);

    // ── Reporte ───────────────────────────────────────────────────────
    console.log("════ SPRINT 03.5 · Hardening & Pipeline Unification ════");
    console.log("── Prueba 1 · Inyección de error contable ──");
    console.log(`  Excepción ............... BalanceOverflowError ✓`);
    console.log(`  WAL sin trazas ......... events_log ${before.walRows} filas (sin cambios) ✓`);
    console.log(`  Journal sin trazas ..... ${before.journalRows} filas (sin cambios) ✓`);
    console.log(`  settled_trades ......... ${before.settledRows} filas (sin cambios) ✓`);
    console.log(`  Saldos del Maker ....... LOCKED ${before.makerLocked}n intacto ✓`);
    console.log(`  Motor en RAM ........... restaurado (bestAsk=100, vol=100) ✓`);
    console.log(`  Hash chain tras rollback  secuencia 2 + replay íntegro ✓`);
    console.log("── Prueba 2 · Snapshot anchor failure ──");
    console.log(`  Ancla alterada ......... ${fakeAnchor.slice(0, 8)}… (recalculado state_hash)`);
    console.log(`  Detección .............. ${replayResult.fallbackReason.slice(0, 60)}…`);
    console.log(`  Fallback ............... replay limpio desde 0 (${lastSeq} eventos) ✓`);
    console.log(`  Estado reconstruido .... bit a bit idéntico ✓`);
    console.log("── Prueba 3 · Latencia estable ──");
    console.log(
      `  Órdenes transaccionadas  ${LATENCY_OPS} (WAL + Engine + Ledger en 1 transacción c/u)`,
    );
    console.log(
      `  Latencia ............... P50=${p50.toFixed(3)} ms · P99=${p99.toFixed(3)} ms · ` +
        `P99.9=${p999.toFixed(3)} ms · max=${max.toFixed(3)} ms`,
    );
    console.log(`  Varianza plana ......... P99.9 ≤ 12×P99 ✓ · max ≤ 30×P99 ✓`);
    console.log(`  Auditoría ledger ....... 0 descuadres ✓`);
    console.log("══════════════════════════════════════════════════════");

    return { before, replayResult, latencies: { p50, p99, p999, max } };
  } finally {
    for (const db of dbs) {
      db.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Entry point ──────────────────────────────────────────────────────

try {
  main();
  console.log("✅ SPRINT 03.5 · TODAS LAS VERIFICACIONES PASARON");
} catch (err) {
  console.error("❌ SPRINT 03.5 FALLÓ:");
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
}
