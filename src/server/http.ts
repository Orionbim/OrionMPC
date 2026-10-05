import { createServer as createHttpServer } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./mcp.js";

const port = Number(process.env.PORT ?? 3000);
const base = process.env.ORIONMCP_PUBLIC_URL;
const issuer = process.env.ORIONMCP_OAUTH_ISSUER;
const jwksUrl = process.env.ORIONMCP_OAUTH_JWKS_URL;
const configured = Boolean(base && issuer && jwksUrl);
const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : undefined;
const http = createHttpServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://internal").pathname;
  const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  if (pathname === "/healthz") return json(200, { status: "alive", version: "0.1.0", authenticationConfigured: configured, remoteRevitAvailable: false });
  if (pathname === "/readyz") return json(configured ? 200 : 503, { authenticationConfigured: configured, remoteRevitAvailable: false });
  if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
    if (!configured) return json(503, { error: "authentication_not_configured" });
    return json(200, { resource: `${base!.replace(/\/$/, "")}/mcp`, authorization_servers: [issuer], scopes_supported: ["orion:read"], bearer_methods_supported: ["header"] });
  }
  if (pathname !== "/mcp") return json(404, { error: "not_found" });
  if (!configured || !jwks) return json(503, { error: "authentication_not_configured" });
  if (req.headers.origin && req.headers.origin !== new URL(base!).origin) return json(403, { error: "origin_denied" });
  const resource = `${base!.replace(/\/$/, "")}/mcp`;
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) throw new Error("missing_token");
    const { payload } = await jwtVerify(auth.slice(7), jwks, { issuer, audience: resource, algorithms: ["RS256", "ES256", "EdDSA"], requiredClaims: ["exp", "sub", "iat"], clockTolerance: 5 });
    if (typeof payload.scope !== "string" || !payload.scope.split(" ").includes("orion:read")) return json(403, { error: "insufficient_scope" });
  } catch {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${base!.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp"`);
    return json(401, { error: "unauthorized" });
  }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(405, { error: "method_not_allowed" }); }
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65_536) { json(413, { error: "message_too_large" }); req.destroy(); return; } chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const server = createServer(undefined, false);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch { if (!res.headersSent) json(400, { error: "invalid_request" }); else res.end(); }
});
http.requestTimeout = 30_000;
http.headersTimeout = 10_000;
http.listen(port, "0.0.0.0", () => console.error(`ORIONMCP HTTP listening on port ${port}; OAuth configured: ${configured}`));
function shutdown() { http.close(() => process.exit(0)); setTimeout(() => { http.closeAllConnections(); process.exit(1); }, 5000).unref(); }
process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
