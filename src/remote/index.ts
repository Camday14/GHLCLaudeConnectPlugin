#!/usr/bin/env node
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connectPglite, connectPostgres, migrate } from "./db.js";

async function main() {
  const cfg = loadConfig();
  const db = cfg.databaseUrl ? await connectPostgres(cfg.databaseUrl) : await connectPglite(process.env.PGLITE_DIR ?? "./data/pglite");
  if (!cfg.databaseUrl) console.error(`[connector] DATABASE_URL not set: using embedded PGlite in ${process.env.PGLITE_DIR ?? "./data/pglite"} (fine for local testing; use Postgres in production).`);
  await migrate(db);
  const { app, engine } = createApp({ db, cfg });
  engine.start(cfg.workerIntervalMs);
  const server = app.listen(cfg.port, () => {
    console.error(`[connector] listening on :${cfg.port}`);
    console.error(`[connector] add this URL in Claude → Settings → Connectors: ${cfg.publicUrl}/mcp`);
    if (!cfg.ghlClientId) console.error("[connector] GHL_CLIENT_ID not set: 'Log in with GoHighLevel' is hidden; token login only.");
    if (!cfg.webhookSecret && !cfg.webhookPublicKey) console.error("[connector] WEBHOOK_SECRET not set: automations use polling (every few minutes) instead of instant webhooks.");
  });
  const shutdown = async () => {
    engine.stop();
    server.close();
    await engine.idle();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(`[connector] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
