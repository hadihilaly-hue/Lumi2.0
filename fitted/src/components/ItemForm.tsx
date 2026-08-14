"use client";

import { CATEGORIES, PATTERNS, SEASONS, type Classification } from "@/lib/types";

// Editable subset of an item — the shape the review + edit forms mutate.
export type ItemFormValue = Classification;

export function ItemForm({
  value,
  onChange,
}: {
  value: ItemFormValue;
  onChange: (next: ItemFormValue) => void;
}) {
  const set = <K extends keyof ItemFormValue>(key: K, v: ItemFormValue[K]) =>
    onChange({ ...value, [key]: v });

  const toggleSeason = (season: (typeof SEASONS)[number]) => {
    const has = value.seasonSuitability.includes(season);
    set(
      "seasonSuitability",
      has
        ? value.seasonSuitability.filter((s) => s !== season)
        : [...value.seasonSuitability, season],
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category">
          <select
            value={value.category}
            onChange={(e) => set("category", e.target.value as ItemFormValue["category"])}
            className="input"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pattern">
          <select
            value={value.pattern}
            onChange={(e) => set("pattern", e.target.value as ItemFormValue["pattern"])}
            className="input"
          >
            {PATTERNS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Subcategory">
        <input
          type="text"
          value={value.subcategory}
          onChange={(e) => set("subcategory", e.target.value)}
          placeholder="e.g. oxford button-down"
          className="input"
        />
      </Field>

      <Field label="Colors (comma separated)">
        <input
          type="text"
          value={value.colors.join(", ")}
          onChange={(e) => set("colors", splitList(e.target.value))}
          placeholder="navy, white"
          className="input"
        />
      </Field>

      <Field label={`Formality: ${value.formalityScore}/10`}>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={value.formalityScore}
          onChange={(e) => set("formalityScore", Number(e.target.value))}
          className="w-full accent-stone-800 dark:accent-stone-200"
        />
        <div className="flex justify-between text-[10px] uppercase tracking-wide text-stone-400">
          <span>gym</span>
          <span>black tie</span>
        </div>
      </Field>

      <Field label="Seasons">
        <div className="flex flex-wrap gap-2">
          {SEASONS.map((s) => {
            const active = value.seasonSuitability.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSeason(s)}
                className={`rounded-full border px-3 py-1 text-sm capitalize transition ${
                  active
                    ? "border-stone-800 bg-stone-800 text-white dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900"
                    : "border-black/15 text-stone-500 dark:border-white/20"
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Style tags (comma separated)">
        <input
          type="text"
          value={value.styleTags.join(", ")}
          onChange={(e) => set("styleTags", splitList(e.target.value))}
          placeholder="preppy, classic"
          className="input"
        />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-stone-500 dark:text-stone-400">{label}</span>
      {children}
    </label>
  );
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
