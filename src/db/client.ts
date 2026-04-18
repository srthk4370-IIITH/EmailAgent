import { Pool } from "pg";
import type { PoolClient } from "pg";
import { getRuntimeConfigRequiredSync } from "../lib/runtimeConfig";

const connectionString = getRuntimeConfigRequiredSync("DATABASE_URL");

export const db = new Pool({
  connectionString,
});

/**
 * Queryable interface: anything that can run db.query().
 * Both Pool and PoolClient satisfy this, so calling code can accept either.
 */
export interface Queryable {
  query: Pool["query"];
}

/**
 * Real PostgreSQL transaction wrapper.
 * - Acquires a dedicated client from the pool
 * - Runs BEGIN / COMMIT with ROLLBACK on any error
 * - The callback receives a PoolClient scoped to the transaction
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function ensureDefaultSystemAndAccount(): Promise<void> {
  await db.query(
    `INSERT INTO systems (id, name, onboarding_state)
     VALUES (1, 'Default System', 'system_created')
     ON CONFLICT (id) DO NOTHING`,
  );

  await db.query(
    `INSERT INTO email_accounts (
       system_id, user_id, email_address, provider,
       oauth_refresh_token, oauth_token_expiry, status, last_history_id
     )
     SELECT
       1,
       u.id,
       COALESCE(NULLIF(u.gmail_email, ''), u.email),
       'gmail',
       u.gmail_refresh_token,
       u.gmail_token_expiry,
       CASE WHEN u.gmail_refresh_token IS NULL THEN 'needs_reauth' ELSE 'active' END,
       c.last_gmail_history_id
     FROM users u
     CROSS JOIN config c
     WHERE NOT EXISTS (
       SELECT 1 FROM email_accounts a WHERE a.system_id = 1 AND a.user_id = u.id
     )
     ORDER BY u.id ASC
     LIMIT 1`,
  );

  await db.query(
    `UPDATE emails e
     SET system_id = 1,
         account_id = (
           SELECT a.id FROM email_accounts a
           WHERE a.system_id = 1
           ORDER BY a.id ASC
           LIMIT 1
         )
     WHERE e.account_id IS NULL`,
  );

  await db.query(
    `UPDATE email_embeddings em
     SET system_id = COALESCE(em.system_id, 1),
         account_id = COALESCE(em.account_id, e.account_id)
     FROM emails e
     WHERE e.id = em.email_id
       AND em.account_id IS NULL`,
  );

  await db.query(
    `UPDATE email_threads t
     SET system_id = COALESCE(t.system_id, 1),
         account_id = COALESCE(
           t.account_id,
           (
             SELECT e.account_id
             FROM emails e
             WHERE e.thread_id = t.thread_id
             ORDER BY e.id DESC
             LIMIT 1
           )
         )
     WHERE t.account_id IS NULL`,
  );

  await db.query(
    `UPDATE job_queue
     SET system_id = COALESCE(system_id, 1),
         account_id = COALESCE(
           account_id,
           (
             SELECT a.id
             FROM email_accounts a
             WHERE a.system_id = 1
             ORDER BY a.id ASC
             LIMIT 1
           )
         )
     WHERE account_id IS NULL`,
  );
}

let schemaInitPromise: Promise<void> | null = null;

async function initDbSchemaInternal(): Promise<void> {
  const client = await db.connect();
  const previousQuery = db.query.bind(db);
  let initQueryQueue: Promise<unknown> = Promise.resolve();
  const queuedClientQuery = ((...args: unknown[]) => {
    const run = () => (client.query as (...clientArgs: unknown[]) => unknown)(...args);
    const queued = initQueryQueue.then(run, run);
    initQueryQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }) as typeof db.query;

  (db as unknown as { query: typeof db.query }).query = queuedClientQuery;
  try {
    await client.query(`SET statement_timeout TO 0;`);
    await client.query(`SET lock_timeout TO 0;`);
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS systems (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Default System',
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      onboarding_state TEXT NOT NULL DEFAULT 'system_created',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id SERIAL PRIMARY KEY,
      system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email_address TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gmail',
      oauth_refresh_token TEXT,
      oauth_token_expiry TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      last_history_id TEXT,
      last_sync_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(system_id, email_address)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS system_diagnostics (
      id BIGSERIAL PRIMARY KEY,
      system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
      account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL,
      check_type TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      error TEXT,
      cause TEXT,
      fix TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS emails (
      id SERIAL PRIMARY KEY,
      gmail_id TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL DEFAULT 'inbox',
      trace_id TEXT,
      thread_id TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      internal_date BIGINT,
      state TEXT NOT NULL,
      category TEXT,
      confidence DOUBLE PRECISION,
      decision TEXT,
      reply TEXT,
      parsed_content JSONB,
      classification_output JSONB,
      rag_context JSONB,
      prompt_version TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      llm_latency_ms INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      last_step TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS trace_id TEXT;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inbox';`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS snippet TEXT NOT NULL DEFAULT '';`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS internal_date BIGINT;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS last_step TEXT;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS parsed_content JSONB;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS classification_output JSONB;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS rag_context JSONB;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS prompt_version TEXT;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS tokens_in INTEGER;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS tokens_out INTEGER;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS llm_latency_ms INTEGER;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL;`);
  await db.query(
    `ALTER TABLE emails ADD COLUMN IF NOT EXISTS processing_version INTEGER NOT NULL DEFAULT 0;`,
  );
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS review_outcome TEXT;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending';`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_seen BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS ready_to_send_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS manual_generate_requested BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(
    `UPDATE emails
     SET manual_generate_requested = COALESCE((parsed_content->>'manual_generate_requested')::boolean, false)
     WHERE parsed_content IS NOT NULL
       AND parsed_content ? 'manual_generate_requested'`,
  );
  await db.query(`UPDATE emails SET is_seen = true WHERE source IN ('sent', 'compose') AND is_seen IS DISTINCT FROM true;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_emails_retry_ready ON emails(state, next_attempt_at, id);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      gmail_email TEXT,
      gmail_refresh_token TEXT,
      gmail_token_expiry TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_email TEXT;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_refresh_token TEXT;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_token_expiry TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS style_signature JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS style_signature_updated_at TIMESTAMPTZ;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS drafts (
      id SERIAL PRIMARY KEY,
      email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      reply TEXT NOT NULL,
      edited_body TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`ALTER TABLE drafts ADD COLUMN IF NOT EXISTS edited_body TEXT;`);
  await db.query(`ALTER TABLE drafts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await db.query(`ALTER TABLE drafts ADD COLUMN IF NOT EXISTS is_fallback BOOLEAN NOT NULL DEFAULT false;`);
  // If the table already has duplicates, collapse to exactly one row per email_id
  // before adding the unique constraint (prevents initDbSchema from failing).
  await db.query(`
    DELETE FROM drafts d
    USING drafts d2
    WHERE d.email_id = d2.email_id
      AND d.id < d2.id
  `);
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'unique_email_draft'
      ) THEN
        ALTER TABLE drafts ADD CONSTRAINT unique_email_draft UNIQUE (email_id);
      END IF;
    END $$;
  `);

  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'email_embeddings'
          AND column_name = 'account_id'
      ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'email_embeddings'
          AND column_name = 'created_at'
      ) THEN
        CREATE INDEX IF NOT EXISTS idx_email_embeddings_account
        ON email_embeddings(account_id, created_at DESC, id DESC);
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      global_mode TEXT NOT NULL DEFAULT 'assist',
      send_mode TEXT NOT NULL DEFAULT 'dry',
      threshold DOUBLE PRECISION NOT NULL DEFAULT 0.7,
      category_rules JSONB NOT NULL DEFAULT '{"general":"assist"}'::jsonb,
      category_colors JSONB NOT NULL DEFAULT '{}'::jsonb,
      tone TEXT NOT NULL DEFAULT 'professional',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT singleton CHECK (id = 1)
    );
  `);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS tone TEXT NOT NULL DEFAULT 'professional';`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'dry';`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS category_colors JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS last_gmail_history_id TEXT;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS llm_failure_count INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS llm_last_failure_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS llm_circuit_open BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS llm_circuit_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS sync_running BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS sync_started_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS embedding_dataset_version BIGINT NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 1;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS embedding_error TEXT;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS risk_score DOUBLE PRECISION;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS risk_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS cost_estimate_tokens INTEGER;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS cost_score DOUBLE PRECISION;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS priority_score DOUBLE PRECISION;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS rag_confidence DOUBLE PRECISION;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS rag_conflict_detected BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS decision_reason TEXT;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS selected_model TEXT;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS style_confidence DOUBLE PRECISION;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS clarification_mode BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS edited_count INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS rejected_count INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS regenerated_count INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS accepted_count INTEGER NOT NULL DEFAULT 0;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    UPDATE config
    SET category_rules = (
      SELECT jsonb_object_agg(value, 'assist')
      FROM jsonb_array_elements_text(category_rules)
    )
    WHERE jsonb_typeof(category_rules) = 'array';
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_threads (
      id SERIAL PRIMARY KEY,
      thread_id TEXT NOT NULL,
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_threads_thread_id_key'
      ) THEN
        ALTER TABLE email_threads DROP CONSTRAINT email_threads_thread_id_key;
      END IF;
    END $$;
  `);

  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'email_threads'
          AND column_name = 'account_id'
      ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_email_threads_account_thread_unique
        ON email_threads(account_id, thread_id)
        WHERE account_id IS NOT NULL;
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_embeddings (
      id SERIAL PRIMARY KEY,
      email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      chunk_text TEXT NOT NULL,
      embedding VECTOR(1536) NOT NULL,
      chunk_type TEXT DEFAULT 'unknown',
      sender_type TEXT DEFAULT 'unknown',
      topic TEXT,
      thread_id TEXT,
      content_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Additive migrations for email_embeddings (safe on existing tables)
  await db.query(`ALTER TABLE email_embeddings ADD COLUMN IF NOT EXISTS chunk_type TEXT DEFAULT 'unknown';`);
  await db.query(`ALTER TABLE email_embeddings ADD COLUMN IF NOT EXISTS sender_type TEXT DEFAULT 'unknown';`);
  await db.query(`ALTER TABLE email_embeddings ADD COLUMN IF NOT EXISTS topic TEXT;`);
  await db.query(`ALTER TABLE email_embeddings ADD COLUMN IF NOT EXISTS thread_id TEXT;`);
  await db.query(`ALTER TABLE email_embeddings ADD COLUMN IF NOT EXISTS content_hash TEXT;`);
  await db.query(`ALTER TABLE email_embeddings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await db.query(`ALTER TABLE email_embeddings ADD COLUMN IF NOT EXISTS system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE email_embeddings ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL;`);

  // TIER 1 CLINICAL CORRECTION: Deterministic Deduplication before adding UNIQUE constraint.
  // KEEP Latest created_at then Longest chunk_text.
  await db.query(`
    DELETE FROM email_embeddings
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY email_id, content_hash 
          ORDER BY created_at DESC, LENGTH(chunk_text) DESC, id DESC
        ) as row_num
        FROM email_embeddings
        WHERE content_hash IS NOT NULL
      ) t
      WHERE t.row_num > 1
    )
  `);

  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'unique_email_chunk_hash'
      ) THEN
        ALTER TABLE email_embeddings ADD CONSTRAINT unique_email_chunk_hash UNIQUE (email_id, content_hash);
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS chunk_feedback (
      chunk_id INTEGER PRIMARY KEY REFERENCES email_embeddings(id) ON DELETE CASCADE,
      retrieved_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      helpful_count INTEGER NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // HNSW index for fast vector similarity search (Phase 9: scaling)
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_email_embeddings_hnsw'
      ) THEN
        CREATE INDEX idx_email_embeddings_hnsw
        ON email_embeddings
        USING hnsw (embedding vector_l2_ops)
        WITH (m = 16, ef_construction = 64);
      END IF;
    END $$;
  `);
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_email_embeddings_hnsw_cosine'
      ) THEN
        CREATE INDEX idx_email_embeddings_hnsw_cosine
        ON email_embeddings
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS compose_requests (
      id SERIAL PRIMARY KEY,
      trace_id TEXT NOT NULL,
      category TEXT NOT NULL,
      context TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      trace_id TEXT NOT NULL,
      gmail_id TEXT,
      step TEXT NOT NULL,
      state TEXT NOT NULL,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_trace_id_id ON logs(trace_id, id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_gmail_id_id ON logs(gmail_id, id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_created_at_id_desc ON logs(created_at DESC, id DESC);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS error_logs (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'UNKNOWN',
      message TEXT NOT NULL,
      reason TEXT NOT NULL,
      fix TEXT NOT NULL,
      severity TEXT NOT NULL,
      retryable BOOLEAN NOT NULL DEFAULT false,
      auto_recoverable BOOLEAN NOT NULL DEFAULT false,
      source TEXT NOT NULL DEFAULT 'api',
      route TEXT,
      operation TEXT,
      email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
      trace_id TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'UNKNOWN';`);
  await db.query(`ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS auto_recoverable BOOLEAN NOT NULL DEFAULT false;`);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs (created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_error_logs_code ON error_logs (code);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS model_performance (
      id SERIAL PRIMARY KEY,
      model TEXT NOT NULL,
      task TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      total_tokens BIGINT NOT NULL DEFAULT 0,
      total_cost_units DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(model, task)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id SERIAL PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      trace_id TEXT,
      dedupe_key TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5;`);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_threads_account_thread_unique
    ON email_threads(account_id, thread_id)
    WHERE account_id IS NOT NULL;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_email_embeddings_account
    ON email_embeddings(account_id, created_at DESC, id DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_ready
    ON job_queue (status, priority DESC, available_at, id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_emails_account_state_date
    ON emails(account_id, state, internal_date DESC, id DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_email_threads_account_thread
    ON email_threads(account_id, thread_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_account_status
    ON job_queue(account_id, status, available_at, id);
  `);

  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'emails_gmail_id_key'
      ) THEN
        ALTER TABLE emails DROP CONSTRAINT emails_gmail_id_key;
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_unique_per_account_gmail
    ON emails(account_id, gmail_id)
    WHERE account_id IS NOT NULL;
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_dedupe_active
    ON job_queue (job_type, dedupe_key)
    WHERE status IN ('pending', 'processing');
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS system_cache (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_system_cache_expires ON system_cache (expires_at);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS action_idempotency (
      id BIGSERIAL PRIMARY KEY,
      email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(email_id, action, idempotency_key)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS send_attempts (
      id BIGSERIAL PRIMARY KEY,
      account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL,
      email_id INTEGER REFERENCES emails(id) ON DELETE CASCADE,
      send_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_send_attempts_send_key
    ON send_attempts(send_key);
  `);

  await db.query(`
    INSERT INTO config (id, global_mode, send_mode, threshold, category_rules, category_colors, tone)
    VALUES (1, 'assist', 'dry', 0.7, '{"general":"assist","unknown":"assist"}'::jsonb, '{}'::jsonb, 'professional')
    ON CONFLICT (id) DO NOTHING;
  `);

  await db.query(`
    UPDATE config
    SET category_rules = category_rules || '{"unknown":"assist"}'::jsonb
    WHERE NOT (category_rules ? 'unknown');
  `);

  // ── Fix 2: System Health table ──────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS system_health (
      service TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_ok_at TIMESTAMPTZ,
      error_message TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed default health rows
  await db.query(`
    INSERT INTO system_health (service, status)
    VALUES ('openai', 'unknown'), ('gmail', 'unknown'), ('worker', 'unknown'), ('db', 'ok')
    ON CONFLICT (service) DO NOTHING;
  `);

  // ── Fix 1: Safety audit trail ───────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS safety_blocks (
      id BIGSERIAL PRIMARY KEY,
      email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      layer TEXT NOT NULL,
      reason TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS safety_review_required BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS safety_block_reason TEXT;`);

  // ── Fix 4: Cost control columns on config ───────────────────────────
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS daily_token_limit INTEGER NOT NULL DEFAULT 500000;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS tokens_used_today INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS token_reset_date DATE NOT NULL DEFAULT CURRENT_DATE;`);

  // ── Fix 5: Worker heartbeat column on system_health ─────────────────
  await db.query(`ALTER TABLE system_health ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;`);

    await ensureDefaultSystemAndAccount();
  } finally {
    (db as unknown as { query: typeof db.query }).query = previousQuery;
    client.release();
  }
}

export async function initDbSchema(): Promise<void> {
  schemaInitPromise ??= initDbSchemaInternal();
  await schemaInitPromise;
}
