import { createServer as createHttpServer } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { pathToFileURL } from "node:url";
import { createServer } from "./mcp.js";
import { Store } from "./store.js";
import { Authorization } from "./authorization.js";
import { Hub } from "./hub.js";

export function buildApplication(config: { base?: string; key?: string; database?: string; proxy?: boolean }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.proxy ? 1 : false);
  const http = createHttpServer(app);
  let store: Store | undefined;
  let hub: Hub | undefined;
  const configured = Boolean(config.base && config.key);
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    if (config.base && req.headers.origin && req.headers.origin !== new URL(config.base).origin) {
      res.status(403).json({ error: "origin_denied" }); return;
    }
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ status: "alive", version: "0.1.0", authenticationConfigured: configured }));
  app.get("/readyz", (_req, res) => res.status(configured ? 200 : 503).json({ authenticationConfigured: configured }));
  if (configured) {
    const base = new URL(config.base!);
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("PUBLIC_URL must be an HTTPS origin (HTTP is allowed on loopback).");
    store = new Store(config.database ?? ".local/auth.sqlite", config.key!);
    const auth = new Authorization(store, base.origin);
    hub = new Hub(http, auth);
    const buckets = new Map<string, { count: number; expires: number }>();
    app.use((req, res, next) => {
      if (!req.path.startsWith("/devices/") && req.path !== "/pair-authorize") return next();
      const key = `${req.ip}:${req.path === "/pair-authorize" ? "codes" : "device"}`, now = Date.now();
      for (const [id, bucket] of buckets) if (bucket.expires <= now) buckets.delete(id);
      if (!buckets.has(key) && buckets.size >= 10_000) { res.status(503).json({ error: "temporarily_unavailable" }); return; }
      const bucket = buckets.get(key) ?? { count: 0, expires: now + 60_000 }; bucket.count++; buckets.set(key, bucket);
      if (bucket.count > (req.path === "/pair-authorize" ? 5 : 60)) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "too_many_attempts" }); return; }
      next();
    });
    app.use(mcpAuthRouter({ provider: auth, issuerUrl: base, resourceServerUrl: new URL(auth.resource), scopesSupported: ["orion:read"], resourceName: "ORIONMCP" }));
    app.use(express.json({ limit: "64kb" }), express.urlencoded({ extended: false, limit: "4kb" }));
    auth.registerPairRoutes(app);
    const verified = requireBearerAuth({ verifier: auth, requiredScopes: ["orion:read"], resourceMetadataUrl: `${base.origin}/.well-known/oauth-protected-resource/mcp` });
    app.post("/mcp", verified, async (req, res) => {
      const owner = req.auth?.extra?.owner;
      if (typeof owner !== "string") { res.status(403).json({ error: "owner_unavailable" }); return; }
      const mcp = createServer((instance, operation, args, document, id) => hub!.dispatch(owner, instance, operation, args, document, id), false, async () => hub!.instances(owner), false);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void mcp.close(); });
      try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body); }
      catch { if (!res.headersSent) res.status(400).json({ error: "invalid_request" }); else res.end(); }
    });
    app.all("/mcp", verified, (_req, res) => { res.setHeader("Allow", "POST"); res.status(405).json({ error: "method_not_allowed" }); });
  } else app.all("/mcp", (_req, res) => res.status(503).json({ error: "authentication_not_configured" }));
  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { if (!res.headersSent) res.status(error?.type === "entity.too.large" ? 413 : 400).json({ error: "invalid_request" }); };
  app.use(errors);
  http.requestTimeout = 30_000; http.headersTimeout = 10_000;
  return { app, http, store, hub };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { http, store, hub } = buildApplication({ base: process.env.ORIONMCP_PUBLIC_URL, key: process.env.ORIONMCP_STORAGE_KEY, database: process.env.ORIONMCP_DB_PATH, proxy: Boolean(process.env.RAILWAY_ENVIRONMENT_ID) });
  const cleanup = setInterval(() => store?.cleanup(), 60_000); cleanup.unref();
  const port = Number(process.env.PORT ?? 8080);
  http.listen(port, "0.0.0.0", () => console.error(`ORIONMCP HTTP listening on port ${port}`));
  function shutdown() { hub?.close(); clearInterval(cleanup); http.close(() => { store?.close(); process.exit(0); }); setTimeout(() => { http.closeAllConnections(); process.exit(1); }, 5000).unref(); }
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}
