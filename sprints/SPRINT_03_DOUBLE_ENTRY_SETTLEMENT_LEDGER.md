# SPRINT 03 — Double-Entry Settlement Ledger

| Campo | Valor |
|---|---|
| Estado | 🔒 Congelado (frozen spec) |
| Depende de | SPRINT_02 |
| Rama sugerida | `sprint/03-settlement-ledger` |
| Propietario | 🗃️ sqlite-dev + ⚛️ nextjs-dev |

## Resumo Executivo (pt-BR)

- **Objetivo:** implementar o motor de saldos de dupla entrada que reserva fundos ao aceitar uma ordem (Maker/Taker balance locking) e liquida atomicamente cada `Trade`, mantendo o invariante contábil em qualquer circunstância.
- **Entregáveis:** `accounts.ts` (`available`/`reserved`/`total`), `journal.ts` (débito e crédito por operação), `reservation.ts` (bloqueio e liberação de fundos) e `settlement.ts` (liquidação atômica por `Trade`), em `src/ledger/`, integrados ao pipeline do motor.
- **Critérios de aceite:** Σ débitos = Σ créditos para suítes determinísticas e aleatórias com seed fixo; reserva insuficiente → rejeição **antes** de tocar o livro; cancelamento libera a reserva exata; rollback sem saldos inconsistentes; overflow/underflow de saldos com BigInt ou checagem de faixa.
- **Atomicidade:** settlement + WAL append na mesma transação SQLite (nada persiste se o outro falhar); cada lançamento referencia a `sequence` do evento que o originou.
- **Verificação:** `npx tsc --noEmit`, `npm run lint` e `npm test -- ledger`.
- **Status:** 🔒 spec congelada (frozen).

## 1. Objetivo

Implementar el motor de saldos de **doble entrada** que reserva fondos al aceptar
una orden (Maker/Taker balance locking) y liquida atómicamente cada `Trade`,
manteniendo el invariante contable en toda circunstancia.

## 2. Alcance / Deliverables

En `src/ledger/`:

- `accounts.ts` — modelo de cuenta: `available`, `reserved` (locked), `total`.
- `journal.ts` — asientos de doble entrada: cada operación genera débito y crédito;
  invariante Σ débitos = Σ créditos verificable.
- `reservation.ts` — bloqueo de fondos: `funds_reserved` al entrar la orden,
  liberación al cancelar/expirar.
- `settlement.ts` — liquidación atómica por `Trade`: débito total de taker,
  crédito neto de maker, fee hook (cero por defecto).
- Integración con el pipeline del motor: el settlement escucha `order_matched` y
  `order_cancelled` de forma transaccional con el WAL (misma transacción SQLite).

Tests:

- Invariante de doble entrada tras N trades aleatorios.
- Reserva insuficiente → rechazo **antes** de tocar el libro.
- Cancelación libera reserva exactamente.
- Rollback: trade fallido a mitad de liquidación no deja saldos inconsistentes.
- Overflow/underflow de saldos (BigInt o cheques de rango).

## 3. Especificación técnica

- Saldos en enteros (unidad mínima) para aritmética exacta; prohibido `number`
  con decimales.
- Atomicidad: settlement + WAL append en la misma transacción SQLite (nada
  persiste si el otro falla).
- Orden estricto de settlement: primero reservas del maker ya existentes, luego
  taker; release de restos IOC en el mismo ciclo.
- Cada asiento referencia `sequence` del evento que lo originó (trazabilidad).

## 4. Criterios de éxito

- [ ] Invariante Σ débitos = Σ créditos en verde para suites deterministas y
  aleatorias con seed fijo.
- [ ] Sin fondos suficientes → la orden jamás llega al libro (test de orden).
- [ ] `npx tsc --noEmit` limpio.

## 5. Verificación

```bash
npx tsc --noEmit
npm run lint
npm test -- ledger
```

## 6. Riesgos

- Carreras de saldo si el settlement se ejecuta fuera del pipeline síncrono del
  motor (se exige procesamiento single-threaded del engine en memoria).
- Redondeos: usar siempre enteros de unidad mínima.
