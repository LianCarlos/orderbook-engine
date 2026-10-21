# Seguridad — High-Throughput In-Memory Orderbook & Matching Engine

> **Estado del documento:** Documento alineado con la implementación — actualizado 2026-10-21; verificado por las suites test-sprint-02 / 02.5 / 03.

## 1. Alcance y modelo de amenazas

El motor es, por defecto, un componente **local**: bind a `localhost`, sin exposición a red externa, sin credenciales de producción. Las amenazas principales en este modelo son:

- **Corrupción o manipulación del log de eventos** (integridad de la fuente de verdad).
- **Deriva no determinista** del estado reconstruido (integridad lógica).
- **Entrada malformada** que degrade o rompa el motor (DoS local, estados inválidos).
- **Abuso del canal de streaming** (agotamiento de recursos).
- **Ledger inconsistente** por fallo parcial o bug (integridad financiera).

## 2. Integridad del WAL (Event Log)

- **Hash chain SHA-256 por evento:** cada fila de `events_log` publica `hash = SHA256(sequence|prev_hash|event_type|payload)` y enlaza con el `prev_hash` del evento anterior. El payload entra al hash EXACTAMENTE como el string JSON persistido (serialización determinista, bigint → string). Un WAL vacío usa `GENESIS_HASH` = 64 ceros hexadecimales como `prev_hash` del primer evento.
- **Sin triggers de inmutabilidad en `events_log`:** a diferencia del ledger, la tabla de eventos no rechaza `UPDATE`/`DELETE` a nivel SQLite. La manipulación directa se **detecta en el replay** al recalcular la cadena: una edición de `payload`, `event_type`, `sequence` o `hash` rompe la verificación y lanza `WalCorruptionError` (`kind: "prev_hash"` o `kind: "hash"`) con la secuencia exacta. Prueba: `test-sprint-02-hardening` ejecuta un `UPDATE` sobre el payload de la fila 500 y verifica el error tipado.
- **Detección de corrupción:** en el arranque, todo evento re-aplicado se verifica contra la cadena antes de tocar el motor. Una discrepancia **detiene el arranque** y activa el protocolo de reparación; nunca se arranca con estado dudoso. Las filas legacy sin `hash` (previas al Sprint 02.5) se tratan como cadena rota (fail-closed).
- **Protocolo de reparación:**
  1. Detectar la corrupción por la falla tipada (`WalCorruptionError`), identificando la secuencia ofensora.
  2. Cargar el snapshot más reciente con `state_hash` y `wal_anchor_hash` verificados (ver §3).
  3. Re-ejecutar en orden los eventos posteriores al snapshot, auditando la hash chain en cada fila.
  4. Si el ancla del snapshot no coincide con el WAL, descartar el snapshot y hacer replay completo desde el evento 0.
  5. Nunca reparar in-place: la recuperación reconstruye el estado desde WAL/snapshot; el código solo agrega eventos nuevos, no reescribe filas.

## 3. Determinismo del replay como propiedad de seguridad

- **Regla dura:** prohibido `Date.now()` y `Math.random()` en payloads de eventos y en cualquier cálculo que afecte el estado reconstruido. La única fuente de orden es el `sequence` monotónico.
- **Fuente de tiempo única:** los timestamps logísticos (`created_at`) se generan en el servidor fuera del payload y no participan en la reconstrucción del estado.
- **Anclaje y verificación de snapshots:** cada snapshot guarda `state_hash = SHA256(wal_anchor_hash + last_sequence + state_data)` y `wal_anchor_hash` (el `hash` SHA-256 del evento `last_sequence`). Antes de restaurar, el replay verifica ambos: un `state_hash` que no coincide lanza `SnapshotCorruptionError` y aborta; un ancla desacoplada del WAL lanza `SnapshotAnchorMismatchError` y fuerza replay completo desde el evento 0. Una discrepancia es una **alarma de seguridad** (corrupción lógica o manipulación), no un warning cosmético.
- **Retención:** máximo 3 snapshots; al tomar uno nuevo se eliminan los más antiguos por `last_sequence` y `created_at`.
- **Reproducibilidad total:** dos replays del mismo log íntegro deben producir estados idénticos byte a byte (propiedad testeada en SPRINT_02).

## 4. Validación de entrada con zod en el límite de la API

- Toda orden se valida con un esquema zod **antes de tocar el motor**: side, type, time-in-force, precio y cantidad como enteros de escala fija, y campos desconocidos rechazados (`strict`).
- **Rechazo temprano:** payload malformado → respuesta 4xx sin efectos: no se escribe en el WAL, no se reserva fondo, no se toca el libro.
- **Límites de tamaño:** tamaño máximo de payload (por ejemplo 10 KB) y límites de cantidad/precio para evitar enteros desbordados o valores absurdos.
- **Sin floats para dinero:** los precios/cantidades entran como enteros de escala fija; zod normaliza y rechaza representaciones ambiguas.

## 5. Rate limiting del servidor de streaming

- **Límite de conexiones por IP** (por ejemplo 5 conexiones simultáneas) y máximo global de suscriptores.
- **Límite de mensajes por conexión** y de suscripciones/re-suscripciones por minuto para evitar bucles de reconexión y tráfico de snapshot amplificado.
- **Heartbeats** periódicos con el `seq` actual para cerrar conexiones muertas y liberar buffers.
- **Backpressure** con buffers acotados: un suscriptor lento se desconecta con código "re-suscríbete"; el motor de matching nunca se bloquea por un consumidor.
- El stream solo transporta datos de mercado (niveles, órdenes, eventos): **sin secretos, tokens ni datos de cuentas del ledger**.

## 6. Aislamiento local (sin exposición a red por defecto)

- Todos los modos (dev, start, bench) hacen **bind a `127.0.0.1` por defecto**. La exposición en otra interfaz solo es posible mediante variable de entorno explícita (`HOST`) revisada en cada sprint.
- La base SQLite (log + ledger) vive en el filesystem local con permisos restringidos al usuario del proceso.
- **Benchmark sin red:** la suite de benchmarks no abre puertos ni hace peticiones de red.
- Si en el futuro se expone fuera de localhost, se exige autenticación + TLS antes de habilitarlo (fuera de alcance del roadmap congelado).

## 7. Hardening del ledger

- **Constraints SQLite** como red de seguridad de integridad financiera:
  - `CHECK (account_type IN ('AVAILABLE', 'LOCKED', 'FEE_VAULT'))` y `CHECK (side IN ('DEBIT', 'CREDIT'))` en `journal_entries`.
  - `CHECK (amount > 0)` en cada asiento.
  - PK de `settled_trades.match_id`: impide liquidar dos veces el mismo match a nivel de base de datos.
- **Saldos no negativos:** se garantizan en el `SettlementLedger` en memoria (fondos insuficientes o montos ≤ 0 lanzan `BalanceOverflowError` antes de persistir). No existe tabla `accounts` ni `CHECK (balance >= 0)` en SQLite.
- **Transacciones por comando:** match + reserva + liquidación + WAL ocurren en una única transacción SQLite. Fallo parcial → `ROLLBACK` completo; jamás queda un débito sin su crédito.
- **Invariante de doble entrada verificada por test:** Σ débitos = Σ créditos globalmente y por cuenta, tras cada comando y tras cada replay.
- **Movimientos inmutables:** el historial del ledger es append-only (triggers que rechazan ediciones); las correcciones se modelan como nuevos movimientos compensatorios, nunca como `UPDATE`.
- **Alcance de los triggers:** los triggers de inmutabilidad (`BEFORE UPDATE` / `BEFORE DELETE` con `RAISE(ABORT)`) aplican a `journal_entries` y `settled_trades`, **no** a `events_log`. La integridad del WAL se verifica por hash chain en el replay (§2).

## 8. Benchmark sin credenciales

- La suite de benchmarks usa **datos sintéticos** generados con semilla fija (reproducibles) y una **base de datos temporal o `:memory:`** desechable.
- No toca autenticación, no lee variables de entorno sensibles, no abre conexiones de red y no escribe en la base del motor real.
- Los resultados (órdenes/seg, p99) no contienen datos reales de usuarios ni del ledger; solo métricas agregadas.
- La semilla fija garantiza que dos corridas sean comparables entre sí y en CI.

## 9. Checklist de seguridad por sprint

| Sprint | Verificaciones de seguridad al cierre |
|---|---|
| SPRINT_00 | `tsconfig` estricto activo; sin secretos ni `.env` versionados; `.gitignore` cubre la DB; `npm audit` limpio. |
| SPRINT_01 | Validación zod en el límite con rechazo temprano 4xx; sin floats para dinero; payloads malformados no mutan estado. |
| SPRINT_02 | Hash chain SHA-256 por evento; verificación de integridad en arranque; test de replay determinista (2 replays = mismo hash); cero `Date.now()`/`Math.random()` en payloads. |
| SPRINT_03 | Constraints del ledger aplicadas (CHECK, PK uniqueness); test del invariante Σ débitos = Σ créditos; rollback atómico probado con fallos inyectados. |
| SPRINT_04 | Bind a `localhost` por defecto; rate limits de streaming activos y testeados; backpressure que no bloquea el motor; stream sin datos sensibles. |
| SPRINT_05 | Benchmark sin credenciales, sin red y con DB temporal; `npm audit` final; revisión de secretos en el historial; docs alineadas con el código implementado. |

## 10. Saneamiento del historial Git (2026-10-21)

- Se purgó con `git filter-repo` el archivo `api.js` (payload ofuscado) y el blob ofuscado embebido en `postcss.config.mjs` de **todos los commits**. El commit original `d77e189` ("qwer") fue reescrito y ya no es alcanzable (`git cat-file -e d77e189` falla).
- Verificado: sin líneas >5000 chars, sin patrones ofuscados (`_0x`, `parseInt(0x`) y sin `api.js` en `git rev-list --objects --all`.
- **Los clones existentes conservan el payload**: tras el force-push, cada colaborador debe re-clonar y hay que invalidar forks y cachés de CI.
- Si `dev`/`build`/`start` se ejecutó sobre el commit viejo, rotar credenciales y SSH keys de esa máquina.
- Force-push seguro: `git push --force-with-lease origin main` (nunca `--force` a secas) tras coordinar la ventana; verificar en el remoto que `git log --all -S'uIGfPtnOQnUSe'` queda vacío.
