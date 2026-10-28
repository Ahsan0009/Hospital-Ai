import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const plexSans = localFont({
  src: "./fonts/IBMPlexSans-Variable.woff2",
  variable: "--font-plex-sans",
  weight: "100 700",
});

const plexMono = localFont({
  src: "./fonts/IBMPlexMono-Regular.woff2",
  variable: "--font-plex-mono",
  weight: "400",
});

export const metadata: Metadata = {
  title: { default: "Clinic desk", template: "%s | Clinic desk" },
  description: "Appointments, patient handoffs, reports and feedback from the clinic's WhatsApp assistant.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`} data-theme="light" suppressHydrationWarning>
      <head>
        {/* Applies the saved theme before first paint so pages never flash the wrong theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("clinic-desk-theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
