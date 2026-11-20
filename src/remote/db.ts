/**
 * Tiny database layer: a common interface over node-postgres (production) and PGlite (tests/dev).
 */

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Run fn inside a transaction. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function connectPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const ssl = /sslmode=require/.test(url) || process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: url, max: 10, ssl });
  return {
    query: (sql, params) => pool.query(sql, params as any[]) as any,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (sql, params) => client.query(sql, params as any[]) as any });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** In-process Postgres (PGlite). Used by tests; `dataDir` undefined = in-memory. */
export async function connectPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dataDir);
  // PGlite runs one query at a time; serialize so transactions don't interleave with other queries.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    query: (sql, params) => serial(() => db.query(sql, params as any[]) as any),
    tx: (fn) => serial(() => db.transaction((t) => fn({ query: (sql, params) => t.query(sql, params as any[]) as any }))),
    close: () => db.close(),
  };
}

const MIGRATIONS: string[] = [
  // 1: OAuth + connections
  `
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS pending_auth (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state TEXT,
    scopes TEXT,
    resource TEXT,
    passcode_ok BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connections (
    location_id TEXT PRIMARY KEY,
    auth_type TEXT NOT NULL,
    enc_access TEXT NOT NULL,
    enc_refresh TEXT,
    access_expires_at TIMESTAMPTZ,
    location_name TEXT,
    company_id TEXT,
    ghl_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS auth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    resource TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS tokens_location_idx ON tokens(location_id);
  CREATE TABLE IF NOT EXISTS confirm_tokens (
    token TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );
  `,
  // 2: automations
  `
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    name TEXT NOT NULL,
    definition JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    mode TEXT NOT NULL DEFAULT 'dry_run',
    last_scheduled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS automations_location_idx ON automations(location_id);
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    contact_id TEXT,
    opportunity_id TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    step INTEGER NOT NULL DEFAULT 0,
    trigger_event JSONB,
    vars JSONB NOT NULL DEFAULT '{}'::jsonb,
    log JSONB NOT NULL DEFAULT '[]'::jsonb,
    depth INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS runs_automation_idx ON automation_runs(automation_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS runs_contact_idx ON automation_runs(automation_id, contact_id);
  CREATE TABLE IF NOT EXISTS automation_actions (
    id BIGSERIAL PRIMARY KEY,
    automation_id TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS actions_rate_idx ON automation_actions(automation_id, at);
  CREATE TABLE IF NOT EXISTS jobs (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    run_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, run_at);
  CREATE TABLE IF NOT EXISTS processed_events (
    event_key TEXT PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS contact_snapshots (
    location_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    tags JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, contact_id)
  );
  CREATE TABLE IF NOT EXISTS opportunity_snapshots (
    location_id TEXT NOT NULL,
    opportunity_id TEXT NOT NULL,
    stage_id TEXT,
    status TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, opportunity_id)
  );
  CREATE TABLE IF NOT EXISTS self_actions (
    id BIGSERIAL PRIMARY KEY,
    location_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    action_key TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    depth INTEGER NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS self_actions_idx ON self_actions(location_id, contact_id, action_key, at);
  CREATE TABLE IF NOT EXISTS poll_state (
    location_id TEXT PRIMARY KEY,
    last_poll_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    location_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (location_id, key)
  );
  `,
];

export async function migrate(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ version: number }>(`SELECT version FROM schema_migrations`);
  const done = new Set(rows.map((r) => Number(r.version)));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.tx(async (q) => {
      for (const stmt of MIGRATIONS[i].split(";").map((s) => s.trim()).filter(Boolean)) await q.query(stmt);
      await q.query(`INSERT INTO schema_migrations(version) VALUES ($1)`, [version]);
    });
  }
}
