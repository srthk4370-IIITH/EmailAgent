"use client";

import Link from "next/link";
import { AlertTriangle, RefreshCcw, Wrench } from "lucide-react";

import type { AppError } from "../../lib/errorNormalizer";

export function InlineErrorCard({
  error,
  onRetry,
}: {
  error: AppError;
  onRetry?: (() => Promise<void>) | (() => void);
}) {
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
                onClick={() => void onRetry()}
              >
                <RefreshCcw className="h-3.5 w-3.5" />
                Retry
              </button>
            )}

            {error.fixNowPath && (
              <Link href={error.fixNowPath} className="app-button-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs">
                <Wrench className="h-3.5 w-3.5" />
                Fix now
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
