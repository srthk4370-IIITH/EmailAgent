import { resolveDefaultAccountId } from "../db/emailAccounts";
import { getDefaultSystemId } from "../db/systems";

export interface AccountContext {
  systemId: number;
  accountId: number | null;
}

export async function resolveAccountContext(input?: {
  accountId?: number | null;
  systemId?: number | null;
}): Promise<AccountContext> {
  const systemId = input?.systemId ?? (await getDefaultSystemId());
  const accountId =
    input?.accountId && Number.isFinite(input.accountId) && input.accountId > 0
      ? input.accountId
      : await resolveDefaultAccountId(systemId);

  return { systemId, accountId };
}

export function parseOptionalAccountId(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
