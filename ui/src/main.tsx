import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

interface Status { instanceId: string; pid: number; version: string; }
interface Document { documentId: string; title: string; readOnly: boolean; projectInfoId: string; }
interface Parameter { name: string; builtInParameter: number | null; storageType: string; readOnly: boolean; value: string | null; }
interface Connection { state: string; message: string; userCode: string; serverBase: string; clientState: string; clientMessage: string; clientCode: string; }
type Reply = { requestId: string; ok: boolean; result?: unknown; error?: { code: string; message: string } };
const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
declare global { interface Window { chrome?: { webview: { postMessage: (data: unknown) => void; addEventListener: (type: string, fn: (e: { data: Reply }) => void) => void } }; } }
window.chrome?.webview.addEventListener("message", ({ data }) => {
  const waiter = pending.get(data.requestId); if (!waiter) return;
  clearTimeout(waiter.timer); pending.delete(data.requestId);
  data.ok ? waiter.resolve(data.result) : waiter.reject(new Error(`${data.error?.code}: ${data.error?.message}`));
});
function call<T = unknown>(operation: string, args: Record<string, unknown> = {}, documentId?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!window.chrome?.webview) { reject(new Error("Abre ORIONMCP dentro de Revit para consultar el estado real.")); return; }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("La respuesta sigue pendiente. Comprueba el resultado antes de repetir un cambio.")); }, 65000);
    pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
    window.chrome.webview.postMessage({ v: 1, requestId, operation, args, documentId, deadlineUtc: new Date(Date.now() + 60000).toISOString() });
  });
}
function App() {
  const [status, setStatus] = useState<Status | null>(null), [docs, setDocs] = useState<Document[]>([]), [docId, setDocId] = useState("");
  const [elementId, setElementId] = useState(""), [params, setParams] = useState<Parameter[]>([]), [selected, setSelected] = useState("");
  const [value, setValue] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [activity, setActivity] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null), [serverBase, setServerBase] = useState("https://orionmpc-production.up.railway.app");
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function refresh() { await run(async () => {
    setStatus(await call<Status>("system.status"));
    const documents = await call<Document[]>("documents.list"); setDocs(documents);
    if (!documents.some((x) => x.documentId === docId)) { setDocId(documents[0]?.documentId ?? ""); setElementId(documents[0]?.projectInfoId ?? ""); setParams([]); }
  }); }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    let mounted = true;
    const timer = setInterval(() => { void call<Connection>("connection.status").then((next) => { if (mounted) setConnection(next); }).catch(() => { /* Explicit connect surfaces errors; an older host may lack this capability. */ }); }, 2500);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  return <main>
    <header><span className="brand">ORIONMCP</span><span className="tag">Revit 2024</span></header>
    <h1>Tu documento, conectado</h1><p>Consulta Revit y prepara cambios con aprobación dentro de la aplicación.</p>
    <section><h2>SHELRA — CLI recomendado</h2>
      <p>Conecta Shelra para trabajar con Revit y Dynamo mediante instrucciones en lenguaje natural.</p>
      <label>Servidor HTTP<input type="url" value={serverBase} onChange={(e) => setServerBase(e.target.value)} disabled={connection != null && connection.state !== "disconnected"} /></label>
      <button disabled={busy || (connection != null && connection.state !== "disconnected")} onClick={() => run(async () => { setConnection(await call<Connection>("connection.connect", { serverBase })); })}>Conectar servidor HTTP</button>
      <button disabled={busy || !connection || connection.state === "disconnected"} onClick={() => run(async () => { setConnection(await call<Connection>("connection.disconnect")); })}>Desconectar equipo</button>
      <p role="status">{connection?.message ?? "Conexión HTTP pendiente de comprobar."}</p>
      {connection?.state === "connected" && <div><button disabled={busy || ["pairing", "waiting_for_client", "approval_required"].includes(connection.clientState)} onClick={() => run(async () => { setConnection(await call<Connection>("connection.pair_client")); })}>Añadir otro cliente</button>
        {connection.clientMessage && <p role="status">{connection.clientMessage}</p>}
        {connection.clientCode && <div><p>Código para el nuevo cliente</p><strong className="pairing-code">{connection.clientCode}</strong><p>Claude Code, Cursor, Shelra u otro cliente: inicia sesión en ORIONMCP, introduce este código en el navegador y aprueba aquí.</p></div>}</div>}
      {connection?.userCode && <div><p>Código temporal de Revit</p><strong className="pairing-code">{connection.userCode}</strong><p>En Shelra, ejecuta <code>shelra mcp orionmcp login</code>, introduce el código en el navegador y aprueba el cliente aquí.</p></div>}
      <p className="small">Equipo conectado y tarea comprobada son estados distintos. Comienza consultando la instancia y los documentos desde Shelra. El permiso remoto inicial es de lectura.</p>
    </section>
    <section><h2>Estado real</h2><div className="status">{status ? `Revit ${status.version} · PID ${status.pid}` : "Pendiente de comprobar"}</div><button disabled={busy} onClick={refresh}>Actualizar estado</button>{status && <p className="small">Instancia: {status.instanceId}</p>}</section>
    <section><h2>Documento objetivo</h2><label>Documento<select value={docId} onChange={(e) => { setDocId(e.target.value); setElementId(docs.find((d) => d.documentId === e.target.value)?.projectInfoId ?? ""); setParams([]); }}>
      {docs.length === 0 && <option value="">Abre un documento en Revit</option>}{docs.map((d) => <option key={d.documentId} value={d.documentId}>{d.title}{d.readOnly ? " · Solo lectura" : ""}</option>)}</select></label>
      <button disabled={busy || !docId} onClick={() => run(async () => { setActivity(JSON.stringify(await call("selection.get", {}, docId), null, 2)); })}>Consultar selección</button></section>
    <section><h2>Parámetros</h2><label>ID del elemento<input value={elementId} onChange={(e) => setElementId(e.target.value)} inputMode="numeric" /></label>
      <button disabled={busy || !docId || !elementId} onClick={() => run(async () => { const result = await call<{ parameters: Parameter[] }>("parameters.read", { elementId }, docId); setParams(result.parameters); setActivity(`Leídos ${result.parameters.length} parámetros del elemento ${elementId}.`); })}>Leer parámetros</button>
      {params.length > 0 && <><label>Parámetro de texto editable<select value={selected} onChange={(e) => { setSelected(e.target.value); setValue(params.find((p) => String(p.builtInParameter) === e.target.value)?.value ?? ""); }}>
        <option value="">Selecciona un parámetro</option>{params.filter((p) => p.builtInParameter && p.storageType === "String" && !p.readOnly).map((p) => <option key={p.builtInParameter} value={p.builtInParameter!}>{p.name}</option>)}</select></label>
        <label>Nuevo valor<input value={value} onChange={(e) => setValue(e.target.value)} maxLength={4096}/></label>
        <button disabled={busy || !selected} onClick={() => run(async () => { setActivity(JSON.stringify(await call("parameter.setString", { elementId, builtInParameter: Number(selected), value }, docId), null, 2)); })}>Revisar cambio y solicitar aprobación</button>
        <details><summary>Valores consultados</summary><pre>{JSON.stringify(params, null, 2)}</pre></details></>}</section>
    <section><h2>Dynamo</h2><button disabled={busy} onClick={() => run(async () => { setActivity(JSON.stringify(await call("dynamo.environment"), null, 2)); })}>Diagnosticar Dynamo</button><p className="small">La edición y evaluación de grafos todavía no están disponibles.</p></section>
    {busy && <p role="status">Solicitud pendiente…</p>}{error && <p className="error" role="alert">{error}</p>}{activity && <section><h2>Actividad</h2><pre>{activity}</pre></section>}
    <footer>Revit 2024 · Conexión saliente HTTPS · Aprobación en el equipo</footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
