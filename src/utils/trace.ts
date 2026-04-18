import { randomUUID } from "crypto";

export function createTraceId(): string {
  return randomUUID();
}

export async function withTrace<T>(traceId: string, fn: (traceId: string) => Promise<T>): Promise<T> {
  return fn(traceId);
}
