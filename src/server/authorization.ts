import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Store } from "./store.js";

const minute = 60_000, day = 86_400_000;
const secret = () => randomBytes(32).toString("hex");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function same(left: string, right: string) { return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
const html = (body: string) => `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ORIONMCP · Conectar</title><body><main><h1>Conectar ORIONMCP</h1>${body}</main></body></html>`;
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
interface Flow { client: OAuthClientInformationFull; params: AuthorizationParams & { resourceString: string }; csrf: string; owner?: string; denied?: boolean; pairingId?: string; }
interface Pair { instanceId: string; proof: string; userCode: string; expires: number; flowId?: string; requestId?: string; owner?: string; approved?: boolean; }
interface Code { clientId: string; owner: string; redirectUri: string; resource: string; challenge: string; scopes: string[]; }
interface Grant { clientId: string; owner: string; resource: string; scopes: string[]; family: string; expires: number; deviceId?: string; }

/** SDK provides OAuth endpoints and PKCE validation; approval belongs to the native Revit host. */
export class Authorization implements OAuthServerProvider {
  readonly resource: string;
  readonly clientsStore: OAuthRegisteredClientsStore;
  constructor(readonly store: Store, readonly base: string) {
    this.resource = `${base.replace(/\/$/, "")}/mcp`;
    this.clientsStore = {
      getClient: (id) => this.store.get<OAuthClientInformationFull>("client", id),
      registerClient: (metadata) => {
        if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== "none") throw new InvalidClientMetadataError("Only public PKCE clients are supported.");
        if (metadata.redirect_uris.length < 1 || metadata.redirect_uris.length > 5 || metadata.redirect_uris.some((uri) => { try { const u = new URL(uri); return u.username !== "" || u.password !== "" || u.hash !== "" || (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))); } catch { return true; } })) throw new InvalidClientMetadataError("HTTPS or loopback redirect required.");
        const client: OAuthClientInformationFull = { ...metadata, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: metadata.token_endpoint_auth_method ?? "none" };
        this.store.set("client", client.client_id, client, Date.now() + 180 * day); return client;
      },
    };
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && params.resource.href !== this.resource) throw new InvalidGrantError("Invalid resource.");
    if (params.scopes?.some((scope) => scope !== "orion:read")) throw new InvalidGrantError("Scope unavailable.");
    const id = secret(), csrf = secret();
    const flow: Flow = { client, params: { ...params, scopes: ["orion:read"], resourceString: this.resource }, csrf };
    this.store.set("flow", id, flow, Date.now() + 5 * minute);
    res.cookie("orion_flow", csrf, { httpOnly: true, secure: new URL(this.base).protocol === "https:", sameSite: "lax", maxAge: 5 * minute, path: "/" });
    res.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.send(html(`<p>Cliente: ${escape(client.client_name ?? "Cliente MCP")}. Permiso solicitado: lectura.</p><p>En Revit, abre ORIONMCP y pulsa Conectar servidor HTTP. Introduce aquí el código temporal mostrado por el add-in y aprueba el cliente dentro de Revit.</p><form method="post" action="/pair-authorize"><input type="hidden" name="flow" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><label>Código de Revit <input name="code" maxlength="8" autocomplete="off" required></label><button>Solicitar emparejamiento</button></form>`));
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> { return this.code(client.client_id, code).challenge; }
  private code(clientId: string, value: string): Code { const code = this.store.get<Code>("code", digest(value)); if (!code || code.clientId !== clientId) throw new InvalidGrantError("Code expired or unavailable."); return code; }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, value: string, verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const code = this.code(client.client_id, value);
    if (!verifier || createHash("sha256").update(verifier).digest("base64url") !== code.challenge || redirectUri !== code.redirectUri || (resource && resource.href !== code.resource)) throw new InvalidGrantError("Code binding mismatch.");
    if (!this.store.take<Code>("code", digest(value))) throw new InvalidGrantError("Code already used.");
    return this.issue({ clientId: client.client_id, owner: code.owner, resource: code.resource, scopes: code.scopes, family: randomUUID(), expires: Date.now() + 30 * day });
  }
  private issue(grant: Grant): OAuthTokens {
    const access = secret(), refresh = secret();
    this.store.set("access", digest(access), grant, Date.now() + 10 * minute);
    this.store.set("refresh", digest(refresh), grant, grant.expires);
    return { access_token: access, token_type: "Bearer", expires_in: 600, refresh_token: refresh, scope: grant.scopes.join(" ") };
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const fingerprint = digest(refresh);
    const used = this.store.get<Grant>("used-refresh", fingerprint);
    if (used?.clientId === client.client_id) { this.store.set("revoked", used.family, true, used.expires); throw new InvalidGrantError("Refresh reuse detected; authenticate again."); }
    const grant = this.store.get<Grant>("refresh", fingerprint);
    if (!grant || grant.clientId !== client.client_id || this.store.get("revoked", grant.family) || (resource && resource.href !== grant.resource) || scopes?.some((s) => !grant.scopes.includes(s))) throw new InvalidGrantError("Refresh unavailable.");
    if (!this.store.take("refresh", fingerprint)) throw new InvalidGrantError("Refresh already used.");
    this.store.set("used-refresh", fingerprint, grant, grant.expires);
    return this.issue({ ...grant, scopes: scopes ?? grant.scopes });
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = this.store.get<Grant>("access", digest(token));
    if (!grant || grant.resource !== this.resource || this.store.get("revoked", grant.family)) throw new InvalidTokenError("Token unavailable.");
    return { token, clientId: grant.clientId, scopes: grant.scopes, expiresAt: Math.floor(this.store.expiry("access", digest(token))! / 1000), resource: new URL(grant.resource), extra: { owner: grant.owner, deviceId: grant.deviceId } };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const grant = this.store.get<Grant>("access", digest(request.token)) ?? this.store.get<Grant>("refresh", digest(request.token));
    if (grant?.clientId === client.client_id) this.store.set("revoked", grant.family, true, grant.expires);
  }
  registerPairRoutes(app: Express): void {
    app.post("/devices/pairing", (req, res) => {
      if (typeof req.body?.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(req.body.instanceId)) return res.status(400).json({ error: "invalid_instance" });
      const pairingId = randomUUID(), proof = secret(), userCode = randomBytes(4).toString("hex").toUpperCase(), expires = Date.now() + 5 * minute;
      this.store.set("pair", pairingId, { instanceId: req.body.instanceId, proof: digest(proof), userCode, expires } satisfies Pair, expires);
      this.store.set("pair-code", userCode, pairingId, expires);
      res.json({ pairingId, pairingSecret: proof, userCode, expiresAt: new Date(expires).toISOString() });
    });
    app.post("/devices/pairing/:id/status", (req, res) => {
      const pair = this.pair(req.params.id, req.headers.authorization); if (!pair) return res.status(401).json({ error: "unauthorized" });
      const flow = pair.flowId ? this.store.get<Flow>("flow", pair.flowId) : undefined;
      res.json({ state: pair.approved ? "approved" : flow ? "approval_required" : "waiting", requestId: pair.requestId, clientName: flow?.client.client_name ?? "Cliente MCP", scopes: ["orion:read"] });
    });
    app.post("/devices/pairing/:id/approve", (req, res) => {
      const pair = this.pair(req.params.id, req.headers.authorization); if (!pair || !pair.flowId || req.body?.requestId !== pair.requestId || typeof req.body?.approved !== "boolean") return res.status(401).json({ error: "unauthorized" });
      const flow = this.store.get<Flow>("flow", pair.flowId); if (!flow || pair.approved) return res.status(409).json({ error: "approval_unavailable" });
      if (!req.body.approved) { flow.denied = true; this.store.set("flow", pair.flowId, flow, pair.expires); return res.json({ state: "denied" }); }
      pair.approved = true; pair.owner = randomUUID(); flow.owner = pair.owner;
      this.store.set("pair", req.params.id, pair, pair.expires); this.store.set("flow", pair.flowId, flow, pair.expires);
      const grant: Grant = { clientId: "orion-native-device", owner: pair.owner, deviceId: pair.instanceId, scopes: ["orion:device"], resource: this.resource, family: randomUUID(), expires: Date.now() + 30 * day };
      const deviceToken = secret(); this.store.set("access", digest(deviceToken), grant, Date.now() + 60 * minute);
      res.json({ state: "approved", deviceToken, expiresIn: 3600 });
    });
    app.post("/pair-authorize", (req, res) => {
      const flowId = typeof req.body?.flow === "string" ? req.body.flow : "";
      const flow = this.store.get<Flow>("flow", flowId);
      const cookie = /(?:^|; )orion_flow=([a-f0-9]{64})/.exec(req.headers.cookie ?? "")?.[1];
      if (!flow || !cookie || !same(cookie, flow.csrf) || req.body?.csrf !== flow.csrf || (req.headers.origin && req.headers.origin !== new URL(this.base).origin)) return res.status(403).send(html("<p>La solicitud caducó. Reinicia la conexión.</p>"));
      const code = String(req.body?.code ?? "").trim().toUpperCase();
      const pairingId = this.store.get<string>("pair-code", code); const pair = pairingId ? this.store.get<Pair>("pair", pairingId) : undefined;
      if (!pair || pair.flowId || pair.approved) return res.status(400).send(html("<p>Código no válido, utilizado o caducado. Genera otro desde Revit.</p>"));
      pair.flowId = flowId; pair.requestId = randomUUID(); flow.pairingId = pairingId;
      this.store.set("pair", pairingId!, pair, pair.expires); this.store.set("flow", flowId, flow, pair.expires); this.store.delete("pair-code", code);
      res.redirect(`/pair/await/${flowId}`);
    });
    app.get("/pair/await/:id", (req, res) => {
      const flow = this.store.get<Flow>("flow", req.params.id);
      const cookie = /(?:^|; )orion_flow=([a-f0-9]{64})/.exec(req.headers.cookie ?? "")?.[1];
      if (!flow || !cookie || !same(cookie, flow.csrf)) return res.status(403).send(html("<p>Conexión caducada.</p>"));
      const redirect = new URL(flow.params.redirectUri);
      if (flow.params.state) redirect.searchParams.set("state", flow.params.state);
      if (flow.denied) { redirect.searchParams.set("error", "access_denied"); this.store.delete("flow", req.params.id); return res.redirect(redirect.href); }
      if (!flow.owner) return res.send(html('<meta http-equiv="refresh" content="2"><p>Aprueba esta conexión dentro de Revit. Esta página se actualizará.</p>'));
      const value = secret();
      this.store.set("code", digest(value), { clientId: flow.client.client_id, owner: flow.owner, redirectUri: flow.params.redirectUri, resource: flow.params.resourceString, challenge: flow.params.codeChallenge, scopes: ["orion:read"] } satisfies Code, Date.now() + minute);
      this.store.delete("flow", req.params.id); redirect.searchParams.set("code", value); res.redirect(redirect.href);
    });
  }
  private pair(id: string, header?: string): Pair | undefined { const pair = this.store.get<Pair>("pair", id); return pair && header?.startsWith("Bearer ") && same(digest(header.slice(7)), pair.proof) ? pair : undefined; }
}
