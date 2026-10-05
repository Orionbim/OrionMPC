using System;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using Autodesk.Revit.UI;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace OrionMcp.Revit2024
{
    internal sealed class WebPanel : Grid, IDockablePaneProvider
    {
        private const string Origin = "https://app.orionmcp.local";
        private readonly ExecutionQueue queue;
        private readonly RemoteConnection remote;
        private bool initialized;
        internal WebPanel(ExecutionQueue queue, RemoteConnection remote) { this.queue = queue; this.remote = remote; Loaded += Initialize; }
        private async void Initialize(object sender, RoutedEventArgs args)
        {
            if (initialized) return; initialized = true;
            try
            {
                var assets = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "ui");
                if (!File.Exists(Path.Combine(assets, "index.html"))) throw new IOException("Faltan los assets Vite empaquetados.");
                var web = new WebView2(); Children.Add(web);
                var profile = Path.Combine(ExecutionQueue.LocalRoot, "WebView2", queue.InstanceId);
                var environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await web.EnsureCoreWebView2Async(environment);
                web.CoreWebView2.SetVirtualHostNameToFolderMapping("app.orionmcp.local", assets, CoreWebView2HostResourceAccessKind.DenyCors);
                web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                web.CoreWebView2.NavigationStarting += (_, e) => { if (!SameOrigin(e.Uri)) e.Cancel = true; };
                web.CoreWebView2.NewWindowRequested += (_, e) => { e.Handled = true; };
                web.CoreWebView2.WebMessageReceived += async (_, e) =>
                {
                    if (!SameOrigin(e.Source)) return;
                    Request request = new Request();
                    try
                    {
                        request = ExecutionQueue.Parse(e.WebMessageAsJson);
                        object result;
                        if (request.operation.StartsWith("connection.", StringComparison.Ordinal))
                        {
                            if (request.v != 1 || !Guid.TryParse(request.requestId, out var requestGuid) || request.documentId != null || !DateTime.TryParse(request.deadlineUtc, out var deadline) || deadline.ToUniversalTime() <= DateTime.UtcNow || deadline.ToUniversalTime() > DateTime.UtcNow.AddMinutes(2)) throw new ApiFault("INVALID_REQUEST", "Solicitud de conexión no válida.");
                            object connection;
                            if (request.operation == "connection.connect" && request.args.Count == 1 && request.args.TryGetValue("serverBase", out var address) && address is string text) connection = remote.Start(text);
                            else if (request.operation == "connection.status" && request.args.Count == 0) connection = remote.Snapshot();
                            else if (request.operation == "connection.disconnect" && request.args.Count == 0) connection = remote.Disconnect();
                            else throw new ApiFault("INVALID_ARGUMENTS", "Acción de conexión no permitida.");
                            result = new { requestId = request.requestId, ok = true, result = connection };
                        }
                        else result = await queue.Submit(request, nativeUi: true);
                        web.CoreWebView2.PostWebMessageAsJson(ExecutionQueue.Json(result));
                    }
                    catch (Exception ex) { web.CoreWebView2.PostWebMessageAsJson(ExecutionQueue.Json(ExecutionQueue.Failure(request, ex is ApiFault fault ? fault.Code : "UI_BRIDGE_ERROR", ex.Message))); }
                };
                web.Source = new Uri(Origin + "/index.html");
            }
            catch (Exception ex) { Children.Clear(); Children.Add(new TextBlock { Text = "ORIONMCP no pudo abrir la interfaz. " + ex.Message, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(20) }); }
        }
        private static bool SameOrigin(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.GetLeftPart(UriPartial.Authority) == Origin;
        public void SetupDockablePane(DockablePaneProviderData data)
        { data.FrameworkElement = this; data.InitialState = new DockablePaneState { DockPosition = DockPosition.Right }; }
    }
}
