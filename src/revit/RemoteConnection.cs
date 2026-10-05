using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Threading;

namespace OrionMcp.Revit2024
{
    // Network threads only enqueue DTOs through ExecutionQueue. They never touch Revit API objects.
    internal sealed class RemoteConnection : IDisposable
    {
        internal const string DefaultServer = "https://orionmpc-production.up.railway.app";
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("ORIONMCP device credential v1");
        private static readonly string[] ReadOperations = { "system.status", "documents.list", "selection.get", "parameters.read", "dynamo.environment" };
        private sealed class Credentials { public string Server = "", Token = "", Refresh = ""; public DateTime ExpiresUtc; }

        private readonly ExecutionQueue queue;
        private readonly Dispatcher dispatcher;
        private readonly object gate = new object();
        private readonly string deviceId;
        private Mutex? deviceLock;
        private CancellationTokenSource? lifetime;
        private ClientWebSocket? socket;
        private Credentials? credentials;
        private volatile int attempt;
        private string state = "disconnected", message = "Conecta el servidor HTTP para comenzar.", userCode = "", serverBase = DefaultServer;
        private string clientState = "idle", clientMessage = "", clientCode = "";
        private bool clientBusy;

        internal RemoteConnection(ExecutionQueue queue, Dispatcher dispatcher)
        {
            this.queue = queue; this.dispatcher = dispatcher;
            deviceId = AcquireDeviceId(queue.InstanceId, out deviceLock);
        }

        // One stable id per machine so the saved credential survives Revit restarts. A second Revit process keeps its own transient id.
        private static string AcquireDeviceId(string fallback, out Mutex? handle)
        {
            handle = null;
            try
            {
                Directory.CreateDirectory(ExecutionQueue.LocalRoot);
                var file = Path.Combine(ExecutionQueue.LocalRoot, "device-id");
                var id = File.Exists(file) ? File.ReadAllText(file).Trim() : "";
                if (!Guid.TryParse(id, out _)) { id = Guid.NewGuid().ToString(); File.WriteAllText(file, id, new UTF8Encoding(false)); }
                id = Guid.Parse(id).ToString();
                var mutex = new Mutex(false, "Local\\ORIONMCP-device-" + id); bool owned;
                try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
                if (owned) { handle = mutex; return id; }
                mutex.Dispose();
            }
            catch (Exception) { }
            return fallback;
        }

        private string CredentialFile => Path.Combine(ExecutionQueue.LocalRoot, "connections", deviceId + ".bin");

        internal object Snapshot()
        {
            lock (gate) return new { state, message, userCode, serverBase, instanceId = deviceId, clientState, clientMessage, clientCode };
        }
        private void Set(string next, string description, string code = "") { lock (gate) { state = next; message = description; userCode = code; } }
        private void SetClient(string next, string description, string code = "") { lock (gate) { clientState = next; clientMessage = description; clientCode = code; } }

        private static string ValidateServer(string address)
        {
            if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "" || uri.AbsolutePath != "/" || (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)))
                throw new ApiFault("INVALID_SERVER", "Utiliza el origen HTTPS del servidor, sin /mcp ni credenciales.");
            return uri.GetLeftPart(UriPartial.Authority);
        }

        private void Persist(Credentials value)
        {
            Directory.CreateDirectory(Path.Combine(ExecutionQueue.LocalRoot, "connections"));
            var json = ExecutionQueue.Json(new Dictionary<string, object> { ["server"] = value.Server, ["token"] = value.Token, ["refresh"] = value.Refresh, ["expires"] = value.ExpiresUtc.ToString("O") });
            // DPAPI binds the receipt to this Windows user; no token ever reaches the WebView.
            var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(json), Entropy, DataProtectionScope.CurrentUser);
            var temporary = CredentialFile + ".tmp"; File.WriteAllBytes(temporary, bytes);
            if (File.Exists(CredentialFile)) File.Delete(CredentialFile);
            File.Move(temporary, CredentialFile);
        }
        private Credentials? Load()
        {
            try
            {
                if (!File.Exists(CredentialFile)) return null;
                var json = Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(CredentialFile), Entropy, DataProtectionScope.CurrentUser));
                var data = new JavaScriptSerializer { MaxJsonLength = 16384 }.Deserialize<Dictionary<string, object>>(json);
                var value = new Credentials { Server = ValidateServer((string)data["server"]), Token = (string)data["token"], Refresh = (string)data["refresh"], ExpiresUtc = DateTime.Parse((string)data["expires"], null, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime() };
                return value.Token.Length > 0 && value.Refresh.Length > 0 ? value : null;
            }
            catch (Exception) { return null; }
        }
        private void Forget() { try { if (File.Exists(CredentialFile)) File.Delete(CredentialFile); } catch (IOException) { } }

        // Called once at startup: a device approved earlier reconnects without any human step.
        internal void TryResume()
        {
            var saved = Load(); if (saved == null) return;
            lock (gate)
            {
                if (lifetime != null) return;
                serverBase = saved.Server; credentials = saved; lifetime = new CancellationTokenSource();
                Set("reconnecting", "Reanudando la conexión autorizada…");
                _ = RunGuarded(saved, lifetime.Token);
            }
        }

        internal object Start(string address)
        {
            var origin = ValidateServer(address);
            lock (gate)
            {
                if (lifetime != null) throw new ApiFault("CONNECTION_RUNNING", "Desconecta la sesión anterior antes de iniciar otra.");
                serverBase = origin; lifetime = new CancellationTokenSource();
                Set("pairing", "Solicitando código temporal…");
                _ = PairAndConnect(origin, lifetime.Token);
                return Snapshot();
            }
        }

        internal object PairClient()
        {
            CancellationToken cancel; Credentials current;
            lock (gate)
            {
                if (state != "connected" || credentials == null || lifetime == null) throw new ApiFault("NOT_CONNECTED", "Conecta el equipo antes de añadir otro cliente.");
                if (clientBusy) throw new ApiFault("CLIENT_PAIRING_RUNNING", "Ya hay un código para otro cliente. Introdúcelo o espera cinco minutos.");
                clientBusy = true; cancel = lifetime.Token; current = credentials; SetClient("pairing", "Solicitando código…");
            }
            _ = Task.Run(async () =>
            {
                try
                {
                    using (var client = NewClient(current.Server))
                    {
                        var result = await Pair(client, current.Server, current.Token, (s, m, c) => SetClient(s, m, c), cancel).ConfigureAwait(false);
                        if (result != null) SetClient("approved", "Cliente autorizado. Ya puede consultar este Revit.");
                    }
                }
                catch (OperationCanceledException) { SetClient("idle", ""); }
                catch (Exception ex) { SetClient("failed", ex is ApiFault fault ? fault.Message : "No se pudo generar el código. Inténtalo de nuevo."); }
                finally { lock (gate) clientBusy = false; }
            });
            return Snapshot();
        }

        // Explicit user action: stop, forget the credential and revoke it on the server (best effort).
        internal object Disconnect()
        {
            Credentials? previous;
            lock (gate) { previous = credentials; credentials = null; }
            Stop(); Forget();
            if (previous != null) _ = Task.Run(async () => { try { using (var client = NewClient(previous.Server)) await Post(client, "/devices/disconnect", new { }, CancellationToken.None, previous.Token).ConfigureAwait(false); } catch (Exception) { } });
            Set("disconnected", "Conexión del equipo cerrada y credencial revocada."); SetClient("idle", "");
            return Snapshot();
        }
        private void Stop() { lock (gate) { lifetime?.Cancel(); socket?.Abort(); lifetime?.Dispose(); lifetime = null; clientBusy = false; } }

        private static HttpClient NewClient(string address) => new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = new Uri(address), Timeout = TimeSpan.FromSeconds(15) };

        private async Task<Dictionary<string, object>> Post(HttpClient client, string route, object body, CancellationToken cancel, string? bearer = null)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Post, route))
            {
                request.Content = new StringContent(ExecutionQueue.Json(body), Encoding.UTF8, "application/json");
                if (bearer != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
                using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false))
                {
                    if (response.StatusCode == HttpStatusCode.Unauthorized) throw new ApiFault("CREDENTIAL_REJECTED", "El servidor ya no acepta esta autorización. Conecta de nuevo.");
                    if (!response.IsSuccessStatusCode) throw new ApiFault("SERVER_REJECTED", "El servidor rechazó la conexión (HTTP " + (int)response.StatusCode + "). Genera otro código o revisa la dirección.");
                    using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var memory = new MemoryStream())
                    {
                        var buffer = new byte[4096]; int count;
                        while ((count = await stream.ReadAsync(buffer, 0, buffer.Length, cancel).ConfigureAwait(false)) > 0) { if (memory.Length + count > 65536) throw new ApiFault("MESSAGE_TOO_LARGE", "Respuesta de conexión demasiado grande."); memory.Write(buffer, 0, count); }
                        return new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 16 }.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(memory.ToArray()));
                    }
                }
            }
        }
        private static string Text(Dictionary<string, object> data, string key) => data.TryGetValue(key, out var value) && value is string text ? text : throw new ApiFault("INVALID_RESPONSE", "Respuesta de conexión no válida.");

        // Shared by the first pairing and by "add another client": code -> client approval -> native confirmation in Revit.
        private async Task<Dictionary<string, object>?> Pair(HttpClient client, string address, string? deviceBearer, Action<string, string, string> report, CancellationToken cancel)
        {
            var pair = await Post(client, "/devices/pairing", new { instanceId = deviceId }, cancel, deviceBearer).ConfigureAwait(false);
            var id = Text(pair, "pairingId"); if (!Guid.TryParse(id, out _)) throw new ApiFault("INVALID_RESPONSE", "ID de emparejamiento no válido.");
            var proof = Text(pair, "pairingSecret"); var code = Text(pair, "userCode");
            report("waiting_for_client", "En Shelra, conecta ORIONMCP e introduce este código en el navegador. Caduca en cinco minutos.", code);
            var expires = DateTime.UtcNow.AddMinutes(5);
            while (!cancel.IsCancellationRequested && DateTime.UtcNow < expires)
            {
                await Task.Delay(2000, cancel).ConfigureAwait(false);
                var status = await Post(client, "/devices/pairing/" + id + "/status", new { }, cancel, proof).ConfigureAwait(false);
                if (Text(status, "state") != "approval_required") continue;
                var requestId = Text(status, "requestId"); var name = Text(status, "clientName");
                report("approval_required", "Revisa y aprueba el cliente dentro de Revit.", code);
                var approved = await dispatcher.InvokeAsync(() => MessageBox.Show("Cliente: " + name.Substring(0, Math.Min(120, name.Length)) + "\nServidor: " + address + "\nEquipo: " + deviceId + "\nSolicitud: " + requestId + "\n\nPermiso: consultar versión, documentos, selección, parámetros y diagnóstico Dynamo.\n\n¿Autorizar esta conexión?", "ORIONMCP — Aprobar cliente", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No, MessageBoxOptions.DefaultDesktopOnly));
                var result = await Post(client, "/devices/pairing/" + id + "/approve", new { requestId, approved = approved == MessageBoxResult.Yes }, cancel, proof).ConfigureAwait(false);
                if (approved != MessageBoxResult.Yes) { report("denied", "Conexión rechazada. No se concedieron permisos.", ""); return null; }
                return result;
            }
            report("expired", "El código caducó. Solicita otro.", "");
            return null;
        }

        private async Task PairAndConnect(string address, CancellationToken cancel)
        {
            try
            {
                Dictionary<string, object>? result;
                using (var client = NewClient(address)) result = await Pair(client, address, null, (s, m, c) => Set(s, m, c), cancel).ConfigureAwait(false);
                if (result == null) { lock (gate) { lifetime?.Dispose(); lifetime = null; } return; }
                var saved = new Credentials { Server = address, Token = Text(result, "deviceToken"), Refresh = Text(result, "refreshToken"), ExpiresUtc = DateTime.UtcNow.AddSeconds(Convert.ToInt32(result["expiresIn"])) };
                Persist(saved); lock (gate) credentials = saved;
                await RunGuarded(saved, cancel).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { Set("disconnected", "Conexión detenida."); }
            catch (Exception ex) { Set("failed", ex is ApiFault fault ? fault.Message : "No se pudo conectar. Comprueba Internet y la dirección del servidor; después solicita otro código."); lock (gate) { lifetime?.Dispose(); lifetime = null; } }
        }

        private async Task RunGuarded(Credentials initial, CancellationToken cancel)
        {
            try { await Run(initial, cancel).ConfigureAwait(false); }
            catch (OperationCanceledException) { Set("disconnected", "Conexión detenida."); }
        }

        // Keeps the device channel alive: renews the short-lived credential before it expires and reconnects with backoff.
        private async Task Run(Credentials current, CancellationToken cancel)
        {
            attempt = 0;
            while (!cancel.IsCancellationRequested)
            {
                try
                {
                    if (current.ExpiresUtc - DateTime.UtcNow < TimeSpan.FromMinutes(5) || attempt >= 3) current = await Refresh(current, cancel).ConfigureAwait(false);
                    await Session(current, cancel).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { throw; }
                catch (ApiFault fault) when (fault.Code == "CREDENTIAL_REJECTED")
                {
                    Forget(); lock (gate) { credentials = null; lifetime?.Dispose(); lifetime = null; }
                    Set("expired", "La autorización del equipo ya no es válida. Conecta de nuevo y repite el código."); return;
                }
                catch (Exception)
                {
                    Set("reconnecting", "Conexión interrumpida. Reconectando sin repetir operaciones…");
                    await Task.Delay(Math.Min(30000, 1000 * (1 << Math.Min(++attempt, 5))), cancel).ConfigureAwait(false);
                }
            }
        }

        private async Task<Credentials> Refresh(Credentials current, CancellationToken cancel)
        {
            using (var client = NewClient(current.Server))
            {
                var result = await Post(client, "/devices/token/refresh", new { refreshToken = current.Refresh }, cancel).ConfigureAwait(false);
                var next = new Credentials { Server = current.Server, Token = Text(result, "deviceToken"), Refresh = Text(result, "refreshToken"), ExpiresUtc = DateTime.UtcNow.AddSeconds(Convert.ToInt32(result["expiresIn"])) };
                Persist(next); lock (gate) credentials = next; // Persist first: a rotated refresh token cannot be replayed.
                return next;
            }
        }

        private async Task Session(Credentials c, CancellationToken cancel)
        {
            var remaining = c.ExpiresUtc - DateTime.UtcNow - TimeSpan.FromMinutes(4);
            if (remaining < TimeSpan.FromSeconds(10)) remaining = TimeSpan.FromSeconds(10);
            using (var rotate = CancellationTokenSource.CreateLinkedTokenSource(cancel))
            using (var ws = new ClientWebSocket())
            {
                rotate.CancelAfter(remaining);
                lock (gate) socket = ws;
                ws.Options.SetRequestHeader("Authorization", "Bearer " + c.Token); ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                var endpoint = new UriBuilder(c.Server) { Scheme = new Uri(c.Server).Scheme == "https" ? "wss" : "ws", Path = "/device" };
                try
                {
                    await ws.ConnectAsync(endpoint.Uri, rotate.Token).ConfigureAwait(false);
                    await Send(ws, new { type = "hello", instanceId = deviceId, pid = Process.GetCurrentProcess().Id }, rotate.Token).ConfigureAwait(false);
                    attempt = 0; Set("connected", "Equipo conectado por HTTPS. Los clientes autorizados ya pueden consultar este Revit.");
                    var buffer = new byte[8192];
                    while (ws.State == WebSocketState.Open && !rotate.IsCancellationRequested)
                    {
                        using (var frame = new MemoryStream())
                        {
                            WebSocketReceiveResult received;
                            do
                            {
                                received = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), rotate.Token).ConfigureAwait(false);
                                if (received.MessageType == WebSocketMessageType.Close) throw new IOException("Remote closed.");
                                if (received.MessageType != WebSocketMessageType.Text || frame.Length + received.Count > 65536) throw new IOException("Invalid frame.");
                                frame.Write(buffer, 0, received.Count);
                            } while (!received.EndOfMessage);
                            Request request = new Request(); object response;
                            try
                            {
                                request = ExecutionQueue.Parse(new UTF8Encoding(false, true).GetString(frame.ToArray()));
                                if (Array.IndexOf(ReadOperations, request.operation) < 0) throw new ApiFault("PERMISSION_DENIED", "El equipo solo autoriza lecturas en esta conexión.");
                                request.identityToken = queue.Token; response = await queue.Submit(request).ConfigureAwait(false);
                            }
                            catch (Exception ex) { response = ExecutionQueue.Failure(request, ex is ApiFault fault ? fault.Code : "REQUEST_FAILED", ex is ApiFault ? ex.Message : "Solicitud no válida."); }
                            await Send(ws, response, cancel).ConfigureAwait(false);
                        }
                    }
                }
                catch (OperationCanceledException) when (!cancel.IsCancellationRequested) { /* Scheduled rotation: renew the credential and reconnect. */ }
            }
        }
        private static Task Send(ClientWebSocket ws, object value, CancellationToken cancel) => ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(ExecutionQueue.Json(value))), WebSocketMessageType.Text, true, cancel);

        public void Dispose()
        {
            Stop();
            try { deviceLock?.ReleaseMutex(); } catch (Exception) { }
            deviceLock?.Dispose(); deviceLock = null;
        }
    }
}
