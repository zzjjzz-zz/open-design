// Real daemon REST and SQLite sandbox behind a private fixture identity/probe.
// No inference, external install, real configuration, or production service.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readAppConfig, writeAppConfig } from '../src/app-config.js';
import { ensureWorkspaceProject, ensureWorkspaceResource, insertProject, openDatabase } from '../src/db.js';
import { registryRootsForDataDir, resolvePluginFolder, upsertInstalledPlugin } from '../src/plugins/registry.js';
import { startServer, type StartServerResult } from '../src/server.js';
import { CATALOG_TOOL_DEFS } from '../src/mcp/catalog-tools.js';

function payload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  const content = result.content as Array<{ text?: string }>;
  expect(result.isError, content[0]?.text).not.toBe(true);
  return JSON.parse(content[0]!.text!);
}

it('real MCP discovery/authority and REST skill/plugin/settings/conversation lifecycle with workspace denials and write replay', async () => {
  const dataDir = process.env.OD_DATA_DIR!;
  const daemon = await startServer({ port: 0, host: '127.0.0.1', returnServer: true }) as StartServerResult;
  const clients: Client[] = [];
  const requests: Array<{ route: string; method: string; status: number; body: string; workspace?: string }> = [];
  let workspace = 'ws-catalog-owner';
  const fixture = createServer(async (req, res) => {
    const route = req.url ?? '/'; const method = req.method ?? 'GET';
    try {
      if (route === '/api/workspace/directory') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ items: [{ workspaceId: workspace, workspaceMemberId: 'fixture-owner', workspaceType: 'personal', memberStatus: 'active', lifecycleState: 'active' }] })); return;
      }
      if (route === '/api/agents?stream=1') {
        res.setHeader('content-type', 'text/event-stream');
        res.end(`event: agent\ndata: ${JSON.stringify({ id: 'agy', available: true, modelsSource: 'live', models: Array.from({ length: 14 }, (_, index) => ({ id: `fixture-model-${index}`, reasoningOptions: [{ id: 'high' }] })), executablePath: '/private/fixture-secret' })}\n\nevent: done\ndata: {}\n\n`); return;
      }
      if (route === '/api/agents') {
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ agents: [{ id: 'agy', available: true, modelsSource: 'fallback', models: [{ id: 'default' }] }] })); return;
      }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'x-od-workspace-id', 'x-od-workspace-member-id']) { const value = req.headers[name]; if (typeof value === 'string') headers[name] = value; }
      const response = await fetch(`${daemon.url}${route}`, { method, headers, ...(body ? { body } : {}), redirect: 'error' });
      requests.push({ route, method, status: response.status, body, ...(headers['x-od-workspace-id'] ? { workspace: headers['x-od-workspace-id'] } : {}) });
      res.statusCode = response.status; res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json'); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  try {
    const db = openDatabase(process.cwd(), { dataDir });
    const project = randomUUID(); const foreign = randomUUID(); const now = Date.now();
    for (const [id, ws] of [[project, workspace], [foreign, 'ws-catalog-foreign']]) {
      insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
      ensureWorkspaceProject(db, { projectId: id, workspaceId: ws, createdByWorkspaceMemberId: 'fixture-owner' });
      await mkdir(path.join(dataDir, 'projects', id!), { recursive: true });
    }
    await writeAppConfig(dataDir, { customInstructions: 'Initial instructions', telemetry: { metrics: false, content: false }, agentModels: { agy: { model: 'fixture-model-13' } }, agentCliEnv: { codex: { OPENAI_API_KEY: 'fixture-secret' } }, agentCliEnvIntent: { codex: { apiKeyOverride: true } } });
    const pluginId = `catalog-plugin-${Date.now()}`;
    const pluginDir = path.join(registryRootsForDataDir(dataDir).userPluginsRoot, pluginId);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'open-design.json'), JSON.stringify({ name: pluginId, title: '! Fixture plugin', version: '1.0.0', description: 'Sandbox plugin' }));
    const resolved = await resolvePluginFolder({ folder: pluginDir, folderId: pluginId, sourceKind: 'local', source: pluginDir });
    if (!resolved.ok) throw new Error('invalid plugin fixture');
    upsertInstalledPlugin(db, resolved.record);
    ensureWorkspaceResource(db, 'plugin', workspace, pluginId, { visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'fixture-owner', updatedByWorkspaceMemberId: 'fixture-owner' });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('fixture address missing');
    const base = `http://127.0.0.1:${address.port}`;
    async function connect(flags: string[]) {
      const client = new Client({ name: 'catalog-sandbox', version: '1.0.0' }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'mcp', '--daemon-url', base, ...flags], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), stderr: 'pipe' }));
      return client;
    }
    const shared = await connect([]);
    const sharedNames = (await shared.listTools()).tools.map((tool) => tool.name);
    for (const definition of CATALOG_TOOL_DEFS) expect(sharedNames).not.toContain(definition.name);
    const beforeShared = requests.length;
    expect((await shared.callTool({ name: 'get_skill', arguments: { id: 'test' } })).isError).toBe(true); expect(requests).toHaveLength(beforeShared);
    const readonly = await connect(['--local-owner']);
    const readonlyNames = (await readonly.listTools()).tools.map((tool) => tool.name);
    expect(readonlyNames).toContain('get_skill'); expect(readonlyNames).not.toContain('import_skill');
    expect((await readonly.callTool({ name: 'import_skill', arguments: { name: 'test', body: 'Text', confirm: true, requestId: 'denied' } })).isError).toBe(true);
    const owner = await connect(['--local-owner', '--allow-writes']);
    const call = (name: string, args: Record<string, unknown> = {}) => owner.callTool({ name, arguments: args });
    const names = (await owner.listTools()).tools.map((tool) => tool.name);
    for (const definition of CATALOG_TOOL_DEFS) expect(names).toContain(definition.name);
    const skillId = `catalog-skill-${Date.now()}`;
    const importArgs = { name: skillId, description: 'Sandbox description', body: 'Only sandbox skill\nNo execution.', triggers: ['sandbox'], confirm: true, requestId: 'import-once' };
    const imported = await call('import_skill', importArgs);
    expect(payload(imported).skill.id).toBe(skillId); expect(await call('import_skill', importArgs)).toEqual(imported);
    expect(requests.filter((item) => item.route === '/api/skills/import')).toHaveLength(1);
    expect((await call('import_skill', { ...importArgs, body: 'changed' })).isError).toBe(true);
    const skillDetails = payload(await call('get_skill', { id: skillId })); expect(skillDetails.skill.body).toContain('Only sandbox'); expect(skillDetails.skill.dir).toBeUndefined();
    expect(payload(await call('list_catalog_skills')).skills).toEqual(expect.arrayContaining([expect.objectContaining({ id: skillId })]));
    expect(payload(await call('list_skill_files', { id: skillId })).files).toContainEqual(expect.objectContaining({ path: 'SKILL.md', kind: 'file' }));
    payload(await call('update_skill', { id: skillId, body: 'Updated sandbox body', confirm: true, requestId: 'update-skill' }));
    expect(payload(await call('get_skill', { id: skillId })).skill).toMatchObject({ body: expect.stringContaining('Updated sandbox'), description: 'Sandbox description', triggers: ['sandbox'] });
    expect(await readFile(path.join(dataDir, 'skills', skillId, 'SKILL.md'), 'utf8')).toContain('Updated sandbox');
    const detail = payload(await call('get_plugin', { id: pluginId })); expect(detail.plugin.id).toBe(pluginId); expect(detail.plugin.fsPath).toBeUndefined(); expect(detail.plugin.source).toBeUndefined();
    expect(payload(await call('list_catalog_plugins')).plugins).toEqual(expect.arrayContaining([expect.objectContaining({ id: pluginId })]));
    expect(payload(await call('get_plugin_stats')).plugins.total).toBeGreaterThan(0);
    expect(payload(await call('doctor_plugin', { id: pluginId }))).toMatchObject({ pluginId, issues: expect.any(Array) });
    workspace = 'ws-catalog-foreign';
    for (const [name, args] of [['get_skill', { id: skillId }], ['get_plugin', { id: pluginId }], ['update_skill', { id: skillId, body: 'Foreign write', confirm: true, requestId: 'foreign-update' }], ['uninstall_plugin', { id: pluginId, confirm: true, requestId: 'foreign-uninstall' }]] as const) {
      expect((await call(name, args)).isError).toBe(true); expect(requests.at(-1)?.status).toBe(404);
    }
    expect(payload(await call('list_catalog_skills')).skills.some((item: { id: string }) => item.id === skillId)).toBe(false);
    expect(payload(await call('list_catalog_plugins')).plugins.some((item: { id: string }) => item.id === pluginId)).toBe(false);
    workspace = 'ws-catalog-owner';
    const deniedConversation = await call('create_conversation', { project: foreign, confirm: true, requestId: 'foreign-create' });
    expect(deniedConversation.isError).toBe(true); expect(requests.at(-1)?.status).toBe(403);
    const createArgs = { project, title: 'Created via MCP', sessionMode: 'chat', confirm: true, requestId: 'create-once' };
    const created = await call('create_conversation', createArgs); expect(payload(created).conversation).toMatchObject({ projectId: project, title: createArgs.title, sessionMode: 'chat' });
    expect(await call('create_conversation', createArgs)).toEqual(created);
    expect(requests.filter((item) => item.route === `/api/projects/${project}/conversations` && item.method === 'POST')).toHaveLength(1);
    const settings = { customInstructions: 'Safe\nmultiline', odNextStrategyMode: 'observe', disabledSkills: [skillId], disabledDesignSystems: [], telemetry: { metrics: false, content: false } };
    const prefs = payload(await call('update_management_settings', { settings, confirm: true, requestId: 'settings' }));
    expect(prefs.settings).toMatchObject(settings); expect(JSON.stringify(prefs)).not.toContain('fixture-secret');
    expect(payload(await call('get_management_settings')).settings).toMatchObject(settings);
    expect((await readAppConfig(dataDir)).agentCliEnv?.codex?.OPENAI_API_KEY).toBe('fixture-secret');
    expect(payload(await call('list_available_agent_models', { agent: 'agy' })).agent.models).toHaveLength(14);
    const model = payload(await call('update_model_preferences', { agent: 'agy', preferences: { reasoning: 'high' }, requestId: 'live-model' }));
    expect(model.agentModels.agy).toMatchObject({ model: 'fixture-model-13', reasoning: 'high' });
    expect((await call('update_model_preferences', { agent: 'agy', preferences: { model: 'default' }, requestId: 'fallback-model' })).isError).toBe(true);
    const deleteArgs = { id: skillId, confirm: true, requestId: 'delete-once' };
    payload(await call('delete_skill', deleteArgs)); payload(await call('delete_skill', deleteArgs));
    expect(requests.filter((item) => item.method === 'DELETE')).toHaveLength(1);
    expect((await call('get_skill', { id: skillId })).isError).toBe(true);
    const uninstallArgs = { id: pluginId, confirm: true, requestId: 'uninstall-once' };
    payload(await call('uninstall_plugin', uninstallArgs)); payload(await call('uninstall_plugin', uninstallArgs));
    expect(requests.filter((item) => item.route.endsWith('/uninstall') && item.method === 'POST')).toHaveLength(1);
    await expect(access(pluginDir)).rejects.toThrow();
    // CLI bootstrap probes daemon health before the MCP session/workspace
    // exists. Every catalogue/config/project REST request must be scoped.
    const unscoped = requests.filter((item) => !item.workspace).map(({ route, method, status }) => ({ route, method, status }));
    console.info('[catalog fixture] unscoped requests (no bodies or credentials)', unscoped);
    expect(unscoped).toEqual(Array.from({ length: 3 }, () => ({ route: '/api/health', method: 'GET', status: 200 })));
    expect(requests.some((item) => item.route.includes('/runs') || item.route === '/api/chat')).toBe(false);
  } finally {
    for (const client of clients.reverse()) await client.close();
    if (fixture.listening) await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    await daemon.shutdown();
    await new Promise<void>((resolve, reject) => daemon.server.close((error) => error ? reject(error) : resolve()));
  }
}, 60_000);
