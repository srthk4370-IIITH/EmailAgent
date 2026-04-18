"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FilePenLine, Inbox, MailPlus, Send, Settings2 } from "lucide-react";
import { GlobalErrorBanner } from "./errors/GlobalErrorBanner";
import { Sidebar } from "./layout/Sidebar";
import { SystemHealthBar } from "./layout/SystemHealthBar";

const mobileNavItems = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/drafts", label: "Drafts", icon: FilePenLine },
  { href: "/compose", label: "Compose", icon: MailPlus },
  { href: "/sent", label: "Sent", icon: Send },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

const PREFETCH_ROUTES = ["/", "/inbox", "/drafts", "/sent", "/logs", "/settings", "/compose"];
const WARMUP_APIS = ["/api/config", "/api/system/check", "/api/sync/status", "/api/system/connections", "/api/logs/activity?limit=90"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const prefetchDoneRef = useRef(false);
  const warmupDoneRef = useRef(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("sidebar-collapsed");
    if (stored === "1") {
      setSidebarCollapsed(true);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("sidebar-collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (prefetchDoneRef.current) return;
    prefetchDoneRef.current = true;
    for (const route of PREFETCH_ROUTES) {
      router.prefetch(route);
    }
  }, [router]);

  useEffect(() => {
    if (pathname === "/login" || pathname === "/onboarding") return;
    if (warmupDoneRef.current) return;

    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (nav.connection?.saveData) return;

    warmupDoneRef.current = true;

    const controller = new AbortController();
    let scheduleTimer: number | null = null;
    let idleId: number | null = null;
    let abortTimer: number | null = null;

    const runWarmup = () => {
      const activeAccountId = Number(window.localStorage.getItem("activeAccountId"));
      const inboxRoute =
        Number.isFinite(activeAccountId) && activeAccountId > 0
          ? `/api/emails?filter=inbox&limit=20&accountId=${activeAccountId}`
          : "/api/emails?filter=inbox&limit=20";
      const dashboardRoute =
        Number.isFinite(activeAccountId) && activeAccountId > 0
          ? `/api/emails?filter=all&limit=20&accountId=${activeAccountId}`
          : "/api/emails?filter=all&limit=20";

      const targets = [...WARMUP_APIS, inboxRoute, dashboardRoute];
      for (const target of targets) {
        void fetch(target, {
          credentials: "include",
          signal: controller.signal,
        }).catch(() => {
          // Warmup is best-effort; ignore endpoint failures.
        });
      }

      // Keep warmup bounded so it never competes with user-initiated requests.
      abortTimer = window.setTimeout(() => controller.abort(), 2400);
    };

    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runWarmup, { timeout: 1200 });
    } else {
      scheduleTimer = window.setTimeout(runWarmup, 220);
    }

    return () => {
      if (scheduleTimer != null) window.clearTimeout(scheduleTimer);
      if (abortTimer != null) window.clearTimeout(abortTimer);
      if (idleId != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      controller.abort();
    };
  }, [pathname]);

  if (pathname === "/login" || pathname === "/onboarding") {
    return <>{children}</>;
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    router.replace("/login");
  }

  return (
    <div className="app-shell relative min-h-screen w-full overflow-hidden app-text-primary">
      <div className="app-shell-glow pointer-events-none absolute inset-0" />

      <div className="relative mx-auto flex h-screen w-full max-w-[1860px] min-w-0 gap-2 overflow-hidden px-2 pb-20 pt-2 md:gap-3 md:px-4 md:pb-4 md:pt-4">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
          onLogout={() => void logout()}
        />

        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <GlobalErrorBanner />
          <main className="app-main-stage flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px]">
            {children}
          </main>
        </div>

        <SystemHealthBar />
      </div>

      <nav className="fixed inset-x-2 bottom-2 z-50 flex items-center justify-between rounded-2xl border app-border bg-[color:var(--surface-layer-2)] px-1.5 py-1.5 shadow-lg backdrop-blur md:hidden">
        {mobileNavItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`app-focus-ring inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] app-motion-fast ${
                active ? "app-accent-bg" : "app-text-secondary app-hover-soft"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate leading-none">{label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
