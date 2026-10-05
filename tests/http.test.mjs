import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Store } from "../dist/server/store.js";
import { Authorization, digest } from "../dist/server/authorization.js";
import { buildApplication } from "../dist/server/http.js";

test("auth store encrypts data, survives reopening, and consumes records once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orion-store-")), file = path.join(dir, "auth.sqlite"), key = randomBytes(32).toString("hex");
  let store = new Store(file, key);
  try {
    store.set("test", "id", { credential: "private-test-value" }, Date.now() + 10_000); store.close();
    assert.equal(readFileSync(file).includes("private-test-value"), false);
    store = new Store(file, key);
    assert.deepEqual(store.take("test", "id"), { credential: "private-test-value" }); assert.equal(store.take("test", "id"), undefined);
    store.set("expired", "id", true, Date.now() - 1); assert.equal(store.get("expired", "id"), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("OAuth pairing, PKCE, token rotation, revocation and tenant isolation (protocol fixture)", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "orion-http-"));
  const app = buildApplication({ base: "http://127.0.0.1", key: randomBytes(32).toString("hex"), database: path.join(dir, "auth.sqlite") });
  await new Promise((resolve) => app.http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.http.address().port}`;
  const request = (route, body, headers = {}) => fetch(`${origin}${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const resource = "http://127.0.0.1/mcp";
  let socket;
  try {
    await t.test("MCP denies unauthenticated calls and advertises OAuth", async () => {
      const denied = await request("/mcp", {}); assert.equal(denied.status, 401); assert.match(denied.headers.get("www-authenticate"), /resource_metadata=/);
      const metadata = await (await request("/.well-known/oauth-protected-resource/mcp")).json(); assert.equal(metadata.resource, resource);
      assert.equal((await request("/devices/pairing", {}, { Origin: "https://malicious.test" })).status, 403);
    });
    const clientResponse = await request("/register", { redirect_uris: ["http://127.0.0.1:49817/callback"], token_endpoint_auth_method: "none", client_name: "Test client" });
    assert.equal(clientResponse.status, 201); const client = await clientResponse.json();
    await t.test("insecure redirect registration is rejected", async () => { assert.equal((await request("/register", { redirect_uris: ["http://remote.test/callback"] })).status, 400); });
    const instanceId = randomUUID(), pair = await (await request("/devices/pairing", { instanceId })).json();
    const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "orion:read", resource, state: "bound-state" });
    const authorization = await request(`/authorize?${params}`);
    assert.equal(authorization.status, 200);
    const cookie = authorization.headers.get("set-cookie").split(";")[0], page = await authorization.text();
    const flow = /name="flow" value="([a-f0-9]+)"/.exec(page)[1], csrf = /name="csrf" value="([a-f0-9]+)"/.exec(page)[1];
    await t.test("pairing requires the browser cookie, device proof and exact approval ID", async () => {
      assert.equal((await request("/pair-authorize", { flow, csrf, code: pair.userCode })).status, 403);
      assert.equal((await request(`/devices/pairing/${pair.pairingId}/status`, {})).status, 401);
    });
    const linked = await request("/pair-authorize", { flow, csrf, code: pair.userCode }, { Cookie: cookie }); assert.equal(linked.status, 302);
    const status = await (await request(`/devices/pairing/${pair.pairingId}/status`, {}, { Authorization: `Bearer ${pair.pairingSecret}` })).json(); assert.equal(status.state, "approval_required");
    assert.equal((await request(`/devices/pairing/${pair.pairingId}/approve`, { requestId: randomUUID(), approved: true }, { Authorization: `Bearer ${pair.pairingSecret}` })).status, 401);
    // Simulates the native consent endpoint for protocol tests. This is not a real Revit approval.
    const approved = await (await request(`/devices/pairing/${pair.pairingId}/approve`, { requestId: status.requestId, approved: true }, { Authorization: `Bearer ${pair.pairingSecret}` })).json();
    const redirect = await request(linked.headers.get("location"), undefined, { Cookie: cookie }); assert.equal(redirect.status, 302);
    const callback = new URL(redirect.headers.get("location")); assert.equal(callback.searchParams.get("state"), "bound-state");
    const auth = new Authorization(app.store, "http://127.0.0.1"), code = callback.searchParams.get("code");
    await t.test("PKCE and resource binding reject substitution", async () => {
      await assert.rejects(auth.exchangeAuthorizationCode(client, code, "wrong", client.redirect_uris[0], new URL(resource)));
      await assert.rejects(auth.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], new URL("https://different.test/mcp")));
    });
    const tokens = await auth.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], new URL(resource));
    await assert.rejects(auth.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], new URL(resource)));
    const identity = await auth.verifyAccessToken(tokens.access_token); assert.equal(identity.scopes[0], "orion:read"); assert.ok(identity.expiresAt > Date.now() / 1000);
    await t.test("device scope cannot invoke MCP; read scope cannot connect the device channel", async () => {
      assert.equal((await request("/mcp", {}, { Authorization: `Bearer ${approved.deviceToken}` })).status, 403);
      const deniedSocket = new WebSocket(`${origin.replace("http", "ws")}/device`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      await new Promise((resolve, reject) => {
        deniedSocket.once("unexpected-response", (_request, response) => { assert.equal(response.statusCode, 401); response.resume(); deniedSocket.terminate(); resolve(); });
        deniedSocket.once("open", () => { deniedSocket.terminate(); reject(new Error("Read token was accepted on the device channel.")); });
        deniedSocket.on("error", () => {});
      });
    });
    socket = new WebSocket(`${origin.replace("http", "ws")}/device`, { headers: { Authorization: `Bearer ${approved.deviceToken}` } });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", instanceId, pid: 1234 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await t.test("instance discovery and dispatch are isolated by owner", async () => {
      assert.equal(app.hub.instances(identity.extra.owner).length, 1); assert.deepEqual(app.hub.instances("another-owner"), []);
      await assert.rejects(app.hub.dispatch("another-owner", instanceId, "system.status", {}));
      await assert.rejects(app.hub.dispatch(identity.extra.owner, instanceId, "parameter.setString", {}));
    });
    await t.test("refresh replay revokes the rotated grant family", async () => {
      const rotated = await auth.exchangeRefreshToken(client, tokens.refresh_token, undefined, new URL(resource));
      await auth.verifyAccessToken(rotated.access_token);
      await assert.rejects(auth.exchangeRefreshToken(client, tokens.refresh_token));
      await assert.rejects(auth.verifyAccessToken(rotated.access_token));
    });
    await t.test("explicit revocation invalidates access", async () => {
      const grant = app.store.get("access", digest(approved.deviceToken));
      app.store.set("revoked", grant.family, true, grant.expires);
      await assert.rejects(auth.verifyAccessToken(approved.deviceToken));
    });
  } finally { socket?.terminate(); app.hub.close(); app.http.closeAllConnections(); await new Promise((resolve) => app.http.close(resolve)); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
