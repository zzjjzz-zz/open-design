// No model/provider calls: a private HTTP fixture supplies the identity
// directory and publication result; project reads/writes pass through to the
// real daemon REST routes and its persisted workspace authority gate.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readAppConfig, writeAppConfig } from '../src/app-config.js';
import { ensureWorkspaceProject, insertConversation, insertProject, openDatabase, upsertMessage } from '../src/db.js';
import { startServer, type StartServerResult } from '../src/server.js';

function payload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(result.isError, content[0]?.text).not.toBe(true);
  return JSON.parse(content[0]!.text!);
}

it('MCP initialize/list, shared fail-closed, real HTTP workspace denial, history/config/export/version lifecycle, errors and requestId replay', async () => {
  const dataDir = process.env.OD_DATA_DIR;
  if (!dataDir) throw new Error('daemon test data root is required');
  const daemon = await startServer({ port: 0, host: '127.0.0.1', returnServer: true }) as StartServerResult;
  const project = randomUUID();
  const foreign = randomUUID();
  const cid = randomUUID();
  const foreignCid = randomUUID();
  const messageId = randomUUID();
  const now = Date.now();
  const db = openDatabase(process.cwd(), { dataDir });
  for (const [id, ws, conv] of [[project, 'ws-fixture-owner', cid], [foreign, 'ws-fixture-foreign', foreignCid]]) {
    insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
    ensureWorkspaceProject(db, { projectId: id, workspaceId: ws, createdByWorkspaceMemberId: 'fixture-owner' });
    insertConversation(db, { id: conv, projectId: id, title: 'Original', createdAt: now, updatedAt: now });
  }
  upsertMessage(db, cid, { id: messageId, role: 'user', content: 'Fixture history only', createdAt: now });
  const projectDir = path.join(dataDir, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'index.html'), '<!doctype html><html><body><h1 data-od-id="title">version one</h1></body></html>');
  await writeAppConfig(dataDir, { agentId: 'codex', agentModels: { codex: { model: 'fixture-model' } }, agentCliEnv: { codex: { OPENAI_API_KEY: 'fixture-secret', OPENAI_BASE_URL: 'https://fixture.invalid' } }, agentCliEnvIntent: { codex: { apiKeyOverride: true } } });
  const requests: Array<{ route: string; method: string; status: number }> = [];
  let publishCount = 0;
  const fixture = createServer(async (req, res) => {
    const route = req.url ?? '/';
    const method = req.method ?? 'GET';
    try {
      if (route === '/api/workspace/directory') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ items: [{ workspaceId: 'ws-fixture-owner', workspaceMemberId: 'fixture-owner', workspaceType: 'personal', memberStatus: 'active', lifecycleState: 'active' }] }));
        return;
      }
      if (route === '/api/agents?stream=1') {
        res.setHeader('content-type', 'text/event-stream');
        res.end(`event: agent\ndata: ${JSON.stringify({ id: 'codex', available: true, modelsSource: 'live', models: [{ id: 'fixture-model', enabled: true, reasoningOptions: [{ id: 'high' }] }] })}\n\nevent: done\ndata: {}\n\n`);
        return;
      }
      if (route === '/api/agents') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ agents: [{ id: 'codex', available: true, modelsSource: 'live', models: [{ id: 'fixture-model', enabled: true, reasoningOptions: [{ id: 'high' }] }] }] }));
        return;
      }
      if (route === `/api/projects/${project}/deploy` && method === 'POST') {
        publishCount += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'fixture-deployment', url: 'https://fixture.invalid' }));
        requests.push({ route, method, status: 200 });
        return;
      }
      if (route.endsWith('/conversations/error/messages')) {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'FIXTURE_UNAVAILABLE', message: 'fixture-secret' } }));
        requests.push({ route, method, status: 503 });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'x-od-workspace-id', 'x-od-workspace-member-id']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const response = await fetch(`${daemon.url}${route}`, { method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), redirect: 'error' });
      requests.push({ route, method, status: response.status });
      res.statusCode = response.status;
      res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.statusCode = 500; res.end('fixture forwarding failed');
    }
  });
  const clients: Client[] = [];
  try {
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('fixture address missing');
    const base = `http://127.0.0.1:${address.port}`;
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    async function connect(owner: boolean) {
      const client = new Client({ name: 'isolated-mcp-contract-test', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', cli, 'mcp', '--daemon-url', base, ...(owner ? ['--local-owner', '--allow-writes'] : [])], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), stderr: 'pipe' }));
      return client;
    }
    const shared = await connect(false); // connect performs real MCP initialize.
    const tools = await shared.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('get_mcp_capabilities');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('list_conversations');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('publish_project');
    expect(payload(await shared.callTool({ name: 'get_mcp_capabilities', arguments: {} }))).toMatchObject({ mode: 'shared-unbound', callerWorkspaceBinding: false, writes: false });
    const initialRequests = requests.length;
    const sharedDenied = await shared.callTool({ name: 'list_conversations', arguments: { project } });
    expect(sharedDenied.isError).toBe(true);
    expect(JSON.stringify(sharedDenied)).toContain('MCP_CALLER_AUTHORITY_REQUIRED');
    expect(requests).toHaveLength(initialRequests);

    const local = await connect(true);
    expect((await local.listTools()).tools.map((tool) => tool.name)).toContain('list_conversations');
    expect((await local.listTools()).tools.map((tool) => tool.name)).toContain('publish_project');
    const call = (name: string, args: Record<string, unknown>) => local.callTool({ name, arguments: args });
    // These refusals come from actual daemon HTTP routes, not the fixture.
    const foreignDenied = await call('list_conversations', { project: foreign });
    expect(foreignDenied.isError).toBe(true);
    expect(JSON.stringify(foreignDenied)).toContain('HTTP 403');
    expect(requests.at(-1)).toMatchObject({ route: `/api/projects/${foreign}/conversations`, status: 403 });
    const wrongConversation = await call('list_messages', { project, conversationId: foreignCid });
    expect(wrongConversation.isError).toBe(true);
    expect(requests.at(-1)?.status).toBe(404);
    const publishDenied = await call('publish_project', { project: foreign, path: 'index.html', providerId: 'cloudflare-pages', target: 'preview', confirm: true, requestId: 'foreign-publish' });
    expect(publishDenied.isError).toBe(true);
    expect(requests.at(-1)?.status).toBe(403);
    expect(publishCount).toBe(0);

    expect(payload(await call('list_conversations', { project })).conversations).toEqual(expect.arrayContaining([expect.objectContaining({ id: cid })]));
    expect(payload(await call('get_conversation', { project, conversationId: cid })).conversation.title).toBe('Original');
    expect(payload(await call('list_messages', { project, conversationId: cid })).messages[0].content).toBe('Fixture history only');
    expect(payload(await call('get_message', { project, conversationId: cid, messageId })).message.id).toBe(messageId);
    const rename = { project, conversationId: cid, title: 'Renamed', requestId: 'rename-once' };
    const renamed = await call('rename_conversation', rename);
    expect(payload(renamed).conversation.title).toBe('Renamed');
    expect(await call('rename_conversation', rename)).toEqual(renamed);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect((await call('rename_conversation', { ...rename, title: 'Conflict' })).isError).toBe(true);

    const safeSettings = payload(await call('get_settings', {}));
    expect(safeSettings.settings.agentId).toBe('codex');
    expect(JSON.stringify(safeSettings)).not.toContain('fixture-secret');
    const updated = payload(await call('update_settings', { settings: { skillId: 'fixture-skill' }, requestId: 'prefs' }));
    expect(updated.settings.skillId).toBe('fixture-skill');
    const model = payload(await call('update_model_preferences', { agent: 'codex', preferences: { reasoning: 'high' }, requestId: 'model' }));
    expect(model.agentModels.codex).toMatchObject({ model: 'fixture-model', reasoning: 'high' });
    expect((await readAppConfig(dataDir)).agentCliEnv?.codex?.OPENAI_API_KEY).toBe('fixture-secret');

    expect((await local.listTools()).tools.map((tool) => tool.name)).toContain('get_visual_edit_targets');
    expect((await local.listTools()).tools.map((tool) => tool.name)).toContain('apply_visual_edit_patch');
    const visual = payload(await call('get_visual_edit_targets', { project, path: 'index.html' }));
    expect(visual.targets).toMatchObject([{ id: 'title', operations: ['set-style', 'set-text'] }]);
    expect((await call('get_visual_edit_targets', { project: foreign, path: 'index.html' })).isError).toBe(true);
    const edit = { project, path: 'index.html', expectedHash: visual.hash, patch: { kind: 'set-text', id: 'title', value: 'visual edit' }, confirm: true, requestId: 'visual-edit-once' };
    const edited = await call('apply_visual_edit_patch', edit);
    const editedPayload = payload(edited);
    expect(editedPayload.previousHash).toBe(visual.hash);
    expect(await call('apply_visual_edit_patch', edit)).toEqual(edited);
    expect((await call('apply_visual_edit_patch', { ...edit, requestId: 'stale-visual' })).isError).toBe(true);
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toContain('visual edit');
    payload(await call('restore_file_version', { project, path: 'index.html', versionId: editedPayload.previousVersionId, confirm: true, requestId: 'visual-undo' }));
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toContain('version one');

    const snapshot = payload(await call('create_file_version', { project, path: 'index.html', label: 'Known good', requestId: 'version' }));
    expect(snapshot.version.id).toBeTruthy();
    const history = payload(await call('list_file_versions', { project, path: 'index.html' }));
    expect(history.versions.length).toBeGreaterThan(0);
    expect(payload(await call('get_file_version', { project, path: 'index.html', versionId: snapshot.version.id })).content).toContain('version one');
    await writeFile(path.join(projectDir, 'index.html'), '<html><body>version two</body></html>');
    payload(await call('restore_file_version', { project, path: 'index.html', versionId: snapshot.version.id, confirm: true, requestId: 'restore' }));
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toContain('version one');
    const preview = payload(await call('get_preview_url', { project, path: 'index.html' }));
    expect(preview.url).toContain(`/api/projects/${project}/preview/`);
    expect(preview.opaqueOrigin).toBe(true);
    expect(payload(await call('get_export_manifest', { project }))).toBeTruthy();
    const exported = payload(await call('export_project', { project, path: 'index.html', format: 'html' }));
    expect(Buffer.from(exported.data, 'base64').toString('utf8')).toContain('version one');
    expect(payload(await call('deployment_preflight', { project, path: 'index.html', providerId: 'vercel-self' }))).toBeTruthy();

    const publish = { project, path: 'index.html', providerId: 'vercel-self', target: 'preview', confirm: true, requestId: 'publish-once' };
    const published = await call('publish_project', publish);
    expect(payload(published).id).toBe('fixture-deployment');
    expect(await call('publish_project', publish)).toEqual(published);
    expect(publishCount).toBe(1);
    const unavailable = await call('list_messages', { project, conversationId: 'error' });
    expect(unavailable.isError).toBe(true);
    expect(JSON.stringify(unavailable)).toContain('FIXTURE_UNAVAILABLE');
    expect(JSON.stringify(unavailable)).not.toContain('fixture-secret');
    const noConfirm = await call('delete_conversation', { project, conversationId: cid, confirm: false, requestId: 'delete' });
    expect(noConfirm.isError).toBe(true);
    payload(await call('delete_conversation', { project, conversationId: cid, confirm: true, requestId: 'delete' }));
    payload(await call('delete_conversation', { project, conversationId: cid, confirm: true, requestId: 'delete' }));
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect((await call('get_conversation', { project, conversationId: cid })).isError).toBe(true);
  } finally {
    for (const client of clients.reverse()) await client.close();
    await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    await daemon.shutdown();
    await new Promise<void>((resolve, reject) => daemon.server.close((error) => error ? reject(error) : resolve()));
  }
}, 60_000);
