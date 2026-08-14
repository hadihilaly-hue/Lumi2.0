"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Home", icon: "✦" },
  { href: "/closet", label: "Closet", icon: "👕" },
  { href: "/generate", label: "Style", icon: "✨" },
  { href: "/history", label: "Saved", icon: "♥" },
] as const;

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-black/10 bg-background/90 backdrop-blur-md dark:border-white/10">
      <div className="mx-auto grid w-full max-w-2xl grid-cols-4">
        {TABS.map((tab) => {
          const active =
            tab.href === "/"
              ? pathname === "/"
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex flex-col items-center gap-1 py-3 text-xs font-medium transition-colors ${
                active
                  ? "text-stone-900 dark:text-white"
                  : "text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
              }`}
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
