// Serialization layer between the Prisma row (JSON-string array fields on SQLite)
// and the app-facing `Item` shape (real arrays). Centralizing this here means the
// rest of the app never touches the JSON encoding, and swapping to Postgres native
// arrays later only changes this one file.

import type { ClothingItem } from "@prisma/client";
import { CATEGORIES, PATTERNS, SEASONS, type Item } from "./types";

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    return [];
  } catch {
    return [];
  }
}

export function encodeArray(values: string[] | undefined | null): string {
  if (!Array.isArray(values)) return "[]";
  const clean = values.map((v) => String(v).trim()).filter(Boolean);
  return JSON.stringify(clean);
}

// Prisma row -> app Item
export function toItem(row: ClothingItem): Item {
  return {
    id: row.id,
    imageUrl: row.imageUrl,
    category: row.category,
    subcategory: row.subcategory,
    colors: parseJsonArray(row.colors),
    seasonSuitability: parseJsonArray(row.seasonSuitability),
    styleTags: parseJsonArray(row.styleTags),
    pattern: row.pattern,
    formalityScore: row.formalityScore,
    isAvailable: row.isAvailable,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toItems(rows: ClothingItem[]): Item[] {
  return rows.map(toItem);
}

// Prisma-ready column values for creating/updating an item.
export interface ItemWriteData {
  imageUrl?: string;
  category: string;
  subcategory: string | null;
  colors: string; // JSON-encoded
  seasonSuitability: string; // JSON-encoded
  styleTags: string; // JSON-encoded
  pattern: string;
  formalityScore: number;
  isAvailable: boolean;
}

// Validate + coerce an untrusted request body (from the review form) into safe
// column values. Whitelists enums, clamps formality, encodes arrays.
export function sanitizeItemInput(body: unknown): ItemWriteData {
  const b = (body ?? {}) as Record<string, unknown>;

  const category = (CATEGORIES as readonly string[]).includes(b.category as string)
    ? (b.category as string)
    : "shirt";

  const pattern = (PATTERNS as readonly string[]).includes(b.pattern as string)
    ? (b.pattern as string)
    : "solid";

  let formality = Math.round(Number(b.formalityScore ?? 5));
  if (!Number.isFinite(formality)) formality = 5;
  formality = Math.min(10, Math.max(1, formality));

  const seasonsIn = Array.isArray(b.seasonSuitability) ? b.seasonSuitability : [];
  const seasons = seasonsIn
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => (SEASONS as readonly string[]).includes(s));

  const subRaw = b.subcategory;
  const subcategory =
    typeof subRaw === "string" && subRaw.trim() ? subRaw.trim() : null;

  const data: ItemWriteData = {
    category,
    subcategory,
    colors: encodeArray(Array.isArray(b.colors) ? (b.colors as string[]) : []),
    seasonSuitability: encodeArray(seasons),
    styleTags: encodeArray(Array.isArray(b.styleTags) ? (b.styleTags as string[]) : []),
    pattern,
    formalityScore: formality,
    isAvailable: b.isAvailable === undefined ? true : Boolean(b.isAvailable),
  };

  if (typeof b.imageUrl === "string" && b.imageUrl.startsWith("/uploads/")) {
    data.imageUrl = b.imageUrl;
  }

  return data;
}
