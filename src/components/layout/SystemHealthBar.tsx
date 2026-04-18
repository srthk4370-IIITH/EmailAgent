"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, RotateCcw, X, XCircle } from "lucide-react";
import { useErrorCenter } from "../errors/ErrorCenter";
import { normalizeError } from "../../lib/errorNormalizer";

export interface HealthData {
  ok: boolean;
  overall_status: "ok" | "degraded" | "down";
  budget?: {
    tokens_used_today: number;
    daily_token_limit: number;
    budget_remaining: number;
    percentage_used: number;
    budget_exceeded: boolean;
  };
  services: Record<
    string,
    {
      status: "ok" | "degraded" | "down" | "unknown";
      error_message: string | null;
      last_heartbeat_at: string | null;
    }
  >;
}

type DiagnosticsCheck = {
  check: string;
  ok: boolean;
  error?: string;
  cause?: string;
  fix?: string;
};

type DiagnosticsRunResponse = {
  ok?: boolean;
  checks?: DiagnosticsCheck[];
};

type ConnectionCheck = {
  ok: boolean;
  error: string | null;
  cause?: string | null;
  fix?: string | null;
};

type ConnectionsResponse = Record<string, ConnectionCheck>;

const HEALTH_ERROR_CODES = new Set([
  "SYSTEM_HEALTH_CRITICAL",
  "SYSTEM_HEALTH_UNREACHABLE",
  "SYSTEM_HEALTH_RATE_LIMIT",
  "SYSTEM_HEALTH_REPAIR_REQUIRED",
]);

function fixPathForIssue(name: string): string {
  return name.toLowerCase().includes("gmail") ? "/onboarding" : "/settings";
}

export function SystemHealthBar() {
  const { setGlobalError, clearGlobalError, globalError } = useErrorCenter();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const globalErrorCodeRef = useRef<string | null>(null);

  useEffect(() => {
    globalErrorCodeRef.current = globalError?.code ?? null;
  }, [globalError]);

  async function runAutoRepair() {
    const issues: Array<{ name: string; cause: string; fix: string; fixNowPath: string }> = [];

    try {
      const diagnosticsRes = await fetch("/api/system/diagnostics/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const diagnosticsBody = (await diagnosticsRes.json().catch(() => null)) as DiagnosticsRunResponse | null;

      if (!diagnosticsRes.ok) {
        const fallback = normalizeError(diagnosticsBody ?? `diagnostics_http_${diagnosticsRes.status}`, {
          source: "ui",
          operation: "system-health-repair-diagnostics",
          fallbackStatus: diagnosticsRes.status,
        });
        issues.push({
          name: "diagnostics",
          cause: fallback.reason,
          fix: fallback.fix,
          fixNowPath: "/settings",
        });
      } else if (Array.isArray(diagnosticsBody?.checks)) {
        for (const check of diagnosticsBody.checks) {
          if (check.ok) continue;
          issues.push({
            name: check.check,
            cause: check.cause ?? check.error ?? "diagnostic_failed",
            fix: check.fix ?? "Review service configuration and retry diagnostics.",
            fixNowPath: fixPathForIssue(check.check),
          });
        }
      }
    } catch (error) {
      const fallback = normalizeError(error, {
        source: "ui",
        operation: "system-health-repair-diagnostics",
        fallbackStatus: 503,
      });
      issues.push({
        name: "diagnostics",
        cause: fallback.reason,
        fix: fallback.fix,
        fixNowPath: "/settings",
      });
    }

    try {
      const connectionsRes = await fetch("/api/system/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: ["db", "openai", "gmail"] }),
        credentials: "include",
      });
      const connectionsBody = (await connectionsRes.json().catch(() => null)) as ConnectionsResponse | null;

      if (!connectionsRes.ok) {
        const fallback = normalizeError(connectionsBody ?? `connections_http_${connectionsRes.status}`, {
          source: "ui",
          operation: "system-health-repair-connections",
          fallbackStatus: connectionsRes.status,
        });
        issues.push({
          name: "connections",
          cause: fallback.reason,
          fix: fallback.fix,
          fixNowPath: "/settings",
        });
      } else if (connectionsBody && typeof connectionsBody === "object") {
        const entries = Object.entries(connectionsBody) as Array<[string, ConnectionCheck]>;
        for (const [name, status] of entries) {
          if (status.ok) continue;
          issues.push({
            name,
            cause: status.cause ?? status.error ?? "connection_failed",
            fix: status.fix ?? "Reconfigure the failing dependency and retry checks.",
            fixNowPath: fixPathForIssue(name),
          });
        }
      }
    } catch (error) {
      const fallback = normalizeError(error, {
        source: "ui",
        operation: "system-health-repair-connections",
        fallbackStatus: 503,
      });
      issues.push({
        name: "connections",
        cause: fallback.reason,
        fix: fallback.fix,
        fixNowPath: "/settings",
      });
    }

    try {
      const healthRes = await fetch("/api/system/health", { credentials: "include" });
      if (healthRes.ok) {
        const data = (await healthRes.json()) as HealthData;
        setHealth(data);
        if (data.overall_status !== "down") {
          clearGlobalError({ force: true });
          return;
        }

        const downServices = Object.entries(data.services ?? {})
          .filter(([, service]) => service.status === "down")
          .map(([name, service]) => `${name}${service.error_message ? `: ${service.error_message}` : ""}`)
          .slice(0, 3)
          .join(" | ");
        issues.push({
          name: "system_health",
          cause: downServices || "Services are still reported as down.",
          fix: "Repair the failing dependencies and run diagnostics again.",
          fixNowPath: "/settings",
        });
      } else {
        const body = await healthRes.json().catch(() => null);
        const fallback = normalizeError(body ?? `system_health_http_${healthRes.status}`, {
          source: "ui",
          operation: "system-health-repair-health",
          fallbackStatus: healthRes.status,
        });
        issues.push({
          name: "system_health",
          cause: fallback.reason,
          fix: fallback.fix,
          fixNowPath: "/settings",
        });
      }
    } catch (error) {
      const fallback = normalizeError(error, {
        source: "ui",
        operation: "system-health-repair-health",
        fallbackStatus: 503,
      });
      issues.push({
        name: "system_health",
        cause: fallback.reason,
        fix: fallback.fix,
        fixNowPath: "/settings",
      });
    }

    const primaryIssue = issues[0] ?? {
      name: "system_health",
      cause: "Health checks could not confirm recovery.",
      fix: "Review runtime services and credentials, then retry diagnostics.",
      fixNowPath: "/settings",
    };

    const unresolved = normalizeError(
      {
        code: "SYSTEM_HEALTH_REPAIR_REQUIRED",
        category: "STATE",
        severity: "critical",
        retryable: true,
        autoRecoverable: false,
        message: "Automatic fix did not fully recover system health",
        reason: primaryIssue.cause,
        fix: primaryIssue.fix,
        fixNowPath: primaryIssue.fixNowPath,
        status: 503,
        retryAfterMs: 5_000,
      },
      { source: "ui", operation: "system-health-repair", fallbackStatus: 503 },
    );

    setGlobalError(
      unresolved,
      async () => {
        await checkHealth();
      },
      async () => {
        await runAutoRepair();
      },
    );
  }

  async function checkHealth() {
    try {
      const res = await fetch("/api/system/health", { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as HealthData;
        setHealth(data);

        if (data.overall_status === "down") {
          const serviceEntries = Object.entries(data.services ?? {}) as Array<[string, HealthData["services"][string]]>;
          const failing = serviceEntries
            .filter(([, service]) => service.status === "down")
            .map(([name, service]) => `${name}${service.error_message ? `: ${service.error_message}` : ""}`)
            .slice(0, 3)
            .join(" | ");

          const critical = normalizeError(
            {
              code: "SYSTEM_HEALTH_CRITICAL",
              category: "STATE",
              severity: "critical",
              retryable: true,
              autoRecoverable: false,
              message: "Critical services are unavailable",
              reason: failing || "One or more core services are down.",
              fix: "Open Settings or Onboarding, repair failing services, then retry diagnostics.",
              fixNowPath: "/settings",
              status: 503,
              retryAfterMs: 5_000,
            },
            { source: "ui", operation: "system-health-poll", fallbackStatus: 503 },
          );

          setGlobalError(
            critical,
            async () => {
              await checkHealth();
            },
            async () => {
              await runAutoRepair();
            },
          );
        } else if (HEALTH_ERROR_CODES.has(globalErrorCodeRef.current ?? "")) {
          clearGlobalError({ force: true });
        }
      } else {
        const body = await res.json().catch(() => null);
        const fallback = normalizeError(body ?? `system_health_http_${res.status}`, {
          source: "ui",
          operation: "system-health-http",
          fallbackStatus: res.status,
        });

        if (res.status === 429 || fallback.code === "RATE_LIMIT") {
          const rateLimited = normalizeError(
            {
              ...fallback,
              code: "SYSTEM_HEALTH_RATE_LIMIT",
              category: "RATE_LIMIT",
              severity: "medium",
              retryable: true,
              autoRecoverable: true,
              message: "Health checks are temporarily rate limited",
              reason: fallback.reason,
              fix: "Wait a few seconds and retry. Monitoring resumes automatically.",
              status: 429,
              retryAfterMs: fallback.retryAfterMs ?? 8_000,
            },
            { source: "ui", operation: "system-health-http", fallbackStatus: 429 },
          );

          setGlobalError(rateLimited, async () => {
            await checkHealth();
          });
          return;
        }

        const unavailable = normalizeError(
          {
            ...fallback,
            code: "SYSTEM_HEALTH_UNREACHABLE",
            category: "NETWORK",
            severity: "critical",
            retryable: true,
            autoRecoverable: false,
            message: "Health endpoint unavailable",
            reason: fallback.reason,
            fix: "Retry diagnostics. If this persists, verify worker/database connectivity and credentials.",
            fixNowPath: "/settings",
            status: res.status,
          },
          { source: "ui", operation: "system-health-http", fallbackStatus: res.status },
        );

        setGlobalError(
          unavailable,
          async () => {
            await checkHealth();
          },
          async () => {
            await runAutoRepair();
          },
        );
      }
    } catch (error) {
      const fallback = normalizeError(error, {
        source: "ui",
        operation: "system-health-fetch",
        fallbackStatus: 503,
      });

      const unavailable = normalizeError(
        {
          ...fallback,
          code: "SYSTEM_HEALTH_UNREACHABLE",
          category: "NETWORK",
          severity: "critical",
          retryable: true,
          autoRecoverable: false,
          message: "Health monitor temporarily offline",
          reason: fallback.reason,
          fix: "Retry diagnostics. If this persists, inspect network and runtime service availability.",
          fixNowPath: "/settings",
          status: 503,
          retryAfterMs: 4_000,
        },
        { source: "ui", operation: "system-health-fetch", fallbackStatus: 503 },
      );

      setGlobalError(
        unavailable,
        async () => {
          await checkHealth();
        },
        async () => {
          await runAutoRepair();
        },
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void checkHealth();
    const interval = setInterval(() => void checkHealth(), 15000 * 2); // Check every 30s
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setBudgetOpen(false);
    }
  }, [open]);

  if (!health && !loading) return null;

  const effectiveStatus = health?.overall_status ?? "degraded";
  const entries = Object.entries(health?.services ?? {});
  const budgetMeta = health?.budget;
  const budgetUsed = budgetMeta?.tokens_used_today ?? 0;
  const budgetLimit = budgetMeta?.daily_token_limit ?? 0;
  const budgetRemaining = budgetMeta?.budget_remaining ?? Math.max(0, budgetLimit - budgetUsed);
  const budgetPercent =
    budgetMeta?.percentage_used ?? (budgetLimit > 0 ? Math.min(100, Math.round((budgetUsed / budgetLimit) * 100)) : 0);

  function formatCompact(value: number): string {
    if (!Number.isFinite(value)) return "0";
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }

  const overallTone =
    effectiveStatus === "down"
      ? "border-red-500/45 bg-red-500/12"
      : effectiveStatus === "degraded"
      ? "border-amber-500/45 bg-amber-500/12"
      : "border-emerald-500/40 bg-emerald-500/12";

  const overallIcon =
    effectiveStatus === "down" ? <XCircle className="h-4 w-4" /> : effectiveStatus === "degraded" ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />;

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-[120] hidden md:block">
      <div ref={rootRef} className="pointer-events-auto relative">
        <button
          type="button"
          onClick={() => {
            setOpen((value) => !value);
            if (budgetOpen) setBudgetOpen(false);
          }}
          className={`app-focus-ring inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold shadow-sm backdrop-blur app-motion-fast ${overallTone}`}
          aria-expanded={open}
          aria-label="Toggle system health details"
        >
          {overallIcon}
          <span>{loading && !health ? "Checking" : `System ${effectiveStatus}`}</span>
          {budgetMeta && <span className="app-text-muted">Budget {formatCompact(budgetUsed)} / {formatCompact(budgetLimit)}</span>}
          <ChevronDown className={`h-3.5 w-3.5 app-motion-fast ${open ? "rotate-180" : ""}`} />
        </button>

        {open && (
          <div className="app-popover absolute right-0 top-[calc(100%+0.5rem)] w-[min(92vw,360px)] rounded-2xl p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] app-text-faint">Live diagnostics</div>
                <div className="mt-1 text-sm font-semibold app-text-primary">System health details</div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void checkHealth()}
                  className="app-button-secondary app-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-full"
                  aria-label="Refresh health"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="app-button-secondary app-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-full"
                  aria-label="Close health panel"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {budgetMeta && (
              <div className="mt-3 rounded-2xl border app-border bg-[color:var(--surface-secondary)] px-3 py-3 text-xs app-text-secondary">
                <button
                  type="button"
                  onClick={() => setBudgetOpen((value) => !value)}
                  className="flex w-full items-start justify-between gap-3 text-left"
                  aria-expanded={budgetOpen}
                  aria-label="Toggle budget details"
                >
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] app-text-faint">Budget</div>
                    <div className="mt-1 text-sm font-semibold app-text-primary">
                      {formatCompact(budgetUsed)} / {formatCompact(budgetLimit)} tokens used
                    </div>
                    <div className="mt-1 text-[11px] app-text-muted">
                      {budgetMeta.budget_exceeded ? "Daily limit reached." : `${formatCompact(budgetRemaining)} tokens remaining.`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                        budgetMeta.budget_exceeded ? "app-state-error" : budgetPercent >= 80 ? "app-state-awaiting" : "app-chip"
                      }`}
                    >
                      {budgetPercent}%
                    </span>
                    <ChevronDown className={`h-3.5 w-3.5 app-motion-fast ${budgetOpen ? "rotate-180" : ""}`} />
                  </div>
                </button>

                <div className={`app-collapsible ${budgetOpen ? "mt-3 max-h-44 opacity-100" : "max-h-0 opacity-0"}`} style={{ transitionProperty: "max-height, opacity, margin-top" }}>
                  <div className="overflow-hidden">
                    <div className="h-2 overflow-hidden rounded-full bg-[color:var(--surface-elevated)]">
                      <div
                        className={`h-full rounded-full ${budgetMeta.budget_exceeded ? "bg-[color:var(--color-danger)]" : "bg-[color:var(--text-primary)]"}`}
                        style={{ width: `${Math.min(100, Math.max(0, budgetPercent))}%` }}
                      />
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                      <div className="rounded-xl border app-border bg-[color:var(--surface-elevated)] px-2 py-2">
                        <div className="app-text-faint">Used</div>
                        <div className="mt-1 font-semibold app-text-primary">{formatCompact(budgetUsed)}</div>
                      </div>
                      <div className="rounded-xl border app-border bg-[color:var(--surface-elevated)] px-2 py-2">
                        <div className="app-text-faint">Remaining</div>
                        <div className="mt-1 font-semibold app-text-primary">{formatCompact(budgetRemaining)}</div>
                      </div>
                      <div className="rounded-xl border app-border bg-[color:var(--surface-elevated)] px-2 py-2">
                        <div className="app-text-faint">Limit</div>
                        <div className="mt-1 font-semibold app-text-primary">{formatCompact(budgetLimit)}</div>
                      </div>
                    </div>

                    <div className="mt-3 text-[11px] app-text-muted">
                      Daily token budget for LLM calls. Generation pauses automatically when the limit is reached.
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 grid gap-2">
              {entries.length === 0 && (
                <div className="rounded-xl border border-dashed app-border px-3 py-4 text-center text-xs app-text-muted">
                  Service status unavailable.
                </div>
              )}

              {entries.map(([name, service]) => (
                <div key={name} className="rounded-xl border app-border bg-[color:var(--surface-secondary)] px-3 py-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] app-text-faint">{name}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs font-medium app-text-primary">
                    <StatusDot status={service.status} />
                    <span className="capitalize">{service.status}</span>
                  </div>
                  {service.error_message && (
                    <div className="mt-1 line-clamp-2 text-[11px] app-text-muted">{service.error_message}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: "ok" | "degraded" | "down" | "unknown" }) {
  const cls =
    status === "ok"
      ? "bg-emerald-500"
      : status === "degraded"
      ? "bg-amber-500"
      : status === "down"
      ? "bg-red-500"
      : "bg-slate-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}
