import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

import { Providers } from "@/components/providers";

// Self-hosted via the `geist` package (next/font/local under the hood)
// rather than next/font/google: no build-time fetch to Google's CDN, which
// keeps `pnpm build` working in network-restricted CI. See docs/DECISIONS.md.

export const metadata: Metadata = {
  title: "Knowledge Base",
  description: "AI-Powered Knowledge Base (Goodspeed Technical Assessment)",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
