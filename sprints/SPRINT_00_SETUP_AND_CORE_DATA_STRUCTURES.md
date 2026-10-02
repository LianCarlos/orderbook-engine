# SPRINT 00 — Setup & Core Data Structures

| Campo | Valor |
|---|---|
| Estado | 🔒 Congelado (frozen spec) |
| Depende de | — |
| Rama sugerida | `sprint/00-core-data-structures` |
| Propietario | ⚛️ nextjs-dev + 🧪 qa-tester |

## 1. Objetivo

Definir el contrato de tipos del dominio y las estructuras de datos núcleo del libro
de órdenes con TypeScript estricto, garantizando desde el primer día la complejidad
requerida por la arquitectura:

- **O(1)** — consulta del mejor precio (best bid / best ask).
- **O(log N)** — localizar / insertar / eliminar un nivel de precio.
- **O(1)** — encolar / desencolar órdenes dentro de un nivel (FIFO Price-Time).

## 2. Alcance / Deliverables

En `src/core/`:

- `types.ts` — tipos del dominio: `OrderSide`, `OrderType` (`LIMIT`, `MARKET`, `CANCEL`),
  `TimeInForce` (`GTC`, `IOC`), `Order`, `LimitLevel`, `OrderBookSnapshot`, `Trade`.
- `price-time.ts` — comparador de prioridad Precio-Tiempo y generador de
  `sequence` monotónico por orden (base del determinismo).
- `levels.ts` — estructura de niveles de precio (árbol balanceado o skiplist) con
  punteros a extremos para best bid/ask en O(1).
- `orderbook.ts` — fachada del libro: insertar/cancelar/consultar niveles.
- `validation.ts` — esquemas `zod` de validación de entrada para todos los tipos.

Tests (patrón AAA, 3 capas):

- Unit tests de `price-time.ts` (ordenamiento estricto, desempate por tiempo).
- Unit tests de `levels.ts` (inserción, borrado, predecesor/sucesor).
- Property-based básico (generación de secuencias válidas de precios).

## 3. Especificación técnica

- **Price-Time Priority:** primero el mejor precio (bids desc, asks asc); dentro del
  mismo precio, FIFO por `sequence` monotónico.
- **Estructura de niveles:** mapa interno de O(1) por precio + árbol ordenado de
  precios para O(log N); cada `LimitLevel` mantiene `head`/`tail` para O(1) en cola.
- **Prohibido** usar `Date.now()` o `Math.random()` en la lógica del libro: toda
  orden lleva `sequence` explícito (determinismo exigido por el WAL en Sprint 02).
- Tipos inmutables en el dominio público; mutabilidad interna aislada en `levels.ts`.

## 4. Criterios de éxito

- [ ] `npx tsc --noEmit` limpio con `strict: true`.
- [ ] Tests unitarios del dominio en verde.
- [ ] Best bid/ask se actualiza correctamente al vaciar un nivel.
- [ ] Un nivel con N órdenes se recorre en orden exacto de llegada.

## 5. Verificación

```bash
npx tsc --noEmit
npm run lint
npm test -- core
```

## 6. Riesgos

- Elegir una estructura de niveles que luego no soporte streaming incremental (validar
  iteración ordenada ascendente y descendente).
- Acoplar tipos a zod en lugar de derivar los tipos desde zod (se decidirá y fijará
  en este sprint para todo el proyecto).
