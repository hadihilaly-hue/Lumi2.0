import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { toItems } from "@/lib/items";
import { ClosetGrid } from "@/components/ClosetGrid";

export const dynamic = "force-dynamic";
export const metadata = { title: "Closet — Fitted" };

export default async function ClosetPage() {
  const rows = await prisma.clothingItem.findMany({ orderBy: { createdAt: "desc" } });
  const items = toItems(rows);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Closet</h1>
          <p className="text-sm text-stone-500">
            {items.length} item{items.length === 1 ? "" : "s"}
          </p>
        </div>
        <Link href="/closet/add" className="btn btn-primary">
          + Add
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/20 px-6 py-16 text-center dark:border-white/20">
          <p className="text-4xl">🧥</p>
          <p className="mt-3 font-medium">Your closet is empty</p>
          <p className="mt-1 text-sm text-stone-500">
            Add photos of your clothes and Fitted will tag them automatically.
          </p>
          <Link href="/closet/add" className="btn btn-primary mt-5">
            Add your first items
          </Link>
        </div>
      ) : (
        <ClosetGrid initialItems={items} />
      )}
    </div>
  );
}
