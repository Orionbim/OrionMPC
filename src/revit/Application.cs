using System;
using System.IO;
using System.Reflection;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace OrionMcp.Revit2024
{
    public sealed class Application : IExternalApplication
    {
        internal static readonly DockablePaneId PaneId = new DockablePaneId(new Guid("A51D947E-6DC8-4927-9C79-F9B1C8513309"));
        internal static ExecutionQueue? Queue;
        private LocalPipe? pipe;
        private RemoteConnection? remote;
        public Result OnStartup(UIControlledApplication app)
        {
            try
            {
                AppDomain.CurrentDomain.AssemblyResolve += ResolveDynamo;
                Queue = new ExecutionQueue();
                Queue.Attach(ExternalEvent.Create(Queue));
                remote = new RemoteConnection(Queue, System.Windows.Threading.Dispatcher.CurrentDispatcher);
                app.RegisterDockablePane(PaneId, "ORIONMCP", new WebPanel(Queue, remote));
                try { app.CreateRibbonTab("ORIONMCP"); } catch (Autodesk.Revit.Exceptions.ArgumentException) { }
                var panel = app.CreateRibbonPanel("ORIONMCP", "Conexión");
                var assembly = Assembly.GetExecutingAssembly().Location;
                panel.AddItem(new PushButtonData("orionmcp.open", "ORIONMCP", assembly, typeof(OpenPanelCommand).FullName));
                panel.AddItem(new PushButtonData("orionmcp.dynamo", "Abrir Dynamo", assembly, typeof(OpenDynamoCommand).FullName));
                pipe = new LocalPipe(Queue);
                pipe.Start();
                if (Environment.GetEnvironmentVariable("ORIONMCP_OPEN_PANEL") == "1") app.Idling += BootstrapPanel;
                return Result.Succeeded;
            }
            catch (Exception ex) { TaskDialog.Show("ORIONMCP", "No se pudo cargar ORIONMCP: " + ex.Message); return Result.Failed; }
        }
        private void BootstrapPanel(object sender, Autodesk.Revit.UI.Events.IdlingEventArgs args)
        {
            var ui = (UIApplication)sender;
            ui.Idling -= BootstrapPanel;
            ui.GetDockablePane(PaneId).Show();
        }
        internal static Assembly? ResolveDynamo(object sender, ResolveEventArgs args)
        {
            var name = new AssemblyName(args.Name).Name;
            var allowed = new[] { "DynamoCore", "DynamoRevitDS", "DynamoServices", "DynamoUtilities", "ProtoCore", "RevitServices", "RevitNodes", "DesignScriptRuntime" };
            if (Array.IndexOf(allowed, name) < 0) return null;
            var installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Autodesk", "Revit 2024", "AddIns", "DynamoForRevit");
            foreach (var directory in new[] { installed, Path.Combine(installed, "Revit") })
            {
                var file = Path.Combine(directory, name + ".dll");
                if (File.Exists(file)) return Assembly.LoadFrom(file);
            }
            return null;
        }
        public Result OnShutdown(UIControlledApplication app)
        {
            remote?.Dispose(); pipe?.Dispose(); Queue?.Dispose(); Queue = null;
            AppDomain.CurrentDomain.AssemblyResolve -= ResolveDynamo;
            return Result.Succeeded;
        }
    }
    [Transaction(TransactionMode.Manual)]
    public sealed class OpenPanelCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
        { data.Application.GetDockablePane(Application.PaneId).Show(); return Result.Succeeded; }
    }
    [Transaction(TransactionMode.Manual)]
    public sealed class OpenDynamoCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
        { return new Dynamo.Applications.DynamoRevit().Execute(data, ref message, elements); }
    }
}
