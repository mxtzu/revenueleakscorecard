import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ASCEND | Roblox Revenue Leak Scorecard",
  description:
    "A lifecycle diagnostic for post-traction Roblox studios to find revenue leaks across acquisition, activation, monetisation, measurement, and compounding.",
  icons: { icon: "/icon.svg" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
