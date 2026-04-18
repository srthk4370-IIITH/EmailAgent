"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { AlertTriangle, RefreshCcw, Wrench } from "lucide-react";

import { buildErrorFixSteps, describeFixTarget } from "../../lib/errorGuidance";
import type { AppError } from "../../lib/errorNormalizer";

export function InlineErrorCard({
  error,
  onRetry,
}: {
  error: AppError;
  onRetry?: (() => Promise<void>) | (() => void);
}) {
  const pathname = usePathname();
  const [showSteps, setShowSteps] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const fixSteps = useMemo(() => buildErrorFixSteps(error), [error]);
  const onFixPage =
    !!error.fixNowPath &&
    (pathname === error.fixNowPath || pathname.startsWith(`${error.fixNowPath}/`));

  async function runRetry() {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      setShowSteps(true);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="rounded-lg border app-state-error px-4 py-3" role="alert" aria-live="polite">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold app-text-primary">
            <span className="rounded-full border app-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]">
              {error.category}
            </span>
            {error.message}
          </div>
          <p className="mt-1 text-xs app-text-secondary">{error.reason}</p>
          <p className="mt-1 text-xs app-text-primary">Fix: {error.fix}</p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {error.retryable && onRetry && (
              <button
                type="button"
                className="app-button-secondary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
                disabled={retrying}
                onClick={() => void runRetry()}
              >
                <RefreshCcw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />
                {retrying ? "Retrying" : "Retry"}
              </button>
            )}

            {error.fixNowPath ? (
              onFixPage ? (
                error.retryable && onRetry ? (
                  <button
                    type="button"
                    className="app-button-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
                    disabled={retrying}
                    onClick={() => void runRetry()}
                  >
                    <Wrench className="h-3.5 w-3.5" />
                    {retrying ? "Re-checking" : "Re-check now"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="app-button-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
                    onClick={() => setShowSteps(true)}
                  >
                    <Wrench className="h-3.5 w-3.5" />
                    Show fix steps
                  </button>
                )
              ) : (
                <Link href={error.fixNowPath} className="app-button-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs">
                  <Wrench className="h-3.5 w-3.5" />
                  Fix now
                </Link>
              )
            ) : null}

            <button
              type="button"
              className="app-button-secondary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
              onClick={() => setShowSteps((value) => !value)}
            >
              {showSteps ? "Hide steps" : "Show steps"}
            </button>

            {error.fixNowPath && !onFixPage && (
              <span className="text-[11px] app-text-muted">Open {describeFixTarget(error.fixNowPath)} if retry fails.</span>
            )}
          </div>

          {showSteps && (
            <div className="mt-3 rounded-lg border app-border bg-[color:var(--surface-secondary)] px-3 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] app-text-faint">Fix Steps</div>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs app-text-secondary">
                {fixSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
