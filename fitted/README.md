# Fitted — AI Wardrobe Stylist

Build a digital closet from photos of clothes you own, then generate complete
outfits for any event using only your own items.

> Lives in the `fitted/` subdirectory of this repo, fully isolated from the
> Lumi static site at the repo root (its own `package.json`, `node_modules`,
> database, and env).

## Stack

- **Next.js (App Router) + TypeScript**
- **Tailwind CSS v4** — mobile-first
- **Prisma + SQLite** for local dev (swappable to Postgres/Supabase)
- **Anthropic API** (`claude-sonnet-4-6`) for vision classification + outfit
  generation. All calls are server-side; the key is never sent to the client.

## Setup

```bash
cd fitted
npm install
cp .env.example .env.local     # then set ANTHROPIC_API_KEY
npx prisma db push             # create the SQLite dev DB
npm run dev                    # http://localhost:3000
```

`ANTHROPIC_API_KEY` is read from `.env.local`. `DATABASE_URL` lives in both
`.env` (for the Prisma CLI) and `.env.local` (for the app runtime).

## Layout

```
src/
  app/                 # routes: / (home), /closet, /generate, /history
  components/          # shared UI (NavBar, ...)
  lib/
    prisma.ts          # PrismaClient singleton
    types.ts           # canonical vocab (categories, slots, seasons) + shapes
    items.ts           # row <-> app-Item serialization (JSON array fields)
    storage.ts         # image storage abstraction (local /uploads; swappable to S3)
    prompts.ts         # (Step 2/3) the two tunable Anthropic prompts
prisma/schema.prisma   # ClothingItem, Outfit, OutfitItem
public/uploads/        # dev image storage (gitignored)
```

## Data model

- **ClothingItem** — one garment: image, category/subcategory, colors, pattern,
  formality (1–10), season suitability, style tags, availability.
- **Outfit** — a generated look: event description, vibe label, explanation,
  favorite flag, `wornAt`.
- **OutfitItem** — join row linking an outfit to a clothing item with a `slot`
  (top / bottom / shoes / outerwear / accessory).

Array-valued fields (`colors`, `seasonSuitability`, `styleTags`) are stored as
JSON strings because SQLite has no array type; `src/lib/items.ts` is the single
place that encodes/decodes them.

## Build status

- [x] **Step 1** — scaffold, schema, storage abstraction, app shell + nav
- [x] **Step 2** — upload (drag-drop + mobile capture) + AI vision classification
      with review-before-save + filterable closet grid (edit / delete / laundry)
- [ ] Step 3 — outfit generation (3 options, item photo cards)
- [ ] Step 4 — shuffle-a-slot, favorites, worn-recently tracking
- [ ] Step 5 — loading/empty/error-state polish
