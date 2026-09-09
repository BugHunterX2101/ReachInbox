import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";
import { ApiError } from "./errorHandler.js";

/** Validate req.body against a zod schema; attach the parsed value. */
export function validateBody(schema: ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first.path.join(".");
      next(
        new ApiError(
          "VALIDATION_ERROR",
          path ? `${path}: ${first.message}` : first.message,
          {
            issues: result.error.issues.map((i: { path: (string | number)[]; message: string }) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          }
        )
      );
      return;
    }
    (req as Request & { parsedBody?: unknown }).parsedBody = result.data;
    next();
  };
}

export function getValidatedBody<T>(req: Request): T {
  return (req as Request & { parsedBody?: T }).parsedBody as T;
}
