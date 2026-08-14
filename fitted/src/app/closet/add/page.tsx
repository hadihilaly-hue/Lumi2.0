import Link from "next/link";
import { AddItemsFlow } from "@/components/AddItemsFlow";

export const metadata = { title: "Add items — Fitted" };

export default function AddItemsPage() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/closet" className="text-stone-400 hover:text-stone-600" aria-label="Back">
          ←
        </Link>
        <h1 className="text-2xl font-bold">Add items</h1>
      </div>
      <AddItemsFlow />
    </div>
  );
}
