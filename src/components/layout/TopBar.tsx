"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Command, Search, Settings, User, X } from "lucide-react";

type AccountOption = {
  id: number;
  email: string;
  status: string;
};

type EmailItem = {
  id: number;
  source?: string;
  subject: string;
  from_email?: string;
  snippet?: string | null;
  state: string;
};

function routeTitle(pathname: string): string {
  if (pathname.startsWith("/inbox")) return "Inbox";
  if (pathname.startsWith("/sent")) return "Sent";
  if (pathname.startsWith("/drafts")) return "Drafts";
  if (pathname.startsWith("/profile")) return "Profile";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/logs")) return "Logs";
  if (pathname.startsWith("/compose")) return "Compose";
  return "Nova Mail";
}

const navItems: Array<{ href: string; label: string }> = [
  { href: "/inbox", label: "Inbox" },
  { href: "/sent", label: "Sent" },
  { href: "/drafts", label: "Drafts" },
  { href: "/compose", label: "Compose" },
  { href: "/profile", label: "Profile" },
  { href: "/settings", label: "Settings" },
];

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<number | null>(null);
  const [emails, setEmails] = useState<EmailItem[]>([]);

  const [accountOpen, setAccountOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const accountRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    async function loadAccounts() {
      try {
        const res = await fetch("/api/system/accounts", { credentials: "include" });
        if (!res.ok) return;
        const json = (await res.json()) as { accounts?: AccountOption[]; activeAccountId?: number };
        const list = Array.isArray(json.accounts) ? json.accounts : [];
        setAccounts(list);

        const local = Number(localStorage.getItem("activeAccountId"));
        const chosen = Number.isFinite(local) && local > 0
          ? local
          : Number.isFinite(json.activeAccountId)
            ? Number(json.activeAccountId)
            : list[0]?.id ?? null;

        setActiveAccountId(chosen);
        if (chosen != null) {
          localStorage.setItem("activeAccountId", String(chosen));
          window.dispatchEvent(new CustomEvent("active-account-changed", { detail: { accountId: chosen } }));
        }
      } catch {
        // Keep current account if this fetch fails.
      }
    }

    void loadAccounts();
  }, []);

  useEffect(() => {
    async function loadEmails() {
      const params = new URLSearchParams({ filter: "all" });
      if (activeAccountId != null) params.set("accountId", String(activeAccountId));
      try {
        const res = await fetch(`/api/emails?${params.toString()}`, { credentials: "include" });
        if (!res.ok) return;
        const json = (await res.json()) as { emails?: EmailItem[] };
        setEmails(Array.isArray(json.emails) ? json.emails : []);
      } catch {
        // Keep previous search cache when refresh fails.
      }
    }

    void loadEmails();
  }, [activeAccountId]);

  useEffect(() => {
    function onAccountChange(event: Event) {
      const custom = event as CustomEvent<{ accountId?: number }>;
      const accountId = Number(custom.detail?.accountId);
      if (Number.isFinite(accountId) && accountId > 0) {
        setActiveAccountId(accountId);
      }
    }

    window.addEventListener("active-account-changed", onAccountChange as EventListener);
    return () => window.removeEventListener("active-account-changed", onAccountChange as EventListener);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNavOpen(false);
        setAccountOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (accountOpen && accountRef.current && !accountRef.current.contains(target)) setAccountOpen(false);
      if (navOpen && navRef.current && !navRef.current.contains(target)) setNavOpen(false);
      if (searchOpen && searchRef.current && !searchRef.current.contains(target)) setSearchOpen(false);
    }

    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [accountOpen, navOpen, searchOpen]);

  const title = routeTitle(pathname);
  const activeAccount = useMemo(() => accounts.find((item) => item.id === activeAccountId) ?? null, [accounts, activeAccountId]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return emails.slice(0, 8);
    return emails
      .filter((email) =>
        [email.subject, email.from_email, email.snippet, email.state]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalized)),
      )
      .slice(0, 8);
  }, [emails, query]);

  function selectAccount(id: number) {
    setActiveAccountId(id);
    setAccountOpen(false);
    localStorage.setItem("activeAccountId", String(id));
    window.dispatchEvent(new CustomEvent("active-account-changed", { detail: { accountId: id } }));
  }

  function openEmail(email: EmailItem) {
    setSearchOpen(false);
    const path = email.source === "sent" || email.state === "SENT" ? "/sent" : "/inbox";
    router.push(`${path}?id=${email.id}`);
  }

  return (
    <header className="relative z-40 rounded-[12px] border app-border bg-[color:var(--surface-elevated)] px-3 py-2.5 shadow-xs backdrop-blur md:px-4 md:py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <div ref={navRef} className="relative">
            <button
              type="button"
              onClick={() => setNavOpen((value) => !value)}
              className="app-button-secondary app-focus-ring inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium"
              aria-label="Open workspace navigation"
              aria-expanded={navOpen}
              aria-controls="workspace-navigation-menu"
            >
              Workspace
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {navOpen && (
              <div id="workspace-navigation-menu" className="app-popover absolute left-0 top-[calc(100%+0.4rem)] z-50 w-56 rounded-xl p-2">
                {navItems.map(({ href, label }) => {
                  const active = pathname === href || pathname.startsWith(`${href}/`);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setNavOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={`app-focus-ring block rounded-xl px-3 py-2 text-sm ${
                        active ? "app-accent-bg" : "app-text-secondary app-hover-soft"
                      }`}
                    >
                      {label}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] app-text-faint">Nova Mail</div>
            <div className="truncate text-base font-semibold app-text-primary">{title}</div>
          </div>
        </div>

        <div className="flex items-center gap-2 md:gap-3">
          <div ref={accountRef} className="relative">
            <button
              type="button"
              onClick={() => setAccountOpen((value) => !value)}
              className="app-button-secondary app-focus-ring inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
              aria-label="Select account"
              aria-expanded={accountOpen}
              aria-controls="account-selection-menu"
            >
              <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              <span className="hidden max-w-[220px] truncate sm:inline">{activeAccount?.email ?? "No account"}</span>
              <span className="sm:hidden">Account</span>
            </button>

            {accountOpen && (
              <div id="account-selection-menu" className="app-popover absolute right-0 top-[calc(100%+0.4rem)] z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl p-2">
                {accounts.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => selectAccount(account.id)}
                    className={`app-focus-ring flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm app-motion-fast ${
                      account.id === activeAccountId ? "app-accent-bg" : "app-hover-soft"
                    }`}
                  >
                    <span className="truncate">{account.email}</span>
                    <span className="text-[10px] app-text-faint">{account.status}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="app-button-secondary app-focus-ring inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
            aria-label="Open command search"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Search</span>
            <span className="hidden items-center gap-1 rounded-full app-chip px-2 py-1 text-[10px] md:inline-flex">
              <Command className="h-3 w-3" />
              K
            </span>
          </button>

          <Link href="/compose" className="app-button-primary app-focus-ring rounded-full px-4 py-1.5 text-xs font-semibold">
            Compose
          </Link>

          <Link href="/settings" className="app-button-secondary app-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-full" aria-label="Settings">
            <Settings className="h-4 w-4" />
          </Link>
          <Link href="/profile" className="app-button-secondary app-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-full" aria-label="Profile">
            <User className="h-4 w-4" />
          </Link>
        </div>
      </div>

      {searchOpen && (
        <div className="fixed inset-0 z-[300] bg-black/35 p-3 backdrop-blur-[8px] md:p-10">
          <div ref={searchRef} role="dialog" aria-modal="true" aria-label="Command search" className="app-popover mx-auto mt-0 w-full max-w-2xl rounded-[20px] p-4 md:mt-2 md:p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold app-text-primary">Command Search</div>
              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                className="app-button-secondary app-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-full"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="app-input flex items-center gap-2 rounded-2xl px-3 py-2.5">
              <Search className="h-4 w-4 app-text-faint" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sender, subject, snippet"
                className="w-full bg-transparent text-sm app-text-primary focus:outline-none"
              />
            </div>

            <div className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto">
              {results.length === 0 && (
                <div className="rounded-xl border border-dashed app-border px-4 py-8 text-center text-sm app-text-muted">
                  No results.
                </div>
              )}
              {results.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openEmail(item)}
                  className="app-focus-ring app-input-strong app-hover-soft w-full rounded-xl px-4 py-3 text-left"
                >
                  <div className="truncate text-sm font-medium app-text-primary">{item.subject || "(no subject)"}</div>
                  <div className="mt-1 truncate text-xs app-text-muted">{item.from_email || item.snippet || "No preview"}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
