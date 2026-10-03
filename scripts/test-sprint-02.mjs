/**
 * SPRINT 02 — Test suite · WAL Persistence & State Replay
 * ─────────────────────────────────────────────────────────────────────
 * qa-tester · Node puro (node:assert/strict), sin frameworks ni deps.
 * Ejecuta con:  node scripts/test-sprint-02.mjs   (Node >= 24)
 *
 * Verifica el ciclo completo de crash recovery:
 *   1. 10,000 operaciones deterministas (LCG, sin Math.random) mezclando
 *      LIMIT (GTC/IOC), MARKET y CANCEL, persistidas en el WAL y
 *      aplicadas en vivo sobre un MatchingEngine.
 *   2. Snapshot canónico del libro (órdenes vivas + profundidad por
 *      nivel + trades + bestBid/bestAsk/totalVolume).
 *   3. "Crash": el motor se descarta y un motor virgen se reconstruye
 *      con replayState(db, freshEngine).
 *   4. El estado rejugado debe ser idéntico bit a bit al snapshot de
 *      control, y el replay de 10k eventos debe terminar en < 150 ms.
 *
 * Nota de resolución de módulos:
 * Los módulos de src/ importan specifiers relativos sin extensión
 * (`./queue`, `../core/types`), que Node ESM puro no resuelve. Se
 * registra el hook de resolución ANTES de cualquier import dinámico
 * (los imports estáticos se resolverían antes del register).
 *
 * Por qué no se usa el loader de tsx aquí: tsx v4 rechaza la vía
 * `register("tsx/esm")` desde node:module ("tsx must be loaded with
 * --import instead of --loader") y su API programática `tsx/esm/api`
 * obliga a cargar los .ts como CommonJS (el proyecto no declara
 * "type": "module"), lo que rompe los specifiers sin extensión vía
 * require(). Node 24 trae type stripping nativo de `.ts`, así que se
 * usa el mismo patrón oficial del repo (test-sprint-00/01.mjs):
 * `registerHooks` añadiendo `.ts` a specifiers relativos.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Hook de resolución: "./x" → "./x.ts" (solo specifiers relativos) ──
// También intercepta require() de paquetes CJS (ej. better-sqlite3), cuyo
// error de resolución es MODULE_NOT_FOUND (no ERR_MODULE_NOT_FOUND); en
// ambos casos se cae al resolver estándar sin tocar el specifier.
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
          // sin equivalente .ts → resolución estándar (que reportará el error)
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
const { replayState, ReplayError, UnknownEventTypeError } = await import(
  "../src/storage/replay.ts"
);
const { MatchingEngine } = await import("../src/engine/matching.ts");

// ── Configuración del experimento ────────────────────────────────────

const TOTAL_OPS = 10_000;
const BATCH_SIZE = 128; // 78 lotes atómicos + 16 eventos individuales
const REPLAY_BUDGET_MS = 150;

/**
 * PRNG LCG determinista (parámetros Numerical Recipes, 32-bit).
 * Math.imul + adición entera: cero Math.random en la lógica de datos.
 */
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

/** Campos del contrato de comparación (lista exacta del Sprint 02). */
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

/**
 * Objeto canónico del estado: órdenes vivas (solo las esperadas; si una
 * orden no esperada sigue viva o una esperada falta, assert falla),
 * profundidad agrupada por side+price (bids desc / asks asc), y datos
 * agregados. Determinista: mismo estado ⇒ misma estructura.
 */
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

  const trades = engineState.trades.map((t) => ({
    matchId: t.matchId,
    makerOrderId: t.makerOrderId,
    takerOrderId: t.takerOrderId,
    price: t.price,
    quantity: t.quantity,
    timestamp: t.timestamp,
  }));

  return {
    orders,
    bids,
    asks,
    bestBid: engineState.bestBid,
    bestAsk: engineState.bestAsk,
    totalVolume: engineState.totalVolume,
    trades,
  };
}

/**
 * Stringify canónico: claves ordenadas recursivamente y bigints
 * etiquetados con sufijo `n` (un number y un bigint con el mismo valor
 * jamás colisionan). Comparar dos snapshots = comparar estos strings.
 */
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orderbook-sprint02-"));
  const dbPath = path.join(tmpDir, "wal.db");
  let db = null;

  try {
    db = openDatabase(dbPath);
    const journalMode = db.pragma("journal_mode", { simple: true });
    assert.equal(journalMode, "wal", `journal_mode debe ser wal, fue: ${journalMode}`);

    const logger = new WalLogger(db);
    const rng = createRng(0x5eed02);
    let engine = new MatchingEngine();

    const liveIds = new Map(); // id → order viva conocida (seguimiento propio)
    const emittedIds = []; // todos los ids de órdenes emitidas (vivas o no)
    let batches = 0;
    let singles = 0;

    /**
     * Aplica un evento persistido al motor en vivo (mismo orden que el WAL)
     * y mantiene `liveIds` como reflejo EXACTO del libro del motor: una
     * orden deja de estar viva si un calce del propio lote la llena por
     * completo (el engine la desenlaza) o si un CANCEL la remueve. Sin
     * esta limpieza, el tracker queda con "fantasmas" y el snapshot de
     * control falla antes de llegar al replay.
     */
    function applyLive(ev, sequence) {
      if (ev.type === "ORDER_NEW") {
        ev.order.sequence = sequence;
        const res = engine.processOrder(ev.order);
        // Makers llenados por completo ya no están en el libro.
        for (const t of res.trades) {
          if (engine.getOrder(t.makerOrderId) === null) {
            liveIds.delete(t.makerOrderId);
          }
        }
        if (res.remainingOrder !== null) {
          liveIds.set(res.remainingOrder.id, res.remainingOrder);
        }
      } else {
        // Idempotente: tras un CANCEL la orden nunca sigue viva (si no
        // existía, el delete es un no-op sobre una entrada ya obsoleta).
        engine.cancelOrder(ev.payload.orderId);
        liveIds.delete(ev.payload.orderId);
      }
    }

    /** Flush atómico de un lote vía appendBatch (secuencias contiguas). */
    function flushBatch(batch) {
      const lastSeq = logger.appendBatch(
        batch.map((ev) => ({ type: ev.type, payload: ev.payload })),
      );
      const firstSeq = lastSeq - BigInt(batch.length - 1);
      for (let i = 0; i < batch.length; i++) {
        applyLive(batch[i], firstSeq + BigInt(i));
      }
      batches += 1;
    }

    /** Flush individual vía appendEvent. */
    function flushSingle(ev) {
      const sequence = logger.appendEvent(ev.type, ev.payload);
      applyLive(ev, sequence);
      singles += 1;
    }

    // ── 1. Generación determinista de 10,000 operaciones ──────────────
    const pending = [];
    const tGen = performance.now();

    for (let i = 1; i <= TOTAL_OPS; i++) {
      const id = `order-${String(i).padStart(6, "0")}`;
      const roll = rng();
      const side = rng() < 0.5 ? "BUY" : "SELL";
      const price = 95n + BigInt(Math.floor(rng() * 11)); // 95..105
      const quantity = 1n + BigInt(Math.floor(rng() * 10)); // 1..10

      if (roll < 0.55) {
        // LIMIT (GTC o IOC)
        const order = createOrderDraft(
          id,
          side,
          "LIMIT",
          price,
          quantity,
          rng() < 0.75 ? "GTC" : "IOC",
          i,
        );
        emittedIds.push(id);
        pending.push({ type: "ORDER_NEW", order, payload: order });
      } else if (roll < 0.75) {
        // MARKET (siempre IOC; el remanente nunca descansa)
        const order = createOrderDraft(id, side, "MARKET", 100n, quantity, "IOC", i);
        emittedIds.push(id);
        pending.push({ type: "ORDER_NEW", order, payload: order });
      } else if (liveIds.size > 0) {
        // CANCEL sobre una orden viva conocida
        const liveList = [...liveIds.keys()];
        const target = liveList[Math.floor(rng() * liveList.length)];
        pending.push({
          type: "ORDER_CANCEL",
          order: null,
          payload: { orderId: target },
        });
      } else {
        // Sin órdenes vivas que cancelar → LIMIT de relleno
        const order = createOrderDraft(id, side, "LIMIT", price, quantity, "GTC", i);
        emittedIds.push(id);
        pending.push({ type: "ORDER_NEW", order, payload: order });
      }

      if (pending.length === BATCH_SIZE) {
        flushBatch(pending.splice(0, BATCH_SIZE));
      }
    }
    for (const ev of pending) {
      flushSingle(ev);
    }
    const genMs = performance.now() - tGen;

    assert.equal(
      logger.lastSequence,
      BigInt(TOTAL_OPS),
      "última secuencia del WAL debe ser exactamente TOTAL_OPS",
    );
    assert.equal(
      logger.lastSequence,
      BigInt(batches * BATCH_SIZE + singles),
      "secuencias = lotes·BATCH_SIZE + individuales (contigüidad)",
    );

    // ── 2. Snapshot de control del libro en vivo ──────────────────────
    const expectedLive = new Set(liveIds.keys());
    const control = buildCanonical(engine, expectedLive, emittedIds);

    // Sanidad: totalVolume del motor = Σ remanente de las órdenes vivas.
    let liveRemaining = 0n;
    for (const o of control.orders) {
      liveRemaining += o.quantity - o.filledQuantity;
    }
    assert.equal(
      engine.totalVolume,
      liveRemaining,
      "totalVolume del motor debe coincidir con Σ remanente de órdenes vivas",
    );

    const canonicalControl = stableStringify(control);
    const depthSummary = {
      bidsLevels: control.bids.length,
      asksLevels: control.asks.length,
      liveOrders: control.orders.length,
      trades: control.trades.length,
    };

    // ── 3. "Crash": el motor en vivo se destruye ──────────────────────
    engine = null;
    assert.equal(engine, null, "motor descartado (simula crash)");

    // ── 4. Replay del WAL sobre un motor virgen ───────────────────────
    const freshEngine = new MatchingEngine();
    const { replayedEvents, durationMs } = replayState(db, freshEngine);
    assert.equal(
      replayedEvents,
      TOTAL_OPS,
      `replay debe reaplicar ${TOTAL_OPS} eventos, aplicó ${replayedEvents}`,
    );

    // ── 5. Comparación bit a bit contra el snapshot de control ────────
    const replayed = buildCanonical(freshEngine, expectedLive, emittedIds);
    const mismatched = [];
    for (const section of Object.keys(control)) {
      if (stableStringify(control[section]) !== stableStringify(replayed[section])) {
        mismatched.push(section);
      }
    }
    if (mismatched.length > 0) {
      throw new Error(
        `estado rejugado difiere del control en: ${mismatched.join(", ")}`,
      );
    }
    assert.equal(
      stableStringify(replayed),
      canonicalControl,
      "estado rejugado debe ser idéntico bit a bit al snapshot de control",
    );

    // ── 6. Umbral de rendimiento del replay ───────────────────────────
    const ordersPerSec = Math.round(TOTAL_OPS / (durationMs / 1000));
    if (durationMs >= REPLAY_BUDGET_MS) {
      throw new Error(
        `replay de ${TOTAL_OPS} eventos tardó ${durationMs.toFixed(2)} ms ` +
          `(umbral: < ${REPLAY_BUDGET_MS} ms)`,
      );
    }

    // ── 7. Reinicio real: un logger nuevo continúa desde la DB ────────
    const loggerAfterRestart = new WalLogger(db);
    const seqAfterRestart = loggerAfterRestart.appendEvent("ORDER_CANCEL", {
      orderId: "no-op",
    });
    assert.equal(
      seqAfterRestart,
      BigInt(TOTAL_OPS + 1),
      "tras reinicio, la secuencia continúa en TOTAL_OPS + 1",
    );

    // ── 8. Errores tipados (sin crash silencioso) ─────────────────────
    const badDb = openDatabase(path.join(tmpDir, "bad.db"));
    badDb
      .prepare("INSERT INTO events_log (sequence, event_type, payload) VALUES (1, 'BOGUS', '{}')")
      .run();
    assert.throws(
      () => replayState(badDb, new MatchingEngine()),
      (err) => err instanceof UnknownEventTypeError && err.sequence === 1n,
      "event_type desconocido debe lanzar UnknownEventTypeError tipado",
    );
    badDb.close();

    const corruptDb = openDatabase(path.join(tmpDir, "corrupt.db"));
    corruptDb
      .prepare("INSERT INTO events_log (sequence, event_type, payload) VALUES (?, 'ORDER_NEW', ?)")
      .run(1, '{"id":"x","price":"not-a-bigint"}');
    assert.throws(
      () => replayState(corruptDb, new MatchingEngine()),
      (err) => err instanceof ReplayError && !(err instanceof UnknownEventTypeError),
      "payload corrupto debe lanzar ReplayError tipado",
    );
    corruptDb.close();

    // ── Reporte ───────────────────────────────────────────────────────
    console.log("════ SPRINT 02 · WAL Persistence & State Replay ════");
    console.log(`DB temporal ......... ${dbPath} (journal_mode=${journalMode})`);
    console.log(
      `Eventos persistidos .. ${TOTAL_OPS} (${batches} lotes atómicos + ${singles} individuales)`,
    );
    console.log(`Generación en vivo .. ${genMs.toFixed(2)} ms`);
    console.log(
      `Replay ............... ${replayedEvents} eventos en ${durationMs.toFixed(2)} ms ` +
        `→ ${ordersPerSec.toLocaleString("en-US")} órdenes/s (umbral < ${REPLAY_BUDGET_MS} ms)`,
    );
    console.log(`Coincidencia bit a bit PASS`);
    console.log(
      `Profundidad .......... bids: ${depthSummary.bidsLevels} niveles · ` +
        `asks: ${depthSummary.asksLevels} niveles · ` +
        `órdenes vivas: ${depthSummary.liveOrders}`,
    );
    console.log(
      `Datos agregados ...... bestBid=${control.bestBid ?? "∅"} · ` +
        `bestAsk=${control.bestAsk ?? "∅"} · totalVolume=${control.totalVolume}n · ` +
        `trades=${depthSummary.trades}`,
    );
    console.log(`Reinicio logger ...... secuencia continúa en ${seqAfterRestart}n ✓`);
    console.log(`Errores tipados ...... UnknownEventTypeError + ReplayError ✓`);
    console.log("══════════════════════════════════════════════════════");

    return { durationMs, ordersPerSec, depthSummary };
  } finally {
    if (db !== null) {
      db.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Entry point ──────────────────────────────────────────────────────

try {
  main();
  console.log("✅ TODAS LAS VERIFICACIONES PASARON");
} catch (err) {
  console.error("❌ SPRINT 02 FALLÓ:");
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
}
