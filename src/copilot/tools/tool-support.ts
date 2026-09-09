/**
 * Thrown by a Tool to surface a clean, user-safe message back to the model (the
 * registry turns it into `{ ok: false, error }`). Never leaks internals.
 */
export class CopilotToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotToolError";
  }
}

// ─── Typed readers over the model-supplied `input` map ──────────────────────

export const readString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

export const readNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export const readBoolean = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

export const readArray = (v: unknown): unknown[] | undefined =>
  Array.isArray(v) ? v : undefined;

export const readRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

export const requireString = (v: unknown, field: string): string => {
  const s = readString(v);
  if (!s) throw new CopilotToolError(`Missing required field: ${field}`);
  return s;
};

export const requireRecord = (
  v: unknown,
  field: string,
): Record<string, unknown> => {
  const r = readRecord(v);
  if (!r) throw new CopilotToolError(`Field "${field}" must be an object.`);
  return r;
};

/**
 * Renders a stored value for display — a relation shows its title rather than
 * its guid, and an array column shows its members rather than `[object Object]`.
 */
export const displayValue = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    const parts = value.map(displayValue).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const r = value as Record<string, unknown>;
    const label = r.title ?? r.name ?? r.label;
    if (typeof label === "string") return label;
    return null;
  }
  return String(value);
};
