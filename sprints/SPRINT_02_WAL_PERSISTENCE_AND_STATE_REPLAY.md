# SPRINT 02 — WAL Persistence & State Replay

| Campo | Valor |
|---|---|
| Estado | 🔒 Congelado (frozen spec) |
| Depende de | SPRINT_01 |
| Rama sugerida | `sprint/02-wal-persistence` |
| Propietario | 🗃️ sqlite-dev + ⚛️ nextjs-dev |

## 1. Objetivo

Persistir todos los eventos del motor en un **Write-Ahead Log** append-only sobre
SQLite (`better-sqlite3`) y garantizar la **reconstrucción determinista** del libro
en arranque mediante replay de eventos, incluyendo snapshot + compactación.

## 2. Alcance / Deliverables

En `src/storage/`:

- `client.ts` — cliente singleton de `better-sqlite3` (patrón `globalThis` para
  evitar `database is locked` con HMR de Next.js; `serverExternalPackages:
  ['better-sqlite3']` ya configurado en `next.config.ts`).
- `schema.ts` + migraciones `drizzle-orm` — tablas `events` (append-only) y
  `snapshots`.
- `wal.ts` — append atómico de eventos con `checksum`, `sequence` y `prevSequence`;
  verificación de cadena en lectura.
- `replay.ts` — reconstructor: aplica eventos en orden sobre un libro virgen y
  produce el mismo estado (bit a bit comparable) que el motor en vivo.
- `snapshot.ts` — toma y carga de snapshots con compactación de eventos antiguos.

Tests:

- Replay de 10k eventos generados → estado idéntico al libro en vivo.
- Cadena rota (checksum inválido / hueco de `sequence`) → detección y error claro.
- Reinicio simulado (nuevo proceso → misma DB) reconstruye el libro.
- Crash-safety: transacción parcial no contamina el WAL.

## 3. Especificación técnica

- WAL en modo append-only; escrituras en transacción SQLite por evento o lote.
- `events` con columnas: `sequence INTEGER PRIMARY KEY`, `prev_sequence`,
  `type TEXT`, `payload JSON`, `checksum TEXT`, `created_at_ms` (default dinámico
  `unixepoch()*1000`, no literal congelado por drizzle-kit).
- Determinismo: `payload` nunca contiene timestamps de reloj ni aleatoriedad;
  solo datos del dominio + `sequence`.
- Replay en un único pasada, O(E) con E eventos.

## 4. Criterios de éxito

- [ ] Replay determinista verificado por test (hash del estado del libro).
- [ ] WAL detecta corrupción y emite error tipado (sin crash silencioso).
- [ ] `npx tsc --noEmit` limpio; tipos regenerados y consistentes.

## 5. Verificación

```bash
npx tsc --noEmit
npm run lint
npm test -- storage
```

## 6. Riesgos

- `better-sqlite3` es síncrono: no bloquear el event loop con batches gigantes
  (se fija tamaño máximo de lote y se mide en Sprint 05).
- Migraciones de drizzle: usar default dinámico SQL (lección aprendida del repo
  anterior: `.default()` congela el timestamp en generate).
