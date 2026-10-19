# Performance — Baseline real y análisis (2026-10-18)

> **Estado del documento:** baseline empírica del SPRINT 05 medida el **2026-10-18** en el hardware de pruebas descrito. Todas las cifras provienen de las dos corridas de `scripts/benchmark.mjs` registradas aquí. No se extrapolan ni ajustan resultados; las métricas que no fueron medidas se marcan como **no verificadas**.
>
> Este documento no certifica los objetivos del sprint: documenta el delta real entre la baseline medida y esos objetivos, tal como exige la especificación del SPRINT 05.

## Resumen ejecutivo

| Pregunta | Resultado |
| --- | --- |
| Throughput vs objetivo | **No cumple.** 127 ord/s (Run A) y 174 ord/s (Run B) frente a ≥50,000 ord/s. |
| p99 vs objetivo de match | **No certificable.** El p99 medido es E2E (17.172 ms / 12.575 ms) e incluye WAL+ledger; no es latencia de matching pura. |
| Fugas de memoria | **No detectadas** en ninguna corrida, según el criterio del script (delta post-GC ≤64 MB). |
| Consistencia del ledger | **Correcta:** 0 descuadres en ambas corridas; 0 divergencias de memoria en Run A. |
| Gate de CI de performance | **No implementado:** el job es informativo (`continue-on-error`) y no compara baseline. |
| L2 broadcast p99 y replay 1M | **No medidos** en esta baseline. |

## Metodología

### Entorno de pruebas

| Componente | Valor |
| --- | --- |
| Fecha de medición | 2026-10-18 |
| SO | Linux |
| CPU | Intel Core i3-7100U CPU @ 2.40 GHz (4 hilos) |
| Node.js | v24.12.0 |
| better-sqlite3 | 12.11.1 |
| SQLite `journal_mode` | `wal` |
| Ubicación | Equipo local de pruebas; **no** es el runner de CI |

### Ejecución real

El entrypoint es `scripts/benchmark.mjs`. El script de `package.json` lo ejecuta con GC expuesto:

```bash
npm run bench -- --orders 100000
# equivale a: node --expose-gc scripts/benchmark.mjs --orders 100000
```

Flags disponibles en el script actual: `--orders` (default 100,000) y `--users` (default 10,000). No hay selección de escenario ni de duración por CLI. El script aborta si no está disponible `globalThis.gc`; por eso `--expose-gc` es obligatorio.

La base de datos es temporal (directorio temporal del sistema operativo) y se elimina al finalizar. El benchmark no abre conexiones de red ni toca la base del motor real.

### Carga y warmup

- **Setup fuera de medición:** `--users` usuarios reciben depósitos USD/BTC en una única transacción.
- **Warmup obligatorio y descartado:** `max(1,000, floor(N/20))` órdenes. Run A (100k): 5,000; Run B (20k): 1,000. Es un warmup por cantidad de órdenes, no por tiempo.
- **Semillas deterministas:** `0xaa01` para warmup y `0x5eed05` para la carga medida.
- **Mezcla de la carga medida:** 20% cancelaciones (si hay órdenes vivas), resto órdenes nuevas; 75% LIMIT entre las nuevas; LIMIT con GTC/IOC 75/25; MARKET con IOC; precios 95–105 y cantidades 1–10; usuario elegido al azar entre los `--users`.
- **Transacción por comando:** cada orden se ejecuta con `ExecutionPipeline.executeOrder`; las cancelaciones usan una transacción directa con `ORDER_CANCEL` + release + `cancelOrder`, porque el pipeline no expone una operación de cancelación.

### Métricas capturadas

| Métrica | Cómo se obtiene |
| --- | --- |
| Throughput | `N / (tiempo total medido)`; `N` es el número de comandos del bucle (órdenes nuevas + cancelaciones) |
| Latencia E2E | `performance.now()` alrededor de cada comando; percentiles P50/P90/P99/P99.9/max sobre todas las muestras |
| Memoria | `heapUsed` antes, post-warmup y post-`gc()`; muestras cada 10,000 órdenes |
| Fuga | Delta post-GC vs antes; el script considera fuga si supera 64 MB |
| SQLite I/O | Tamaño de DB y WAL antes/después; `journal_mode` |
| Ledger | `audit()`: transacciones descuadradas y divergencias de memoria |
| Salida | Tabla en consola + `bench-results.json` (gitignored) |

### Alcance y límites

- La latencia reportada es **E2E por comando**: incluye append al WAL, holds/reservas, matching en memoria, liquidación del ledger y commit SQLite. **No** aísla el tiempo de `MatchingEngine.processOrder`.
- La suite actual ejecuta una **carga mixta única**; la spec del sprint pedía una suite de escenarios separados. No hay medición separada por escenario ni de broadcast L2.
- No se mide el replay de 1M eventos en este benchmark.
- `bench-results.json` se escribe en el directorio de ejecución y está en `.gitignore`; no hay baseline histórica versionada en el repositorio.

## Resultados

### Run A — 100,000 órdenes

> **Procedencia de las cifras:** provienen de la salida de consola del benchmark ejecutado el 2026-10-18. Su JSON no está versionado: `bench-results.json` está en `.gitignore` y actualmente contiene los resultados de Run B (20k).

#### Throughput y latencia E2E — Run A

| Métrica | Valor |
| --- | --- |
| Órdenes medidas | 100,000 |
| Usuarios | 10,000 |
| Warmup | 5,000 |
| Throughput | 127 ord/s |
| Tiempo total medido | 786,551 ms (≈13.1 min) |
| Latencia E2E P50 | 7.985 ms |
| Latencia E2E P90 | 13.504 ms |
| Latencia E2E P99 | 17.172 ms |
| Latencia E2E P99.9 | 29.556 ms |
| Latencia E2E max | 77.639 ms |

#### Memoria — Run A

| Métrica | Valor |
| --- | --- |
| `heapUsed` antes (post-setup, pre-warmup) | 17.5 MB |
| `heapUsed` post-warmup | 11.5 MB |
| `heapUsed` post-GC | 21.8 MB |
| Fuga post-GC | 4.30 MB (sin fugas) |
| Pico muestreado (cada 10k) | ~105.4 MB |

#### SQLite — Run A

| Métrica | Valor |
| --- | --- |
| DB | 4 KB → 89,616 KB |
| WAL | 3,378,432 → 4,181,832 bytes (~3.3 → 4.1 MB) |
| `journal_mode` | `wal` |

> La DB y el WAL se miden por separado. El valor inicial de 4 KB corresponde al archivo `.db`; el WAL ya contiene ~3.3 MB tras el setup. El script no fuerza un checkpoint antes de medir.

#### Consistencia y workload — Run A

| Métrica | Valor |
| --- | --- |
| Ledger | 0 transacciones descuadradas · 0 divergencias de memoria |
| Cancelaciones | 17,159 |
| Trades | 36,392 |
| Órdenes resting | 1 |

### Run B — 20,000 órdenes

Run B usa la carga del job de CI (`--orders 20000`), pero se midió en el mismo equipo local con Node v24.12.0; **no** se ejecutó en `ubuntu-latest` ni con Node 22.

#### Throughput y latencia E2E — Run B

| Métrica | Valor |
| --- | --- |
| Órdenes medidas | 20,000 |
| Usuarios | 10,000 (default de `--users`; la corrida se describe como cambio solo de N) |
| Warmup | 1,000 |
| Throughput | 174 ord/s |
| Tiempo total medido | 115,206.890061 ms (≈115.2 s) |
| Latencia E2E P50 | 6.049 ms |
| Latencia E2E P90 | 9.067 ms |
| Latencia E2E P99 | 12.575 ms |
| Latencia E2E P99.9 | 18.152 ms |
| Latencia E2E max | 36.518 ms |

#### Memoria — Run B

| Métrica | Valor |
| --- | --- |
| `heapUsed` antes (post-setup, pre-warmup) | 17.6 MB |
| `heapUsed` post-warmup | 11.4 MB |
| `heapUsed` post-GC | 13.7 MB |
| Fuga post-GC | −3.95 MB (sin fugas) |
| Pico muestreado | 45.53 MB (muestra a las 10k órdenes; a las 20k fue 28.47 MB) |

#### SQLite — Run B

| Métrica | Valor |
| --- | --- |
| DB | 4 KB → 20,224 KB |
| WAL | ~3.3 MB → 4.1 MB |
| `journal_mode` | `wal` |

#### Consistencia — Run B

| Métrica | Valor |
| --- | --- |
| Ledger | 0 descuadres |
| Workload (cancelaciones/trades/resting) | 3,421 cancelaciones · 7,227 trades · 1 orden resting |

### Comparativa Run A vs Run B

| Métrica | Run A (100k) | Run B (20k) | Delta |
| --- | --- | --- | --- |
| Throughput | 127 ord/s | 174 ord/s | **+37%** |
| Latencia E2E P99 | 17.172 ms | 12.575 ms | **−27%** |
| Latencia E2E P50 | 7.985 ms | 6.049 ms | — |
| Fuga post-GC | 4.30 MB | −3.95 MB | sin fugas en ambas |
| Ledger | 0 descuadres · 0 divergencias | 0 descuadres | consistente |

> Misma máquina, mismo Node y misma versión de better-sqlite3; solo cambia N (y el warmup asociado).

### Historial de baseline

| Fecha | Entorno | N | Throughput | P99 E2E | Corrida |
| --- | --- | --- | --- | --- | --- |
| 2026-10-18 | i3-7100U · Node 24.12.0 · better-sqlite3 12.11.1 | 100,000 | 127 ord/s | 17.172 ms | Run A |
| 2026-10-18 | i3-7100U · Node 24.12.0 · better-sqlite3 12.11.1 | 20,000 | 174 ord/s | 12.575 ms | Run B |

> Primera baseline registrada. En futuras corridas, añadir una fila con fecha, entorno, N, throughput y p99; no borrar corridas anteriores. Si cambia el hardware o la versión de Node/better-sqlite3, registrar un entorno nuevo.

## Comparación con objetivos del Sprint 05

| Objetivo | Umbral | Run A | Run B | Veredicto |
| --- | --- | --- | --- | --- |
| Throughput | ≥50,000 ord/s | 127 ord/s (0.25% del objetivo) | 174 ord/s (0.35% del objetivo) | ❌ No cumple |
| Match latency p99 | ≤2 ms | 17.172 ms E2E (~8.6x) | 12.575 ms E2E (~6.3x) | ❌ No certificable; E2E muy por encima |
| L2 broadcast p99 | ≤10 ms | no medido | no medido | ⚠️ No verificado |
| Replay 1M eventos | ≤30 s | no medido | no medido | ⚠️ No verificado |

> Los porcentajes y factores de esta tabla son aritmética directa sobre las cifras medidas y los umbrales de la spec; no son mediciones adicionales.
>
> La comparación de p99 es conservadora: el umbral de 2 ms es de **matching puro**, mientras que el valor medido es **E2E** e incluye WAL+ledger. Aun así, el p99 E2E es ~8.6x y ~6.3x el umbral, por lo que no hay evidencia de cumplimiento.

**Conclusión de la comparación:** el entorno de pruebas no cumple la baseline objetivo. La spec del SPRINT 05 exige documentar el delta y la baseline real en lugar de falsear números; este documento cumple esa exigencia. Los objetivos de L2 y replay quedan pendientes de medición.

## Análisis del cuello de botella (fsync WAL)

### Evidencia: P50 ≈ 1/throughput

| Corrida | Throughput | 1/throughput | P50 E2E |
| --- | --- | --- | --- |
| Run A | 127 ord/s | ~125 ord/s (1 / 7.985 ms) | 7.985 ms |
| Run B | 174 ord/s | ~165 ord/s (1 / 6.049 ms) | 6.049 ms |

La cercanía entre el tiempo medio por comando y el P50 es consistente con un **costo fijo dominante por comando**. La latencia E2E incluye WAL+ledger; el matching puro no está aislado.

### Ruta de código y costos por comando

- `ExecutionPipeline.executeOrder` abre **una transacción SQLite por orden**. Dentro de ella: `ORDER_NEW` al WAL, hold de fondos, `processOrder` en memoria, `TRADE_MATCH` por cada trade, liquidación en el ledger y liberación de remanentes.
- Las cancelaciones también se ejecutan en **una transacción por comando**: `ORDER_CANCEL`, release de fondos y `cancelOrder`.
- `WalLogger` serializa el payload de forma determinista y calcula un **SHA-256 por evento** para la cadena de hashes.
- `better-sqlite3` es síncrono y usa una única conexión; la base se abre con `journal_mode=WAL` y `synchronous=NORMAL`.

Por tanto, cada comando paga: serialización/hash, inserts del WAL, operaciones del ledger, commit SQLite y, si corresponde, checkpoints/sincronización. **La proporción de cada componente no está medida.**

### Hipótesis fsync/commit y matiz de `synchronous=NORMAL`

**Hipótesis:** el costo dominante es el commit/sincronización por transacción. El patrón P50 ≈ 1/throughput es consistente con un fsync/commit síncrono por comando.

**Matiz verificado en código:** `openDatabase` configura `journal_mode=WAL` y `synchronous=NORMAL`. En WAL+NORMAL, SQLite no garantiza un fsync en cada commit; la sincronización del WAL ocurre en checkpoints. En consecuencia:

- La atribución exacta al fsync **no está probada** por este benchmark.
- En WAL+NORMAL el commit es consistente, pero **no garantiza durabilidad ante caída de energía**; para durabilidad estricta por commit habría que usar `synchronous=FULL`. No se ha medido el costo de ese cambio.
- Para cuantificar el componente de sincronización hay que instrumentar o comparar `synchronous=FULL`, `NORMAL` y `OFF` con la misma carga, y medir checkpoints/IO. `OFF` no es aceptable para producción sin un análisis explícito de durabilidad.

Lo que sí está verificado es el costo por comando y la forma de la distribución. **El matching en memoria no está aislado**; no se puede afirmar que cumpla o incumpla los 2 ms con esta métrica.

### Qué falta para aislar el cuello de botella

- Medir la latencia del matching en memoria sin SQLite (engine-only) y reportarla separada de la E2E.
- Medir por separado el append al WAL y el commit SQLite.
- Comparar los modos de `synchronous` con la misma carga y el mismo hardware.
- Evaluar batch-writes/group commit y verificar que se mantienen atomicidad, rollback y auditoría del ledger.
- Medir la actividad de checkpoints y el crecimiento de DB/WAL durante la corrida.

## Varianza y su impacto en el baseline de CI

| Comparación | Run A | Run B | Delta | Tolerancia de la spec |
| --- | --- | --- | --- | --- |
| Throughput | 127 ord/s | 174 ord/s | **+37%** | ±15% |
| Latencia E2E P99 | 17.172 ms | 12.575 ms | **−27%** | ±15% |

Ambos deltas superan la tolerancia de ±15%. La comparación es en la misma máquina, con el mismo Node y la misma versión de better-sqlite3; solo cambia N (100k → 20k) y el warmup (5,000 → 1,000).

**Conclusión:** un baseline absoluto fijo entre hardware heterogéneo **no es viable**. Incluso en la misma máquina, el resultado depende de N. Las causas exactas no están instrumentadas; los datos correlacionan con un tamaño final de DB mucho menor en Run B (20,224 KB vs 89,616 KB), distinta duración de corrida (Run B: 115.2 s) y distinta proporción de warmup (5,000 → 1,000). No se atribuye causalidad sin medición.

**Implicación para CI:** comparar contra una baseline del **mismo runner**, con el mismo N, las mismas versiones de Node/better-sqlite3 y el mismo warmup; o normalizar explícitamente. Un umbral absoluto copiado de este equipo no es válido para `ubuntu-latest`.

Run B usa la carga del job de CI (`--orders 20000`), pero se midió en el equipo local con Node 24.12.0, no en `ubuntu-latest` con Node 22. No debe tratarse como baseline del runner de CI.

## Estado del gate de CI (deuda)

| Elemento | Estado actual | Evidencia | Consecuencia |
| --- | --- | --- | --- |
| Job `benchmark` | Existe, informativo | `.github/workflows/ci.yml` | No bloquea el pipeline |
| Carga ejecutada | `--orders 20000` | workflow | No se mide la carga completa de 100k en CI |
| Comparación contra baseline | No implementada | no hay step de comparación | El gate de −15% de la spec no existe |
| Artefacto | `bench-results.json` | `actions/upload-artifact` | Es efímero; no hay baseline versionada |
| Runtime | Node 22 / `ubuntu-latest` | workflow | No comparable directamente con la baseline local (Node 24.12.0) |

**Deuda declarada:** el gate de regresión del −15% que pide la spec **no está implementado**. El job `benchmark` usa `continue-on-error: true`, por lo que un fallo del benchmark no bloquea el pipeline, y no hay ningún step que lea una baseline ni compare throughput. `bench-results.json` se sube como artefacto, pero está en `.gitignore` y no se versiona como baseline.

**Consecuencia:** hoy no hay protección automática contra regresiones de performance. Los criterios de éxito del sprint ("CI verde completo...") no equivalen a un gate de performance mientras el job siga siendo `continue-on-error`.

## Recomendaciones

| Prioridad | Recomendación | Evidencia / motivo | Cómo verificarla |
| --- | --- | --- | --- |
| Alta | Separar la latencia de matching puro de la latencia E2E | El p99 medido incluye WAL+ledger y el objetivo es match p99 | Medir engine-only sin SQLite y reportar ambas métricas |
| Alta | Evaluar batch-writes/group commit | Una transacción por comando; P50 ≈ 1/throughput | A/B con mismo N y hardware; verificar throughput, p99, atomicidad y ledger |
| Alta | Implementar el gate real de CI | `continue-on-error: true` y sin comparación de baseline | Baseline por runner + comparación + job bloqueante cuando sea estable |
| Media | Medir replay de 1M eventos y L2 broadcast p99 | Objetivos del sprint no medidos | Harness dedicado; documentar resultados y entorno |
| Media | Cuantificar el trade-off de `synchronous` | `NORMAL` ya está activo; el fsync no está aislado | Comparar `FULL`/`NORMAL`/`OFF` con misma carga y analizar durabilidad |
| Media | Baseline normalizada por runner | +37%/−27% en la misma máquina supera ±15% | Fingerprint de hardware/versiones, mismo N y warmup, mediana de varias corridas |
| Baja | Añadir versión de better-sqlite3/SQLite al JSON | El JSON registra hardware, Node, N, usuarios y warmup, pero no la versión de better-sqlite3 | Extender `meta` (no implementado) |

> No se prometen mejoras: cada recomendación es una hipótesis a medir. Cualquier cambio debe validarse con la misma carga y compararse contra esta baseline en el mismo entorno.

## Referencias

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — arquitectura, transacción por comando, WAL y ledger.
- [`docs/SECURITY.md`](./SECURITY.md) — benchmark sin credenciales, DB temporal e integridad.
- [`sprints/SPRINT_05_BENCHMARK_SUITE_POLISH_AND_CI.md`](../sprints/SPRINT_05_BENCHMARK_SUITE_POLISH_AND_CI.md) — objetivos y criterios del sprint.
- [`scripts/benchmark.mjs`](../scripts/benchmark.mjs) — implementación de la suite de benchmarks.
- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — job de benchmark y estado del gate.
- [`README.md`](../README.md) — objetivos de rendimiento y scripts del proyecto.
