import { Injectable, UnauthorizedException } from "@nestjs/common";
import { UcodeClient, UcodeError } from "../ucode/ucode.client";
import type { CallerContext } from "../ucode/ucode.types";

const CACHE_TTL_MS = 5 * 60_000;

interface CachedCaller {
  caller: CallerContext;
  expiresAt: number;
}

/**
 * Turns a bearer token into a CallerContext — who is asking, and which Company
 * their data lives in.
 *
 * The Company is deliberately *derived*, never accepted as input. The HRMS SPA
 * attaches `companies_id` client-side in an axios interceptor, so the ucode
 * backend does not enforce tenancy on its own: a request that simply omits the
 * field returns rows from every company. If the Copilot took the Company from
 * its request body, any caller could read another company's staff by editing
 * one JSON field.
 */
@Injectable()
export class CallerService {
  private readonly cache = new Map<string, CachedCaller>();

  constructor(private readonly ucode: UcodeClient) {}

  async resolve(token: string): Promise<CallerContext> {
    const trimmed = token.trim();
    if (!trimmed) throw new UnauthorizedException("Missing bearer token.");

    const cached = this.cache.get(trimmed);
    if (cached && cached.expiresAt > Date.now()) return cached.caller;

    const userId = readUserId(trimmed);

    // Reading the caller's own row proves the token is live: ucode verifies the
    // signature and the session on this call, so a tampered or expired token
    // fails here rather than somewhere deeper in a tool.
    // Deliberately a raw request rather than `ucode.getOne`: that method
    // verifies the row's Company against the context, and here the Company is
    // exactly what we are still trying to learn. Passing an empty one would
    // make the check reject every row. Reading the caller's own row by the id
    // in their own token needs no tenant check — the token is the proof.
    let body: unknown;
    try {
      body = await this.ucode.request(
        { userId, companiesId: "", token: trimmed },
        "GET",
        `/v2/items/user_base/${encodeURIComponent(userId)}`,
      );
    } catch (e) {
      if (e instanceof UcodeError && (e.status === 401 || e.status === 403)) {
        throw new UnauthorizedException("Your session is no longer valid.");
      }
      throw e;
    }

    const row = readSelfRow(body);
    if (!row) {
      throw new UnauthorizedException("Your user record could not be loaded.");
    }

    const companiesId = readString(row.companies_id);
    if (!companiesId) {
      // Refusing here is the point: without a Company we cannot scope a single
      // query, and an unscoped query is a cross-tenant read.
      throw new UnauthorizedException(
        "Your user record has no company, so HRMS data cannot be scoped to you.",
      );
    }

    const caller: CallerContext = { userId, companiesId, token: trimmed };
    this.cache.set(trimmed, { caller, expiresAt: Date.now() + CACHE_TTL_MS });
    this.prune();
    return caller;
  }

  /** Keeps the token cache from growing without bound on a long-lived process. */
  private prune(): void {
    if (this.cache.size < 500) return;
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= now) this.cache.delete(k);
    }
  }
}

/**
 * Reads `user_id` out of the token payload. The signature is deliberately NOT
 * checked here — ucode verifies it on every call we make with this same token,
 * and a tampered payload invalidates that signature, so a forged id can only
 * produce a rejected request, never a successful cross-user read. The claim is
 * used solely to know which row to look up.
 */
const readUserId = (token: string): string => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new UnauthorizedException("Malformed bearer token.");
  }
  let claims: Record<string, unknown>;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    claims = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new UnauthorizedException("Malformed bearer token.");
  }
  const userId = readString(claims.user_id);
  if (!userId) {
    throw new UnauthorizedException("Bearer token carries no user_id.");
  }
  return userId;
};

/** Digs the user row out of ucode's `{data:{data:{response}}}` envelope. */
const readSelfRow = (body: unknown): Record<string, unknown> | null => {
  const b = body as { data?: { data?: { response?: unknown } } } | null;
  const row = b?.data?.data?.response ?? b?.data?.data ?? null;
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
};

const readString = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
