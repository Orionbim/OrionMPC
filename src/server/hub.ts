import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import { Authorization } from "./authorization.js";
import type { HostResult } from "./bridge.js";

interface Peer { owner: string; deviceId: string; instanceId: string; pid: number; socket: WebSocket; alive: boolean; }
export class Hub {
  private server: WebSocketServer;
  private peers = new Map<string, Peer>();
  private pending = new Map<string, { peer: Peer; resolve: (r: HostResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(server: Server, auth: Authorization) {
    const ws = this.server = new WebSocketServer({ noServer: true, maxPayload: 262_144 });
    server.on("upgrade", (req, socket, head) => {
      void (async () => {
        if (new URL(req.url ?? "/", "http://internal").pathname !== "/device" || !req.headers.authorization?.startsWith("Bearer ")) throw new Error("Denied");
        const identity = await auth.verifyAccessToken(req.headers.authorization.slice(7));
        const owner = identity.extra?.owner, instanceId = identity.extra?.deviceId;
        if (!identity.scopes.includes("orion:device") || typeof owner !== "string" || typeof instanceId !== "string") throw new Error("Denied");
        ws.handleUpgrade(req, socket, head, (peerSocket) => {
          const peer: Peer = { owner, deviceId: instanceId, instanceId: "", pid: 0, socket: peerSocket, alive: true };
          const helloDeadline = setTimeout(() => { if (!peer.pid) peerSocket.close(1008, "Hello required"); }, 10_000);
          const key = `${owner}:${instanceId}`, existing = this.peers.get(key); existing?.socket.close(1000, "Connection replaced"); this.peers.set(key, peer);
          peerSocket.on("pong", () => { peer.alive = true; });
          peerSocket.on("message", (raw) => {
            try {
              const frame = JSON.parse(raw.toString());
              if (frame.type === "hello") {
                if ((frame.deviceId ?? frame.instanceId) !== peer.deviceId || typeof frame.instanceId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(frame.instanceId) || !Number.isInteger(frame.pid) || frame.pid <= 0) { peerSocket.close(1008, "Invalid instance identity"); return; }
                peer.instanceId = frame.instanceId; peer.pid = frame.pid; return;
              }
              const waiter = this.pending.get(frame.requestId);
              if (!waiter || waiter.peer !== peer || typeof frame.ok !== "boolean") return;
              clearTimeout(waiter.timer); this.pending.delete(frame.requestId); waiter.resolve(frame);
            } catch { peerSocket.close(1008, "Invalid frame"); }
          });
          peerSocket.on("error", () => { peerSocket.close(); });
          peerSocket.on("close", () => {
            clearTimeout(helloDeadline);
            if (this.peers.get(key) === peer) this.peers.delete(key);
            for (const [id, waiter] of this.pending) if (waiter.peer === peer) { clearTimeout(waiter.timer); this.pending.delete(id); waiter.reject(new Error("Device disconnected.")); }
          });
          // Token validity is checked throughout the connection, not just at upgrade.
          const heartbeat = setInterval(() => { void auth.verifyAccessToken(req.headers.authorization!.slice(7)).then(() => { if (!peer.alive) return peerSocket.terminate(); peer.alive = false; peerSocket.ping(); }).catch(() => peerSocket.close(1008, "Authorization expired")); }, 15_000);
          peerSocket.on("close", () => clearInterval(heartbeat));
        });
      })().catch(() => { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); });
    });
  }
  instances(owner: string) { return [...this.peers.values()].filter((p) => p.owner === owner && p.pid > 0).map(({ instanceId, pid }) => ({ instanceId, pid })); }
  close() { for (const client of this.server.clients) client.terminate(); this.server.close(); }
  async dispatch(owner: string, instanceId: string, operation: string, args: Record<string, unknown>, documentId?: string, suppliedId?: string): Promise<HostResult> {
    if (!["system.status", "documents.list", "selection.get", "parameters.read", "dynamo.environment"].includes(operation)) throw new Error("Remote writes are unavailable until durable approval and reconciliation are verified.");
    const peer = [...this.peers.values()].find((p) => p.owner === owner && p.instanceId === instanceId && p.pid > 0); if (!peer || peer.socket.readyState !== WebSocket.OPEN) throw new Error("Target Revit instance is disconnected.");
    if (this.pending.size >= 128) throw new Error("Remote queue is full.");
    const requestId = suppliedId ?? randomUUID();
    if (this.pending.has(requestId)) throw new Error("Request is already running; reconcile before retrying.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Device response timed out.")); }, 60_000);
      this.pending.set(requestId, { peer, resolve, reject, timer });
      peer.socket.send(JSON.stringify({ v: 1, requestId, operation, args, documentId, deadlineUtc: new Date(Date.now() + 55_000).toISOString() }));
    });
  }
}
