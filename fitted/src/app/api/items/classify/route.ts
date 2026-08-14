import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/storage";
import { classifyImage, isVisionSupported } from "@/lib/anthropic";
import type { Classification } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB per file

const DEFAULT_CLASSIFICATION: Classification = {
  category: "shirt",
  subcategory: "",
  colors: [],
  pattern: "solid",
  formalityScore: 5,
  seasonSuitability: ["spring", "summer", "fall", "winter"],
  styleTags: [],
};

interface ClassifyResult {
  imageUrl: string;
  classification: Classification;
  classified: boolean; // false = AI skipped/failed, user fills in manually
  note?: string;
}

// POST multipart/form-data with one or more `files`. Each image is saved to
// storage and classified with Claude vision. Nothing is written to the DB here
// — the client reviews/edits, then POSTs to /api/items to save.
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  }

  const results: ClassifyResult[] = [];

  for (const file of files) {
    if (file.size === 0) continue;
    if (file.size > MAX_BYTES) {
      results.push({
        imageUrl: "",
        classification: DEFAULT_CLASSIFICATION,
        classified: false,
        note: `${file.name} is larger than 12 MB and was skipped.`,
      });
      continue;
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "image/jpeg";

    let imageUrl = "";
    try {
      imageUrl = await storage.saveImage(bytes, file.name, mime);
    } catch {
      results.push({
        imageUrl: "",
        classification: DEFAULT_CLASSIFICATION,
        classified: false,
        note: `Could not save ${file.name}.`,
      });
      continue;
    }

    if (!isVisionSupported(mime)) {
      results.push({
        imageUrl,
        classification: DEFAULT_CLASSIFICATION,
        classified: false,
        note: "Auto-tagging supports JPEG, PNG, WebP or GIF — please fill in the details.",
      });
      continue;
    }

    try {
      const classification = await classifyImage(bytes.toString("base64"), mime);
      results.push({ imageUrl, classification, classified: true });
    } catch (err) {
      results.push({
        imageUrl,
        classification: DEFAULT_CLASSIFICATION,
        classified: false,
        note:
          err instanceof Error && err.message.includes("ANTHROPIC_API_KEY")
            ? "AI is not configured (missing API key) — fill in the details manually."
            : "Auto-tagging failed — please fill in the details.",
      });
    }
  }

  return NextResponse.json({ results });
}
