// Server-only Anthropic helpers. The API key is read from the environment and
// never leaves the server. Both entry points return parsed/validated JSON and
// retry once on a parse or shape failure.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  CLASSIFICATION_SYSTEM,
  CLASSIFICATION_USER,
  MODEL,
  STYLIST_SYSTEM,
  buildStylistUser,
  type StylistInputs,
} from "./prompts";
import {
  CATEGORIES,
  PATTERNS,
  SEASONS,
  SLOTS,
  type Category,
  type Classification,
  type Pattern,
  type Season,
  type Slot,
} from "./types";

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to fitted/.env.local to enable AI features.",
    );
  }
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

export type VisionMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export const SUPPORTED_VISION_TYPES: VisionMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export function isVisionSupported(mime: string): mime is VisionMediaType {
  return (SUPPORTED_VISION_TYPES as string[]).includes(mime.toLowerCase());
}

// Pull the first balanced JSON object out of a model response, tolerating stray
// prose or ```json fences the model may add despite instructions.
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace-scan
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function textFromMessage(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ----------------------------------------------------------------------------
// Normalization — clamp/whitelist model output so the DB + UI stay consistent.
// ----------------------------------------------------------------------------

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter(Boolean);
}

function normalizeClassification(raw: unknown): Classification {
  const o = (raw ?? {}) as Record<string, unknown>;

  const category = (CATEGORIES as readonly string[]).includes(o.category as string)
    ? (o.category as Category)
    : "shirt";

  const pattern = (PATTERNS as readonly string[]).includes(o.pattern as string)
    ? (o.pattern as Pattern)
    : "solid";

  let formality = Math.round(Number(o.formality_score ?? o.formalityScore ?? 5));
  if (!Number.isFinite(formality)) formality = 5;
  formality = Math.min(10, Math.max(1, formality));

  const seasons = asStringArray(o.season_suitability ?? o.seasonSuitability).filter(
    (s): s is Season => (SEASONS as readonly string[]).includes(s),
  );

  const subRaw = o.subcategory;
  const subcategory = typeof subRaw === "string" ? subRaw.trim() : "";

  return {
    category,
    subcategory,
    colors: asStringArray(o.colors).slice(0, 4),
    pattern,
    formalityScore: formality,
    seasonSuitability: seasons.length ? seasons : ["spring", "summer", "fall", "winter"],
    styleTags: asStringArray(o.style_tags ?? o.styleTags).slice(0, 4),
  };
}

// ----------------------------------------------------------------------------
// 1. Classify one image
// ----------------------------------------------------------------------------

export async function classifyImage(
  base64Data: string,
  mediaType: VisionMediaType,
): Promise<Classification> {
  const anthropic = getAnthropic();

  const run = async (): Promise<Classification> => {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: CLASSIFICATION_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64Data },
            },
            { type: "text", text: CLASSIFICATION_USER },
          ],
        },
      ],
    });
    return normalizeClassification(extractJson(textFromMessage(msg)));
  };

  try {
    return await run();
  } catch {
    // one retry
    return await run();
  }
}

// ----------------------------------------------------------------------------
// 2. Stylist — generate 3 outfit options (used in Step 3)
// ----------------------------------------------------------------------------

export interface RawOutfit {
  vibeLabel: string;
  explanation: string;
  slots: { slot: Slot; itemId: string }[];
}

function normalizeOutfits(raw: unknown): RawOutfit[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o.outfits) ? o.outfits : [];
  return list.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const slotsRaw = Array.isArray(e.slots) ? e.slots : [];
    const slots = slotsRaw
      .map((s) => {
        const so = (s ?? {}) as Record<string, unknown>;
        return { slot: so.slot as Slot, itemId: String(so.itemId ?? "") };
      })
      .filter(
        (s) => (SLOTS as readonly string[]).includes(s.slot) && s.itemId.length > 0,
      );
    return {
      vibeLabel: typeof e.vibeLabel === "string" ? e.vibeLabel : "Outfit",
      explanation: typeof e.explanation === "string" ? e.explanation : "",
      slots,
    };
  });
}

export async function generateOutfits(inputs: StylistInputs): Promise<RawOutfit[]> {
  const anthropic = getAnthropic();
  const userMsg = buildStylistUser(inputs);

  const run = async (): Promise<RawOutfit[]> => {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: STYLIST_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });
    return normalizeOutfits(extractJson(textFromMessage(msg)));
  };

  try {
    return await run();
  } catch {
    return await run();
  }
}
