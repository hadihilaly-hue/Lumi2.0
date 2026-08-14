// Image storage abstraction.
//
// Dev implementation writes to `public/uploads/` so Next serves the files at
// `/uploads/<name>` with zero extra config. The `Storage` interface is the seam:
// to move to S3 or Supabase Storage later, implement `saveImage`/`deleteImage`
// against that backend and swap the exported `storage` instance — no caller changes.

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export interface Storage {
  /** Persist raw image bytes; return a public URL/path usable in an <img src>. */
  saveImage(bytes: Buffer, originalName: string, mimeType: string): Promise<string>;
  /** Best-effort delete of a previously saved image by its stored URL/path. */
  deleteImage(url: string): Promise<void>;
}

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const PUBLIC_PREFIX = "/uploads/";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

function extFor(originalName: string, mimeType: string): string {
  const fromMime = EXT_BY_MIME[mimeType.toLowerCase()];
  if (fromMime) return fromMime;
  const fromName = path.extname(originalName).toLowerCase();
  return fromName || ".jpg";
}

class LocalStorage implements Storage {
  async saveImage(bytes: Buffer, originalName: string, mimeType: string): Promise<string> {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extFor(originalName, mimeType)}`;
    await fs.writeFile(path.join(UPLOAD_DIR, name), bytes);
    return `${PUBLIC_PREFIX}${name}`;
  }

  async deleteImage(url: string): Promise<void> {
    if (!url.startsWith(PUBLIC_PREFIX)) return;
    const name = url.slice(PUBLIC_PREFIX.length);
    // Guard against path traversal — only allow a bare filename.
    if (name.includes("/") || name.includes("..")) return;
    try {
      await fs.unlink(path.join(UPLOAD_DIR, name));
    } catch {
      // File may already be gone; deletion is best-effort.
    }
  }
}

export const storage: Storage = new LocalStorage();
