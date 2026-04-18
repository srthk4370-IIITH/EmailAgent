"use client";

import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  rightAction?: ReactNode;
  collapsed?: boolean;
  compactLabel?: string;
  className?: string;
};

export function PageHeader({
  title,
  subtitle,
  rightAction,
  collapsed = false,
  compactLabel,
  className = "",
}: PageHeaderProps) {
  if (collapsed) {
    return (
      <div className={`border-b app-border px-4 py-3 md:px-6 ${className}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold app-text-primary">{compactLabel ?? title}</h2>
          </div>
          {rightAction && <div className="shrink-0">{rightAction}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={`border-b app-border px-4 py-4 md:px-6 md:py-5 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight app-text-primary md:text-3xl">{title}</h1>
          {subtitle && <p className="mt-1 text-sm app-text-muted">{subtitle}</p>}
        </div>
        {rightAction && <div className="shrink-0">{rightAction}</div>}
      </div>
    </div>
  );
}
