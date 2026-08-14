import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { encodeArray, toItem } from "@/lib/items";
import { CATEGORIES, PATTERNS, SEASONS } from "@/lib/types";

export const runtime = "nodejs";

// PATCH /api/items/:id — partial update. Accepts any subset of editable fields;
// used both for full-classification edits and quick availability toggles.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const data: Record<string, unknown> = {};

  if (typeof body.category === "string" && (CATEGORIES as readonly string[]).includes(body.category))
    data.category = body.category;
  if ("subcategory" in body)
    data.subcategory =
      typeof body.subcategory === "string" && body.subcategory.trim()
        ? body.subcategory.trim()
        : null;
  if (typeof body.pattern === "string" && (PATTERNS as readonly string[]).includes(body.pattern))
    data.pattern = body.pattern;
  if (body.formalityScore !== undefined) {
    let f = Math.round(Number(body.formalityScore));
    if (Number.isFinite(f)) data.formalityScore = Math.min(10, Math.max(1, f));
  }
  if (Array.isArray(body.colors)) data.colors = encodeArray(body.colors as string[]);
  if (Array.isArray(body.styleTags)) data.styleTags = encodeArray(body.styleTags as string[]);
  if (Array.isArray(body.seasonSuitability)) {
    const seasons = (body.seasonSuitability as unknown[])
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => (SEASONS as readonly string[]).includes(s));
    data.seasonSuitability = encodeArray(seasons);
  }
  if (body.isAvailable !== undefined) data.isAvailable = Boolean(body.isAvailable);

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
  }

  try {
    const row = await prisma.clothingItem.update({ where: { id }, data });
    return NextResponse.json({ item: toItem(row) });
  } catch {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
}

// DELETE /api/items/:id — remove item and best-effort delete its image file.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const row = await prisma.clothingItem.delete({ where: { id } });
    await storage.deleteImage(row.imageUrl);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
}
