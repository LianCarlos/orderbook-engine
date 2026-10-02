import type { Order } from "./types";

/**
 * Nodo de la lista doblemente enlazada de un nivel de precio.
 * Mantiene la orden y los punteros hacia sus vecinos inmediatos.
 */
export class OrderNode {
  readonly order: Order;
  prev: OrderNode | null;
  next: OrderNode | null;
  owner: DoublyLinkedList | null;

  constructor(order: Order) {
    this.order = order;
    this.prev = null;
    this.next = null;
    this.owner = null;
  }
}

/**
 * Volumen restante de una orden (`quantity − filledQuantity`).
 */
function remainingVolume(node: OrderNode): bigint {
  return node.order.quantity - node.order.filledQuantity;
}

/**
 * Lista doblemente enlazada de órdenes dentro de un mismo nivel de
 * precio. Implementa la prioridad Price-Time: FIFO por orden de llegada.
 *
 * Complejidad de todas las operaciones expuestas: O(1).
 */
export class DoublyLinkedList {
  private _head: OrderNode | null = null;
  private _tail: OrderNode | null = null;
  private _length = 0;
  private _totalVolume = 0n;

  /** Orden más antigua (frente de calce). O(1). */
  get head(): OrderNode | null {
    return this._head;
  }

  /** Orden más reciente. O(1). */
  get tail(): OrderNode | null {
    return this._tail;
  }

  /** Número de órdenes en la lista. O(1). */
  get length(): number {
    return this._length;
  }

  /**
   * Volumen restante agregado: Σ(quantity − filledQuantity), mantenido
   * incrementalmente. O(1).
   */
  get totalVolume(): bigint {
    return this._totalVolume;
  }

  /**
   * Inserta una orden al final (prioridad por tiempo) y devuelve el
   * nodo creado, clave para cancelación O(1) posterior. O(1).
   */
  push(order: Order): OrderNode {
    const node = new OrderNode(order);
    if (this._tail !== null) {
      this._tail.next = node;
      node.prev = this._tail;
    } else {
      this._head = node;
    }
    this._tail = node;
    this._length += 1;
    this._totalVolume += remainingVolume(node);
    node.owner = this;
    return node;
  }

  /**
   * Aplica un fill parcial atómico: incrementa `filledQuantity` y
   * decrementa `totalVolume` en la misma operación. Única vía legal
   * para mutar `filledQuantity` de una orden viva. O(1).
   */
  fill(node: OrderNode, qty: bigint): void {
    if (node.owner !== this) {
      throw new Error(
        "OrderNode does not belong to this list (already detached or from another list)",
      );
    }
    const remaining = remainingVolume(node);
    if (qty <= 0n) {
      throw new Error(`fill quantity must be positive, got ${qty}`);
    }
    if (qty > remaining) {
      throw new Error(
        `fill quantity ${qty} exceeds remaining volume ${remaining}`,
      );
    }
    node.order.filledQuantity += qty;
    this._totalVolume -= qty;
  }

  /**
   * Desenlaza un nodo arbitrario sin recorrer la lista y actualiza el
   * volumen restante agregado. Lanza `Error` si el nodo no pertenece a
   * esta lista (ya desenlazado o de otra lista). O(1).
   */
  remove(node: OrderNode): void {
    if (node.owner !== this) {
      throw new Error(
        "OrderNode does not belong to this list (already detached or from another list)",
      );
    }
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      this._head = node.next;
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this._tail = node.prev;
    }
    this._totalVolume -= remainingVolume(node);
    this._length -= 1;
    node.prev = null;
    node.next = null;
    node.owner = null;
  }
}
