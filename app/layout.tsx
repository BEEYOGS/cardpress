import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cardpress — UV ID Card Studio",
  description: "Studio desain kartu ID dengan preview langsung dan ekspor siap cetak.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className="dark">
      <body>{children}</body>
    </html>
  );
}
