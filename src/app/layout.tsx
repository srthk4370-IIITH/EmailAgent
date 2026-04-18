import type { ReactNode } from "react";

import { AppShell } from "../components/AppShell";
import { AuthGate } from "../components/AuthGate";
import { ErrorCenterProvider } from "../components/errors/ErrorCenter";
import { ThemeProvider } from "../components/ThemeProvider";

import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <ThemeProvider>
          <ErrorCenterProvider>
            <AuthGate>
              <AppShell>{children}</AppShell>
            </AuthGate>
          </ErrorCenterProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
