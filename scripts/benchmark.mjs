/**
 * SPRINT 05 — Suite de benchmarking de alto rendimiento (100k órdenes).
 *
 * Carga masiva determinista (seed fijo): órdenes LIMIT/MARKET/CANCEL
 * distribuidas entre N usuarios, ejecutadas por el ExecutionPipeline
 * transaccional (WAL + Engine + Ledger). Mide en tiempo real:
 *   - Throughput (órdenes/segundo)
 *   - Latencia end-to-end: P50 / P90 / P99 / P99.9 / max
 *   - Memoria: heapUsed antes, durante (cada 10k) y después de gc()
 *     forzado (detección de memory leaks en WAL/ledger)
 *   - I/O SQLite: tamaños de DB/WAL y checkpoint.
 *
 * Uso:
 *   node --expose-gc scripts/benchmark.mjs [--orders 100000] [--users 10000]
 *   (o `npm run bench`)
 *
 * Salida: tabla en consola + bench-results.json (gitignored).
 */
import { performance } from "node:perf_hooks";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const { SettlementLedger } = await import("../src/ledger/ledger.ts");
const { MatchingEngine } = await import("../src/engine/matching.ts");
const { ExecutionPipeline } = await import("../src/engine/pipeline.ts");

// ── Configuración ────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { orders: 100_000, users: 10_000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--orders" && argv[i + 1] !== undefined) {
      options.orders = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === "--users" && argv[i + 1] !== undefined) {
      options.users = Number(argv[i + 1]);
      i++;
    }
  }
  return options;
}

const { orders: TOTAL_ORDERS, users: TOTAL_USERS } = parseArgs(process.argv.slice(2));

const WARMUP_ORDERS = Math.max(1_000, Math.floor(TOTAL_ORDERS / 20));
const MEM_SAMPLE_EVERY = 10_000;
const LEAK_TOLERANCE_MB = 64; // slack post-gc vs pre-run

if (typeof globalThis.gc !== "function") {
  console.error(
    "benchmark: este script requiere GC forzado. Ejecuta con --expose-gc:\n" +
      "  node --expose-gc scripts/benchmark.mjs  (o npm run bench)",
  );
  process.exit(1);
}

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

function percentile(sorted, q) {
  const index = Math.floor(sorted.length * q);
  return sorted[Math.max(0, index - 1)];
}

function formatMs(ms) {
  return ms >= 100 ? ms.toFixed(1) : ms >= 1 ? ms.toFixed(3) : ms.toFixed(5);
}

// ── Motor del benchmark ──────────────────────────────────────────────

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orderbook-bench-"));
  const dbPath = path.join(tmpDir, "bench.db");
  let db = null;

  try {
    db = openDatabase(dbPath);
    const logger = new WalLogger(db);
    const ledger = new SettlementLedger(db, {
      baseAsset: "BTC",
      quoteAsset: "USD",
    });
    const engine = new MatchingEngine();
    const pipeline = new ExecutionPipeline(db, engine, logger, ledger, {
      baseAsset: "BTC",
      quoteAsset: "USD",
    });

    // Setup (fuera de la medición): 10,000 usuarios con depósitos, todo
    // en UNA transacción vía depositRaw.
    db.transaction(() => {
      for (let u = 0; u < TOTAL_USERS; u++) {
        ledger.depositRaw(`user-${u}`, "USD", 10_000_000n);
        ledger.depositRaw(`user-${u}`, "BTC", 100_000n);
      }
    })();

    const heapBeforeMb = process.memoryUsage().heapUsed / (1024 * 1024);
    const dbSizeBefore = fs.statSync(dbPath).size;
    const walSizeBefore = fs.existsSync(`${dbPath}-wal`)
      ? fs.statSync(`${dbPath}-wal`).size
      : 0;

    // Cancelación transaccional (el pipeline no tiene cancel aún — backlog).
    const executeCancel = (orderId, meta) => {
      db.transaction(() => {
        logger.appendEvent("ORDER_CANCEL", { orderId });
        const live = engine.getOrder(orderId);
        if (live !== null) {
          const remaining = live.quantity - live.filledQuantity;
          if (meta.side === "SELL") {
            ledger.releaseFundsRaw(meta.userId, "BTC", remaining, orderId);
          } else {
            ledger.releaseFundsRaw(meta.userId, "USD", remaining * meta.price, orderId);
          }
          engine.cancelOrder(orderId);
        }
      })();
    };

    // Warmup (obligatorio): descarta el primer run, calienta JIT/SQLite.
    const rngWarmup = createRng(0xaa01);
    for (let i = 1; i <= WARMUP_ORDERS; i++) {
      const side = rngWarmup() < 0.5 ? "BUY" : "SELL";
      const price = 95n + BigInt(Math.floor(rngWarmup() * 11));
      const quantity = 1n + BigInt(Math.floor(rngWarmup() * 10));
      pipeline.executeOrder(
        makeOrder(
          `warm-${i}`, side, "LIMIT", price, quantity, "IOC",
          `user-${Math.floor(rngWarmup() * TOTAL_USERS)}`, i,
        ),
      );
    }
    globalThis.gc();
    const heapAfterWarmupMb = process.memoryUsage().heapUsed / (1024 * 1024);

    // ── Carga masiva medida ──────────────────────────────────────────
    const rng = createRng(0x5eed05);
    const alive = new Map(); // orderId → { userId, side, price }
    const latencies = [];
    const memSamples = [];
    let cancels = 0;
    let tradesTotal = 0;
    let seqCounter = 0n;

    const benchStart = performance.now();
    for (let i = 1; i <= TOTAL_ORDERS; i++) {
      const roll = rng();
      const t0 = performance.now();

      if (roll < 0.2 && alive.size > 0) {
        const ids = [...alive.keys()];
        const orderId = ids[Math.floor(rng() * ids.length)];
        const meta = alive.get(orderId);
        executeCancel(orderId, meta);
        alive.delete(orderId);
        cancels += 1;
      } else {
        const side = rng() < 0.5 ? "BUY" : "SELL";
        const isLimit = rng() < 0.75;
        const price = 95n + BigInt(Math.floor(rng() * 11));
        const quantity = 1n + BigInt(Math.floor(rng() * 10));
        const user = `user-${Math.floor(rng() * TOTAL_USERS)}`;
        const order = makeOrder(
          `bench-${i}`, side, isLimit ? "LIMIT" : "MARKET", price, quantity,
          isLimit ? (rng() < 0.75 ? "GTC" : "IOC") : "IOC", user, i,
        );
        const result = pipeline.executeOrder(order);
        tradesTotal += result.trades.length;
        for (const trade of result.trades) {
          if (engine.getOrder(trade.makerOrderId) === null) {
            alive.delete(trade.makerOrderId);
          }
        }
        if (result.remainingOrder !== null) {
          alive.set(order.id, { userId: user, side, price });
        }
        void seqCounter;
      }

      latencies.push(performance.now() - t0);

      if (i % MEM_SAMPLE_EVERY === 0) {
        memSamples.push({
          atOrders: i,
          heapUsedMb: process.memoryUsage().heapUsed / (1024 * 1024),
        });
      }
    }
    const benchEnd = performance.now();
    const totalMs = benchEnd - benchStart;
    const tps = TOTAL_ORDERS / (totalMs / 1000);

    // GC forzado: verificación de ausencia de fugas en WAL/ledger.
    globalThis.gc();
    const heapAfterGcMb = process.memoryUsage().heapUsed / (1024 * 1024);
    const leakMb = heapAfterGcMb - heapBeforeMb;
    const noLeak = leakMb <= LEAK_TOLERANCE_MB;

    // I/O SQLite.
    const dbSizeAfter = fs.statSync(dbPath).size;
    const walSizeAfter = fs.existsSync(`${dbPath}-wal`)
      ? fs.statSync(`${dbPath}-wal`).size
      : 0;

    // Auditoría contable final.
    const audit = ledger.audit();

    // Percentiles.
    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 0.5);
    const p90 = percentile(latencies, 0.9);
    const p99 = percentile(latencies, 0.99);
    const p999 = percentile(latencies, 0.999);
    const max = latencies[latencies.length - 1];

    const results = {
      meta: {
        generatedAt: new Date().toISOString(),
        orders: TOTAL_ORDERS,
        users: TOTAL_USERS,
        warmupOrders: WARMUP_ORDERS,
        hardware: `${os.cpus()[0]?.model ?? "unknown"} (${os.cpus().length} cores)`,
        node: process.version,
      },
      throughput: { ordersPerSecond: Math.round(tps), totalMs },
      latencyMs: { p50, p90, p99, p999, max },
      memoryMb: {
        before: heapBeforeMb,
        afterWarmup: heapAfterWarmupMb,
        afterGc: heapAfterGcMb,
        leakAfterGc: leakMb,
        noLeak,
        samples: memSamples,
      },
      sqliteIo: {
        journalMode: db.pragma("journal_mode", { simple: true }),
        dbBytesBefore: dbSizeBefore,
        dbBytesAfter: dbSizeAfter,
        walBytesBefore: walSizeBefore,
        walBytesAfter: walSizeAfter,
      },
      ledger: {
        unbalancedTransactions: audit.unbalancedTransactions,
        memoryMismatches: audit.memoryMismatches,
      },
      workload: { cancels, tradesTotal, restingOrders: alive.size },
    };

    // ── Reporte ──────────────────────────────────────────────────────
    console.log("════ SPRINT 05 · Benchmark Suite (100k load) ════");
    console.log(`Órdenes ............... ${TOTAL_ORDERS.toLocaleString("en-US")} (${TOTAL_USERS.toLocaleString("en-US")} usuarios)`);
    console.log(`Mezcla ................ LIMIT/MARKET + ${cancels.toLocaleString("en-US")} cancelaciones · ${tradesTotal.toLocaleString("en-US")} trades`);
    console.log(`Warmup ................ ${WARMUP_ORDERS.toLocaleString("en-US")} órdenes (descartadas)`);
    console.log("── Rendimiento ──");
    console.log(`Throughput ............ ${Math.round(tps).toLocaleString("en-US")} órdenes/s`);
    console.log(`Latencia E2E .......... P50=${formatMs(p50)} ms · P90=${formatMs(p90)} ms · P99=${formatMs(p99)} ms · P99.9=${formatMs(p999)} ms · max=${formatMs(max)} ms`);
    console.log("── Memoria (GC forzado) ──");
    console.log(`heapUsed .............. antes ${heapBeforeMb.toFixed(1)} MB → post-warmup ${heapAfterWarmupMb.toFixed(1)} MB → post-gc ${heapAfterGcMb.toFixed(1)} MB`);
    console.log(`Fuga post-gc .......... ${leakMb.toFixed(2)} MB ${noLeak ? "(sin fugas ✓)" : "(¡Fuga detectada!)"}`);
    console.log("── I/O SQLite ──");
    console.log(`journal_mode .......... ${db.pragma("journal_mode", { simple: true })}`);
    console.log(`DB ..................... ${(dbSizeBefore / 1024).toFixed(0)} KB → ${(dbSizeAfter / 1024).toFixed(0)} KB`);
    console.log(`WAL .................... ${(walSizeBefore / 1024).toFixed(0)} KB → ${(walSizeAfter / 1024).toFixed(0)} KB`);
    console.log("── Consistencia ──");
    console.log(`Ledger ................ ${audit.unbalancedTransactions} transacciones descuadradas · ${audit.memoryMismatches} divergencias`);
    console.log(`Objetivos baseline .... throughput ≥ 50,000/s · p99 ≤ 2 ms (hardware local documenta delta real)`);
    console.log("═══════════════════════════════════════════════════");

    if (!noLeak) {
      throw new Error(
        `posible memory leak: post-gc ${heapAfterGcMb.toFixed(1)} MB vs pre-run ${heapBeforeMb.toFixed(1)} MB (delta ${leakMb.toFixed(2)} MB)`,
      );
    }
    if (audit.unbalancedTransactions !== 0 || audit.memoryMismatches !== 0) {
      throw new Error("ledger descuadrado tras el benchmark");
    }

    fs.writeFileSync("bench-results.json", JSON.stringify(results, null, 2));
    return results;
  } finally {
    if (db !== null) {
      db.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log("✅ BENCHMARK COMPLETADO (resultados en bench-results.json)");
} catch (err) {
  console.error("❌ BENCHMARK FALLÓ:");
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
}

