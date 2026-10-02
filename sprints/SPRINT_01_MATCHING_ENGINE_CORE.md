# SPRINT 01 — Matching Engine Core

| Campo | Valor |
|---|---|
| Estado | 🔒 Congelado (frozen spec) |
| Depende de | SPRINT_00 |
| Rama sugerida | `sprint/01-matching-engine` |
| Propietario | ⚛️ nextjs-dev + 🧪 qa-tester |

## 1. Objetivo

Implementar el motor de calce en memoria que procesa órdenes entrantes contra el
libro aplicando prioridad Precio-Tiempo, con soporte completo de tipos de orden
(`LIMIT`, `MARKET`, `CANCEL`) y Time-in-Force (`GTC`, `IOC`), emitiendo eventos
inmutables que serán la base del WAL (Sprint 02).

## 2. Alcance / Deliverables

En `src/engine/`:

- `events.ts` — tipos de evento de dominio: `order_placed`, `order_matched`,
  `order_cancelled`, `order_rejected` (sin side effects de tiempo/aleatoriedad).
- `matcher.ts` — núcleo del calce: cruzamiento de libro, caminata de niveles,
  generación de `Trade`s parciales y totales.
- `processor.ts` — pipeline de entrada: validar → ejecutar contra el libro →
  emitir eventos → devolver resultado determinista.
- `policies.ts` — reglas GTC/IOC y manejo de restos (IOC: descartar resto sin
  persistir; GTC: resto al libro).

Tests:

- Escenarios de cruce: match parcial, match total, multi-nivel.
- `MARKET` sin liquidez → rechazo; `IOC` con resto → resto descartado.
- `CANCEL` sobre orden inexistente → evento de rechazo idempotente.
- Self-trade prevention (misma `traderId` no se cruza consigo misma).

## 3. Especificación técnica

- El motor **no** persiste ni transmite: consume el libro y devuelve
  `{ events, trades }`. Side effects (WAL, broadcast, ledger) se conectan en
  sprints posteriores como listeners de eventos.
- Cada evento lleva `sequence` monotónico global y `prevSequence` (cadena
  verificable para el WAL).
- Complejidad por orden: O(K log N) donde K = niveles tocados; target de
  asignación: el matcher debe poder hacer match contra un nivel en O(M) con M =
  órdenes ejecutadas en ese nivel.

## 4. Criterios de éxito

- [ ] 100% de escenarios de test definidos en verde.
- [ ] El estado del libro tras N operaciones es idéntico al de un re-juego de
  eventos (propiedad de determinismo verificada por test).
- [ ] `npx tsc --noEmit` limpio; sin `any` en la superficie pública del motor.

## 5. Verificación

```bash
npx tsc --noEmit
npm run lint
npm test -- engine
```

## 6. Riesgos

- Orden de desempate Precio-Tiempo incorrecto en igualdad de precio (validar con
  tests explícitos de `sequence`).
- Market orders que crucen niveles vacíos parcialmente (estado del libro inválido).
