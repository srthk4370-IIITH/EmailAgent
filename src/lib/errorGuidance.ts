import type { AppError } from "./errorNormalizer";

function fixTargetLabel(path: string | undefined): string {
  if (!path) return "Settings";
  if (path === "/settings" || path.startsWith("/settings/")) return "Settings";
  if (path === "/onboarding" || path.startsWith("/onboarding/")) return "Onboarding";
  if (path === "/login" || path.startsWith("/login/")) return "Login";
  if (path === "/inbox" || path.startsWith("/inbox/")) return "Inbox";
  if (path === "/logs" || path.startsWith("/logs/")) return "Logs";
  return path;
}

export function describeFixTarget(path: string | undefined): string {
  return fixTargetLabel(path);
}

export function buildErrorFixSteps(error: AppError): string[] {
  const steps: string[] = [error.fix];

  if (error.fixNowPath) {
    steps.push(`Open ${fixTargetLabel(error.fixNowPath)} and apply the required configuration or reconnect steps.`);
  }

  if (error.retryable) {
    steps.push("After applying the fix, click Retry or Re-check now.");
  } else {
    steps.push("After applying the fix, repeat the failed action from the current screen.");
  }

  if (error.category === "AUTH") {
    steps.push("If access still fails, sign out and sign in again.");
  }

  if (error.category === "NETWORK") {
    steps.push("Confirm network connectivity and verify backend runtime services are reachable.");
  }

  if (error.category === "STATE") {
    steps.push("Run diagnostics from Settings to validate database, worker, and provider dependencies.");
  }

  const unique = new Set<string>();
  const ordered: string[] = [];
  for (const step of steps) {
    const normalized = step.trim();
    if (!normalized || unique.has(normalized)) continue;
    unique.add(normalized);
    ordered.push(normalized);
  }

  return ordered;
}
