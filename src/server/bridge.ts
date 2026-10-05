import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { z } from "zod";

const instanceSchema = z.object({ v: z.literal(1), instanceId: z.uuid(), pid: z.number().int().positive(), pipeName: z.string().regex(/^orionmcp\.revit2024\.[0-9]+$/), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type Instance = z.infer<typeof instanceSchema>;
export interface HostResult { requestId: string; ok: boolean; result?: unknown; error?: { code: string; message: string }; }

export async function instances(): Promise<Instance[]> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return [];
  const directory = path.join(process.env.LOCALAPPDATA, "ORIONMCP", "instances");
  let files: string[];
  try { files = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: Instance[] = [];
  for (const file of files.filter((file) => /^[0-9]+\.json$/.test(file)).slice(0, 32)) {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(path.join(directory, file), "utf8")); }
    catch { console.error("ORIONMCP ignored an unreadable local instance registration."); continue; }
    const parsed = instanceSchema.safeParse(raw);
    if (!parsed.success || parsed.data.pipeName !== `orionmcp.revit2024.${parsed.data.pid}` || file !== `${parsed.data.pid}.json`) continue;
    try { process.kill(parsed.data.pid, 0); } catch { continue; }
    found.push(parsed.data);
  }
  return found;
}

export async function callHost(instanceId: string, operation: string, args: Record<string, unknown>, documentId?: string, suppliedRequestId?: string): Promise<HostResult> {
  const target = (await instances()).find((instance) => instance.instanceId === instanceId);
  if (!target) throw new Error("Revit instance is unavailable. Refresh instances before continuing.");
  const requestId = suppliedRequestId ?? randomUUID();
  const payload = JSON.stringify({ v: 1, requestId, operation, documentId, args, deadlineUtc: new Date(Date.now() + 60_000).toISOString(), identityToken: target.token });
  if (Buffer.byteLength(payload) > 65_536) throw new Error("Request exceeds the local message limit.");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\${target.pipeName}`);
    socket.setEncoding("utf8");
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Result uncertain for request ${requestId}; do not repeat a write automatically.`)); }, 65_000);
    socket.on("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response) > 262_144) { socket.destroy(new Error("Host result exceeded the message limit.")); return; }
      const end = response.indexOf("\n");
      if (end < 0) return;
      try {
        const result: HostResult = JSON.parse(response.slice(0, end));
        if (result.requestId !== requestId || typeof result.ok !== "boolean") throw new Error("Invalid host response.");
        resolve(result); socket.end();
      } catch (error) { reject(error); socket.destroy(); }
    });
    socket.on("error", reject);
    socket.on("close", () => { clearTimeout(timer); reject(new Error("Host disconnected; reconcile any previous write before retrying.")); });
  });
}
