export function logSlowApi(route: string, startMs: number): void {
  const latency = Date.now() - startMs;
  if (latency > 1000) {
    console.warn("SLOW API:", route, latency);
  }
}
