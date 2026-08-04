import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anchor Docs",
  description: "Next.js docs assistant — every answer anchored to its source.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        {children}
      </body>
    </html>
  );
}
