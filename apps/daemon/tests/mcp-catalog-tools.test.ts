import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMcpToolCall, localMcpToolDefinitions, TOOL_DEFS } from '../src/mcp.js';
import { CATALOG_TOOL_DEFS, McpCatalogTools } from '../src/mcp/catalog-tools.js';
import { _resetMcpWorkspaceContextCacheForTests } from '../src/mcp-workspace-context.js';

const base = 'http://127.0.0.1:19235';
const directory = { items: [{ workspaceId: 'ws-a', workspaceMemberId: 'member-a', workspaceType: 'personal', memberStatus: 'active', lifecycleState: 'active' }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const owner = () => new McpCatalogTools({ localOwner: true, allowWrites: true });
const call = (name: string, args: Record<string, unknown> = {}, catalogTools = owner()) => handleMcpToolCall(base, name, args, { catalogTools });
const body = (result: Awaited<ReturnType<typeof call>>) => { expect(result.isError, result.content[0]?.text).not.toBe(true); return JSON.parse(result.content[0]!.text); };
function mockDaemon(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string, init: RequestInit = {}) => url.endsWith('/directory') ? json(directory) : handler(url, init));
  vi.stubGlobal('fetch', mock); return mock;
}
const skill = { id: 'test-skill', name: 'test-skill', source: 'user', body: 'Old', description: 'Description', triggers: ['design'], dir: '/private/SECRET', apiKey: 'SECRET' };
const plugin = { id: 'test-plugin', title: 'Test', version: '1.0.0', sourceKind: 'local', trust: 'restricted', source: '/private/SECRET', fsPath: '/private/SECRET', manifest: { name: 'Test', description: 'A plugin', od: { taskKind: 'design', capabilities: ['fs:write'], context: { skills: [{ ref: 'skill:test-skill', path: '/private/SECRET', token: 'SECRET' }], designSystem: { ref: 'design-system:test', path: '/private/SECRET' }, mcp: [{ env: { token: 'SECRET' } }] }, credentials: 'SECRET' }, secret: 'SECRET' } };
afterEach(() => { vi.unstubAllGlobals(); _resetMcpWorkspaceContextCacheForTests(); });

describe('catalogue access and strict inputs', () => {
  it('registers unique tools and hides all new tools from shared discovery and writes from read-only discovery', () => {
    expect(new Set(TOOL_DEFS.map((tool) => tool.name)).size).toBe(TOOL_DEFS.length);
    for (const tool of CATALOG_TOOL_DEFS) {
      expect(TOOL_DEFS).toContain(tool);
      expect(localMcpToolDefinitions().some((item) => item.name === tool.name)).toBe(false);
      expect(localMcpToolDefinitions({ localOwner: true }).some((item) => item.name === tool.name)).toBe(tool.annotations.readOnlyHint);
      expect(localMcpToolDefinitions({ localOwner: true, allowWrites: true }).some((item) => item.name === tool.name)).toBe(true);
    }
  });
  const samples: Record<string, Record<string, unknown>> = {
    get_skill: { id: 'test-skill' }, list_skill_files: { id: 'test-skill' }, import_skill: { name: 'test-skill', body: 'Text' }, update_skill: { id: 'test-skill', body: 'Text' }, delete_skill: { id: 'test-skill' }, get_plugin: { id: 'test-plugin' }, doctor_plugin: { id: 'test-plugin' }, uninstall_plugin: { id: 'test-plugin' }, update_management_settings: { settings: { customInstructions: 'Text' } }, create_conversation: { project: 'test-project' }, list_available_agent_models: { agent: 'agy' },
  };
  it.each(CATALOG_TOOL_DEFS)('shared $name is denied without HTTP even with valid input', async (definition) => {
    const mock = mockDaemon(() => json({}));
    const args = { ...samples[definition.name], ...(!definition.annotations.readOnlyHint ? { confirm: true, requestId: 'once' } : {}) };
    expect((await call(definition.name, args, new McpCatalogTools())).content[0]!.text).toContain('MCP_CALLER_AUTHORITY_REQUIRED');
    expect(mock).not.toHaveBeenCalled();
  });
  it.each(CATALOG_TOOL_DEFS.filter((tool) => !tool.annotations.readOnlyHint))('$name requires operator writes and explicit confirmation before HTTP', async (definition) => {
    const mock = mockDaemon(() => json({}));
    const args = { ...samples[definition.name], confirm: true, requestId: 'once' };
    expect((await call(definition.name, args, new McpCatalogTools({ localOwner: true }))).content[0]!.text).toContain('MCP_WRITE_AUTHORITY_REQUIRED');
    expect((await call(definition.name, { ...args, confirm: false })).content[0]!.text).toContain('CONFIRMATION_REQUIRED');
    expect(mock).not.toHaveBeenCalled();
  });
  it.each(['/absolute', '../escape', 'a/../b', 'a%2fb', 'a\\b', 'https://remote.invalid', 'a?x=y', 'a#hash', ''])('rejects unsafe catalog id %s', async (id) => {
    const mock = mockDaemon(() => json({}));
    expect((await call('get_skill', { id })).isError).toBe(true); expect(mock).not.toHaveBeenCalled();
  });
  it.each(['sourceDir', 'path', 'url', 'source', 'apiKey', 'localOwner', 'workspaceId', '__proto__'])('rejects extra input %s before HTTP', async (key) => {
    const mock = mockDaemon(() => json({}));
    expect((await call('import_skill', { name: 'test-skill', body: 'Text', confirm: true, requestId: 'once', [key]: 'SECRET' })).isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });
  it.each(['apiKey', 'agentCliEnv', 'privacyDecisionAt', 'orbit', 'workspaceScopes', 'installationId', 'projectLocations', 'telemetry.auth'])('rejects forbidden management setting %s', async (key) => {
    const mock = mockDaemon(() => json({}));
    expect((await call('update_management_settings', { settings: { [key]: 'SECRET' }, confirm: true, requestId: 'once' })).isError).toBe(true); expect(mock).not.toHaveBeenCalled();
  });
  it.each([{}, { telemetry: { metrics: false } }, { telemetry: { metrics: false, content: false, token: 'SECRET' } }, { customInstructions: 'x'.repeat(5001) }, { odNextStrategyMode: 'other' }, { disabledSkills: ['/absolute'] }, { disabledDesignSystems: Array(201).fill('id') }])('rejects invalid settings %j', async (settings) => {
    const mock = mockDaemon(() => json({}));
    expect((await call('update_management_settings', { settings, confirm: true, requestId: 'once' })).isError).toBe(true); expect(mock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503])('directory failure HTTP %i never falls back to headerless', async (status) => {
    const mock = vi.fn(async () => json({ error: 'SECRET' }, status)); vi.stubGlobal('fetch', mock);
    expect((await call('get_skill', { id: 'test-skill' })).content[0]!.text).toContain('WORKSPACE_CONTEXT_REQUIRED'); expect(mock).toHaveBeenCalledTimes(1);
  });
  it('rejects non-loopback origin before discovery', async () => {
    const mock = mockDaemon(() => json({}));
    const result = await handleMcpToolCall('https://remote.invalid', 'get_plugin_stats', {}, { catalogTools: owner() });
    expect(result.content[0]!.text).toContain('MCP_LOCAL_OWNER_ONLY'); expect(mock).not.toHaveBeenCalled();
  });
});

describe('safe REST projections and management', () => {
  it('uses workspace headers and drops paths, sources, secrets and arbitrary manifest fields', async () => {
    const mock = mockDaemon((url) => url.endsWith('/skills') ? json({ skills: [skill] }) : url.endsWith('/plugins') ? json({ plugins: [plugin] }) : url.includes('/plugins/') ? json(plugin) : json(skill));
    expect(body(await call('get_plugin', { id: 'test-plugin' })).plugin.manifest.od.context).toEqual({ skills: [{ ref: 'skill:test-skill' }], designSystem: { ref: 'design-system:test' } });
    for (const [name, args] of [['get_skill', { id: 'test-skill' }], ['list_catalog_skills', {}], ['get_plugin', { id: 'test-plugin' }], ['list_catalog_plugins', {}]] as const) {
      const result = body(await call(name, args)); expect(JSON.stringify(result)).not.toContain('SECRET');
    }
    expect(mock.mock.calls.at(-1)![1]).toMatchObject({ headers: { 'x-od-workspace-id': 'ws-a', 'x-od-workspace-member-id': 'member-a' }, redirect: 'error' });
  });
  it('keeps file paths relative and hides raw diagnostics', async () => {
    mockDaemon((url) => url.endsWith('/files') ? json({ files: [{ path: 'SKILL.md', kind: 'file', size: 12, secret: 'SECRET' }, { path: '/private/SECRET', kind: 'file' }, { path: '../SECRET', kind: 'file' }] }) : json({ ok: false, issues: [{ severity: 'error', code: 'manifest.invalid', message: 'SECRET', field: '/private/SECRET' }], credentials: 'SECRET' }));
    expect(body(await call('list_skill_files', { id: 'test-skill' })).files).toEqual([{ path: 'SKILL.md', kind: 'file', size: 12 }]);
    expect(body(await call('doctor_plugin', { id: 'test-plugin' }))).toEqual({ pluginId: 'test-plugin', ok: false, issues: [{ severity: 'error', code: 'manifest.invalid' }] });
  });
  it('projects safe settings, accepts multiline/empty/null resets and sends only the patch', async () => {
    const mock = mockDaemon((_url, init) => json({ config: { customInstructions: 'one\ntwo', odNextStrategyMode: 'observe', telemetry: { metrics: false, content: false }, orbit: { token: 'SECRET' }, agentCliEnv: { token: 'SECRET' }, ...(init.body ? JSON.parse(String(init.body)) : {}) } }));
    expect(JSON.stringify(body(await call('get_management_settings')))).not.toContain('SECRET');
    for (const customInstructions of ['one\ntwo', '', null]) {
      const settings = { customInstructions, odNextStrategyMode: null, disabledSkills: [], telemetry: { metrics: false, content: false } };
      expect(body(await call('update_management_settings', { settings, confirm: true, requestId: `settings-${String(customInstructions).length}` })).settings).toMatchObject(settings);
      expect(JSON.parse(String(mock.mock.calls.at(-1)![1]?.body))).toEqual(settings);
    }
  });
  it('preserves omitted skill metadata, never writes a caller-selected name or directory', async () => {
    const mock = mockDaemon((_url, init) => init.method === 'PUT' ? json({ skill }) : json(skill));
    body(await call('update_skill', { id: 'test-skill', body: 'New\nbody', confirm: true, requestId: 'update' }));
    expect(JSON.parse(String(mock.mock.calls.at(-1)![1]?.body))).toEqual({ name: 'test-skill', body: 'New\nbody', description: 'Description', triggers: ['design'] });
  });
  it.each([{ ...skill, source: 'built-in' }, { ...skill, teamSynced: true }, { ...skill, name: 'different' }])('refuses unsafe skill mutation %j', async (value) => {
    const mock = mockDaemon(() => json(value));
    expect((await call('update_skill', { id: 'test-skill', body: 'Text', confirm: true, requestId: 'once' })).content[0]!.text).toContain('CATALOG_MUTATION_DENIED');
    expect(mock.mock.calls.some(([, init]) => init !== undefined && init.method === 'PUT')).toBe(false);
  });
  it.each([{ ...plugin, sourceKind: 'bundled' }, { ...plugin, source: 'team:plugin:one' }])('refuses bundled or team uninstall %j', async (value) => {
    const mock = mockDaemon(() => json(value));
    expect((await call('uninstall_plugin', { id: 'test-plugin', confirm: true, requestId: 'once' })).content[0]!.text).toContain('CATALOG_MUTATION_DENIED');
    expect(mock.mock.calls.some(([, init]) => init !== undefined && init.method === 'POST')).toBe(false);
  });
  it('deduplicates concurrent writes and rejects changed payload, tool or workspace', async () => {
    const session = owner(); const mock = mockDaemon(() => json({ skill }));
    const args = { name: 'test-skill', body: 'Text', confirm: true, requestId: 'once' };
    const results = await Promise.all([call('import_skill', args, session), call('import_skill', args, session)]);
    expect(results[0]).toEqual(results[1]); expect(mock.mock.calls.filter(([, init]) => init !== undefined && init.method === 'POST')).toHaveLength(1);
    expect((await call('import_skill', { ...args, body: 'changed' }, session)).content[0]!.text).toContain('IDEMPOTENCY_CONFLICT');
    expect((await call('delete_skill', { id: 'test-skill', confirm: true, requestId: 'once' }, session)).content[0]!.text).toContain('IDEMPOTENCY_CONFLICT');
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [{ ...directory.items[0], workspaceId: 'ws-b' }] })));
    expect((await call('import_skill', args, session)).content[0]!.text).toContain('IDEMPOTENCY_CONFLICT');
  });
  it('retains ambiguous write failures without replay or credential leakage', async () => {
    const session = owner(); const mock = mockDaemon(() => { throw new Error('SECRET'); });
    const args = { settings: { customInstructions: 'Text' }, confirm: true, requestId: 'once' };
    for (let i = 0; i < 2; i++) {
      const result = await call('update_management_settings', args, session);
      expect(result.content[0]!.text).toContain('outcome may be unknown'); expect(JSON.stringify(result)).not.toContain('SECRET');
    }
    expect(mock.mock.calls.filter(([, init]) => init !== undefined && init.method === 'PUT')).toHaveLength(1);
  });
  it.each([401, 403, 404, 500])('preserves HTTP %i without echoing upstream body', async (status) => {
    mockDaemon(() => json({ error: 'SECRET /private/home', token: 'SECRET' }, status));
    const result = await call('get_plugin', { id: 'test-plugin' }); expect(result.content[0]!.text).toContain(`HTTP ${status}`); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('reads a 3.27 MB /api/plugins catalogue with 465 entries, then returns only a safe bounded page', async () => {
    const plugins = Array.from({ length: 465 }, (_, index) => ({ ...plugin, id: `plugin-${index}`, source: 'SECRET'.repeat(1200) }));
    const serialized = JSON.stringify({ plugins });
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(3_267_245);
    mockDaemon(() => new Response(serialized));
    const page = body(await call('list_catalog_plugins', { offset: 450, limit: 10 }));
    expect(page).toMatchObject({ total: 465, offset: 450, limit: 10, nextOffset: 460, upstreamLimitBytes: 8 * 1024 * 1024 });
    expect(page.plugins).toHaveLength(10); expect(page.plugins[0].id).toBe('plugin-450');
    expect(JSON.stringify(page)).not.toContain('SECRET');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16 * 1024);
    expect(body(await call('list_catalog_plugins', { offset: 460 })).nextOffset).toBeNull();
  });
  it.each([{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }, { limit: '10' }])('rejects invalid pagination before HTTP: %j', async (args) => {
    const mock = mockDaemon(() => json({}));
    expect((await call('list_catalog_plugins', args)).isError).toBe(true); expect(mock).not.toHaveBeenCalled();
  });
  it('rejects oversized or malformed REST responses', async () => {
    mockDaemon(() => new Response('SECRET-not-json'));
    expect((await call('get_plugin_stats')).content[0]!.text).toContain('INVALID_DAEMON_RESPONSE');
    mockDaemon(() => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    expect((await call('get_plugin_stats')).content[0]!.text).toContain('RESPONSE_TOO_LARGE');
  });
});
