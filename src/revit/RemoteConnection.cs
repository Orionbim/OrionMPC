using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
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
    // Network threads only enqueue DTOs. They never access Revit API objects.
    internal sealed class RemoteConnection : IDisposable
    {
        internal const string DefaultServer = "https://orionmpc-production.up.railway.app";
        private readonly ExecutionQueue queue;
        private readonly Dispatcher dispatcher;
        private readonly object gate = new object();
        private CancellationTokenSource? lifetime;
        private ClientWebSocket? socket;
        private string state = "disconnected", message = "Conecta el servidor HTTP para comenzar.", userCode = "", serverBase = DefaultServer;
        internal RemoteConnection(ExecutionQueue queue, Dispatcher dispatcher) { this.queue = queue; this.dispatcher = dispatcher; }
        internal object Snapshot() { lock (gate) return new { state, message, userCode, serverBase, instanceId = queue.InstanceId }; }
        private void Set(string next, string description, string code = "") { lock (gate) { state = next; message = description; userCode = code; } }
        internal object Start(string address)
        {
            if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "" || uri.AbsolutePath != "/" || (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback))) throw new ApiFault("INVALID_SERVER", "Utiliza el origen HTTPS del servidor, sin /mcp ni credenciales.");
            lock (gate)
            {
                if (lifetime != null) throw new ApiFault("CONNECTION_RUNNING", "Desconecta la sesión anterior antes de iniciar otra.");
                serverBase = uri.GetLeftPart(UriPartial.Authority); lifetime = new CancellationTokenSource();
                Set("pairing", "Solicitando código temporal…");
                _ = PairAndConnect(serverBase, lifetime.Token);
                return Snapshot();
            }
        }
        internal object Disconnect() { lock (gate) { lifetime?.Cancel(); socket?.Abort(); lifetime?.Dispose(); lifetime = null; Set("disconnected", "Conexión del equipo cerrada. Las credenciales del cliente se revocan desde su sesión."); return Snapshot(); } }
        private async Task<Dictionary<string, object>> Post(HttpClient client, string route, object body, CancellationToken cancel, string? proof = null)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Post, route))
            {
                request.Content = new StringContent(ExecutionQueue.Json(body), Encoding.UTF8, "application/json");
                if (proof != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", proof);
                using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false))
                {
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
        private async Task PairAndConnect(string address, CancellationToken cancel)
        {
            try
            {
                using (var handler = new HttpClientHandler { AllowAutoRedirect = false })
                using (var client = new HttpClient(handler) { BaseAddress = new Uri(address), Timeout = TimeSpan.FromSeconds(15) })
                {
                    var pair = await Post(client, "/devices/pairing", new { instanceId = queue.InstanceId }, cancel).ConfigureAwait(false);
                    var id = Text(pair, "pairingId"); if (!Guid.TryParse(id, out _)) throw new ApiFault("INVALID_RESPONSE", "ID de emparejamiento no válido.");
                    var proof = Text(pair, "pairingSecret"); var code = Text(pair, "userCode");
                    Set("waiting_for_client", "En Shelra, conecta ORIONMCP e introduce este código en el navegador. Caduca en cinco minutos.", code);
                    var expires = DateTime.UtcNow.AddMinutes(5);
                    while (!cancel.IsCancellationRequested && DateTime.UtcNow < expires)
                    {
                        await Task.Delay(2000, cancel).ConfigureAwait(false);
                        var status = await Post(client, "/devices/pairing/" + id + "/status", new { }, cancel, proof).ConfigureAwait(false);
                        if (Text(status, "state") != "approval_required") continue;
                        var requestId = Text(status, "requestId"); var name = Text(status, "clientName");
                        Set("approval_required", "Revisa y aprueba el cliente dentro de Revit.", code);
                        var approved = await dispatcher.InvokeAsync(() => MessageBox.Show("Cliente: " + name.Substring(0, Math.Min(120, name.Length)) + "\nServidor: " + address + "\nInstancia: " + queue.InstanceId + "\nSolicitud: " + requestId + "\n\nPermiso: consultar versión, documentos, selección, parámetros y diagnóstico Dynamo.\n\n¿Autorizar esta conexión?", "ORIONMCP — Aprobar cliente", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No));
                        var result = await Post(client, "/devices/pairing/" + id + "/approve", new { requestId, approved = approved == MessageBoxResult.Yes }, cancel, proof).ConfigureAwait(false);
                        if (approved != MessageBoxResult.Yes) { Set("denied", "Conexión rechazada. No se concedieron permisos."); return; }
                        var token = Text(result, "deviceToken");
                        // DPAPI binds this receipt to the current Windows user; no token reaches WebView.
                        var directory = Path.Combine(ExecutionQueue.LocalRoot, "connections"); Directory.CreateDirectory(directory);
                        File.WriteAllBytes(Path.Combine(directory, queue.InstanceId + ".bin"), ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(address), DataProtectionScope.CurrentUser));
                        await ConnectLoop(address, token, DateTime.UtcNow.AddSeconds(Convert.ToInt32(result["expiresIn"])), cancel).ConfigureAwait(false);
                        return;
                    }
                    Set("expired", "El código caducó. Desconecta y solicita otro.");
                }
            }
            catch (OperationCanceledException) { Set("disconnected", "Conexión detenida."); }
            catch (Exception ex) { Set("failed", ex is ApiFault fault ? fault.Message : "No se pudo conectar. Comprueba Internet y la dirección del servidor; después solicita otro código."); }
        }
        private async Task ConnectLoop(string address, string token, DateTime expires, CancellationToken cancel)
        {
            int attempt = 0;
            while (!cancel.IsCancellationRequested && DateTime.UtcNow < expires)
            {
                try
                {
                    using (var ws = new ClientWebSocket())
                    {
                        socket = ws; ws.Options.SetRequestHeader("Authorization", "Bearer " + token); ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                        var endpoint = new UriBuilder(address) { Scheme = new Uri(address).Scheme == "https" ? "wss" : "ws", Path = "/device" };
                        await ws.ConnectAsync(endpoint.Uri, cancel).ConfigureAwait(false);
                        await Send(ws, new { type = "hello", instanceId = queue.InstanceId, pid = Process.GetCurrentProcess().Id }, cancel).ConfigureAwait(false);
                        Set("connected", "Equipo conectado por HTTPS. Comprueba la conexión con una consulta desde Shelra."); attempt = 0;
                        var buffer = new byte[8192];
                        while (ws.State == WebSocketState.Open && !cancel.IsCancellationRequested)
                        {
                            using (var frame = new MemoryStream())
                            {
                                WebSocketReceiveResult received;
                                do { received = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), cancel).ConfigureAwait(false); if (received.MessageType == WebSocketMessageType.Close) throw new IOException("Remote closed."); if (received.MessageType != WebSocketMessageType.Text || frame.Length + received.Count > 65536) throw new IOException("Invalid frame."); frame.Write(buffer, 0, received.Count); } while (!received.EndOfMessage);
                                Request request = new Request(); object response;
                                try
                                {
                                    request = ExecutionQueue.Parse(new UTF8Encoding(false, true).GetString(frame.ToArray()));
                                    var allowed = new[] { "system.status", "documents.list", "selection.get", "parameters.read", "dynamo.environment" };
                                    if (Array.IndexOf(allowed, request.operation) < 0) throw new ApiFault("PERMISSION_DENIED", "El equipo solo autoriza lecturas en esta conexión.");
                                    request.identityToken = queue.Token; response = await queue.Submit(request).ConfigureAwait(false);
                                }
                                catch (Exception ex) { response = ExecutionQueue.Failure(request, ex is ApiFault fault ? fault.Code : "REQUEST_FAILED", ex is ApiFault ? ex.Message : "Solicitud no válida."); }
                                await Send(ws, response, cancel).ConfigureAwait(false);
                            }
                        }
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception) { Set("reconnecting", "Conexión interrumpida. Reconectando sin repetir operaciones…"); await Task.Delay(Math.Min(30000, 1000 * (1 << Math.Min(++attempt, 5))), cancel).ConfigureAwait(false); }
            }
            Set("expired", "La autorización del equipo caducó. Conecta de nuevo.");
        }
        private static Task Send(ClientWebSocket ws, object value, CancellationToken cancel) => ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(ExecutionQueue.Json(value))), WebSocketMessageType.Text, true, cancel);
        public void Dispose() { Disconnect(); }
    }
}
