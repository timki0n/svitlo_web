import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./components/ThemeProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "4U Світло",
  description: "Графік живлення ЖК 4U з графіками відключень YASNO.",
};

export const viewport = {
  themeColor: "#0b1221",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get("theme")?.value === "light" ? "light" : "dark";

  return (
    <html
      lang="uk"
      className={themeCookie === "dark" ? "dark" : ""}
      suppressHydrationWarning
    >
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider initialTheme={themeCookie}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
