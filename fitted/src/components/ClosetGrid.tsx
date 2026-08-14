"use client";

import { useMemo, useState } from "react";
import { ItemForm } from "./ItemForm";
import type { Classification, Item } from "@/lib/types";

const FORMALITY_BANDS = [
  { key: "any", label: "Any formality", test: () => true },
  { key: "casual", label: "Casual (1–4)", test: (f: number) => f <= 4 },
  { key: "smart", label: "Smart (5–7)", test: (f: number) => f >= 5 && f <= 7 },
  { key: "formal", label: "Formal (8–10)", test: (f: number) => f >= 8 },
] as const;

export function ClosetGrid({ initialItems }: { initialItems: Item[] }) {
  const [items, setItems] = useState<Item[]>(initialItems);
  const [category, setCategory] = useState("all");
  const [color, setColor] = useState("all");
  const [band, setBand] = useState("any");
  const [editing, setEditing] = useState<Item | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const categories = useMemo(
    () => Array.from(new Set(items.map((i) => i.category))).sort(),
    [items],
  );
  const colors = useMemo(
    () => Array.from(new Set(items.flatMap((i) => i.colors))).sort(),
    [items],
  );

  const filtered = useMemo(() => {
    const bandTest = FORMALITY_BANDS.find((b) => b.key === band)?.test ?? (() => true);
    return items.filter(
      (i) =>
        (category === "all" || i.category === category) &&
        (color === "all" || i.colors.includes(color)) &&
        bandTest(i.formalityScore),
    );
  }, [items, category, color, band]);

  const toggleAvailable = async (item: Item) => {
    setBusyId(item.id);
    const next = !item.isAvailable;
    // optimistic
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, isAvailable: next } : i)));
    try {
      const res = await fetch(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAvailable: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setItems((list) => list.map((i) => (i.id === item.id ? { ...i, isAvailable: !next } : i)));
    } finally {
      setBusyId(null);
    }
  };

  const removeItem = async (item: Item) => {
    if (!confirm(`Delete this ${item.subcategory || item.category}?`)) return;
    setBusyId(item.id);
    const prev = items;
    setItems((list) => list.filter((i) => i.id !== item.id));
    try {
      const res = await fetch(`/api/items/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
    } catch {
      setItems(prev);
    } finally {
      setBusyId(null);
    }
  };

  const saveEdit = async (id: string, value: Classification) => {
    const res = await fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (res.ok) {
      const { item } = (await res.json()) as { item: Item };
      setItems((list) => list.map((i) => (i.id === id ? item : i)));
      setEditing(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="grid grid-cols-3 gap-2">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="input text-sm">
          <option value="all">All types</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={color} onChange={(e) => setColor(e.target.value)} className="input text-sm">
          <option value="all">All colors</option>
          {colors.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={band} onChange={(e) => setBand(e.target.value)} className="input text-sm">
          {FORMALITY_BANDS.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
      </div>

      <p className="text-xs text-stone-400">
        {filtered.length} of {items.length} item{items.length === 1 ? "" : "s"}
      </p>

      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-stone-500">No items match these filters.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {filtered.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onEdit={() => setEditing(item)}
              onToggle={() => toggleAvailable(item)}
              onDelete={() => removeItem(item)}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditModal item={editing} onClose={() => setEditing(null)} onSave={saveEdit} />
      )}
    </div>
  );
}

function ItemCard({
  item,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  item: Item;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-black/10 bg-white dark:border-white/10 dark:bg-white/5">
      <div className="relative aspect-square">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.imageUrl}
          alt={item.subcategory || item.category}
          className={`h-full w-full object-cover ${item.isAvailable ? "" : "opacity-40 grayscale"}`}
        />
        {!item.isAvailable && (
          <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
            In laundry
          </span>
        )}
        <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
          {item.formalityScore}/10
        </span>
      </div>
      <div className="space-y-1 p-2">
        <p className="truncate text-sm font-medium capitalize">
          {item.subcategory || item.category}
        </p>
        <p className="truncate text-xs text-stone-400 capitalize">{item.colors.join(", ") || "—"}</p>
        <div className="flex items-center justify-between pt-1 text-xs">
          <button onClick={onEdit} disabled={busy} className="text-stone-500 hover:text-stone-800 disabled:opacity-40">
            Edit
          </button>
          <button onClick={onToggle} disabled={busy} className="text-stone-500 hover:text-stone-800 disabled:opacity-40">
            {item.isAvailable ? "Laundry" : "Restore"}
          </button>
          <button onClick={onDelete} disabled={busy} className="text-stone-500 hover:text-red-500 disabled:opacity-40">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function EditModal({
  item,
  onClose,
  onSave,
}: {
  item: Item;
  onClose: () => void;
  onSave: (id: string, value: Classification) => Promise<void>;
}) {
  const [value, setValue] = useState<Classification>({
    category: item.category as Classification["category"],
    subcategory: item.subcategory ?? "",
    colors: item.colors,
    pattern: item.pattern as Classification["pattern"],
    formalityScore: item.formalityScore,
    seasonSuitability: item.seasonSuitability as Classification["seasonSuitability"],
    styleTags: item.styleTags,
  });
  const [saving, setSaving] = useState(false);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-background p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.imageUrl} alt="" className="h-16 w-16 rounded-xl object-cover" />
          <h3 className="text-lg font-semibold">Edit item</h3>
        </div>
        <ItemForm value={value} onChange={setValue} />
        <div className="mt-5 flex gap-3">
          <button className="btn btn-ghost flex-1" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary flex-1"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await onSave(item.id, value);
              setSaving(false);
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
