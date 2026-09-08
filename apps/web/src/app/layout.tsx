import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Heima — a little more together", template: "%s · Heima" },
  description: "Your private home for shopping, household work, and finances.",
  manifest: "/manifest.webmanifest",
  icons: { apple: "/icon-180.png" },
  appleWebApp: { capable: true, title: "Heima", statusBarStyle: "default" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#28594b",
  viewportFit: "cover",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
