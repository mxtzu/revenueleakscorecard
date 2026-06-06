import Script from "next/script";
import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const auditUrl = "https://t.co/Zc46iJTUX9";

export const metadata: Metadata = {
  title: "ASCEND | Roblox Revenue Leak Scorecard",
  description:
    "A lifecycle diagnostic for post-traction Roblox studios to find revenue leaks across acquisition, activation, monetisation, measurement, and compounding.",
  icons: { icon: "/icon.svg" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
        <Script id="audit-cta-link" strategy="afterInteractive">
          {`
            (() => {
              const auditUrl = "${auditUrl}";
              const isAuditCta = (node) =>
                node?.textContent?.trim().includes("Book a Revenue Leak Audit");
              const wireAuditCtas = () => {
                document.querySelectorAll("a").forEach((link) => {
                  if (isAuditCta(link)) link.href = auditUrl;
                });
              };
              document.addEventListener("click", (event) => {
                const target = event.target.closest("a,button");
                if (!isAuditCta(target)) return;
                event.preventDefault();
                window.location.href = auditUrl;
              }, true);
              wireAuditCtas();
              new MutationObserver(wireAuditCtas).observe(document.body, {
                childList: true,
                subtree: true
              });
            })();
          `}
        </Script>
      </body>
    </html>
  );
}
