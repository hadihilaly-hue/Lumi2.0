"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ItemForm, type ItemFormValue } from "./ItemForm";
import type { Classification } from "@/lib/types";

interface Draft {
  imageUrl: string;
  classified: boolean;
  note?: string;
  value: ItemFormValue;
}

interface ClassifyResult {
  imageUrl: string;
  classification: Classification;
  classified: boolean;
  note?: string;
}

type Stage = "select" | "classifying" | "review";

export function AddItemsFlow() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("select");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    if (files.length === 0) {
      setError("Please choose image files.");
      return;
    }
    setError(null);
    setStage("classifying");

    const form = new FormData();
    files.forEach((f) => form.append("files", f));

    try {
      const res = await fetch("/api/items/classify", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed.");
      }
      const { results } = (await res.json()) as { results: ClassifyResult[] };
      const usable = results.filter((r) => r.imageUrl);
      if (usable.length === 0) {
        setError(results[0]?.note || "None of the images could be processed.");
        setStage("select");
        return;
      }
      setDrafts(
        usable.map((r) => ({
          imageUrl: r.imageUrl,
          classified: r.classified,
          note: r.note,
          value: r.classification,
        })),
      );
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStage("select");
    }
  }, []);

  const updateDraft = (i: number, value: ItemFormValue) =>
    setDrafts((d) => d.map((draft, idx) => (idx === i ? { ...draft, value } : draft)));

  const removeDraft = (i: number) =>
    setDrafts((d) => d.filter((_, idx) => idx !== i));

  const saveAll = async () => {
    if (drafts.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: drafts.map((d) => ({ imageUrl: d.imageUrl, ...d.value })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not save items.");
      }
      router.push("/closet");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save items.");
      setSaving(false);
    }
  };

  if (stage === "classifying") {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-center">
        <Spinner />
        <p className="font-medium">Tagging your items…</p>
        <p className="text-sm text-stone-500">Claude is looking at each photo.</p>
      </div>
    );
  }

  if (stage === "review") {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Review {drafts.length} item{drafts.length === 1 ? "" : "s"}
          </h2>
          <button
            type="button"
            onClick={() => {
              setDrafts([]);
              setStage("select");
            }}
            className="text-sm text-stone-500 underline"
          >
            Start over
          </button>
        </div>
        <p className="text-sm text-stone-500">
          Fitted&apos;s guesses are below. Fix anything that&apos;s off before saving.
        </p>

        {error && <ErrorBanner message={error} />}

        <div className="space-y-6">
          {drafts.map((draft, i) => (
            <div
              key={draft.imageUrl}
              className="rounded-2xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-white/5"
            >
              <div className="mb-3 flex items-start gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={draft.imageUrl}
                  alt="Uploaded item"
                  className="h-24 w-24 shrink-0 rounded-xl object-cover"
                />
                <div className="min-w-0 flex-1">
                  {!draft.classified && (
                    <p className="mb-1 text-xs text-amber-600 dark:text-amber-400">
                      {draft.note || "Not auto-tagged — please fill in the details."}
                    </p>
                  )}
                  <p className="truncate text-sm font-medium capitalize">
                    {draft.value.subcategory || draft.value.category}
                  </p>
                  <p className="text-xs text-stone-400">Item {i + 1}</p>
                </div>
                <button
                  type="button"
                  onClick={() => removeDraft(i)}
                  className="text-sm text-stone-400 hover:text-red-500"
                  aria-label="Remove"
                >
                  ✕
                </button>
              </div>
              <ItemForm value={draft.value} onChange={(v) => updateDraft(i, v)} />
            </div>
          ))}
        </div>

        <div className="sticky bottom-20 flex gap-3 rounded-2xl bg-background/80 py-2 backdrop-blur">
          <button
            type="button"
            onClick={saveAll}
            disabled={saving || drafts.length === 0}
            className="btn btn-primary flex-1"
          >
            {saving ? "Saving…" : `Save ${drafts.length} to closet`}
          </button>
        </div>
      </div>
    );
  }

  // select stage
  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-16 text-center transition ${
          dragging
            ? "border-stone-800 bg-stone-800/5 dark:border-stone-200"
            : "border-black/20 dark:border-white/20"
        }`}
      >
        <span className="text-3xl">📸</span>
        <p className="font-medium">Add clothing photos</p>
        <p className="text-sm text-stone-500">
          Tap to take/choose photos, or drag &amp; drop here. One item per photo works best.
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        capture="environment"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-stone-800 dark:border-stone-600 dark:border-t-stone-200" />
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
      {message}
    </div>
  );
}
