# SPRINT 04 — L2 Orderbook Streaming API

| Campo | Valor |
|---|---|
| Estado | 🔒 Congelado (frozen spec) |
| Depende de | SPRINT_03 |
| Rama sugerida | `sprint/04-l2-streaming` |
| Propietario | ⚛️ nextjs-dev + 🎨 ui-designer |

## 1. Objetivo

Exponer el libro en tiempo real: API local de ingreso de órdenes (Route Handlers),
streaming **L2** (profundidad agregada por precio) y **L3** (orden a orden) vía
SSE/WebSocket, y una interfaz Next.js 16 de visualización en vivo.

## 2. Alcance / Deliverables

En `src/api/`:

- `routes.ts` — Route Handlers: `POST /api/orders` (ingreso validado con zod),
  `GET /api/book/snapshot` (estado completo), `DELETE /api/orders/:id` (cancel).
- `broadcast.ts` — hub de suscriptores con backpressure básico.
- `stream.ts` — endpoints SSE `/api/stream/l2` y `/api/stream/l3` con protocolo
  snapshot + deltas (`snapshot`, `diff`, `heartbeat`).
- `reconcile.ts` — reconciliación de profundidad si un cliente pierde deltas
  (vuelve a pedir snapshot).

En `src/app/` (visual, delegado a 🎨 ui-designer con Contrato de Datos):

- Página de libro: tabla de bids/asks, último precio, profundidad con Tailwind.
- Conexión SSE en cliente con reconexión automática y estado de conexión.

Tests:

- Snapshot + secuencia de deltas reconstruye el libro exacto (propiedad).
- Validación zod rechaza órdenes malformadas con 400 tipado.
- Cliente SSE se reconecta y resincroniza tras desconexión.
- Tests de integración del flujo completo: orden → match → delta emitido.

## 3. Especificación técnica

- Streaming **local** (bind a localhost); sin autenticación en este sprint pero
  con rate limiting básico (Sprint de seguridad futura).
- Deltas referencian `sequence` del WAL para deduplicación del lado cliente.
- L2 agrupa por nivel de precio; L3 expone órdenes individuales (solo libro
  público, sin `traderId` en el payload de streaming).
- Backpressure: si un cliente va lento, se descarta la conexión y se le notifica
  para resincronizar (nunca bloquear el motor).

## 4. Criterios de éxito

- [ ] Flujo end-to-end en verde (POST orden → match → SSE delta → UI actualizada).
- [ ] Latencia de broadcast objetivo p99 ≤ 10 ms (medida en Sprint 05).
- [ ] `npx tsc --noEmit` limpio.

## 5. Verificación

```bash
npx tsc --noEmit
npm run lint
npm test -- api
npm run dev   # verificación manual de la visualización
```

## 6. Riesgos

- SSE en Next.js: asegurar `export const dynamic` / streaming sin caché de ruta.
- UI debe degradar con gracia si el stream cae (estado visible de reconexión).
