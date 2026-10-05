import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callHost, instances, type HostResult } from "./bridge.js";

export type Dispatcher = typeof callHost;
function content(result: HostResult) {
  return { isError: !result.ok, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}
export function createServer(dispatch: Dispatcher | undefined = callHost, local = true, listInstances = async () => (await instances()).map(({ instanceId, pid }) => ({ instanceId, pid })), allowWrites = local): McpServer {
  const server = new McpServer({ name: "orionmcp", version: "0.1.0" });
  server.registerTool("orion_status", {
    description: "Inspect ORIONMCP transport readiness and live Revit instances. Discovered or configured is not end-to-end verified.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => ({ content: [{ type: "text", text: JSON.stringify({ mode: local ? "local" : "remote", revitInstances: await listInstances(), remoteDeviceChannelImplemented: !local, endToEndVerified: false }) }] }));
  if (!dispatch) return server;
  const context = { instanceId: z.uuid(), documentId: z.uuid() };
  const read = { readOnlyHint: true, destructiveHint: false };
  server.registerTool("revit_status", { description: "Query version and API state of the explicit live Revit instance.", inputSchema: { instanceId: z.uuid() }, annotations: read }, async ({ instanceId }) => content(await dispatch(instanceId, "system.status", {})));
  server.registerTool("revit_documents_list", { description: "List open documents and opaque document IDs in a specific instance. Never infer a write target from active document.", inputSchema: { instanceId: z.uuid() }, annotations: read }, async ({ instanceId }) => content(await dispatch(instanceId, "documents.list", {})));
  server.registerTool("revit_selection_get", { description: "Read selection only when the target document is the active UI document; otherwise report context conflict.", inputSchema: context, annotations: read }, async ({ instanceId, documentId }) => content(await dispatch(instanceId, "selection.get", {}, documentId)));
  server.registerTool("revit_parameters_read", { description: "Read up to 50 parameters from an element identified by decimal Int64 string. Includes stable built-in IDs where available.", inputSchema: { ...context, elementId: z.string().regex(/^[0-9]+$/) }, annotations: read }, async ({ instanceId, documentId, elementId }) => content(await dispatch(instanceId, "parameters.read", { elementId }, documentId)));
  if (allowWrites) server.registerTool("revit_parameter_set_string", { description: "Set a writable built-in string parameter with an explicit requestId. Revit asks for a native human approval bound to this document, element, parameter and value before starting the transaction. Commit and final value are checked. Keep requestId to reconcile; timeout never authorizes automatic retry.", inputSchema: { ...context, requestId: z.uuid(), elementId: z.string().regex(/^[0-9]+$/), builtInParameter: z.number().int().negative(), value: z.string().max(4096) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ instanceId, documentId, requestId, elementId, builtInParameter, value }) => content(await dispatch(instanceId, "parameter.setString", { elementId, builtInParameter, value }, documentId, requestId)));
  server.registerTool("dynamo_environment", { description: "Inspect the installed DynamoRevit version and whether its real model is running. Does not claim graph evaluation or node compatibility.", inputSchema: { instanceId: z.uuid() }, annotations: read }, async ({ instanceId }) => content(await dispatch(instanceId, "dynamo.environment", {})));
  return server;
}
