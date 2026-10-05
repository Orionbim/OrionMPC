// Real MCP stdio client -> ORIONMCP -> Windows named pipe -> Revit ExternalEvent.
// Read-only; never fabricate a model or approve a write.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
const client = new Client({ name: 'orionmcp-readonly-verification', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/server/local.js')], stderr: 'pipe' }));
try {
  const listed = await client.listTools();
  const status = await client.callTool({ name: 'orion_status', arguments: {} });
  const envelope = JSON.parse(status.content[0].text);
  const instanceId = envelope.revitInstances[0]?.instanceId;
  if (!instanceId) throw new Error('No live ORIONMCP Revit instance was discovered. Load the add-in and retry.');
  const revit = await client.callTool({ name: 'revit_status', arguments: { instanceId } });
  const documents = await client.callTool({ name: 'revit_documents_list', arguments: { instanceId } });
  const docs = JSON.parse(documents.content[0].text).result;
  const target = docs?.[0];
  const selection = target ? await client.callTool({ name: 'revit_selection_get', arguments: { instanceId, documentId: target.documentId } }) : null;
  const parameters = target?.projectInfoId ? await client.callTool({ name: 'revit_parameters_read', arguments: { instanceId, documentId: target.documentId, elementId: target.projectInfoId } }) : null;
  const dynamo = await client.callTool({ name: 'dynamo_environment', arguments: { instanceId } });
  const result = { observedAtUtc: new Date().toISOString(), kind: 'real_revit_readonly', transport: 'stdio -> Windows named pipe', toolCount: listed.tools.length, revit, documents, selection, parameters, dynamo, railwayVerified: false, dynamoEvaluationVerified: false, llmProviderTested: false };
  await fs.mkdir('.local/evidence', { recursive: true });
  await fs.writeFile('.local/evidence/local-revit.json', JSON.stringify(result, null, 2));
  const observed = JSON.parse(revit.content[0].text);
  if (!observed.ok) throw new Error(`Revit returned ${observed.error?.code}`);
  console.log(JSON.stringify({ version: observed.result.version, build: observed.result.build, pid: observed.result.pid, apiContext: observed.result.apiContext, toolCount: listed.tools.length, documentsQueried: !documents.isError, selectionQueried: selection ? !selection.isError : false, parametersRead: parameters ? JSON.parse(parameters.content[0].text).result?.parameters?.length : 0, dynamoEnvironmentRead: !dynamo.isError, evidence: '.local/evidence/local-revit.json' }, null, 2));
} finally { await client.close(); }
