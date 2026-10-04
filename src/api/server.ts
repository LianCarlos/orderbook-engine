/**
 * Servidor de streaming en tiempo real (Sprint 04).
 *
 * Hub de difusión acoplado al `ExecutionPipeline` con transporte dual:
 * - Clientes in-process (simulación/test): `connectClient()`.
 * - Transporte HTTP real sin dependencias: SSE en `GET /stream`
 *   (canales depth_snapshot / depth_update / trades) y JSON en
 *   `GET /book/snapshot`.
 *
 * Canales:
 * - `depth_snapshot`: profundidad L2 completa al conectar el cliente.
 * - `depth_update`: deltas de niveles de precio inmediatamente después
 *   de cada `executeOrder` exitosa (`notifyOrderExecuted`).
 * - `trades`: ejecuciones inmutables (price, quantity, makerOrderId,
 *   takerOrderId, sequence del WAL).
 *
 * Cada mensaje lleva un `seq` de difusión global monotónico; los
 * clientes pueden detectar pérdidas verificando contigüidad (zero gap)
 * y validar su libro local contra el `checksum` CRC32 del snapshot.
 */
import http from "node:http";
import type { MatchingEngine } from "../engine/matching";
import type { MatchResult } from "../engine/matching";
import type { Order } from "../core/types";
import {
  L2OrderbookAggregator,
  type DepthSnapshot,
} from "./depth";
import { serializeDto } from "./serializer";

export type StreamChannel = "depth_snapshot" | "depth_update" | "trades";

/** Mensaje emitido por el servidor de streaming. */
export interface StreamMessage {
  channel: StreamChannel;
  /** Secuencia de difusión global monotónica (zero-gap verificable). */
  seq: bigint;
  data: unknown;
}

/** Delta de nivel de precio publicado en el canal `depth_update`. */
export interface PriceLevelUpdate {
  side: "BUY" | "SELL";
  price: bigint;
  /** Volumen remanente del nivel tras la orden (0n = nivel eliminado). */
  quantity: bigint;
}

/** Evento del canal `trades`. */
export interface TradeStreamEvent {
  matchId: string;
  price: bigint;
  quantity: bigint;
  makerOrderId: string;
  takerOrderId: string;
  sequence: bigint;
}

/** Cliente del hub de streaming (in-process o detrás de un transporte). */
export class StreamClient {
  private readonly _messages: StreamMessage[] = [];
  private _handler: ((message: StreamMessage) => void) | null = null;

  /** Mensajes recibidos hasta ahora (cola ordenada de difusión). */
  get messages(): readonly StreamMessage[] {
    return this._messages;
  }

  /** Handler de entrega inmediata (usado por el transporte SSE). */
  set onMessage(handler: ((message: StreamMessage) => void) | null) {
    this._handler = handler;
  }

  /** Entrega un mensaje (push a cola + handler inmediato si existe). */
  receive(message: StreamMessage): void {
    this._messages.push(message);
    if (this._handler !== null) {
      this._handler(message);
    }
  }
}

const DEFAULT_DEPTH_LIMIT = 20;
const HEARTBEAT_MS = 15_000;

export interface StreamingServerOptions {
  /** Máximo de conexiones SSE simultáneas (default 100). */
  maxConnections?: number;
  /** Máximo de conexiones SSE por IP (default 10). */
  maxConnectionsPerIp?: number;
}

export class StreamingServer {
  private readonly _engine: MatchingEngine;
  private readonly _aggregator: L2OrderbookAggregator;
  private readonly _clients = new Set<StreamClient>();
  private readonly _lastDepth = new Map<string, bigint>(); // "side|price" → qty
  private readonly _maxConnections: number;
  private readonly _maxConnectionsPerIp: number;
  private _broadcastSeq = 0n;
  private _httpServer: http.Server | null = null;
  private _activeSseConnections = 0;
  private readonly _connectionsByIp = new Map<string, number>();

  constructor(
    engine: MatchingEngine,
    aggregator: L2OrderbookAggregator,
    options: StreamingServerOptions = {},
  ) {
    this._engine = engine;
    this._aggregator = aggregator;
    this._maxConnections = options.maxConnections ?? 100;
    this._maxConnectionsPerIp = options.maxConnectionsPerIp ?? 10;
    // Estado previo completo de niveles (base para calcular deltas).
    const full = this._aggregator.getDepthSnapshot(Number.MAX_SAFE_INTEGER);
    for (const level of [...full.bids, ...full.asks]) {
      this._lastDepth.set(`${level.side}|${level.price}`, level.quantity);
    }
  }

  /** Conecta un cliente simulado; recibe el snapshot L2 de inmediato. */
  connectClient(): StreamClient {
    const client = new StreamClient();
    this._addClient(client);
    return client;
  }

  /**
   * Notifica una orden ejecutada con éxito: emite deltas de niveles
   * tocados (depth_update) y cada trade (trades) con la secuencia WAL
   * de la orden que los generó. Sincrónico: tras retornar, todos los
   * clientes ya recibieron los mensajes.
   */
  notifyOrderExecuted(order: Order, result: MatchResult, walSequence: bigint): void {
    // Canal trades: ejecuciones inmutables.
    for (const trade of result.trades) {
      this._broadcast("trades", {
        matchId: trade.matchId,
        price: trade.price,
        quantity: trade.quantity,
        makerOrderId: trade.makerOrderId,
        takerOrderId: trade.takerOrderId,
        sequence: walSequence,
      } satisfies TradeStreamEvent);
    }

    // Canal depth_update: niveles tocados por el calce y por la orden.
    const prices = new Set<bigint>();
    for (const trade of result.trades) {
      prices.add(trade.price);
    }
    if (order.type === "LIMIT") {
      prices.add(order.price);
    }
    for (const price of prices) {
      for (const side of ["BUY", "SELL"] as const) {
        const quantity = this._aggregator.levelQuantity(side, price);
        const key = `${side}|${price}`;
        const previous = this._lastDepth.get(key) ?? 0n;
        if (quantity !== previous) {
          this._lastDepth.set(key, quantity);
          this._broadcast("depth_update", {
            side,
            price,
            quantity,
          } satisfies PriceLevelUpdate);
        }
      }
    }
  }

  /** Snapshot L2 actual (para el transporte HTTP y validaciones). */
  depthSnapshot(depthLimit = DEFAULT_DEPTH_LIMIT): DepthSnapshot {
    return this._aggregator.getDepthSnapshot(depthLimit);
  }

  /**
   * Arranca el transporte HTTP (SSE + JSON) en 127.0.0.1. Con `port=0`
   * elige un puerto efímero; devuelve el puerto asignado.
   */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/stream" && req.method === "GET") {
          // Rate limiting: conexiones globales y por IP (SECURITY.md Sprint 04).
          const ip = req.socket.remoteAddress ?? "unknown";
          const perIp = this._connectionsByIp.get(ip) ?? 0;
          if (
            this._activeSseConnections >= this._maxConnections ||
            perIp >= this._maxConnectionsPerIp
          ) {
            res.writeHead(429, { "Content-Type": "text/plain" });
            res.end("rate limit exceeded");
            return;
          }
          this._activeSseConnections += 1;
          this._connectionsByIp.set(ip, perIp + 1);
          let released = false;
          const release = () => {
            if (released) {
              return;
            }
            released = true;
            this._activeSseConnections -= 1;
            const remaining = (this._connectionsByIp.get(ip) ?? 1) - 1;
            if (remaining <= 0) {
              this._connectionsByIp.delete(ip);
            } else {
              this._connectionsByIp.set(ip, remaining);
            }
          };

          // SSE: snapshot inicial + eventos en vivo.
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const client = new StreamClient();
          client.onMessage = (message) => {
            if (res.writableEnded || res.destroyed) {
              return;
            }
            // Backpressure (ARCHITECTURE §6.4): si el cliente no drena,
            // se le avisa para re-sincronizar y se desconecta — el motor
            // jamás se bloquea por un consumidor lento.
            try {
              const data = { seq: message.seq, ...(message.data as Record<string, unknown>) };
              const ok = res.write(
                `id: ${message.seq}\nevent: ${message.channel}\ndata: ${serializeDto(data)}\n\n`,
              );
              if (!ok) {
                res.write("event: resync_required\ndata: {}\n\n");
                res.end();
                this._clients.delete(client);
              }
            } catch {
              this._clients.delete(client);
              res.destroy();
            }
          };
          this._addClient(client);
          // Sin buffer de historial: en reconexión (Last-Event-ID), el
          // snapshot inicial de _addClient es la re-sincronización.
          req.on("close", () => {
            release();
            this._clients.delete(client);
          });
          req.on("error", () => {
            release();
            this._clients.delete(client);
          });
          res.on("error", () => {
            release();
            this._clients.delete(client);
          });
          // Heartbeat: detecta medias conexiones muertas en silencio.
          const heartbeat = setInterval(() => {
            if (res.destroyed || res.writableEnded) {
              clearInterval(heartbeat);
              return;
            }
            res.write(":hb\n\n");
          }, HEARTBEAT_MS);
          heartbeat.unref();
          res.on("close", () => clearInterval(heartbeat));
        } else if (url === "/book/snapshot" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(serializeDto(this.depthSnapshot(DEFAULT_DEPTH_LIMIT)));
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
        }
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("streaming server: dirección no disponible"));
          return;
        }
        this._httpServer = server;
        resolve(address.port);
      });
    });
  }

  /** Detiene el transporte HTTP y desconecta a todos los clientes. */
  close(): void {
    this._clients.clear();
    if (this._httpServer !== null) {
      // Corta sockets keep-alive/SSE pendientes: de lo contrario
      // http.Server.close() esperaría conexiones inactivas para siempre.
      this._httpServer.closeAllConnections?.();
      this._httpServer.close();
      this._httpServer = null;
    }
  }

  // ── Internos ───────────────────────────────────────────────────────

  private _addClient(client: StreamClient): void {
    this._clients.add(client);
    // Snapshot L2 completo al conectar (primer mensaje del cliente).
    this._deliver(client, "depth_snapshot", this.depthSnapshot(DEFAULT_DEPTH_LIMIT));
  }

  private _deliver(client: StreamClient, channel: StreamChannel, data: unknown): void {
    this._broadcastSeq += 1n;
    client.receive({ channel, seq: this._broadcastSeq, data });
  }

  private _broadcast(channel: StreamChannel, data: unknown): void {
    for (const client of this._clients) {
      this._deliver(client, channel, data);
    }
  }
}
