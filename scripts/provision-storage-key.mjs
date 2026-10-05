import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const directory = new URL("../.local/secrets/", import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = new URL("storage-key", directory);
if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
const key = readFileSync(file, "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key file.");
try {
  const cli = process.env.RAILWAY_CLI ?? (process.platform === "win32" ? path.join(process.env.APPDATA, "npm", "node_modules", "@railway", "cli", "bin", "railway.exe") : "railway");
  execFileSync(cli, ["variable", "set", "ORIONMCP_STORAGE_KEY", "--stdin", "--skip-deploys"], { input: key, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  process.stdout.write("Encryption key configured. Its value was not printed.\n");
} catch { process.stderr.write("Could not configure the encryption key. Check Railway authentication and the linked service.\n"); process.exitCode = 1; }
