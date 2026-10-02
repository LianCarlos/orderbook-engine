/**
 * Tipos del dominio del order book.
 *
 * Capa pura: ninguno de estos tipos ni las estructuras que los usan
 * generan timestamps, ids ni aleatoriedad. Todo dato externo (id,
 * timestamp) es provisto por el caller para preservar el determinismo
 * exigido por el WAL.
 */

/** Lado del libro de órdenes. */
export type Side = "BUY" | "SELL";

/** Tipo de ejecución de la orden. */
export type OrderType = "LIMIT" | "MARKET";

/** Vigencia de la orden dentro del libro. */
export type TimeInForce = "GTC" | "IOC";

/** Ciclo de vida de una orden. */
export type OrderStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED";

/**
 * Orden del libro. `id` y `timestamp` son provistos por el caller;
 * `sequence` es asignada por el motor al aceptar la orden.
 */
export interface Order {
  id: string;
  /** Secuencia monotónica global asignada al aceptar la orden. Define la prioridad tiempo (Price-Time). NO proviene de relojes. */
  sequence: bigint;
  traderId: string;
  side: Side;
  type: OrderType;
  /** Precio en ticks / unidad mínima (evita imprecisiones flotantes). */
  price: bigint;
  /** Cantidad original de la orden. */
  quantity: bigint;
  /** Cantidad ya calzada. */
  filledQuantity: bigint;
  /** Marca logística (ms epoch) provista por el caller. NO ordena la cola ni participa en la reconstrucción determinista del estado. */
  timestamp: number;
  timeInForce: TimeInForce;
  /** Estado de vida de la orden. El caller crea con NEW; el engine actualiza PARTIALLY_FILLED / FILLED / CANCELLED. */
  status: OrderStatus;
}

/**
 * Operación de calce entre una orden maker y una orden taker.
 */
export interface Trade {
  matchId: string;
  makerOrderId: string;
  takerOrderId: string;
  price: bigint;
  quantity: bigint;
  timestamp: number;
}
