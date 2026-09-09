import type { NextFunction, Request, Response } from "express";
import type { ApiErrorCode } from "@reachinbox/shared-types";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ApiError) {
    res.status(STATUS_BY_CODE[err.code]).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  // Zod errors from validateBody are converted there; anything else is a bug.
  console.error("[api] unhandled error:", err);
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "something went wrong",
    },
  });
}
