/**
 * Modelo contable de doble entrada (Sprint 03).
 *
 * Convenciones:
 * - Saldos en enteros (unidad mínima); prohibido `number` con
 *   decimales. Toda la aritmética es bigint.
 * - `DEBIT` incrementa el saldo de una cuenta de activo;
 *   `CREDIT` lo decrementa. Todo asiento se compone de al menos un
 *   débito y un crédito, y por cada asset se cumple la
 *   REGLA INVIOLABLE: Suma(Débitos) == Suma(Créditos).
 * - `EXTERNAL` es la contrapartida contable de los depósitos (liability
 *   sintética); vive solo en el journal, sin saldo en memoria.
 */

/** Tipo de subcuenta del inventario financiero. */
export type AccountType = "AVAILABLE" | "LOCKED" | "FEE_VAULT";

/** Lado del asiento contable. */
export type EntrySide = "DEBIT" | "CREDIT";

/** Id de la cuenta sintética contraparte de los depósitos. */
export const EXTERNAL_ACCOUNT_ID = "external";

/** Id de la cuenta del sistema (comisiones). */
export const SYSTEM_ACCOUNT_ID = "system";

/** Asiento inmutable de doble entrada. */
export interface LedgerEntry {
  /** Titular de la subcuenta (usuario, sistema o contrapartida externa). */
  accountId: string;
  accountType: AccountType;
  /** Activo (ej. "USD", "BTC"). */
  asset: string;
  side: EntrySide;
  /** Monto en unidad mínima (bigint). */
  amount: bigint;
}

/** Transacción financiera: N ≥ 2 asientos, balanceada por asset. */
export interface LedgerTransaction {
  txId: string;
  /** Orden del dominio que originó la transacción (trazabilidad). */
  orderId: string | null;
  entries: readonly LedgerEntry[];
}
