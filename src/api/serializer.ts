/**
 * Serializador DTO seguro para bigint (Sprint 04).
 *
 * JSON.stringify nativo lanza TypeError con bigint; este módulo
 * convierte de forma transparente y recursiva todos los campos bigint
 * (precios, cantidades, secuencias, timestamps) a string decimal, sin
 * pérdida de precisión para clientes JS/Web.
 */
export function toSafeJson(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(toSafeJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      out[key] = toSafeJson(record[key]);
    }
    return out;
  }
  return value;
}

/** Serializa un DTO a JSON con bigints como strings (listo para red). */
export function serializeDto(value: unknown): string {
  return JSON.stringify(toSafeJson(value));
}
