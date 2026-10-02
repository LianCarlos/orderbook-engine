# Hoja de Ruta Congelada — Orderbook & Matching Engine

> **Estado:** 🔒 CONGELADA (frozen). Cualquier cambio de alcance requiere revisión del CTO.
> **Base de integración:** `main` (sprints cortos con PR individual).

## Resumen

Proyecto 02: motor de calce de órdenes en memoria con prioridad **Precio-Tiempo**,
persistencia **WAL + Event Sourcing** sobre SQLite, **ledger de doble entrada** para
liquidación atómica Maker/Taker, **streaming L2/L3** en tiempo real y **suite de
benchmarks** con métricas de throughput y latencia p99.

La hoja de ruta se ejecuta en 6 sprints secuenciales. Cada sprint entrega código
compilable (`npx tsc --noEmit` limpio), tests en verde y documentación actualizada.

## Roadmap

| Sprint | Tema | Depende de | Foco principal |
|---|---|---|---|
| `SPRINT_00` | Setup & Core Data Structures | — | Tipos estrictos del libro, Price-Time Priority, estructuras O(1)/O(log N) |
| `SPRINT_01` | Matching Engine Core | Sprint 00 | Calce LIMIT/MARKET/CANCEL con GTC/IOC |
| `SPRINT_02` | WAL Persistence & State Replay | Sprint 01 | Append-only log, replay determinista, snapshot |
| `SPRINT_03` | Double-Entry Settlement Ledger | Sprint 02 | Reserva y liquidación atómica Maker/Taker |
| `SPRINT_04` | L2 Orderbook Streaming API | Sprint 03 | SSE/WebSocket de profundidades, visual Next.js |
| `SPRINT_05` | Benchmark Suite, Polish & CI | Sprint 04 | órdenes/seg, p99, gate de CI |

## Definition of Done (global, aplica a todos los sprints)

1. `npx tsc --noEmit` pasa limpio (TypeScript estricto).
2. `npm run lint` pasa sin errores ni warnings.
3. Tests de la capa correspondiente en verde (`npm test`).
4. Documentación técnica sincronizada (`docs/ARCHITECTURE.md` si aplica).
5. PR de sprint revisado por arquitectura antes de merge a `main`.

## Verificación mínima por sprint

```bash
npx tsc --noEmit
npm run lint
npm test
```

## Especificaciones por sprint

- [SPRINT_00 — Setup & Core Data Structures](./SPRINT_00_SETUP_AND_CORE_DATA_STRUCTURES.md)
- [SPRINT_01 — Matching Engine Core](./SPRINT_01_MATCHING_ENGINE_CORE.md)
- [SPRINT_02 — WAL Persistence & State Replay](./SPRINT_02_WAL_PERSISTENCE_AND_STATE_REPLAY.md)
- [SPRINT_03 — Double-Entry Settlement Ledger](./SPRINT_03_DOUBLE_ENTRY_SETTLEMENT_LEDGER.md)
- [SPRINT_04 — L2 Orderbook Streaming API](./SPRINT_04_L2_ORDERBOOK_STREAMING_API.md)
- [SPRINT_05 — Benchmark Suite, Polish & CI](./SPRINT_05_BENCHMARK_SUITE_POLISH_AND_CI.md)
