import { db } from "./client";

export interface UserRow {
  id: number;
  email: string;
  created_at: Date;
  google_sub?: string | null;
  gmail_email?: string | null;
  gmail_refresh_token?: string | null;
  gmail_token_expiry?: Date | null;
  style_signature?: unknown;
  style_signature_updated_at?: Date | null;
}

export async function upsertUserByEmail(email: string): Promise<UserRow> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw new Error("Invalid email");
  }

  const result = await db.query<UserRow>(
    `
      INSERT INTO users (email)
      VALUES ($1)
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id, email, created_at
    `,
    [normalized],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to upsert user");
  return row;
}

export async function getPrimaryUser(): Promise<UserRow | null> {
  const result = await db.query<UserRow>(
    "SELECT id, email, created_at, google_sub, gmail_email, gmail_refresh_token, gmail_token_expiry, style_signature, style_signature_updated_at FROM users ORDER BY id ASC LIMIT 1",
  );
  return result.rows[0] ?? null;
}

export async function getUserStyleSignature(userId: number): Promise<Record<string, unknown> | null> {
  const result = await db.query<{ style_signature: unknown }>(
    "SELECT style_signature FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  const raw = result.rows[0]?.style_signature;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export async function saveUserStyleSignature(userId: number, signature: Record<string, unknown>): Promise<void> {
  await db.query(
    `UPDATE users
     SET style_signature = $2::jsonb,
         style_signature_updated_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [userId, JSON.stringify(signature)],
  );
}

export async function createSession(userId: number, token: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await db.query(`INSERT INTO sessions (token, user_id) VALUES ($1, $2)`, [token, userId]);
}

export async function getUserBySessionToken(token: string): Promise<UserRow | null> {
  const result = await db.query<UserRow>(
    `
      SELECT u.id, u.email, u.created_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = $1
      LIMIT 1
    `,
    [token],
  );
  return result.rows[0] ?? null;
}

/** Alias for callers that expect an explicit DB session check. */
export const getSessionFromDB = getUserBySessionToken;

export async function deleteSession(token: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

export async function upsertUserByGoogle(input: {
  googleSub: string;
  email: string;
  gmailEmail?: string | undefined;
  refreshToken?: string | undefined;
  tokenExpiry?: Date | undefined;
}): Promise<UserRow> {
  const normalizedEmail = input.email.trim().toLowerCase();
  if (!normalizedEmail.includes("@")) {
    throw new Error("Invalid Google profile email");
  }

  const existing = await db.query<UserRow>(
    `SELECT id, email, created_at, google_sub, gmail_email, gmail_refresh_token, gmail_token_expiry FROM users WHERE google_sub = $1 OR email = $2 LIMIT 1`,
    [input.googleSub, normalizedEmail],
  );

  const row = existing.rows[0];

  if (row) {
    // Only update refresh_token if a new one is provided.
    // Google often doesn't resend it unless prompt=consent is used.
    const updateFields: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [row.id];

    if (input.googleSub && row.google_sub !== input.googleSub) {
      params.push(input.googleSub);
      updateFields.push(`google_sub = $${params.length}`);
    }
    if (input.gmailEmail) {
      params.push(input.gmailEmail);
      updateFields.push(`gmail_email = $${params.length}`);
    }
    if (input.refreshToken) {
      params.push(input.refreshToken);
      updateFields.push(`gmail_refresh_token = $${params.length}`);
    }
    if (input.tokenExpiry) {
      params.push(input.tokenExpiry);
      updateFields.push(`gmail_token_expiry = $${params.length}`);
    }

    if (updateFields.length > 1) {
      const up = await db.query<UserRow>(
        `UPDATE users SET ${updateFields.join(", ")} WHERE id = $1 RETURNING id, email, created_at, google_sub, gmail_email, gmail_refresh_token, gmail_token_expiry`,
        params,
      );
      return up.rows[0]!;
    }
    return row;
  }

  const ins = await db.query<UserRow>(
    `INSERT INTO users (email, google_sub, gmail_email, gmail_refresh_token, gmail_token_expiry)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, created_at, google_sub, gmail_email, gmail_refresh_token, gmail_token_expiry`,
    [normalizedEmail, input.googleSub, input.gmailEmail ?? null, input.refreshToken ?? null, input.tokenExpiry ?? null],
  );

  const newRow = ins.rows[0];
  if (!newRow) throw new Error("Failed to create Google user");
  return newRow;
}
