import type { NextFunction, Request, Response } from "express";
import { getPool } from "@reachinbox/db-schema";
import { ApiError } from "./errorHandler.js";

export interface AuthedRequest extends Request {
  user?: {
    id: string;
    tenantId: string;
    name: string;
    email: string;
    avatarUrl: string | null;
  };
}

/**
 * Server-side auth gate: tenantId always derives from the authenticated
 * session, never a client-supplied parameter (§11 — what makes the dual rate
 * limiter trustworthy).
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const session = (req as Request & { session?: { userId?: string } }).session;
  const userId = session?.userId;
  if (!userId) {
    next(new ApiError("UNAUTHORIZED", "sign in to continue"));
    return;
  }
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    tenant_id: string;
    name: string;
    email: string;
    avatar_url: string | null;
  }>(
    `SELECT id, tenant_id, name, email, avatar_url FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    next(new ApiError("UNAUTHORIZED", "sign in to continue"));
    return;
  }
  const u = result.rows[0];
  (req as AuthedRequest).user = {
    id: u.id,
    tenantId: u.tenant_id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatar_url,
  };
  next();
}
