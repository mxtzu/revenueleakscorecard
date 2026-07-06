import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "@fontsource/archivo-black";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: "ASCEND | Revenue Leak Diagnosis for Roblox Studios",
  description:
    "A two-minute Revenue Leak Diagnosis for post-traction Roblox studios. Six questions, answerable from your Creator Dashboard, that name the leak costing you the most across Acquisition, Activation, Monetization, Measurement, and Compounding.",
  icons: {
    icon: "/icon.svg"
  }
};

export const viewport: Viewport = {
  themeColor: "#0A0A0B"
};

const gaMeasurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        {gaMeasurementId ? (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaMeasurementId}`}
              strategy="afterInteractive"
            />
            <Script id="ga4-init" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${gaMeasurementId}');
              `}
            </Script>
          </>
        ) : null}
      </body>
    </html>
  );
}
