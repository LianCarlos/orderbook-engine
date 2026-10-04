/**
 * SPRINT 02.5 — Hardening & Security · Hash Chain WAL + Engine Snapshotting
 * ─────────────────────────────────────────────────────────────────────
 * qa-tester · Node puro (node:assert/strict), sin frameworks ni deps.
 * Ejecuta con:  node scripts/test-sprint-02-hardening.mjs   (Node >= 24)
 *
 * Prueba 1 · Fast Recovery:
 *   20,000 eventos con hash chain SHA-256; snapshot a los 15,000.
 *   Crash simulado y medición: snapshot + delta debe ser al menos 3x
 *   más rápido que el replay completo, con estado bit a bit idéntico.
 *
 * Prueba 2 · Tamper Detection:
 *   UPDATE malicioso directo sobre el payload de la fila 500.
 *   El replay debe lanzar WalCorruptionError con la secuencia exacta
 *   alterada y ABORTAR la restauración.
 *
 * Nota de resolución de módulos: patrón del repo (test-sprint-02.mjs):
 * registerHooks añade `.ts` a specifiers relativos sin extensión.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Hook de resolución: "./x" → "./x.ts" (solo specifiers relativos) ──
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
const { replayState, WalCorruptionError, SnapshotCorruptionError } = await import(
  "../src/storage/replay.ts"
);
const { takeSnapshot } = await import("../src/storage/snapshot.ts");
const { MatchingEngine } = await import("../src/engine/matching.ts");

// ── Configuración del experimento ────────────────────────────────────

const TOTAL_EVENTS = 20_000;
const SNAPSHOT_AT = 15_000;
const BATCH_SIZE = 128;
const MIN_SPEEDUP = 3; // Prueba 1: snapshot + delta ≥ 3x más rápido

/** PRNG LCG determinista (Numerical Recipes, 32-bit). */
function createRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000; // [0, 1)
  };
}

/** Borrador de orden determinista. `sequence` la asigna el WalLogger. */
function createOrderDraft(id, side, type, price, quantity, tif, timestamp) {
  return {
    id,
    sequence: 0n,
    traderId: "trader-1",
    side,
    type,
    price,
    quantity,
    filledQuantity: 0n,
    timestamp,
    timeInForce: tif,
    status: "NEW",
  };
}

// ── Snapshot canónico del libro ──────────────────────────────────────

function pickOrderFields(o) {
  return {
    id: o.id,
    side: o.side,
    type: o.type,
    price: o.price,
    quantity: o.quantity,
    filledQuantity: o.filledQuantity,
    sequence: o.sequence,
    timeInForce: o.timeInForce,
    status: o.status,
  };
}

function buildCanonical(engineState, expectedLiveIds, allEmittedIds) {
  const orders = [];
  for (const id of allEmittedIds) {
    const o = engineState.getOrder(id);
    if (expectedLiveIds.has(id)) {
      assert.notEqual(o, null, `orden esperada viva ausente: ${id}`);
      orders.push(pickOrderFields(o));
    } else {
      assert.equal(o, null, `orden no esperada sigue viva: ${id}`);
    }
  }

  const depthBy = new Map();
  for (const o of orders) {
    const remaining = o.quantity - o.filledQuantity;
    const level =
      depthBy.get(`${o.side}|${o.price}`) ??
      { side: o.side, price: o.price, volume: 0n, count: 0 };
    level.volume += remaining;
    level.count += 1;
    depthBy.set(`${o.side}|${o.price}`, level);
  }
  const bySide = (side) =>
    [...depthBy.values()]
      .filter((l) => l.side === side)
      .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0))
      .map((l) => ({ price: l.price, volume: l.volume, count: l.count }));

  const bids = bySide("BUY").reverse(); // mayor bid primero
  const asks = bySide("SELL"); // menor ask primero

  // Nota: el histórico de trades en RAM no forma parte del estado
  // capturado por el snapshot (fuente de verdad: WAL); la continuidad
  // determinista se valida aparte vía _matchCounter.
  return {
    orders,
    bids,
    asks,
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

// ── Motor del experimento ────────────────────────────────────────────

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orderbook-sprint025-"));
  const dbFullPath = path.join(tmpDir, "wal-full.db");
  const dbSnapPath = path.join(tmpDir, "wal-snap.db");
  let dbFull = null;
  let dbSnap = null;

  try {
    dbFull = openDatabase(dbFullPath);
    dbSnap = openDatabase(dbSnapPath);
    const loggerFull = new WalLogger(dbFull);
    const loggerSnap = new WalLogger(dbSnap);
    const rng = createRng(0x51a7a57);
    let engineFull = new MatchingEngine();
    let engineSnap = new MatchingEngine();

    const liveIds = new Map(); // id → orden viva conocida (reflejo del libro)
    const emittedIds = []; // todos los ids de órdenes emitidas

    /** Aplica un evento persistido a un motor en vivo. */
    function applyLive(engine, ev, sequence) {
      if (ev.type === "ORDER_NEW") {
        ev.order.sequence = sequence;
        const res = engine.processOrder(ev.order);
        for (const t of res.trades) {
          if (engine.getOrder(t.makerOrderId) === null) {
            liveIds.delete(t.makerOrderId);
          }
        }
        if (res.remainingOrder !== null) {
          liveIds.set(res.remainingOrder.id, res.remainingOrder);
        }
      } else {
        engine.cancelOrder(ev.payload.orderId);
        liveIds.delete(ev.payload.orderId);
      }
    }

    /** Flush atómico idéntico en ambas DBs + ambos motores. */
    function flushBatch(batch) {
      const mapped = batch.map((ev) => ({ type: ev.type, payload: ev.payload }));
      const lastFull = loggerFull.appendBatch(mapped);
      const lastSnap = loggerSnap.appendBatch(mapped);
      assert.equal(lastFull, lastSnap, "secuencias alineadas entre DBs");
      const firstSeq = lastFull - BigInt(batch.length - 1);
      for (let i = 0; i < batch.length; i++) {
        const seq = firstSeq + BigInt(i);
        applyLive(engineFull, batch[i], seq);
        applyLive(engineSnap, batch[i], seq);
      }
    }

    // ── Generación determinista de 20,000 operaciones ────────────────
    const pending = [];
    for (let i = 1; i <= TOTAL_EVENTS; i++) {
      const id = `order-${String(i).padStart(6, "0")}`;
      const roll = rng();
      const side = rng() < 0.5 ? "BUY" : "SELL";
      const price = 95n + BigInt(Math.floor(rng() * 11)); // 95..105
      const quantity = 1n + BigInt(Math.floor(rng() * 10)); // 1..10

      if (roll < 0.55) {
        const order = createOrderDraft(
          id, side, "LIMIT", price, quantity,
          rng() < 0.75 ? "GTC" : "IOC", i,
        );
        emittedIds.push(id);
        pending.push({ type: "ORDER_NEW", order, payload: order });
      } else if (roll < 0.75) {
        const order = createOrderDraft(id, side, "MARKET", 100n, quantity, "IOC", i);
        emittedIds.push(id);
        pending.push({ type: "ORDER_NEW", order, payload: order });
      } else if (liveIds.size > 0) {
        const liveList = [...liveIds.keys()];
        const target = liveList[Math.floor(rng() * liveList.length)];
        pending.push({ type: "ORDER_CANCEL", order: null, payload: { orderId: target } });
      } else {
        const order = createOrderDraft(id, side, "LIMIT", price, quantity, "GTC", i);
        emittedIds.push(id);
        pending.push({ type: "ORDER_NEW", order, payload: order });
      }

      if (pending.length === BATCH_SIZE) {
        flushBatch(pending.splice(0, BATCH_SIZE));
      }

      // Snapshot exactamente tras el evento 15,000 (flush parcial atómico).
      if (i === SNAPSHOT_AT) {
        if (pending.length > 0) {
          flushBatch(pending.splice(0, pending.length));
        }
        assert.equal(loggerSnap.lastSequence, BigInt(SNAPSHOT_AT));
        const snapshotId = takeSnapshot(engineSnap, dbSnap, BigInt(SNAPSHOT_AT));
        // Retención: solo los últimos 3 snapshots sobreviven.
        for (let k = 0; k < 4; k++) {
          takeSnapshot(engineSnap, dbSnap, BigInt(SNAPSHOT_AT));
        }
        const snapCount = dbSnap
          .prepare("SELECT COUNT(*) AS c FROM snapshots")
          .get().c;
        assert.equal(snapCount, 3, "solo deben retenerse los últimos 3 snapshots");
        assert.ok(snapshotId.length > 0, "takeSnapshot devuelve un id");
      }
    }
    if (pending.length > 0) {
      flushBatch(pending);
    }

    assert.equal(loggerFull.lastSequence, BigInt(TOTAL_EVENTS));
    assert.equal(loggerSnap.lastSequence, BigInt(TOTAL_EVENTS));

    // ── Snapshot de control del libro en vivo ────────────────────────
    const expectedLive = new Set(liveIds.keys());
    const controlFull = buildCanonical(engineFull, expectedLive, emittedIds);
    const controlSnap = buildCanonical(engineSnap, expectedLive, emittedIds);
    assert.equal(
      stableStringify(controlFull),
      stableStringify(controlSnap),
      "ambos motores vivos deben ser idénticos",
    );
    const controlMatchCounter = engineFull._matchCounter;
    const controlTradeCount = engineFull.trades.length;

    // ── Crash: ambos motores se destruyen ────────────────────────────
    engineFull = null;
    engineSnap = null;

    // ── Prueba 1 · Fast Recovery ─────────────────────────────────────
    const freshFull = new MatchingEngine();
    const t0 = performance.now();
    const fullResult = replayState(dbFull, freshFull);
    const tFull = performance.now() - t0;
    assert.equal(fullResult.replayedEvents, TOTAL_EVENTS);

    const freshSnap = new MatchingEngine();
    const t1 = performance.now();
    const snapResult = replayState(dbSnap, freshSnap);
    const tSnap = performance.now() - t1;
    assert.equal(
      snapResult.replayedEvents,
      TOTAL_EVENTS - SNAPSHOT_AT,
      "con snapshot solo se re-aplica el delta",
    );

    const canonicalFull = stableStringify(
      buildCanonical(freshFull, expectedLive, emittedIds),
    );
    const canonicalSnap = stableStringify(
      buildCanonical(freshSnap, expectedLive, emittedIds),
    );
    assert.equal(
      canonicalFull,
      canonicalSnap,
      "replay completo y snapshot+delta reconstruyen el mismo estado",
    );
    assert.equal(
      canonicalFull,
      stableStringify(controlFull),
      "estado reconstruido debe ser bit a bit idéntico al control",
    );
    // Continuidad determinista: el matchCounter restaurado por el
    // snapshot debe coincidir con el del replay completo (sin reusar
    // matchIds).
    assert.equal(
      freshSnap._matchCounter,
      controlMatchCounter,
      "matchCounter restaurado debe continuar sin colisiones",
    );
    assert.equal(freshFull._matchCounter, controlMatchCounter);

    const speedup = tFull / tSnap;
    assert.ok(
      speedup >= MIN_SPEEDUP,
      `fast recovery ${speedup.toFixed(2)}x < umbral ${MIN_SPEEDUP}x ` +
        `(completo=${tFull.toFixed(2)} ms, snapshot+delta=${tSnap.toFixed(2)} ms)`,
    );

    // ── Prueba 2 · Tamper Detection ──────────────────────────────────
    const victim = dbFull
      .prepare("SELECT payload FROM events_log WHERE sequence = 500")
      .get();
    assert.ok(victim, "la fila 500 existe");
    // UPDATE malicioso: altera el payload sin recalcular el hash.
    dbFull
      .prepare("UPDATE events_log SET payload = ? WHERE sequence = 500")
      .run(`${victim.payload} `);

    let corruption = null;
    try {
      replayState(dbFull, new MatchingEngine());
      throw new Error("el replay debió ABORTAR por corrupción");
    } catch (err) {
      corruption = err;
    }
    assert.ok(
      corruption instanceof WalCorruptionError,
      `esperaba WalCorruptionError, recibí ${
        corruption?.constructor?.name ?? String(corruption)
      }`,
    );
    assert.equal(
      corruption.sequence,
      500n,
      "la detección debe señalar la secuencia exacta alterada",
    );

    // ── Prueba 2b · Snapshot Tamper Detection (H1) ───────────────────
    dbSnap.prepare("UPDATE snapshots SET state_data = state_data || ' '").run();
    let snapCorruption = null;
    try {
      replayState(dbSnap, new MatchingEngine());
      throw new Error("el replay debió ABORTAR por snapshot corrupto");
    } catch (err) {
      snapCorruption = err;
    }
    assert.ok(
      snapCorruption instanceof SnapshotCorruptionError,
      `esperaba SnapshotCorruptionError, recibí ${
        snapCorruption?.constructor?.name ?? String(snapCorruption)
      }`,
    );

    // ── Reporte ───────────────────────────────────────────────────────
    const depthSummary = {
      bidsLevels: controlFull.bids.length,
      asksLevels: controlFull.asks.length,
      liveOrders: controlFull.orders.length,
      trades: controlTradeCount,
    };

    console.log("════ SPRINT 02.5 · Hardening & Security ════");
    console.log(
      `Eventos generados ..... ${TOTAL_EVENTS} (hash chain SHA-256 en ambas DBs)`,
    );
    console.log(`Snapshot .............. sequence ${SNAPSHOT_AT} (retención 3 ✓)`);
    console.log("── Prueba 1 · Fast Recovery ──");
    console.log(`  Replay completo ..... ${TOTAL_EVENTS} eventos en ${tFull.toFixed(2)} ms`);
    console.log(
      `  Snapshot + delta .... ${TOTAL_EVENTS - SNAPSHOT_AT} eventos en ${tSnap.toFixed(2)} ms`,
    );
    console.log(
      `  Speedup ............. ${speedup.toFixed(2)}x (umbral: ≥ ${MIN_SPEEDUP}x) ✓`,
    );
    console.log(`  Estado reconstruido . bit a bit idéntico ✓ (${depthSummary.liveOrders} órdenes vivas)`);
    console.log("── Prueba 2 · Tamper Detection ──");
    console.log(`  UPDATE malicioso .... payload de sequence 500 (sin recalcular hash)`);
    console.log(
      `  Detección ........... WalCorruptionError [${corruption.kind}] en sequence ${corruption.sequence} ✓`,
    );
    console.log(`  Mensaje ............. ${corruption.message}`);
    console.log("── Prueba 2b · Snapshot Tamper Detection (H1) ──");
    console.log(
      `  UPDATE malicioso .... state_data de todos los snapshots (sin recalcular state_hash)`,
    );
    console.log(
      `  Detección ........... SnapshotCorruptionError en ${snapCorruption.snapshotId} ✓`,
    );
    console.log(`  Mensaje ............. ${snapCorruption.message}`);
    console.log(
      `Profundidad ........... bids: ${depthSummary.bidsLevels} · asks: ${depthSummary.asksLevels} · trades: ${depthSummary.trades}`,
    );
    console.log("══════════════════════════════════════════════");

    return { tFull, tSnap, speedup, corruption, depthSummary };
  } finally {
    if (dbFull !== null) {
      dbFull.close();
    }
    if (dbSnap !== null) {
      dbSnap.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Entry point ──────────────────────────────────────────────────────

try {
  main();
  console.log("✅ SPRINT 02.5 · TODAS LAS VERIFICACIONES PASARON");
} catch (err) {
  console.error("❌ SPRINT 02.5 FALLÓ:");
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
}
