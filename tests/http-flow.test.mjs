import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApplication } from "../dist/server/http.js";

// Every step goes through the real HTTP routes (including /token) and a real MCP SDK client.
// The "device" is a WebSocket stub, not Revit: this proves the server contract, not a Revit result.
test("full HTTP flow: pairing, /token, MCP over Streamable HTTP, device refresh and a second client", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "orion-flow-"));
  const app = buildApplication({ base: "http://127.0.0.1", key: randomBytes(32).toString("hex"), database: path.join(dir, "auth.sqlite") });
  await new Promise((resolve) => app.http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.http.address().port}`, resource = "http://127.0.0.1/mcp";
  const post = (route, body, headers = {}) => fetch(origin + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });
  const sockets = [];
  try {
    const instanceId = randomUUID();
    async function authorizeClient(name, code, bearer) {
      const client = await (await post("/register", { redirect_uris: ["http://127.0.0.1:49817/cb"], token_endpoint_auth_method: "none", client_name: name })).json();
      const pair = await (await post("/devices/pairing", { instanceId }, bearer ? { Authorization: `Bearer ${bearer}` } : {})).json();
      const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
      const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "orion:read", resource, state: "s" });
      const page = await fetch(`${origin}/authorize?${query}`, { redirect: "manual" });
      const cookie = page.headers.get("set-cookie").split(";")[0], html = await page.text();
      const flow = /name="flow" value="([a-f0-9]+)"/.exec(html)[1], csrf = /name="csrf" value="([a-f0-9]+)"/.exec(html)[1];
      const linked = await post("/pair-authorize", { flow, csrf, code: pair.userCode }, { Cookie: cookie });
      assert.equal(linked.status, 302);
      const status = await (await post(`/devices/pairing/${pair.pairingId}/status`, {}, { Authorization: `Bearer ${pair.pairingSecret}` })).json();
      const approved = await (await post(`/devices/pairing/${pair.pairingId}/approve`, { requestId: status.requestId, approved: true }, { Authorization: `Bearer ${pair.pairingSecret}` })).json();
      const redirect = await fetch(origin + linked.headers.get("location"), { headers: { Cookie: cookie }, redirect: "manual" });
      const authorizationCode = new URL(redirect.headers.get("location")).searchParams.get("code");
      const token = await fetch(origin + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: authorizationCode, code_verifier: verifier, client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource }) });
      return { client, approved, token };
    }
    const first = await authorizeClient("first client");
    await t.test("the real /token endpoint issues tokens (regression: verifier was never forwarded)", async () => {
      assert.equal(first.token.status, 200);
      const body = await first.token.json(); first.tokens = body;
      assert.ok(body.access_token && body.refresh_token);
      first.refreshed = await fetch(origin + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: first.client.client_id, resource }) });
      assert.equal(first.refreshed.status, 200);
    });
    await t.test("the paired device receives a refresh credential and can renew it once", async () => {
      assert.ok(first.approved.deviceToken && first.approved.refreshToken);
      const renewed = await post("/devices/token/refresh", { refreshToken: first.approved.refreshToken });
      assert.equal(renewed.status, 200); first.device = await renewed.json(); assert.ok(first.device.deviceToken && first.device.refreshToken);
      const replay = await post("/devices/token/refresh", { refreshToken: first.approved.refreshToken });
      assert.equal(replay.status, 401);
      // Replay revokes the family, including the freshly issued credential.
      assert.equal((await post("/devices/token/refresh", { refreshToken: first.device.refreshToken })).status, 401);
    });
    await t.test("a new device credential after revocation is rejected on the device channel", async () => {
      const denied = new WebSocket(origin.replace("http", "ws") + "/device", { headers: { Authorization: `Bearer ${first.device.deviceToken}` } });
      await new Promise((resolve) => { denied.once("error", resolve); denied.once("open", () => { sockets.push(denied); resolve(); }); });
      assert.notEqual(denied.readyState, WebSocket.OPEN);
    });
    // Second device pairing (fresh credential) to exercise MCP and "additional client" with the same owner.
    const second = await authorizeClient("second client");
    const bearer = second.approved.deviceToken, secondTokens = await second.token.json();
    const socket = new WebSocket(origin.replace("http", "ws") + "/device", { headers: { Authorization: `Bearer ${bearer}` } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const revitInstanceId = randomUUID();
    socket.send(JSON.stringify({ type: "hello", deviceId: instanceId, instanceId: revitInstanceId, pid: 4242 }));
    socket.on("message", (raw) => { const m = JSON.parse(raw.toString()); socket.send(JSON.stringify({ requestId: m.requestId, ok: true, result: { stub: true, operation: m.operation } })); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.test("a real MCP SDK client lists tools and reaches the device through Streamable HTTP", async () => {
      const mcp = new Client({ name: "flow-test", version: "0" });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${secondTokens.access_token}` } } }));
      try {
        const tools = (await mcp.listTools()).tools.map((x) => x.name); assert.ok(tools.includes("revit_status") && tools.includes("orion_status"));
        const status = JSON.parse((await mcp.callTool({ name: "orion_status", arguments: {} })).content[0].text); assert.equal(status.revitInstances.length, 1); assert.equal(status.revitInstances[0].instanceId, revitInstanceId);
        await assert.rejects(app.hub.dispatch(app.store.get("access", (await import("../dist/server/authorization.js")).digest(secondTokens.access_token)).owner, instanceId, "system.status", {}));
        const reply = JSON.parse((await mcp.callTool({ name: "revit_status", arguments: { instanceId: revitInstanceId } })).content[0].text); assert.equal(reply.ok, true);
      } finally { await mcp.close(); }
      assert.equal((await fetch(origin + "/mcp", { headers: { Authorization: `Bearer ${secondTokens.access_token}`, Accept: "text/event-stream" } })).status, 405);
    });
    await t.test("an additional client minted by the device shares its owner and needs no new device credential", async () => {
      const third = await authorizeClient("third client", undefined, bearer);
      assert.equal(third.approved.deviceToken, undefined);
      const tokens = await third.token.json(); assert.equal(third.token.status, 200);
      const mcp = new Client({ name: "third", version: "0" });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
      try { const status = JSON.parse((await mcp.callTool({ name: "orion_status", arguments: {} })).content[0].text); assert.equal(status.revitInstances[0].instanceId, revitInstanceId); }
      finally { await mcp.close(); }
    });
    await t.test("a stranger cannot mint codes for someone else's device", async () => {
      assert.equal((await post("/devices/pairing", { instanceId }, { Authorization: "Bearer " + "0".repeat(64) })).status, 401);
      assert.equal((await post("/devices/pairing", { instanceId: randomUUID() }, { Authorization: `Bearer ${bearer}` })).status, 401);
    });
    await t.test("disconnect revokes the device family", async () => {
      assert.equal((await post("/devices/disconnect", {}, { Authorization: `Bearer ${bearer}` })).status, 200);
      assert.equal((await post("/devices/disconnect", {}, { Authorization: `Bearer ${bearer}` })).status, 401);
    });
  } finally { for (const s of sockets) s.terminate(); app.hub.close(); app.http.closeAllConnections(); await new Promise((resolve) => app.http.close(resolve)); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
