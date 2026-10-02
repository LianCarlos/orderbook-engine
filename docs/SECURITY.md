# Seguridad — High-Throughput In-Memory Orderbook & Matching Engine

> **Estado del documento:** borrador de diseño pre-implementación (scaffolding congelado). Los controles descritos se implementan y verifican sprint a sprint según el checklist del final.

## 1. Alcance y modelo de amenazas

El motor es, por defecto, un componente **local**: bind a `localhost`, sin exposición a red externa, sin credenciales de producción. Las amenazas principales en este modelo son:

- **Corrupción o manipulación del log de eventos** (integridad de la fuente de verdad).
- **Deriva no determinista** del estado reconstruido (integridad lógica).
- **Entrada malformada** que degrade o rompa el motor (DoS local, estados inválidos).
- **Abuso del canal de streaming** (agotamiento de recursos).
- **Ledger inconsistente** por fallo parcial o bug (integridad financiera).

## 2. Integridad del WAL (Event Log)

- **Checksums por registro:** cada evento lleva checksum calculado sobre `seq + event_type + payload` (CRC32C, barato y suficiente para detectar corrupción accidental; verificable en cada lectura).
- **Checksum agregado por segmento:** hash del rango de eventos entre snapshots para detectar corrupción temprana en arranque sin leer todo el log.
- **Inmutabilidad:** triggers SQLite que rechazan `UPDATE`/`DELETE` sobre la tabla de eventos. El log solo crece o se compacta archivando segmentos ya cubiertos por snapshot.
- **Detección de corrupción:** en el arranque, todo evento leído se verifica contra su checksum antes de aplicarse. Un evento corrupto **detiene el arranque** y activa el protocolo de reparación; nunca se arranca con estado dudoso.
- **Reparación vía replay:**
  1. Detectar el primer evento con checksum inválido.
  2. Cargar el último snapshot íntegro (hash verificado).
  3. Re-ejecutar en orden los eventos posteriores al snapshot que tengan checksum válido.
  4. Truncar la cola corrupta a partir del primer evento inválido (nunca reparar in-place; el log es append-only).
  5. Registrar un evento de incidente/metadato externo y continuar desde el estado reconstruido.

## 3. Determinismo del replay como propiedad de seguridad

- **Regla dura:** prohibido `Date.now()` y `Math.random()` en payloads de eventos y en cualquier cálculo que afecte el estado reconstruido. La única fuente de orden es el `sequence` monotónico.
- **Fuente de tiempo única:** los timestamps logísticos (`created_at`) se generan en el servidor fuera del payload y no participan en la reconstrucción del estado.
- **Verificación de deriva:** cada snapshot guarda el hash del estado en su `seq`. Tras cada replay, se compara el hash reconstruido contra el guardado. Una discrepancia es una **alarma de seguridad** (bug no determinista o corrupción lógica silenciosa), no un warning cosmético.
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
  - FK de movimientos → cuentas (`accounts`).
  - `CHECK (amount > 0)` en movimientos.
  - `CHECK (balance >= 0)` en cuentas (ningún saldo negativo jamás).
  - Uniqueness de referencias para impedir liquidación duplicada del mismo match.
- **Transacciones por comando:** match + reserva + liquidación + WAL ocurren en una única transacción SQLite. Fallo parcial → `ROLLBACK` completo; jamás queda un débito sin su crédito.
- **Invariante de doble entrada verificada por test:** Σ débitos = Σ créditos globalmente y por cuenta, tras cada comando y tras cada replay.
- **Movimientos inmutables:** el historial del ledger es append-only (triggers que rechazan ediciones); las correcciones se modelan como nuevos movimientos compensatorios, nunca como `UPDATE`.

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
| SPRINT_02 | Checksum en cada evento; verificación de integridad en arranque; test de replay determinista (2 replays = mismo hash); cero `Date.now()`/`Math.random()` en payloads. |
| SPRINT_03 | Constraints del ledger aplicadas (FK, CHECK, uniqueness); test del invariante Σ débitos = Σ créditos; rollback atómico probado con fallos inyectados. |
| SPRINT_04 | Bind a `localhost` por defecto; rate limits de streaming activos y testeados; backpressure que no bloquea el motor; stream sin datos sensibles. |
| SPRINT_05 | Benchmark sin credenciales, sin red y con DB temporal; `npm audit` final; revisión de secretos en el historial; docs alineadas con el código implementado. |
