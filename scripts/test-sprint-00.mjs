/**
 * SPRINT 00 — Test suite · Core Data Structures & Domain Types
 * ─────────────────────────────────────────────────────────────────────
 * qa-tester · Node puro (node:assert/strict), sin frameworks ni deps.
 * Ejecuta con:  node scripts/test-sprint-00.mjs   (Node >= 24)
 *
 * Nota de resolución de módulos:
 * Node 24 hace type stripping nativo de `.ts`, pero NO resuelve
 * specifiers relativos sin extensión. `src/core/level.ts` importa
 * `./queue` sin extensión, lo que produciría ERR_MODULE_NOT_FOUND.
 * Para no tocar el código bajo prueba (contrato de API intacto), se
 * registra un hook de resolución que añade `.ts` a specifiers
 * relativos sin extensión. El código de `src/core/` no se modifica.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { registerHooks } from "node:module";
import { DoublyLinkedList, OrderNode } from "../src/core/queue.ts";

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

const { LimitLevel } = await import("../src/core/level.ts");

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Crea una orden LIMIT BUY GTC válida con `price`/`quantity` como
 * literales bigint y `filledQuantity: 0n`. `timestamp: 0` y
 * `sequence: BigInt(id)` deterministas (la secuencia monotónica sigue
 * el orden de inserción 1..N; nada de Date.now/Math.random en la
 * lógica del libro). Incluye `status: "NEW"`: el tipo `Order` de
 * `src/core/types.ts` (Sprint 01) lo exige como campo obligatorio.
 */
function createOrder(id, price, quantity) {
  return {
    id: String(id),
    sequence: BigInt(id),
    traderId: "trader-1",
    side: "BUY",
    type: "LIMIT",
    price: BigInt(price),
    quantity: BigInt(quantity),
    filledQuantity: 0n,
    timestamp: 0,
    timeInForce: "GTC",
    status: "NEW",
  };
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

// ── T1 · FIFO 100,000 órdenes ────────────────────────────────────────

function t1Fifo100k() {
  // Arrange
  const list = new DoublyLinkedList();
  const N = 100_000;

  // Act
  for (let i = 1; i <= N; i++) {
    list.push(createOrder(i, 100, 10));
  }

  // Assert — extremos y métricas
  assert.ok(list.head instanceof OrderNode, "head debe ser un OrderNode");
  assert.equal(list.head.order.id, "1");
  assert.equal(list.head.order.sequence, 1n, "head.sequence = 1n (primera orden)");
  assert.equal(list.tail.order.id, String(N));
  assert.equal(list.tail.order.sequence, BigInt(N), "tail.sequence = N");
  assert.equal(list.length, N);
  assert.equal(list.totalVolume, 1_000_000n);

  // Assert — recorrido FIFO exacto ids 1..N y secuencia monotónica
  let node = list.head;
  let visited = 0;
  while (node !== null) {
    visited += 1;
    assert.equal(node.order.id, String(visited));
    assert.equal(node.order.sequence, BigInt(visited), "secuencia monotónica 1..N");
    node = node.next;
  }
  assert.equal(visited, N);
  assert.equal(list.head.prev, null);
  assert.equal(list.tail.next, null);
}

// ── T2 · Remove O(1) de nodos intermedios, head/tail y doble remove ──

function t2RemoveIntermediate() {
  // Arrange
  const list = new DoublyLinkedList();
  const N = 100_000;
  const middleNodes = [];

  // Act — push capturando 100 nodos intermedios (1 por cada bloque de
  // 1,000, en el punto medio: 500, 1500, ..., 99500) para no tocar
  // head (1) / tail (100000) ni sus reemplazos inmediatos (2 / 99999).
  for (let i = 1; i <= N; i++) {
    const node = list.push(createOrder(i, 100, 10));
    if (i >= 500 && (i - 500) % 1000 === 0) {
      middleNodes.push(node);
    }
  }

  // Assert — capturados exactamente 100, sin head/tail
  assert.equal(middleNodes.length, 100);
  assert.equal(middleNodes[0].order.id, "500");
  assert.equal(middleNodes[99].order.id, "99500");

  // Act — remove O(1) de los 100 nodos intermedios
  for (const node of middleNodes) {
    list.remove(node);
  }

  // Assert — métricas y extremos intactos
  assert.equal(list.length, 99_900);
  assert.equal(list.totalVolume, 999_000n);
  assert.equal(list.head.order.id, "1");
  assert.equal(list.tail.order.id, String(N));

  // Act — remover head y tail
  const oldHead = list.head;
  const oldTail = list.tail;
  list.remove(oldHead);
  list.remove(oldTail);

  // Assert — reemplazos correctos: id=2 e id=99999
  assert.equal(list.head.order.id, "2");
  assert.equal(list.tail.order.id, "99999");
  assert.equal(list.length, 99_898);

  // Assert — remove del mismo nodo dos veces lanza Error
  assert.throws(() => list.remove(oldHead), Error);
  assert.throws(() => list.remove(oldTail), Error);
  assert.throws(() => list.remove(middleNodes[0]), Error);

  // Assert — nodo ajeno a la lista lanza Error
  const otherList = new DoublyLinkedList();
  const foreignNode = otherList.push(createOrder(1, 100, 10));
  assert.throws(() => list.remove(foreignNode), Error);
}

// ── T3 · LimitLevel ──────────────────────────────────────────────────

function t3LimitLevel() {
  // Arrange
  const level = new LimitLevel(100n);
  assert.equal(level.price, 100n);
  assert.equal(level.isEmpty(), true);
  assert.equal(level.totalVolume, 0n);

  // Act — 3 órdenes al mismo precio, 5n c/u
  const n1 = level.addOrder(createOrder(1, 100, 5));
  const n2 = level.addOrder(createOrder(2, 100, 5));
  const n3 = level.addOrder(createOrder(3, 100, 5));

  // Assert
  assert.equal(level.isEmpty(), false);
  assert.equal(level.totalVolume, 15n);
  assert.equal(level.queue.length, 3);

  // Act — vaciar el nivel
  level.removeOrder(n1);
  level.removeOrder(n2);
  level.removeOrder(n3);

  // Assert
  assert.equal(level.isEmpty(), true);
  assert.equal(level.totalVolume, 0n);
}

// ── T4 · Timing: Gate A (100k push) + Gate B (100k remove) < 50 ms c/u ─

function t4TimingGates() {
  // Arrange — warmup JIT: 1 pasada de 10k push+remove (NO medida)
  const warmup = new DoublyLinkedList();
  const W = 10_000;
  const warmOrders = new Array(W);
  for (let i = 0; i < W; i++) warmOrders[i] = createOrder(i + 1, 100, 10);
  const warmNodes = new Array(W);
  for (let i = 0; i < W; i++) warmNodes[i] = warmup.push(warmOrders[i]);
  for (let i = 0; i < W; i++) warmup.remove(warmNodes[i]);
  assert.equal(warmup.length, 0);
  assert.equal(warmup.totalVolume, 0n);

  // Arrange — 100,000 objetos Order pre-generados FUERA del cronómetro
  const N = 100_000;
  const orders = new Array(N);
  for (let i = 0; i < N; i++) orders[i] = createOrder(i + 1, 100, 10);
  const list = new DoublyLinkedList();
  const nodes = new Array(N);

  // Gate A — 100,000 push (medido con process.hrtime.bigint)
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) nodes[i] = list.push(orders[i]);
  const pushNs = process.hrtime.bigint() - t0;
  const pushMs = Number(pushNs) / 1e6;

  // Gate B — 100,000 remove de los mismos nodos (medido por separado)
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) list.remove(nodes[i]);
  const removeNs = process.hrtime.bigint() - t0;
  const removeMs = Number(removeNs) / 1e6;

  const totalMs = pushMs + removeMs;
  console.log(`   Gate A · 100k push   : ${pushMs.toFixed(2)} ms  (límite < 50 ms)`);
  console.log(`   Gate B · 100k remove : ${removeMs.toFixed(2)} ms  (límite < 50 ms)`);
  console.log(`   Total combinado      : ${totalMs.toFixed(2)} ms  (informativo)`);

  // Assert — integridad post-remoción (antes de validar latencia,
  // para reportar siempre ambos gate times incluso si uno falla)
  assert.equal(list.length, 0);
  assert.equal(list.totalVolume, 0n);

  // Assert — límite de latencia por gate
  assert.ok(
    pushMs < 50,
    `Gate A · 100k push tomó ${pushMs.toFixed(2)} ms (límite: < 50 ms)`,
  );
  assert.ok(
    removeMs < 50,
    `Gate B · 100k remove tomó ${removeMs.toFixed(2)} ms (límite: < 50 ms)`,
  );

  return totalMs;
}

// ── T5 · Fill parcial atómico ────────────────────────────────────────

function t5AtomicPartialFill() {
  // Arrange — 3 órdenes de 10n c/u → totalVolume 30n
  const list = new DoublyLinkedList();
  const n1 = list.push(createOrder(1, 100, 10));
  const n2 = list.push(createOrder(2, 100, 10));
  const n3 = list.push(createOrder(3, 100, 10));
  assert.equal(list.totalVolume, 30n);
  assert.equal(list.length, 3);

  // Act — fill parcial de 4n sobre el nodo central
  list.fill(n2, 4n);

  // Assert — atomicidad: totalVolume y filledQuantity cambian juntos
  assert.equal(list.totalVolume, 26n, "totalVolume = 30n − 4n = 26n");
  assert.equal(n2.order.filledQuantity, 4n, "filledQuantity = 4n");
  assert.equal(n2.order.quantity, 10n, "quantity original intacta");
  // los vecinos no se ven afectados
  assert.equal(n1.order.filledQuantity, 0n);
  assert.equal(n3.order.filledQuantity, 0n);

  // Act — fill del remanente 6n → llena la orden exactamente
  list.fill(n2, 6n);

  // Assert
  assert.equal(list.totalVolume, 20n, "totalVolume = 26n − 6n = 20n");
  assert.equal(n2.order.filledQuantity, 10n, "orden llena: 4n + 6n = 10n");

  // Act — remove de la orden llena: resta 0 al volumen
  list.remove(n2);

  // Assert
  assert.equal(list.totalVolume, 20n, "remove de orden llena no altera totalVolume");
  assert.equal(list.length, 2);

  // Assert — rechazos (no mutan el libro)
  // 1) fill sobre un nodo ya removido (owner = null)
  assert.throws(() => list.fill(n2, 1n), Error);
  // 2) fill sobre un nodo ajeno a la lista
  const otherList = new DoublyLinkedList();
  const foreignNode = otherList.push(createOrder(9, 100, 10));
  assert.throws(() => list.fill(foreignNode, 1n), Error);
  // 3) fill con qty <= 0n
  assert.throws(() => list.fill(n1, 0n), Error);
  // 4) fill que excede el remanente (10n disponible, pide 11n)
  assert.throws(() => list.fill(n1, 11n), Error);

  // Assert — el libro quedó intacto tras todos los rechazos
  assert.equal(list.totalVolume, 20n);
  assert.equal(list.length, 2);
  assert.equal(n1.order.filledQuantity, 0n);
  assert.equal(n3.order.filledQuantity, 0n);
}

// ── Ejecución ────────────────────────────────────────────────────────

console.log("SPRINT 00 — Core Data Structures & Domain Types");
console.log(`Node ${process.version} · type stripping nativo (.ts)`);
console.log("─".repeat(64));

await runTest("T1 · FIFO 100,000 órdenes", t1Fifo100k);
await runTest(
  "T2 · Remove O(1) intermedios + head/tail + doble remove",
  t2RemoveIntermediate,
);
await runTest("T3 · LimitLevel add/remove/isEmpty/totalVolume", t3LimitLevel);
await runTest(
  "T4 · Timing Gate A/B 100k push + 100k remove < 50 ms c/u",
  t4TimingGates,
);
await runTest(
  "T5 · Fill parcial atómico (fill/validaciones/rechazos)",
  t5AtomicPartialFill,
);

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
