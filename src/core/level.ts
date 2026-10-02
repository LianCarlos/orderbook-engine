import type { Order } from "./types";
import { DoublyLinkedList, type OrderNode } from "./queue";

/**
 * Nivel de precio del libro: un precio fijo y la cola FIFO de órdenes
 * que descansan en él, en orden de llegada (Price-Time).
 */
export class LimitLevel {
  readonly price: bigint;
  readonly queue: DoublyLinkedList;

  constructor(price: bigint) {
    this.price = price;
    this.queue = new DoublyLinkedList();
  }

  /** Encola una orden en el nivel; delega en `queue.push`. */
  addOrder(order: Order): OrderNode {
    return this.queue.push(order);
  }

  /** Desenlaza una orden del nivel; delega en `queue.remove`. */
  removeOrder(node: OrderNode): void {
    this.queue.remove(node);
  }

  /**
   * Aplica un fill parcial atómico sobre una orden del nivel. Delega en
   * `queue.fill`. O(1).
   */
  fill(node: OrderNode, qty: bigint): void {
    this.queue.fill(node, qty);
  }

  /** True si el nivel no tiene órdenes. */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /** Volumen restante agregado del nivel; delega en `queue.totalVolume`. */
  get totalVolume(): bigint {
    return this.queue.totalVolume;
  }
}
