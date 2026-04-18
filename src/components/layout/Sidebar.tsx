"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  Inbox,
  LayoutGrid,
  LogOut,
  MailPlus,
  RefreshCcw,
  Send,
  Settings2,
  SunMoon,
  Tag,
  UserRound,
} from "lucide-react";
import { useTheme } from "../ThemeProvider";

type EmailItem = {
  state: string;
  source?: string;
  is_seen?: boolean;
};

type AccountOption = {
  id: number;
  email: string;
  status: string;
  lastSyncAt?: string | null;
};

const SIDEBAR_EMAIL_CACHE_PREFIX = "sidebar:emails:v1";

function sidebarEmailCacheKey(accountId: number | null): string {
  return `${SIDEBAR_EMAIL_CACHE_PREFIX}:${accountId ?? "all"}`;
}

function readSidebarEmailCache(accountId: number | null): EmailItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(sidebarEmailCacheKey(accountId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { emails?: EmailItem[] } | null;
    return Array.isArray(parsed?.emails) ? parsed.emails : [];
  } catch {
    return [];
  }
}

function writeSidebarEmailCache(accountId: number | null, emails: EmailItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(sidebarEmailCacheKey(accountId), JSON.stringify({ emails, cachedAt: Date.now() }));
  } catch {
    // Cache is best-effort only.
  }
}

const navItems = [
  { href: "/", label: "Home", icon: LayoutGrid },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/drafts", label: "Drafts", icon: FilePenLine },
  { href: "/sent", label: "Sent", icon: Send },
  { href: "/rejected", label: "Classified", icon: Tag },
  { href: "/logs", label: "Activity", icon: Activity },
  { href: "/profile", label: "Profile", icon: UserRound },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function Sidebar({
  collapsed,
  onToggleCollapse,
  onLogout,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onLogout: () => void;
}) {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();

  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const params = new URLSearchParams({ filter: "all" });
      if (activeAccountId != null) params.set("accountId", String(activeAccountId));

      const cached = readSidebarEmailCache(activeAccountId);
      if (!cancelled && cached.length > 0) {
        setEmails(cached);
      }

      try {
        const res = await fetch(`/api/emails?${params.toString()}`, { credentials: "include" });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { emails?: EmailItem[] };
        if (!cancelled) {
          const nextEmails = Array.isArray(json.emails) ? json.emails : [];
          setEmails(nextEmails);
          writeSidebarEmailCache(activeAccountId, nextEmails);
        }
      } catch {
        // Keep last known counts if polling fails.
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        void load();
      }
    }

    void load();
    const timer = setInterval(() => void load(), 20000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeAccountId]);

  useEffect(() => {
    let cancelled = false;

    async function loadAccounts() {
      try {
        const res = await fetch("/api/system/accounts", { credentials: "include" });
        if (!res.ok || cancelled) return;

        const json = (await res.json()) as {
          accounts?: AccountOption[];
          activeAccountId?: number | null;
        };

        const list = Array.isArray(json.accounts) ? json.accounts : [];
        if (cancelled) return;
        setAccounts(list);

        const local = Number(localStorage.getItem("activeAccountId"));
        const selected =
          Number.isFinite(local) && local > 0
            ? local
            : Number.isFinite(json.activeAccountId)
            ? Number(json.activeAccountId)
            : list[0]?.id ?? null;

        setActiveAccountId((prev) => {
          if (selected != null && prev !== selected) {
            localStorage.setItem("activeAccountId", String(selected));
            window.dispatchEvent(new CustomEvent("active-account-changed", { detail: { accountId: selected } }));
          }
          return selected;
        });
      } catch {
        // Keep existing account state when account list refresh fails.
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        void loadAccounts();
      }
    }

    void loadAccounts();
    const timer = setInterval(() => void loadAccounts(), 30000);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    function onAccountChange(event: Event) {
      const custom = event as CustomEvent<{ accountId?: number }>;
      const accountId = Number(custom.detail?.accountId ?? NaN);
      if (Number.isFinite(accountId) && accountId > 0) {
        setActiveAccountId(accountId);
      }
    }

    window.addEventListener("active-account-changed", onAccountChange as EventListener);
    return () => window.removeEventListener("active-account-changed", onAccountChange as EventListener);
  }, []);

  const counts = useMemo(
    () => ({
      inbox: emails.filter(
        (email) =>
          email.source === "inbox" &&
          email.is_seen === false,
      ).length,
      drafts: emails.filter((email) => email.state === "AWAITING_REVIEW" || email.state === "READY_TO_SEND").length,
      sent: emails.filter((email) => email.source === "sent" || email.state === "SENT").length,
    }),
    [emails],
  );

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId) ?? null,
    [accounts, activeAccountId],
  );

  function selectAccount(id: number) {
    setActiveAccountId(id);
    localStorage.setItem("activeAccountId", String(id));
    window.dispatchEvent(new CustomEvent("active-account-changed", { detail: { accountId: id } }));
  }

  const accountStatusText = activeAccount?.status === "needs_reauth" ? "Needs re-auth" : "Active";
  const accountStatusTone =
    activeAccount?.status === "needs_reauth"
      ? "text-amber-600 bg-amber-500/10 border-amber-500/25"
      : "text-emerald-600 bg-emerald-500/10 border-emerald-500/25";

  return (
    <aside
      className={`panel-surface-strong hidden h-full shrink-0 flex-col overflow-hidden rounded-[20px] px-2 py-2 app-motion-medium md:flex ${
        collapsed ? "w-[88px]" : "w-[304px]"
      }`}
    >
      <div className="rounded-[18px] border app-border bg-[color:var(--surface-layer-2)] px-2 py-2">
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"} px-1 py-1`}>
          {!collapsed && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] app-text-faint">Nova Workspace</div>
              <div className="mt-1 text-sm font-semibold app-text-primary">Mail Operations</div>
            </div>
          )}

          <button
            type="button"
            onClick={onToggleCollapse}
            className="app-button-secondary app-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-full"
            aria-label="Toggle sidebar"
            aria-pressed={collapsed}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        {!collapsed && (
          <div className="mt-3 rounded-[14px] border app-border bg-[color:var(--surface-secondary)] px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] app-text-faint">Active mailbox</div>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${accountStatusTone}`}>
                {accountStatusText}
              </span>
            </div>

            <select
              value={activeAccountId ?? ""}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next > 0) selectAccount(next);
              }}
              className="app-input mt-2 w-full text-xs"
              aria-label="Select mailbox account"
            >
              {accounts.length === 0 && <option value="">No accounts</option>}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>

            {activeAccount?.status === "needs_reauth" ? (
              <a
                href="/api/auth/google?prompt=consent%20select_account"
                className="app-button-primary app-focus-ring mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold"
              >
                <RefreshCcw className="h-3.5 w-3.5" />
                Reconnect Gmail
              </a>
            ) : (
              <div className="mt-2 text-[11px] app-text-muted">
                Last sync: {activeAccount?.lastSyncAt ? new Date(activeAccount.lastSyncAt).toLocaleTimeString() : "not yet"}
              </div>
            )}
          </div>
        )}
      </div>

      <Link
        href="/compose"
        className={`app-button-primary app-focus-ring mt-3 inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${
          collapsed ? "mx-auto h-10 w-10 rounded-full p-0" : ""
        }`}
        aria-label="Compose email"
        title="Compose"
      >
        <MailPlus className="h-4 w-4" />
        {!collapsed && "Compose"}
      </Link>

      <nav className="mt-3 flex-1 space-y-1 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
          const count = href === "/inbox" ? counts.inbox : href === "/drafts" ? counts.drafts : href === "/sent" ? counts.sent : null;

          return (
            <Link
              key={href}
              href={href}
              title={label}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              className={`app-focus-ring relative flex items-center rounded-xl px-3 py-2.5 text-sm app-motion-fast ${
                active ? "app-accent-bg" : "app-text-secondary app-hover-soft"
              } ${collapsed ? "justify-center" : "justify-between"}`}
            >
              <span className="inline-flex items-center gap-2.5">
                <Icon className="h-4 w-4" />
                {!collapsed && label}
              </span>
              {typeof count === "number" && count > 0 && (
                <span
                  className={`app-chip rounded-full ${
                    collapsed ? "absolute right-1.5 top-1.5 px-1.5 py-0 text-[9px]" : "px-2 py-0.5 text-[10px]"
                  }`}
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className={`mt-2 grid gap-2 ${collapsed ? "grid-cols-1" : "grid-cols-2"}`}>
        <button
          type="button"
          onClick={toggleTheme}
          className={`app-button-secondary app-focus-ring inline-flex items-center rounded-xl px-3 py-2.5 text-sm ${collapsed ? "justify-center" : "gap-2"}`}
          aria-label="Toggle theme"
        >
          <SunMoon className="h-4 w-4" />
          {!collapsed && (theme === "dark" ? "Dark" : "Light")}
        </button>

        <button
          type="button"
          onClick={onLogout}
          className={`app-button-secondary app-focus-ring inline-flex items-center rounded-xl px-3 py-2.5 text-sm ${collapsed ? "justify-center" : "gap-2"}`}
        >
          <LogOut className="h-4 w-4" />
          {!collapsed && "Logout"}
        </button>
      </div>
    </aside>
  );
}
