// Serialization layer between the Prisma row (JSON-string array fields on SQLite)
// and the app-facing `Item` shape (real arrays). Centralizing this here means the
// rest of the app never touches the JSON encoding, and swapping to Postgres native
// arrays later only changes this one file.

import type { ClothingItem } from "@prisma/client";
import type { Item } from "./types";

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
