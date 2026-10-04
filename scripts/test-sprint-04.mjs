/**
 * SPRINT 04 — L2 Orderbook Depth & Real-Time Streaming API · Validación
 * ─────────────────────────────────────────────────────────────────────
 * qa-tester · Node puro (node:assert/strict), sin frameworks ni deps.
 * Ejecuta con:  node scripts/test-sprint-04.mjs   (Node >= 24)
 *
 * 1. Arranca el servidor de streaming (hub in-process + SSE/HTTP real).
 * 2. Conecta un cliente simulado → recibe depth_snapshot inicial.
 * 3. Ráfaga de 1,000 órdenes al ExecutionPipeline + difusión en vivo.
 * 4. Zero-gap: secuencia de difusión contigua sin pérdidas.
 * 5. El cliente reconstruye el libro L2 desde snapshot + deltas y su
 *    checksum CRC32 debe ser 100% idéntico al del servidor.
 * 6. Validación del transporte HTTP: /book/snapshot JSON y /stream SSE.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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
const { SettlementLedger } = await import("../src/ledger/ledger.ts");
const { MatchingEngine } = await import("../src/engine/matching.ts");
const { ExecutionPipeline } = await import("../src/engine/pipeline.ts");
const {
  L2OrderbookAggregator,
  computeLevelsChecksum,
} = await import("../src/api/depth.ts");
const { StreamingServer } = await import("../src/api/server.ts");

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

/** Reconstruye el checksum L2 desde un mapa de niveles (cliente). */
function clientChecksum(levelsByKey, side) {
  const rows = [...levelsByKey.entries()]
    .filter(([key]) => key.startsWith(`${side}|`))
    .map(([key, qty]) => ({
      side,
      price: BigInt(key.slice(`${side}|`.length)),
      quantity: qty,
    }));
  // BUY desc (mayor primero) · SELL asc (menor primero) — como el servidor.
  rows.sort((a, b) => {
    if (a.price === b.price) {
      return 0;
    }
    return side === "BUY"
      ? (a.price < b.price ? 1 : -1)
      : (a.price < b.price ? -1 : 1);
  });
  return rows;
}

async function readFirstSseEvent(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // Un evento SSE termina en línea en blanco; se busca el PRIMER
      // bloque que declare `event:` (puede haber preámbulos/comentarios).
      let endIndex = buffer.indexOf("\n\n");
      while (endIndex !== -1) {
        const block = buffer.slice(0, endIndex);
        if (block.includes("event:")) {
          controller.abort();
          return block;
        }
        buffer = buffer.slice(endIndex + 2);
        endIndex = buffer.indexOf("\n\n");
      }
    }
    throw new Error("SSE: el stream terminó sin eventos");
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orderbook-sprint04-"));
  let db = null;
  let server = null;

  try {
    db = openDatabase(path.join(tmpDir, "stream.db"));
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

    for (let u = 0; u < 1_000; u++) {
      ledger.deposit(`user-${u}`, "USD", 10_000_000n);
      ledger.deposit(`user-${u}`, "BTC", 100_000n);
    }

    const aggregator = new L2OrderbookAggregator(engine);
    // Rate limits configurados para verificar el ALTO-3 del arquitecto.
    server = new StreamingServer(engine, aggregator, {
      maxConnections: 2,
      maxConnectionsPerIp: 2,
    });

    // ── 1. Arranca el servidor de streaming (SSE/HTTP real) ──────────
    const portPromise = server.listen(0);

    // ── 2. Cliente simulado: recibe depth_snapshot al conectar ──────
    const client = server.connectClient();
    assert.equal(client.messages.length, 1);
    const firstMessage = client.messages[0];
    assert.equal(firstMessage.channel, "depth_snapshot");
    assert.equal(firstMessage.seq, 1n);
    const initialSnapshot = firstMessage.data;
    assert.ok(Array.isArray(initialSnapshot.bids));
    assert.ok(Array.isArray(initialSnapshot.asks));
    assert.equal(typeof initialSnapshot.checksum, "string");
    // bids descendentes / asks ascendentes.
    for (let i = 1; i < initialSnapshot.bids.length; i++) {
      assert.ok(initialSnapshot.bids[i - 1].price > initialSnapshot.bids[i].price);
    }
    for (let i = 1; i < initialSnapshot.asks.length; i++) {
      assert.ok(initialSnapshot.asks[i - 1].price < initialSnapshot.asks[i].price);
    }

    // ── 3. Ráfaga de 1,000 órdenes con difusión en vivo ─────────────
    const rng = createRng(0x5a1e04);
    const BURST = 1_000;
    let totalTrades = 0;
    const broadcastLatencies = [];

    for (let i = 1; i <= BURST; i++) {
      const side = rng() < 0.5 ? "BUY" : "SELL";
      const isLimit = rng() < 0.85;
      const price = 95n + BigInt(Math.floor(rng() * 11)); // 95..105
      const quantity = 1n + BigInt(Math.floor(rng() * 10)); // 1..10
      const user = `user-${Math.floor(rng() * 1_000)}`;
      const order = makeOrder(
        `s4-${i}`, side, isLimit ? "LIMIT" : "MARKET", price, quantity,
        isLimit ? (rng() < 0.75 ? "GTC" : "IOC") : "IOC", user, i,
      );
      const result = pipeline.executeOrder(order);
      totalTrades += result.trades.length;
      const t0 = performance.now();
      server.notifyOrderExecuted(order, result, result.walSequence);
      broadcastLatencies.push(performance.now() - t0);
    }

    // ── 4. Zero-gap: secuencia de difusión contigua ─────────────────
    assert.ok(
      client.messages.length > BURST,
      `mensajes recibidos: ${client.messages.length} (esperados > ${BURST})`,
    );
    let previousSeq = 0n;
    let updates = 0;
    let tradesMessages = 0;
    for (const message of client.messages) {
      assert.equal(
        message.seq,
        previousSeq + 1n,
        `zero-gap: seq esperada ${previousSeq + 1n}, recibida ${message.seq}`,
      );
      previousSeq = message.seq;
      if (message.channel === "depth_update") {
        updates += 1;
      } else if (message.channel === "trades") {
        tradesMessages += 1;
      }
    }
    assert.equal(tradesMessages, totalTrades, "cada trade debe emitirse una vez");
    assert.ok(updates > 0, "debe haber deltas de niveles");

    // ── 5. Reconstrucción L2 en el cliente + checksum idéntico ──────
    const levelsByKey = new Map(); // "side|price" → qty
    for (const level of [...initialSnapshot.bids, ...initialSnapshot.asks]) {
      levelsByKey.set(`${level.side}|${level.price}`, level.quantity);
    }
    for (const message of client.messages) {
      if (message.channel === "depth_update") {
        const update = message.data;
        const key = `${update.side}|${update.price}`;
        if (update.quantity === 0n) {
          levelsByKey.delete(key);
        } else {
          levelsByKey.set(key, update.quantity);
        }
      }
    }
    const clientBids = clientChecksum(levelsByKey, "BUY");
    const clientAsks = clientChecksum(levelsByKey, "SELL");
    const clientChecksumValue = computeLevelsChecksum(clientBids, clientAsks);

    const serverSnapshot = aggregator.getDepthSnapshot(20);
    assert.equal(
      clientChecksumValue,
      serverSnapshot.checksum,
      "checksum del libro reconstruido en el cliente debe ser 100% idéntico al del servidor",
    );
    assert.equal(clientBids.length, serverSnapshot.bids.length);
    assert.equal(clientAsks.length, serverSnapshot.asks.length);

    // ── 6. Transporte HTTP: JSON y SSE ──────────────────────────────
    const listenPort = await portPromise;
    const httpBase = `http://127.0.0.1:${listenPort}`;

    const jsonResponse = await fetch(`${httpBase}/book/snapshot`);
    assert.equal(jsonResponse.status, 200);
    const jsonSnapshot = await jsonResponse.json();
    assert.equal(typeof jsonSnapshot.checksum, "string");
    assert.equal(jsonSnapshot.checksum, serverSnapshot.checksum);
    for (const level of jsonSnapshot.bids) {
      assert.equal(typeof level.price, "string");
      assert.equal(typeof level.quantity, "string");
    }

    const sseEvent = await readFirstSseEvent(`${httpBase}/stream`);
    assert.ok(
      sseEvent.includes("event: depth_snapshot"),
      `el primer evento SSE debe ser depth_snapshot: ${sseEvent.slice(0, 80)}`,
    );
    assert.ok(sseEvent.includes(serverSnapshot.checksum));
    assert.ok(sseEvent.includes("id: 1"), "el frame SSE debe llevar id: <seq>");

    // Rate limiting: con límite 2, la tercera conexión simultánea recibe 429.
    const heldConnections = [];
    for (let k = 0; k < 2; k++) {
      const controller = new AbortController();
      const held = await fetch(`${httpBase}/stream`, { signal: controller.signal });
      assert.equal(held.status, 200);
      heldConnections.push({ controller, held });
    }
    const blocked = await fetch(`${httpBase}/stream`);
    assert.equal(
      blocked.status,
      429,
      "la tercera conexión simultánea debe ser rechazada por rate limit",
    );
    for (const { controller } of heldConnections) {
      controller.abort();
    }

    // Auditoría contable final.
    const audit = ledger.audit();
    assert.equal(audit.unbalancedTransactions, 0);
    assert.equal(audit.memoryMismatches, 0);

    // ── Reporte ───────────────────────────────────────────────────────
    broadcastLatencies.sort((a, b) => a - b);
    const p = (q) => broadcastLatencies[Math.floor(broadcastLatencies.length * q)];
    console.log("════ SPRINT 04 · L2 Depth & Real-Time Streaming ════");
    console.log(`Servidor ............... 127.0.0.1:${listenPort} (SSE + JSON)`);
    console.log(`Snapshot inicial ....... ${initialSnapshot.bids.length} bids · ${initialSnapshot.asks.length} asks · checksum ${initialSnapshot.checksum}`);
    console.log(`Ráfaga ................. ${BURST} órdenes · ${totalTrades} trades emitidos · ${updates} deltas de niveles`);
    console.log(`Mensajes totales ....... ${client.messages.length} (snapshot + updates + trades)`);
    console.log(`Zero-gap ............... secuencia contigua 1..${previousSeq}n ✓`);
    console.log(
      `Checksum L2 ........... cliente ${clientChecksumValue} == servidor ${serverSnapshot.checksum} ✓`,
    );
    console.log(
      `Latencia de difusión ... P50=${p(0.5).toFixed(4)} ms · P99=${p(0.99).toFixed(4)} ms · max=${broadcastLatencies[broadcastLatencies.length - 1].toFixed(4)} ms`,
    );
    console.log(`HTTP JSON .............. /book/snapshot checksum idéntico ✓`);
    console.log(`SSE .................... primer evento depth_snapshot con id/seq ✓`);
    console.log(`Rate limiting .......... 429 en la 3ª conexión simultánea ✓`);
    console.log(`Auditoría ledger ....... 0 descuadres ✓`);
    console.log("══════════════════════════════════════════════════════");

    return { client, serverSnapshot, totalTrades, updates };
  } finally {
    if (server !== null) {
      server.close();
    }
    if (db !== null) {
      db.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Entry point ──────────────────────────────────────────────────────

try {
  await main();
  console.log("✅ SPRINT 04 · TODAS LAS VERIFICACIONES PASARON");
} catch (err) {
  console.error("❌ SPRINT 04 FALLÓ:");
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
}
