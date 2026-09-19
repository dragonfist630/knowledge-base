"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileTextIcon, MessageSquareIcon, BarChart3Icon } from "lucide-react";

import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/documents", label: "Documents", icon: FileTextIcon },
  { href: "/chat", label: "Chat", icon: MessageSquareIcon },
  { href: "/usage", label: "Usage", icon: BarChart3Icon },
] as const;

/** The sidebar's three top-level sections. A client component only because active-route highlighting needs `usePathname`. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
