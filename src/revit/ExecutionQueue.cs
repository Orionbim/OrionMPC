using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace OrionMcp.Revit2024
{
    public sealed class Request
    {
        public int v { get; set; }
        public string requestId { get; set; } = "";
        public string operation { get; set; } = "";
        public string? documentId { get; set; }
        public Dictionary<string, object> args { get; set; } = new Dictionary<string, object>();
        public string deadlineUtc { get; set; } = "";
        public string identityToken { get; set; } = "";
    }
    public sealed class ApiFault : Exception
    {
        public string Code { get; }
        public ApiFault(string code, string message) : base(message) { Code = code; }
    }
    public sealed class ExecutionQueue : IExternalEventHandler, IDisposable
    {
        internal readonly string InstanceId = Guid.NewGuid().ToString();
        internal readonly string Token;
        internal static string LocalRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ORIONMCP");
        private readonly ConcurrentQueue<Pending> queue = new ConcurrentQueue<Pending>();
        private readonly Dictionary<Document, string> documents = new Dictionary<Document, string>();
        private readonly Dictionary<string, Pending> requests = new Dictionary<string, Pending>();
        private readonly object gate = new object();
        private ExternalEvent? externalEvent;
        private bool stopped;
        private sealed class Pending
        {
            public Request Request = null!; public string Hash = "";
            public TaskCompletionSource<object> Completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        public ExecutionQueue()
        {
            var bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            Token = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        }
        public void Attach(ExternalEvent evt) { externalEvent = evt; }
        internal static string Json(object value) => new JavaScriptSerializer { MaxJsonLength = 262144 }.Serialize(value);
        internal static Request Parse(string json)
        {
            if (json.Length > 65536) throw new ApiFault("MESSAGE_TOO_LARGE", "Solicitud demasiado grande.");
            var parser = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 16 };
            var raw = parser.Deserialize<Dictionary<string, object>>(json);
            var allowed = new[] { "v", "requestId", "operation", "documentId", "args", "deadlineUtc", "identityToken" };
            if (raw.Keys.Any(key => !allowed.Contains(key))) throw new ApiFault("INVALID_ARGUMENTS", "Campos no permitidos.");
            return parser.Deserialize<Request>(json);
        }
        public Task<object> Submit(Request request, bool nativeUi = false)
        {
            if (!nativeUi && !ConstantEquals(request.identityToken, Token)) throw new ApiFault("UNAUTHORIZED", "Identidad local no autorizada.");
            if (request.v != 1 || !Guid.TryParse(request.requestId, out var id)) throw new ApiFault("INVALID_REQUEST", "Solicitud no válida.");
            request.requestId = id.ToString();
            var allowed = new[] { "system.status", "documents.list", "selection.get", "parameters.read", "parameter.setString", "dynamo.environment" };
            if (!allowed.Contains(request.operation)) throw new ApiFault("CAPABILITY_UNAVAILABLE", "Capacidad no implementada en este incremento.");
            var deadline = Deadline(request);
            if (deadline <= DateTime.UtcNow || deadline > DateTime.UtcNow.AddMinutes(2)) throw new ApiFault("EXPIRED", "Solicitud caducada o plazo no válido.");
            if (request.args == null) throw new ApiFault("INVALID_ARGUMENTS", "Argumentos no válidos.");
            string hash;
            using (var sha = SHA256.Create()) hash = Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(Json(new { request.operation, request.documentId, args = request.args.OrderBy(pair => pair.Key).ToArray() }))));
            lock (gate)
            {
                if (stopped) throw new ApiFault("REVIT_CLOSED", "Revit se está cerrando.");
                if (requests.TryGetValue(request.requestId, out var previous))
                { if (previous.Hash != hash) throw new ApiFault("REQUEST_CONFLICT", "El identificador ya se utilizó con otra operación."); return previous.Completion.Task; }
                if (queue.Count >= 32 || requests.Count >= 2000) throw new ApiFault("QUEUE_FULL", "Cola o sesión llena. Consulta el resultado anterior antes de reintentar.");
                var pending = new Pending { Request = request, Hash = hash }; requests.Add(request.requestId, pending); queue.Enqueue(pending);
                var raised = externalEvent!.Raise();
                if (raised == ExternalEventRequest.Denied || raised == ExternalEventRequest.TimedOut) pending.Completion.TrySetResult(Failure(request, "REVIT_BUSY", "Revit no aceptó el evento."));
                return pending.Completion.Task;
            }
        }
        private static bool ConstantEquals(string left, string right)
        { if (left == null || left.Length != right.Length) return false; int diff = 0; for (int i = 0; i < right.Length; i++) diff |= left[i] ^ right[i]; return diff == 0; }
        private static DateTime Deadline(Request request)
        { if (!DateTime.TryParse(request.deadlineUtc, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var deadline)) throw new ApiFault("INVALID_ARGUMENTS", "Plazo no válido."); return deadline; }
        public void Execute(UIApplication app)
        {
            int count = 0;
            while (count++ < 8 && queue.TryDequeue(out var pending))
            {
                if (pending.Completion.Task.IsCompleted) continue;
                try
                {
                    if (Deadline(pending.Request) <= DateTime.UtcNow) throw new ApiFault("EXPIRED", "Solicitud caducada antes de ejecutarse.");
                    var result = Dispatch(app, pending.Request);
                    pending.Completion.TrySetResult(new { requestId = pending.Request.requestId, ok = true, result });
                }
                catch (ApiFault ex) { pending.Completion.TrySetResult(Failure(pending.Request, ex.Code, ex.Message)); }
                catch (Exception ex) { pending.Completion.TrySetResult(Failure(pending.Request, "REVIT_API_ERROR", ex.Message)); }
            }
            if (!queue.IsEmpty) externalEvent!.Raise();
        }
        private string DocumentId(Document document)
        { if (!documents.TryGetValue(document, out var id)) { id = Guid.NewGuid().ToString(); documents.Add(document, id); } return id; }
        private Document ResolveDocument(UIApplication app, string? id)
        {
            foreach (Document document in app.Application.Documents) if (document.IsValidObject && DocumentId(document) == id) return document;
            throw new ApiFault("DOCUMENT_NOT_FOUND", "El documento objetivo no existe o se cerró. Actualiza el contexto.");
        }
        private object Dispatch(UIApplication app, Request request)
        {
            if (request.operation == "system.status") { Keys(request); return new { instanceId = InstanceId, pid = Process.GetCurrentProcess().Id, version = app.Application.VersionNumber, build = app.Application.VersionBuild, apiContext = "ExternalEvent", queueDepth = queue.Count }; }
            if (request.operation == "documents.list")
            {
                Keys(request);
                return app.Application.Documents.Cast<Document>().Select(d => new { documentId = DocumentId(d), title = d.Title, readOnly = d.IsReadOnly, familyDocument = d.IsFamilyDocument, projectInfoId = d.IsFamilyDocument ? null : d.ProjectInformation.Id.Value.ToString(CultureInfo.InvariantCulture) }).ToArray();
            }
            if (request.operation == "dynamo.environment") { Keys(request); return DynamoState(); }
            var document = ResolveDocument(app, request.documentId);
            if (request.operation == "selection.get")
            {
                Keys(request);
                if (app.ActiveUIDocument == null || app.ActiveUIDocument.Document != document) throw new ApiFault("CONTEXT_CONFLICT", "La selección pertenece al documento visible. Activa el documento objetivo y vuelve a consultar.");
                return new { documentId = request.documentId, elementIds = app.ActiveUIDocument.Selection.GetElementIds().Take(200).Select(id => id.Value.ToString(CultureInfo.InvariantCulture)).ToArray() };
            }
            if (request.operation == "parameters.read")
            {
                Keys(request, "elementId"); var element = Element(document, request);
                return new { documentId = request.documentId, elementId = element.Id.Value.ToString(), parameters = element.Parameters.Cast<Parameter>().Take(50).Select(p => new { name = p.Definition.Name, builtInParameter = p.Id.Value < 0 ? (long?)p.Id.Value : null, sharedGuid = p.IsShared ? p.GUID.ToString() : null, storageType = p.StorageType.ToString(), readOnly = p.IsReadOnly, value = p.StorageType == StorageType.String ? p.AsString() : p.AsValueString() }).ToArray() };
            }
            Keys(request, "elementId", "builtInParameter", "value");
            if (document.IsReadOnly) throw new ApiFault("READ_ONLY", "El documento es de solo lectura.");
            var target = Element(document, request);
            var builtInId = Convert.ToInt32(request.args["builtInParameter"], CultureInfo.InvariantCulture);
            if (!Enum.IsDefined(typeof(BuiltInParameter), builtInId)) throw new ApiFault("INVALID_PARAMETER", "Identificador de parámetro no válido.");
            var parameter = target.get_Parameter((BuiltInParameter)builtInId);
            if (parameter == null || parameter.IsReadOnly || parameter.StorageType != StorageType.String) throw new ApiFault("PARAMETER_NOT_WRITABLE", "Este incremento admite parámetros built-in de texto editables.");
            if (!(request.args["value"] is string value) || value.Length > 4096) throw new ApiFault("INVALID_ARGUMENTS", "Valor de texto no válido.");
            var before = parameter.AsString();
            var review = new TaskDialog("ORIONMCP — Aprobar cambio");
            review.MainInstruction = "Cambiar «" + parameter.Definition.Name + "» en «" + document.Title + "»";
            review.MainContent = "Documento: " + request.documentId + "\nElemento: " + target.Id.Value + "\nSolicitud: " + request.requestId + "\n\nActual: " + before + "\nNuevo: " + value;
            review.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Aprobar esta operación concreta"); review.CommonButtons = TaskDialogCommonButtons.Cancel;
            if (review.Show() != TaskDialogResult.CommandLink1) throw new ApiFault("APPROVAL_DENIED", "Cambio cancelado por la persona usuaria.");
            if (Deadline(request) <= DateTime.UtcNow) throw new ApiFault("EXPIRED", "Aprobación fuera de plazo; no se modificó el modelo.");
            if (ResolveDocument(app, request.documentId) != document || parameter.AsString() != before) throw new ApiFault("CONTEXT_CHANGED", "Documento o valor cambió después de preparar la operación.");
            var journal = Path.Combine(LocalRoot, "journal", InstanceId); Directory.CreateDirectory(journal);
            var receipt = Path.Combine(journal, request.requestId + ".json");
            File.WriteAllText(receipt, Json(new { requestId = request.requestId, status = "executing", documentId = request.documentId }), new UTF8Encoding(false));
            using (var transaction = new Transaction(document, "ORIONMCP: " + parameter.Definition.Name))
            {
                if (transaction.Start() != TransactionStatus.Started) throw new ApiFault("TRANSACTION_FAILED", "No se pudo iniciar la transacción.");
                if (!parameter.Set(value)) { transaction.RollBack(); throw new ApiFault("SET_FAILED", "Revit rechazó el valor."); }
                var committed = transaction.Commit();
                if (committed != TransactionStatus.Committed) throw new ApiFault(committed == TransactionStatus.Pending ? "RESULT_UNCERTAIN" : "TRANSACTION_FAILED", "Estado de commit: " + committed);
            }
            var final = target.get_Parameter((BuiltInParameter)builtInId).AsString();
            if (final != value) throw new ApiFault("POSTCONDITION_FAILED", "El valor final no coincide con el solicitado.");
            var outcome = new { requestId = request.requestId, status = "completed", documentId = request.documentId, elementId = target.Id.Value.ToString(), before, value = final, transaction = "Committed", verified = true };
            File.WriteAllText(receipt, Json(outcome), new UTF8Encoding(false));
            return outcome;
        }
        private static object DynamoState()
        {
            var model = Dynamo.Applications.DynamoRevit.RevitDynamoModel;
            return new { coreVersion = typeof(Dynamo.Models.DynamoModel).Assembly.GetName().Version.ToString(), revitVersion = typeof(Dynamo.Applications.DynamoRevit).Assembly.GetName().Version.ToString(), running = model != null, workspace = model?.CurrentWorkspace?.Name, nodeCount = model?.CurrentWorkspace?.Nodes.Count(), graphEvaluationVerified = false };
        }
        private static Element Element(Document document, Request request)
        {
            if (!request.args.TryGetValue("elementId", out var raw) || !(raw is string id) || !long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value <= 0) throw new ApiFault("INVALID_ARGUMENTS", "ElementId debe ser una cadena decimal Int64 positiva.");
            return document.GetElement(new ElementId(value)) ?? throw new ApiFault("ELEMENT_NOT_FOUND", "El elemento no existe en este documento.");
        }
        private static void Keys(Request request, params string[] keys)
        { if (request.args.Count != keys.Length || keys.Any(key => !request.args.ContainsKey(key))) throw new ApiFault("INVALID_ARGUMENTS", "Los argumentos no coinciden con el contrato."); }
        internal static object Failure(Request request, string code, string message) => new { requestId = request.requestId, ok = false, error = new { code, message } };
        public string GetName() => "ORIONMCP controlled execution";
        public void Dispose() { lock (gate) { stopped = true; foreach (var pending in requests.Values) pending.Completion.TrySetResult(Failure(pending.Request, "REVIT_CLOSED", "Revit cerró la conexión.")); } externalEvent?.Dispose(); }
    }
}
