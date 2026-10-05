using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace OrionMcp.Revit2024
{
    internal sealed class LocalPipe : IDisposable
    {
        private readonly ExecutionQueue queue;
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private readonly string pipeName = "orionmcp.revit2024." + Process.GetCurrentProcess().Id;
        private string? registration;
        private NamedPipeServerStream? listener;
        internal LocalPipe(ExecutionQueue queue) { this.queue = queue; }
        internal void Start()
        {
            var directory = Path.Combine(ExecutionQueue.LocalRoot, "instances"); Directory.CreateDirectory(directory);
            registration = Path.Combine(directory, Process.GetCurrentProcess().Id + ".json");
            File.WriteAllText(registration, ExecutionQueue.Json(new { v = 1, instanceId = queue.InstanceId, pid = Process.GetCurrentProcess().Id, pipeName, token = queue.Token }), new UTF8Encoding(false));
            _ = Task.Run(Listen);
        }
        private async Task Listen()
        {
            try
            {
                while (!cancellation.IsCancellationRequested)
                {
                    var security = new PipeSecurity();
                    security.SetAccessRuleProtection(true, false);
                    security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User!, PipeAccessRights.FullControl, AccessControlType.Allow));
                    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
                    var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 16, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security);
                    listener = pipe;
                    await pipe.WaitForConnectionAsync(cancellation.Token).ConfigureAwait(false);
                    _ = Handle(pipe);
                }
            }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) when (cancellation.IsCancellationRequested) { }
            catch (Exception ex) { File.AppendAllText(Path.Combine(ExecutionQueue.LocalRoot, "host-errors.log"), DateTime.UtcNow.ToString("O") + " IPC listener: " + ex.Message + "\n"); }
        }
        private async Task Handle(NamedPipeServerStream pipe)
        {
            using (pipe)
            {
                Request request = new Request();
                try
                {
                    var bytes = new byte[65537]; int size = 0, end = -1;
                    while (end < 0 && size < bytes.Length)
                    {
                        var read = await pipe.ReadAsync(bytes, size, bytes.Length - size, cancellation.Token).ConfigureAwait(false);
                        if (read == 0) return; size += read; end = Array.IndexOf(bytes, (byte)'\n', 0, size);
                    }
                    if (end < 0 || end > 65536) throw new ApiFault("MESSAGE_TOO_LARGE", "Solicitud demasiado grande.");
                    request = ExecutionQueue.Parse(Encoding.UTF8.GetString(bytes, 0, end));
                    var result = await queue.Submit(request).ConfigureAwait(false);
                    var reply = Encoding.UTF8.GetBytes(ExecutionQueue.Json(result) + "\n");
                    await pipe.WriteAsync(reply, 0, reply.Length, cancellation.Token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    try { var reply = Encoding.UTF8.GetBytes(ExecutionQueue.Json(ExecutionQueue.Failure(request, ex is ApiFault fault ? fault.Code : "IPC_ERROR", ex.Message)) + "\n"); await pipe.WriteAsync(reply, 0, reply.Length).ConfigureAwait(false); }
                    catch (IOException) { /* Peer disconnected; do not repeat the operation. */ }
                }
            }
        }
        public void Dispose() { cancellation.Cancel(); listener?.Dispose(); if (registration != null && File.Exists(registration)) File.Delete(registration); }
    }
}
