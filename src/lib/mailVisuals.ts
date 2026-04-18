import type { CSSProperties } from "react";

export type StateVisual = {
  label: string;
  className: string;
};

const STATE_VISUALS: Record<string, StateVisual> = {
  INGESTED: { label: "Ingested", className: "app-state-ingested" },
  PROCESSING: { label: "Processing", className: "app-state-processing" },
  CLASSIFIED: { label: "Classified", className: "app-state-classified" },
  READY_TO_GENERATE: { label: "Generate", className: "app-state-ready_to_generate" },
  GENERATED: { label: "Generated", className: "app-state-generated" },
  AWAITING_REVIEW: { label: "Review", className: "app-state-awaiting_review" },
  READY_TO_SEND: { label: "Ready to send", className: "app-state-ready_to_send" },
  SENT: { label: "Sent", className: "app-state-sent" },
  ERROR_TEMP: { label: "Temp error", className: "app-state-error_temp" },
  ERROR_FATAL: { label: "Fatal error", className: "app-state-error_fatal" },
  DEAD: { label: "Dead letter", className: "app-state-error_fatal" },
};

export function getStateVisual(state: string): StateVisual {
  const normalized = (state ?? "").toUpperCase();
  if (normalized === "DEAD") {
    return STATE_VISUALS.DEAD ?? { label: "Dead letter", className: "app-state-error_fatal" };
  }
  if (normalized.startsWith("ERROR")) {
    return normalized === "ERROR_FATAL"
      ? STATE_VISUALS.ERROR_FATAL ?? { label: "Fatal error", className: "app-state-error_fatal" }
      : STATE_VISUALS.ERROR_TEMP ?? { label: "Temp error", className: "app-state-error_temp" };
  }
  return STATE_VISUALS[normalized] ?? { label: "Pending", className: "app-state-ingested" };
}

function hashCategory(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function normalizeCategoryKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function getCategoryTone(
  category: string | null | undefined,
  overrides?: Record<string, string> | null,
): CSSProperties {
  const normalized = normalizeCategoryKey(category ?? "uncategorized");
  const override =
    overrides?.[normalized] ??
    overrides?.[(category ?? "uncategorized").trim().toLowerCase()];
  if (override && /^#[0-9a-fA-F]{6}$/.test(override)) {
    return {
      "--cat-hue": String(hexToHue(override)),
      "--cat-color": override,
    } as CSSProperties;
  }
  const hue = hashCategory(normalized) % 360;
  return {
    "--cat-hue": String(hue),
    '--cat-color': `hsl(${hue} 10% 58%)`,
  } as CSSProperties;
}

function hexToHue(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}
