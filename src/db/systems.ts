import { db } from "./client";

export interface SystemRow {
  id: number;
  name: string;
  config_json: Record<string, unknown>;
  onboarding_state: string;
  created_at: string;
  updated_at: string;
}

export async function getDefaultSystemId(): Promise<number> {
  const result = await db.query<{ id: number }>(
    "SELECT id FROM systems ORDER BY id ASC LIMIT 1",
  );
  return result.rows[0]?.id ?? 1;
}

export async function getSystemById(id: number): Promise<SystemRow | null> {
  const result = await db.query<SystemRow>("SELECT * FROM systems WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] ?? null;
}

export async function updateOnboardingState(systemId: number, state: string): Promise<void> {
  await db.query(
    "UPDATE systems SET onboarding_state = $1, updated_at = NOW() WHERE id = $2",
    [state, systemId],
  );
}

export async function saveOnboardingDraft(systemId: number, encryptedDraft: string): Promise<void> {
  await db.query(
    `UPDATE systems
     SET config_json = jsonb_set(
       COALESCE(config_json, '{}'::jsonb),
       '{onboarding_draft}',
       to_jsonb($1::text),
       true
     ),
     updated_at = NOW()
     WHERE id = $2`,
    [encryptedDraft, systemId],
  );
}

export async function clearOnboardingDraft(systemId: number): Promise<void> {
  await db.query(
    `UPDATE systems
     SET config_json = COALESCE(config_json, '{}'::jsonb) - 'onboarding_draft',
         updated_at = NOW()
     WHERE id = $1`,
    [systemId],
  );
}

export async function getOnboardingDraft(systemId: number): Promise<string | null> {
  const result = await db.query<{ draft: string | null }>(
    `SELECT config_json->>'onboarding_draft' AS draft
     FROM systems
     WHERE id = $1
     LIMIT 1`,
    [systemId],
  );
  return result.rows[0]?.draft ?? null;
}
