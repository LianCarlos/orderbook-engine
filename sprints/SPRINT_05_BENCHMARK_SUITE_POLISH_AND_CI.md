# SPRINT 05 — Benchmark Suite, Polish & CI

| Campo | Valor |
|---|---|
| Estado | 🔒 Congelado (frozen spec) |
| Depende de | SPRINT_04 |
| Rama sugerida | `sprint/05-benchmark-ci` |
| Propietario | ⚛️ nextjs-dev + 🧪 qa-tester + 🔀 integrator |

## 1. Objetivo

Medir y certificar el rendimiento del motor contra los objetivos del proyecto,
pulir los bordes de estabilidad y dejar un gate de CI que impida regresiones de
rendimiento y tipos.

## 2. Alcance / Deliverables

En `scripts/`:

- `benchmark.mjs` completo (reemplaza el stub): escenarios reproducibles —
  add-only, cancel-heavy, mixed match, market burst.
- Métricas por escenario: **órdenes/segundo**, **latencia de match p99**, p50,
  p99.9, y uso de memoria pico.
- Salida en formato tabular + JSON (`bench-results.json`) para CI.

En `.github/workflows/ci.yml`:

- Nuevo job `benchmark`: ejecuta la suite de benchmark y falla si el throughput
  baja más de un 15% respecto a la baseline registrada.
- Mantener jobs `typecheck-and-lint` y `test`.

En `docs/`:

- `docs/PERFORMANCE.md` (o sección en ARCHITECTURE.md): metodología, hardware de
  referencia, baseline y resultados históricos.

## 3. Especificación técnica

- Benchmarks deterministas: seeds fijos, N configurable por CLI (`--orders`,
  `--duration`, `--scenario`).
- Warmup obligatorio (1s mínimo) antes de medir; descartar el primer run.
- Objetivos (baseline a certificar):
  - Throughput ≥ 50,000 órdenes/seg.
  - Match latency p99 ≤ 2 ms.
  - L2 broadcast p99 ≤ 10 ms.
  - Replay de 1M eventos ≤ 30 s.
- Si el hardware local no alcanza el objetivo, documentar el delta y la baseline
  real (no falsear números).

## 4. Criterios de éxito

- [ ] `npm run bench` reproducible con resultados en JSON.
- [ ] CI verde completo (typecheck + lint + tests + benchmark).
- [ ] Documentación de performance publicada con baseline.
- [ ] PR de cierre hacia `main` con revisión de arquitectura aprobada.

## 5. Verificación

```bash
npx tsc --noEmit
npm run lint
npm test
npm run bench -- --orders 100000
```

## 6. Riesgos

- Varianza entre máquinas: fijar hardware de referencia y tolerancia (±15%).
- `better-sqlite3` síncrono puede ser el cuello de botella del WAL: si el
  throughput objetivo no se cumple, evaluar batch-writes y documentar trade-off.
