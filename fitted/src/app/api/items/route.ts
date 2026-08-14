import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sanitizeItemInput, toItem, toItems } from "@/lib/items";

export const runtime = "nodejs";

// GET /api/items — full closet (newest first). Client uses this to refresh.
export async function GET() {
  const rows = await prisma.clothingItem.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ items: toItems(rows) });
}

// POST /api/items — create one or many items from reviewed classifications.
// Body: a single item object, or { items: [...] }.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rawItems: unknown[] = Array.isArray((body as { items?: unknown[] })?.items)
    ? (body as { items: unknown[] }).items
    : [body];

  const created = [];
  for (const raw of rawItems) {
    const data = sanitizeItemInput(raw);
    if (!data.imageUrl) {
      return NextResponse.json(
        { error: "Each item needs an uploaded imageUrl." },
        { status: 400 },
      );
    }
    const row = await prisma.clothingItem.create({
      data: { ...data, imageUrl: data.imageUrl },
    });
    created.push(toItem(row));
  }

  return NextResponse.json({ items: created }, { status: 201 });
}
