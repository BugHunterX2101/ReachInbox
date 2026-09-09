import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { getConfig } from "@reachinbox/config";
import { requireAuth, type AuthedRequest } from "../../middleware/requireAuth.js";

export const attachmentsRouter: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
});

const DATA_DIR = process.env.ATTACHMENT_DATA_DIR
  ? path.resolve(process.env.ATTACHMENT_DATA_DIR)
  : path.resolve(process.cwd(), ".data/attachments");

/**
 * HMAC token over the stored filename (ENCRYPTION_KEY) so the WORKER's mail
 * transport can fetch attachments without a browser session, while arbitrary
 * callers still need a session. URLs remain unguessable and file-scoped.
 */
function attachmentToken(name: string): string {
  return crypto.createHmac("sha256", getConfig().ENCRYPTION_KEY).update(name).digest("hex");
}

function tokenIsValid(name: string, token: unknown): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const expected = attachmentToken(name);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ensureDir(): string {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  return DATA_DIR;
}

/**
 * POST /api/attachments — upload one file, store it locally (S3-compatible
 * storage is a later swap; §4.1's storage_url field already abstracts it),
 * and return the storageUrl the schedule API expects (§10.2 attachments).
 */
attachmentsRouter.post(
  "/",
  requireAuth,
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({
          error: { code: "VALIDATION_ERROR", message: "attach a file in the file field" },
        });
        return;
      }
      const dir = ensureDir();
      const id = crypto.randomUUID();
      const safeName = file.originalname.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
      const storedName = `${id}-${safeName}`;
      fs.writeFileSync(path.join(dir, storedName), file.buffer);

      const cfg = getConfig();
      const base = process.env.PUBLIC_ATTACHMENT_BASE_URL ?? `${cfg.WEB_URL.replace(/\/$/, "")}/api`.replace("localhost:3000", "localhost:3001");
      const url = `${base}/attachments/file/${storedName}?token=${attachmentToken(storedName)}`;

      res.status(201).json({
        filename: file.originalname,
        contentType: file.mimetype,
        sizeBytes: file.size,
        storageUrl: url,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/attachments/file/:name — serve the stored bytes (session-gated).
 * Nodemailer then fetches these over HTTP when sending (path attachment).
 */
attachmentsRouter.get(
  "/file/:name",
  // Signed-token OR session: the worker's mail transport has no browser
  // session, so it authenticates with the HMAC token minted at upload time.
  (req: Request, res: Response, next: NextFunction) => {
    const name = path.basename(req.params["name"] ?? "");
    if (tokenIsValid(name, req.query["token"])) {
      next();
      return;
    }
    requireAuth(req, res, next);
  },
  (req: Request, res: Response) => {
    const name = path.basename(req.params["name"] ?? "");
    const full = path.join(ensureDir(), name);
    if (!fs.existsSync(full) || !full.startsWith(DATA_DIR)) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "attachment not found" } });
      return;
    }
    res.sendFile(full);
  }
);
