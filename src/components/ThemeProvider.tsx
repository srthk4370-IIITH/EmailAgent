"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    const stored = window.localStorage.getItem("mail-theme");
    if (stored === "light" || stored === "dark") {
      setThemeState(stored);
      document.documentElement.dataset.theme = stored;
      return;
    }

    const preferredDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const nextTheme: Theme = preferredDark ? "dark" : "light";
    setThemeState(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: (nextTheme) => {
        setThemeState(nextTheme);
        document.documentElement.dataset.theme = nextTheme;
        window.localStorage.setItem("mail-theme", nextTheme);
      },
      toggleTheme: () => {
        const nextTheme = theme === "light" ? "dark" : "light";
        setThemeState(nextTheme);
        document.documentElement.dataset.theme = nextTheme;
        window.localStorage.setItem("mail-theme", nextTheme);
      },
    }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
