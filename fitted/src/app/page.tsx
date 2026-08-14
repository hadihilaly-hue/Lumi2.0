import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [itemCount, availableCount, outfitCount, favoriteCount] =
    await Promise.all([
      prisma.clothingItem.count(),
      prisma.clothingItem.count({ where: { isAvailable: true } }),
      prisma.outfit.count(),
      prisma.outfit.count({ where: { isFavorite: true } }),
    ]);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Fitted</h1>
        <p className="text-stone-500 dark:text-stone-400">
          Your AI wardrobe stylist. Outfits built from what you actually own.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <Stat label="Items in closet" value={itemCount} sub={`${availableCount} available`} />
        <Stat label="Saved outfits" value={outfitCount} sub={`${favoriteCount} favorites`} />
      </section>

      <section className="space-y-3">
        <ActionCard
          href="/closet"
          title="Build your closet"
          body="Snap or upload photos of your clothes. Fitted tags each item automatically."
          cta="Open closet →"
        />
        <ActionCard
          href="/generate"
          title="Get an outfit"
          body="Tell Fitted where you're going and get three complete looks from your wardrobe."
          cta="Style me →"
          disabled={itemCount === 0}
          disabledHint="Add a few items first"
        />
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-2xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-white/5">
      <div className="text-3xl font-semibold">{value}</div>
      <div className="mt-1 text-sm font-medium">{label}</div>
      <div className="text-xs text-stone-400">{sub}</div>
    </div>
  );
}

function ActionCard({
  href,
  title,
  body,
  cta,
  disabled = false,
  disabledHint,
}: {
  href: string;
  title: string;
  body: string;
  cta: string;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const inner = (
    <div
      className={`rounded-2xl border border-black/10 bg-white p-5 transition dark:border-white/10 dark:bg-white/5 ${
        disabled ? "opacity-60" : "hover:border-black/25 dark:hover:border-white/25"
      }`}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{body}</p>
      <p className="mt-3 text-sm font-medium">
        {disabled ? (disabledHint ?? "Unavailable") : cta}
      </p>
    </div>
  );
  if (disabled) return inner;
  return <Link href={href}>{inner}</Link>;
}
