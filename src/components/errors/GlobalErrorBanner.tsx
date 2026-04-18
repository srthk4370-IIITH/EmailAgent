"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, RefreshCcw, Wrench, X } from "lucide-react";

import { useErrorCenter } from "./ErrorCenter";

export function GlobalErrorBanner() {
  const { globalError, retryAction, clearGlobalError, canDismissGlobalError } = useErrorCenter();
  const [retrying, setRetrying] = useState(false);

  if (!globalError) return null;

  const critical = globalError.severity === "critical";
  const containerTone = critical
    ? "border-red-500/60 bg-red-500/15"
    : globalError.severity === "high"
    ? "border-rose-400/50 bg-rose-500/10"
    : "app-state-error";

  async function runRetry() {
    if (!retryAction || retrying) return;
    setRetrying(true);
    try {
      await retryAction();
      clearGlobalError({ force: true });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className={`mb-2 rounded-xl border px-4 py-3 shadow-sm ${containerTone}`} role="alert" aria-live="assertive">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold app-text-primary">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="rounded-full border app-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]">
              {globalError.category}
            </span>
            {globalError.message}
          </div>
          <p className="mt-1 text-xs app-text-secondary">{globalError.reason}</p>
          <p className="mt-1 text-xs font-medium app-text-primary">Fix: {globalError.fix}</p>
          {globalError.autoRecoverable && !critical && (
            <p className="mt-1 text-[11px] app-text-muted">
              Automatic recovery is enabled{typeof globalError.retryAfterMs === "number" ? ` (next retry in ${Math.ceil(globalError.retryAfterMs / 1000)}s).` : "."}
            </p>
          )}
          {!canDismissGlobalError && (
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-red-500">
              Action required: this alert remains visible until resolved.
            </p>
          )}
        </div>

        {canDismissGlobalError && (
          <button
            type="button"
            className="app-button-secondary rounded-full p-1.5"
            onClick={() => clearGlobalError()}
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {globalError.retryable && retryAction && (
          <button
            type="button"
            onClick={() => void runRetry()}
            disabled={retrying}
            className="app-button-secondary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />
            {retrying ? "Retrying" : "Retry"}
          </button>
        )}

        {globalError.fixNowPath && (
          <Link href={globalError.fixNowPath} className="app-button-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs">
            <Wrench className="h-3.5 w-3.5" />
            Fix now
          </Link>
        )}
      </div>
    </div>
  );
}
