import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** Durable encrypted auth state. One replica / one volume until external coordination is added. */
export class Store {
  private db: DatabaseSync;
  private key: Buffer;
  constructor(file: string, keyHex: string) {
    if (!/^[a-f0-9]{64}$/.test(keyHex)) throw new Error("ORIONMCP_STORAGE_KEY must contain 32 bytes encoded as lowercase hex.");
    this.key = Buffer.from(keyHex, "hex"); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(kind,id));");
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT body,expires FROM records WHERE kind=? AND id=?").get(kind, id) as { body: string; expires: number } | undefined;
    if (!row || row.expires <= Date.now()) return undefined;
    const [nonce, tag, encrypted] = row.body.split(".");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonce!, "hex"));
    decipher.setAAD(Buffer.from(`${kind}:${id}`)); decipher.setAuthTag(Buffer.from(tag!, "hex"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted!, "hex")), decipher.final()]).toString("utf8")) as T;
  }
  set(kind: string, id: string, value: unknown, expires: number): void {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce); cipher.setAAD(Buffer.from(`${kind}:${id}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const body = [nonce, cipher.getAuthTag(), data].map((b) => b.toString("hex")).join(".");
    this.db.prepare("INSERT INTO records(kind,id,body,expires) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,expires=excluded.expires").run(kind, id, body, expires);
  }
  delete(kind: string, id: string): void { this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id); }
  expiry(kind: string, id: string): number | undefined {
    const row = this.db.prepare("SELECT expires FROM records WHERE kind=? AND id=?").get(kind, id) as { expires: number } | undefined;
    return row && row.expires > Date.now() ? row.expires : undefined;
  }
  close(): void { this.db.close(); }
  take<T>(kind: string, id: string): T | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = this.get<T>(kind, id); this.delete(kind, id); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  cleanup(): void { this.db.prepare("DELETE FROM records WHERE expires<=?").run(Date.now()); }
}
