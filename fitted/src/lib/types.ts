// Shared domain types + canonical vocabularies for Fitted.
// These are the single source of truth for categories, slots, seasons, etc.,
// referenced by both the AI prompts and the UI so they never drift.

export const CATEGORIES = [
  "shirt",
  "t-shirt",
  "polo",
  "sweater",
  "hoodie",
  "jacket",
  "pants",
  "jeans",
  "shorts",
  "shoes",
  "accessory",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const PATTERNS = [
  "solid",
  "striped",
  "plaid",
  "checkered",
  "graphic",
  "floral",
  "camo",
  "textured",
  "other",
] as const;
export type Pattern = (typeof PATTERNS)[number];

export const SEASONS = ["spring", "summer", "fall", "winter"] as const;
export type Season = (typeof SEASONS)[number];

export const SLOTS = ["top", "bottom", "shoes", "outerwear", "accessory"] as const;
export type Slot = (typeof SLOTS)[number];

// The shape the classifier must return and the UI edits before saving.
export interface Classification {
  category: Category;
  subcategory: string;
  colors: string[]; // primary first, then secondary
  pattern: Pattern;
  formalityScore: number; // 1..10
  seasonSuitability: Season[];
  styleTags: string[]; // e.g. ["preppy", "athletic", "streetwear", "classic"]
}

// A closet item as the app works with it (arrays already parsed).
export interface Item {
  id: string;
  imageUrl: string;
  category: string;
  subcategory: string | null;
  colors: string[];
  seasonSuitability: string[];
  styleTags: string[];
  pattern: string;
  formalityScore: number;
  isAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OutfitSlotChoice {
  slot: Slot;
  itemId: string;
}

// One generated outfit option (as returned by the stylist + hydrated with items).
export interface OutfitOption {
  vibeLabel: string;
  explanation: string;
  slots: OutfitSlotChoice[];
}

export interface SavedOutfit {
  id: string;
  eventDescription: string;
  vibeLabel: string;
  explanation: string;
  isFavorite: boolean;
  wornAt: string | null;
  createdAt: string;
  items: { slot: string; item: Item }[];
}
