export function badgeForState(state: string): string {
  const s = (state ?? "").toUpperCase();
  if (s === "INGESTED") return "app-state-ingested";
  if (s === "PROCESSING") return "app-state-processing";
  if (s === "CLASSIFIED") return "app-state-classified";
  if (s === "READY_TO_GENERATE") return "app-state-ready_to_generate";
  if (s === "GENERATED") return "app-state-generated";
  if (s === "AWAITING_REVIEW") return "app-state-awaiting_review";
  if (s === "READY_TO_SEND") return "app-state-ready_to_send";
  if (s === "SENT") return "app-state-sent";
  if (s === "DEAD") return "app-state-error_fatal";
  if (s === "ERROR_FATAL") return "app-state-error_fatal";
  if (s.startsWith("ERROR") || s === "ERROR_TEMP") return "app-state-error_temp";
  return "app-state-ingested";
}

export function badgeForCategory(category: string | null): string {
  const c = (category ?? "unknown").toLowerCase();
  const colors: Record<string, string> = {
    support: "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]",
    help: "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]",
    feedback: "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]",
    review: "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]",
    lead: "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]",
    sales: "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]",
    priority: "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]",
    urgent: "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]",
    spam: "bg-[color:var(--surface-secondary)] text-[color:var(--text-muted)] ring-1 ring-[color:var(--border-soft)]",
    junk: "bg-[color:var(--surface-secondary)] text-[color:var(--text-muted)] ring-1 ring-[color:var(--border-soft)]",
  };

  return colors[c] || "bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]";
}
