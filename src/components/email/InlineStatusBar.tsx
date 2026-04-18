"use client";

import { getCategoryTone, getStateVisual } from "../../lib/mailVisuals";

export function InlineStatusBar({
  state,
  category,
  confidence,
  className = "",
}: {
  state: string;
  category?: string | null | undefined;
  confidence?: number | null | undefined;
  className?: string;
}) {
  const stateVisual = getStateVisual(state);
  const confidenceLabel = typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : "Unscored";

  return (
    <div className={`sticky top-0 z-20 border-b app-border bg-[color:var(--surface-elevated)] px-4 py-3 shadow-sm ${className}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] app-text-faint">
        <span className={`rounded-full px-2.5 py-1 ${stateVisual.className}`}>Classification inline</span>
        {category && (
          <span className="app-category-token rounded-full px-2.5 py-1" style={getCategoryTone(category)}>
            {category}
          </span>
        )}
        <span className="rounded-full app-state-ready px-2.5 py-1">{confidenceLabel}</span>
      </div>
    </div>
  );
}