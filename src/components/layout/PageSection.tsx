import type { ReactNode } from "react";

type PageSectionProps = {
  title?: string;
  subtitle?: string;
  className?: string;
  contentClassName?: string;
  children?: ReactNode;
};

export function PageSection({
  title,
  subtitle,
  className = "",
  contentClassName = "",
  children,
}: PageSectionProps) {
  return (
    <section className={`panel-surface rounded-[16px] px-5 py-5 ${className}`}>
      {(title || subtitle) && (
        <header className="mb-3">
          {title && <h3 className="text-sm font-semibold uppercase tracking-[0.14em] app-text-muted">{title}</h3>}
          {subtitle && <p className="mt-1 text-sm app-text-secondary">{subtitle}</p>}
        </header>
      )}
      <div className={contentClassName}>{children}</div>
    </section>
  );
}
