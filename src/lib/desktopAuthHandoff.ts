type HandoffReadyEntry = {
  status: "ready";
  token: string;
  createdAt: number;
};

type HandoffErrorEntry = {
  status: "error";
  error: string;
  createdAt: number;
};

type HandoffEntry = HandoffReadyEntry | HandoffErrorEntry;

const ENTRY_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 256;
const HANDOFF_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

const handoffEntries = new Map<string, HandoffEntry>();

function pruneExpiredEntries(now = Date.now()): void {
  for (const [id, entry] of handoffEntries.entries()) {
    if (now - entry.createdAt > ENTRY_TTL_MS) {
      handoffEntries.delete(id);
    }
  }

  if (handoffEntries.size <= MAX_ENTRIES) return;

  const ordered = Array.from(handoffEntries.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (handoffEntries.size > MAX_ENTRIES) {
    const oldest = ordered.shift();
    if (!oldest) break;
    handoffEntries.delete(oldest[0]);
  }
}

function normalizeErrorLabel(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "oauth_failed";
  return trimmed.slice(0, 200);
}

export function isValidDesktopHandoffId(handoffId: string): boolean {
  return HANDOFF_ID_PATTERN.test(handoffId);
}

export function markDesktopAuthHandoffReady(handoffId: string, token: string): void {
  if (!isValidDesktopHandoffId(handoffId)) return;
  if (!token.trim()) return;

  pruneExpiredEntries();
  handoffEntries.set(handoffId, {
    status: "ready",
    token,
    createdAt: Date.now(),
  });
}

export function markDesktopAuthHandoffError(handoffId: string, error: string): void {
  if (!isValidDesktopHandoffId(handoffId)) return;

  pruneExpiredEntries();
  handoffEntries.set(handoffId, {
    status: "error",
    error: normalizeErrorLabel(error),
    createdAt: Date.now(),
  });
}

export type DesktopHandoffConsumeResult =
  | { status: "pending" }
  | { status: "ready"; token: string }
  | { status: "error"; error: string };

export function consumeDesktopAuthHandoff(handoffId: string): DesktopHandoffConsumeResult {
  if (!isValidDesktopHandoffId(handoffId)) {
    return { status: "error", error: "invalid_handoff_id" };
  }

  pruneExpiredEntries();
  const entry = handoffEntries.get(handoffId);
  if (!entry) {
    return { status: "pending" };
  }

  handoffEntries.delete(handoffId);
  if (entry.status === "ready") {
    return { status: "ready", token: entry.token };
  }

  return { status: "error", error: entry.error };
}
