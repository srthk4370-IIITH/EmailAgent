const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 150;

const buckets = new Map<string, { count: number; resetAt: number }>();

export function clientIpFromRequest(request: Request): string {
  const xf = request.headers.get("x-forwarded-for");
  if (xf) {
    const first = xf.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/** Returns true if the request is allowed. */
export function checkApiRateLimit(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (b.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  b.count += 1;
  return true;
}
