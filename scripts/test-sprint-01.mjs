/**
 * SPRINT 01 — Test suite · Matching Engine Core
 * ─────────────────────────────────────────────────────────────────────
 * qa-tester · Node puro (node:assert/strict), sin frameworks ni deps.
 * Ejecuta con:  node scripts/test-sprint-01.mjs   (Node >= 24)
 *
 * Contrato bajo prueba (src/engine/matching.ts, clase MatchingEngine):
 *   - new MatchingEngine()
 *   - processOrder(order)  → { trades: Trade[], remainingOrder: Order | null }
 *   - cancelOrder(orderId) → Order | null (null si no existe; status CANCELLED)
 *   - bestBid / bestAsk    → bigint | null
 *   - totalVolume          → bigint (Σ volumen restante bids + asks)
 *   - trades               → readonly Trade[] (histórico acumulado)
 *   - getOrder(orderId)    → Order | null
 *
 * Nota de resolución de módulos:
 * Node 24 hace type stripping nativo de `.ts`, pero NO resuelve
 * specifiers relativos sin extensión (`./queue` en src/core/level.ts).
 * Se registra el mismo hook de resolución que en test-sprint-00.mjs:
 * añade `.ts` a specifiers relativos sin extensión. No se modifica
 * el código bajo prueba.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { registerHooks } from "node:module";

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
        if (err && err.code === "ERR_MODULE_NOT_FOUND") {
          // sin equivalente .ts → resolución estándar (que reportará el error)
          return nextResolve(specifier, context);
        }
        throw err;
      }
    }
    return nextResolve(specifier, context);
  },
});

const { MatchingEngine } = await import("../src/engine/matching.ts");

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Crea una orden válida determinista. `sequence: BigInt(id)`,
 * `traderId: "trader-1"`, `filledQuantity: 0n`, `timestamp: 0`,
 * `status: "NEW"` y bigints para `price`/`quantity` (nada de
 * Date.now/Math.random en la lógica del libro).
 */
function createOrder(id, side, type, price, quantity, tif) {
  return {
    id: String(id),
    sequence: BigInt(id),
    traderId: "trader-1",
    side,
    type,
    price: BigInt(price),
    quantity: BigInt(quantity),
    filledQuantity: 0n,
    timestamp: 0,
    timeInForce: tif,
    status: "NEW",
  };
}

/** Verifica la forma de un Trade (campos y tipos) sin imponer id de match. */
function assertTradeShape(trade) {
  assert.equal(typeof trade, "object", "trade debe ser un objeto");
  assert.equal(typeof trade.matchId, "string", "matchId: string");
  assert.equal(typeof trade.makerOrderId, "string", "makerOrderId: string");
  assert.equal(typeof trade.takerOrderId, "string", "takerOrderId: string");
  assert.equal(typeof trade.price, "bigint", "price: bigint");
  assert.equal(typeof trade.quantity, "bigint", "quantity: bigint");
  assert.equal(typeof trade.timestamp, "number", "timestamp: number");
}

// ── Runner ───────────────────────────────────────────────────────────

const results = [];

async function runTest(name, fn) {
  const started = performance.now();
  try {
    const customMs = await fn();
    const ms = customMs === undefined ? performance.now() - started : customMs;
    results.push({ name, pass: true, ms });
    console.log(`✅ ${name} — ${ms.toFixed(2)} ms`);
  } catch (err) {
    const ms = performance.now() - started;
    results.push({ name, pass: false, ms });
    console.log(`❌ ${name} — ${ms.toFixed(2)} ms`);
    const detail = err instanceof Error ? err.stack : String(err);
    for (const line of detail.split("\n")) {
      console.log(`   ${line}`);
    }
  }
}

// ── T1 · Calce LIMIT exacto al Maker Price ───────────────────────────

function t1ExactLimitMatch() {
  // Arrange — motor virgen
  const engine = new MatchingEngine();
  assert.equal(engine.bestBid, null, "bestBid inicial null");
  assert.equal(engine.bestAsk, null, "bestAsk inicial null");
  assert.equal(engine.totalVolume, 0n, "totalVolume inicial 0n");
  assert.equal(engine.trades.length, 0, "sin trades acumulados al inicio");

  // Act — resting SELL GTC 10@100 (id "1")
  const resting = engine.processOrder(createOrder(1, "SELL", "LIMIT", 100, 10, "GTC"));

  // Assert — la resting descansa con status NEW, sin trades
  assert.equal(resting.trades.length, 0, "la resting no genera trades");
  assert.notEqual(resting.remainingOrder, null, "remainingOrder no es null");
  assert.equal(resting.remainingOrder.status, "NEW", "status NEW al descansar");
  assert.equal(resting.remainingOrder.id, "1");
  assert.equal(engine.bestAsk, 100n, "bestAsk = 100n");
  assert.equal(engine.totalVolume, 10n, "totalVolume = 10n");

  // Act — BUY LIMIT 10@100 (id "2") cruza contra la resting
  const result = engine.processOrder(createOrder(2, "BUY", "LIMIT", 100, 10, "GTC"));

  // Assert — 1 trade exacto al Maker Price
  assert.equal(result.trades.length, 1, "trades.length === 1");
  assert.equal(engine.trades.length, 1, "histórico acumulado = 1");
  const trade = result.trades[0];
  assertTradeShape(trade);
  assert.equal(trade.price, 100n, "price = 100n (Maker Price)");
  assert.equal(trade.quantity, 10n, "quantity = 10n");
  assert.equal(trade.makerOrderId, "1", "maker = SELL resting (id 1)");
  assert.equal(trade.takerOrderId, "2", "taker = BUY entrante (id 2)");

  // Assert — taker totalmente ejecutado y libro vacío
  assert.equal(result.remainingOrder, null, "remainingOrder === null");
  assert.equal(engine.totalVolume, 0n, "libro vacío: totalVolume 0n");
  assert.equal(engine.bestBid, null, "libro vacío: bestBid null");
  assert.equal(engine.bestAsk, null, "libro vacío: bestAsk null");
}

// ── T2 · IOC parcial + descarte sin persistir resto ──────────────────

function t2IocPartialAndDiscard() {
  // Arrange — escenario A: IOC que cruza y deja resto
  const engineA = new MatchingEngine();
  const restingA = engineA.processOrder(createOrder(1, "SELL", "LIMIT", 100, 5, "GTC"));
  assert.equal(restingA.remainingOrder.status, "NEW");
  assert.equal(engineA.totalVolume, 5n);

  // Act — BUY IOC 10@100: 5n calzan, 5n restantes se descartan
  const resultA = engineA.processOrder(createOrder(2, "BUY", "LIMIT", 100, 10, "IOC"));

  // Assert — 1 trade de 5n; remanente descartado (NO insertado)
  assert.equal(resultA.trades.length, 1, "1 trade");
  assert.equal(engineA.trades.length, 1);
  const tradeA = resultA.trades[0];
  assertTradeShape(tradeA);
  assert.equal(tradeA.price, 100n, "Maker Price 100n");
  assert.equal(tradeA.quantity, 5n, "quantity 5n");
  assert.equal(tradeA.makerOrderId, "1");
  assert.equal(tradeA.takerOrderId, "2");
  assert.equal(resultA.remainingOrder, null, "remanente IOC descartado (null)");
  assert.equal(engineA.totalVolume, 0n, "totalVolume 0n: resto NO persistido");
  assert.equal(engineA.bestBid, null, "bestBid null: resto NO insertado");
  assert.equal(engineA.bestAsk, null, "bestAsk null: resting consumida");

  // Arrange — escenario B: IOC sin cruce contra la misma resting (misma
  // configuración); el libro NO se toca y el IOC se descarta completo.
  const engineB = new MatchingEngine();
  const restingB = engineB.processOrder(createOrder(1, "SELL", "LIMIT", 100, 5, "GTC"));
  assert.equal(restingB.remainingOrder.status, "NEW");
  assert.equal(engineB.totalVolume, 5n);

  // Act — BUY IOC 5@99: no cruza el ask de 100n
  const resultB = engineB.processOrder(createOrder(2, "BUY", "LIMIT", 99, 5, "IOC"));

  // Assert — 0 trades, nada insertado
  assert.equal(resultB.trades.length, 0, "0 trades (99n no cruza 100n)");
  assert.equal(engineB.trades.length, 0);
  assert.equal(resultB.remainingOrder, null, "IOC descartado (null)");
  assert.equal(engineB.totalVolume, 5n, "totalVolume intacto: solo la resting");
  assert.equal(engineB.bestAsk, 100n, "bestAsk intacto: 100n");
  assert.equal(engineB.bestBid, null, "bestBid null: IOC NO insertado");
}

// ── T3 · Cancelación O(1) en medio del libro ─────────────────────────

function t3CancelMiddleOfBook() {
  // Arrange — 3 SELL GTC al MISMO precio (100n) + 1 BUY GTC en otro nivel (90n)
  const engine = new MatchingEngine();
  for (const [id, price] of [[1, 100], [2, 100], [3, 100]]) {
    const r = engine.processOrder(createOrder(id, "SELL", "LIMIT", price, 10, "GTC"));
    assert.equal(r.remainingOrder.status, "NEW");
  }
  const buyResult = engine.processOrder(createOrder(4, "BUY", "LIMIT", 90, 10, "GTC"));
  assert.equal(buyResult.remainingOrder.status, "NEW");
  assert.equal(engine.bestAsk, 100n);
  assert.equal(engine.bestBid, 90n);
  assert.equal(engine.totalVolume, 40n, "3×10n asks + 10n bid");

  // Act — cancelar la SELL del medio (id "2")
  const cancelled = engine.cancelOrder("2");

  // Assert — devuelve la orden con status CANCELLED; nivel intacto
  assert.notEqual(cancelled, null, "cancelOrder devuelve la orden");
  assert.equal(cancelled.id, "2");
  assert.equal(cancelled.status, "CANCELLED", "status === CANCELLED");
  assert.equal(engine.bestAsk, 100n, "bestAsk intacto: 100n");
  assert.equal(engine.totalVolume, 30n, "nivel conserva 2×10n + bid 10n");
  const o1 = engine.getOrder("1");
  const o3 = engine.getOrder("3");
  assert.notEqual(o1, null, "getOrder('1') existe tras cancelar la del medio");
  assert.notEqual(o3, null, "getOrder('3') existe tras cancelar la del medio");
  assert.equal(o1.status, "NEW", "orden 1 sigue resting");
  assert.equal(o3.status, "NEW", "orden 3 sigue resting");

  // Act — cancelar id inexistente
  const missing = engine.cancelOrder("inexistente");

  // Assert — null idempotente
  assert.equal(missing, null, "cancelOrder('inexistente') === null");

  // Act — cancelar las 2 restantes del nivel de 100n
  const c1 = engine.cancelOrder("1");
  assert.equal(c1.status, "CANCELLED");
  assert.equal(engine.bestAsk, 100n, "aún queda una orden en el nivel");
  const c3 = engine.cancelOrder("3");
  assert.equal(c3.status, "CANCELLED");

  // Assert — nivel eliminado, BUY intacta
  assert.equal(engine.bestAsk, null, "bestAsk null: nivel de 100n eliminado");
  assert.equal(engine.bestBid, 90n, "BUY intacta: bestBid 90n");
  assert.equal(engine.totalVolume, 10n, "solo la BUY de 10n");
  const o4 = engine.getOrder("4");
  assert.notEqual(o4, null, "getOrder('4') intacta");
  assert.equal(o4.status, "NEW");
}

// ── T4 · Conservación exacta de volumen en cruce multi-nivel ─────────

function t4MultiLevelVolumeConservation() {
  // Arrange — asks: 5@100, 5@101, 10@102
  const engineA = new MatchingEngine();
  for (const [id, price, qty] of [[1, 100, 5], [2, 101, 5], [3, 102, 10]]) {
    const r = engineA.processOrder(createOrder(id, "SELL", "LIMIT", price, qty, "GTC"));
    assert.equal(r.remainingOrder.status, "NEW");
  }
  assert.equal(engineA.totalVolume, 20n);

  // Act — BUY LIMIT GTC 18@102: cruza los 3 niveles (5+5+8)
  const resultA = engineA.processOrder(createOrder(4, "BUY", "LIMIT", 102, 18, "GTC"));

  // Assert — trades exactos a Maker Prices en orden de precio ascendente
  assert.equal(resultA.trades.length, 3, "3 trades (un nivel c/u)");
  const [t1, t2, t3] = resultA.trades;
  assertTradeShape(t1);
  assertTradeShape(t2);
  assertTradeShape(t3);
  assert.equal(t1.price, 100n, "trade 1: Maker Price 100n");
  assert.equal(t1.quantity, 5n, "trade 1: 5n");
  assert.equal(t2.price, 101n, "trade 2: Maker Price 101n");
  assert.equal(t2.quantity, 5n, "trade 2: 5n");
  assert.equal(t3.price, 102n, "trade 3: Maker Price 102n");
  assert.equal(t3.quantity, 8n, "trade 3: 8n");
  assert.equal(
    t1.quantity + t2.quantity + t3.quantity,
    18n,
    "Σ cantidades de trades === 18n",
  );
  assert.equal(engineA.trades.length, 3, "histórico acumulado = 3");

  // Assert — taker 18n totalmente ejecutado; quedan 2n en el ask de 102
  assert.equal(resultA.remainingOrder, null, "BUY 18n totalmente ejecutada");
  assert.equal(engineA.totalVolume, 2n, "totalVolume === 2n");
  assert.equal(engineA.bestAsk, 102n, "bestAsk = 102n (remanente del ask)");
  assert.equal(engineA.bestBid, null, "bestBid null: no quedan bids");
  const asksRestantes = engineA.totalVolume - (engineA.bestBid ?? 0n);
  assert.equal(asksRestantes, 2n, "volumen de asks restante === 2n (totalVolume − bestBid)");
  const askRemainder = engineA.getOrder("3");
  assert.notEqual(askRemainder, null);
  assert.equal(askRemainder.status, "PARTIALLY_FILLED", "ask 102 parcialmente lleno");
  assert.equal(askRemainder.filledQuantity, 8n, "ask 102: filledQuantity 8n");

  // Act — cancelar la remanente del ask
  const cancelledA = engineA.cancelOrder("3");
  assert.equal(cancelledA.status, "CANCELLED");

  // Assert — libro vacío
  assert.equal(engineA.totalVolume, 0n, "totalVolume === 0n tras cancelar la remanente");

  // Arrange — mismo libro, BUY 22@102: resto 2n DEBE persistir en bids
  const engineB = new MatchingEngine();
  for (const [id, price, qty] of [[1, 100, 5], [2, 101, 5], [3, 102, 10]]) {
    const r = engineB.processOrder(createOrder(id, "SELL", "LIMIT", price, qty, "GTC"));
    assert.equal(r.remainingOrder.status, "NEW");
  }

  // Act — BUY LIMIT GTC 22@102: consume 5+5+10 y deja 2n en bids
  const resultB = engineB.processOrder(createOrder(4, "BUY", "LIMIT", 102, 22, "GTC"));

  // Assert — trades 5@100, 5@101, 10@102; resto 2n insertado en bids
  assert.equal(resultB.trades.length, 3, "3 trades");
  assert.equal(resultB.trades[0].price, 100n);
  assert.equal(resultB.trades[0].quantity, 5n);
  assert.equal(resultB.trades[1].price, 101n);
  assert.equal(resultB.trades[1].quantity, 5n);
  assert.equal(resultB.trades[2].price, 102n);
  assert.equal(resultB.trades[2].quantity, 10n);
  assert.equal(
    resultB.trades[0].quantity + resultB.trades[1].quantity + resultB.trades[2].quantity,
    20n,
    "Σ cantidades de trades === 20n",
  );
  assert.notEqual(resultB.remainingOrder, null, "remainingOrder no es null");
  assert.equal(resultB.remainingOrder.status, "PARTIALLY_FILLED", "remanente PARTIALLY_FILLED");
  assert.equal(resultB.remainingOrder.side, "BUY");
  assert.equal(resultB.remainingOrder.price, 102n);
  assert.equal(resultB.remainingOrder.quantity, 22n);
  assert.equal(resultB.remainingOrder.filledQuantity, 20n);
  assert.equal(engineB.bestBid, 102n, "bestBid === 102n (remanente en bids)");
  assert.equal(engineB.bestAsk, null, "bestAsk null: asks consumidos");
  assert.equal(engineB.totalVolume, 2n, "totalVolume === 2n");
  const bidRemainder = engineB.getOrder("4");
  assert.notEqual(bidRemainder, null);
  assert.equal(bidRemainder.status, "PARTIALLY_FILLED");

  // Act — cancelar la remanente del bid
  const cancelledB = engineB.cancelOrder("4");
  assert.equal(cancelledB.status, "CANCELLED");

  // Assert — libro vacío
  assert.equal(engineB.totalVolume, 0n, "totalVolume === 0n tras cancelar la remanente");
  assert.equal(engineB.bestBid, null);
}

// ── Ejecución ────────────────────────────────────────────────────────

console.log("SPRINT 01 — Matching Engine Core");
console.log(`Node ${process.version} · type stripping nativo (.ts)`);
console.log("─".repeat(64));

await runTest("T1 · Calce LIMIT exacto al Maker Price", t1ExactLimitMatch);
await runTest("T2 · IOC parcial + descarte sin persistir resto", t2IocPartialAndDiscard);
await runTest("T3 · Cancelación O(1) en medio del libro", t3CancelMiddleOfBook);
await runTest("T4 · Conservación exacta de volumen multi-nivel", t4MultiLevelVolumeConservation);

console.log("─".repeat(64));
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`Resultado: ${passed}/${results.length} PASS`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ❌ ${f.name}`);
  console.log("GATE: BLOCKED — tests en rojo");
  process.exitCode = 1;
} else {
  console.log("GATE: PASSED — todos los tests en verde");
  process.exitCode = 0;
}
