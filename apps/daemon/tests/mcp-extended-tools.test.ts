import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpDaemonTarget, handleMcpToolCall, localMcpToolDefinitions, TOOL_DEFS } from '../src/mcp.js';
import { EXTENDED_TOOL_DEFS, McpExtendedTools } from '../src/mcp/extended-tools.js';
import { _resetMcpWorkspaceContextCacheForTests } from '../src/mcp-workspace-context.js';

const base = 'http://127.0.0.1:19234';
const project = '11111111-1111-1111-1111-111111111111';
const directory = { items: [{ workspaceId: 'ws-a', workspaceMemberId: 'member-a', workspaceType: 'personal', memberStatus: 'active', lifecycleState: 'active' }] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const body = (result: Awaited<ReturnType<typeof handleMcpToolCall>>) => JSON.parse(result.content[0]!.text);
const owner = () => new McpExtendedTools({ localOwner: true, allowWrites: true });
const call = (name: string, args: Record<string, unknown> = {}, extendedTools = owner()) => handleMcpToolCall(base, name, args, { extendedTools });

function mockDaemon(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/api/workspace/directory')) return json(directory);
    if (url.endsWith('/api/agents?stream=1')) {
      const result = await handler(url.replace('?stream=1', ''), init);
      const catalog = await result.json() as { agents?: unknown[] };
      return new Response((catalog.agents ?? []).map((agent) => `event: agent\ndata: ${JSON.stringify(agent)}\n\n`).join('') + 'event: done\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => { vi.unstubAllGlobals(); _resetMcpWorkspaceContextCacheForTests(); });

describe('MCP sensitive extension policy', () => {
  it('registers unique definitions through the public MCP catalogue', () => {
    expect(new Set(TOOL_DEFS.map((tool) => tool.name)).size).toBe(TOOL_DEFS.length);
    for (const definition of EXTENDED_TOOL_DEFS) expect(TOOL_DEFS).toContain(definition);
    expect(localMcpToolDefinitions().filter((tool) => EXTENDED_TOOL_DEFS.some((ext) => ext.name === tool.name)).map((tool) => tool.name)).toEqual(['get_mcp_capabilities']);
    expect(localMcpToolDefinitions({ localOwner: true }).some((tool) => tool.name === 'publish_project')).toBe(false);
    expect(localMcpToolDefinitions({ localOwner: true, allowWrites: true }).some((tool) => tool.name === 'publish_project')).toBe(true);
  });

  it.each(EXTENDED_TOOL_DEFS.filter((tool) => tool.name !== 'get_mcp_capabilities').map((tool) => [tool.name, tool.inputSchema]))('shared %s never uses daemon default workspace', async (name, schema) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const args: Record<string, unknown> = {};
    for (const field of schema.required ?? []) {
      const prop = schema.properties![field]!;
      args[field] = prop.type === 'object' ? Object.fromEntries((prop.required ?? []).map((key) => [key, prop.properties?.[key]?.enum?.[0] ?? 'value'])) : prop.type === 'boolean' ? true : prop.enum?.[0] ?? 'value';
    }
    const result = await handleMcpToolCall(base, name, args);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('MCP_CALLER_AUTHORITY_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports shared authorization as blocked without daemon access', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(body(await handleMcpToolCall(base, 'get_mcp_capabilities', {}))).toMatchObject({ mode: 'shared-unbound', sensitiveReads: false, writes: false, callerWorkspaceBinding: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ localOwner: true }, { localOwner: true, allowWrites: true }])('never treats caller args or metadata as authority: %j', async (forged) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const result = await handleMcpToolCall(base, 'list_conversations', { project, ...forged });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-loopback origins even in operator-selected mode', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const result = await handleMcpToolCall('https://example.com', 'get_settings', {}, { extendedTools: owner() });
    expect(result.content[0]!.text).toContain('MCP_LOCAL_OWNER_ONLY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires operator write opt-in before directory discovery', async () => {
    const mock = mockDaemon(() => json({}));
    const result = await call('rename_conversation', { project, conversationId: 'c1', title: 'New', requestId: 'r1' }, new McpExtendedTools({ localOwner: true }));
    expect(result.content[0]!.text).toContain('MCP_WRITE_AUTHORITY_REQUIRED');
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(['delete_conversation', 'restore_file_version', 'publish_project'])('%s requires literal confirmation before any HTTP call', async (name) => {
    const mock = mockDaemon(() => json({}));
    const args = name === 'delete_conversation' ? { project, conversationId: 'c1', confirm: false, requestId: 'r1' } : name === 'restore_file_version' ? { project, path: 'index.html', versionId: 'v1', confirm: false, requestId: 'r1' } : { project, path: 'index.html', providerId: 'vercel-self', target: 'preview', confirm: false, requestId: 'r1' };
    expect((await call(name, args)).content[0]!.text).toContain('CONFIRMATION_REQUIRED');
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])('directory HTTP %i cannot fall back to headerless access', async (status) => {
    const mock = vi.fn(async () => json({ error: 'denied' }, status)); vi.stubGlobal('fetch', mock);
    expect((await call('list_conversations', { project })).content[0]!.text).toContain('WORKSPACE_CONTEXT_REQUIRED');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 503])('REST HTTP %i preserves denial and does not retry or echo secrets', async (status) => {
    const mock = mockDaemon(() => json({ error: { code: 'WORKSPACE_PROJECT_PERMISSION_DENIED', message: 'token=SECRET /private/home' } }, status));
    const result = await call('list_conversations', { project });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`HTTP ${status}`);
    expect(result.content[0]!.text).not.toContain('SECRET');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1]![1]?.headers).toMatchObject({ 'x-od-workspace-id': 'ws-a', 'x-od-workspace-member-id': 'member-a' });
  });
});

describe('MCP history and safe preferences', () => {
  it('gets exact conversations and messages, with bounded history pages', async () => {
    mockDaemon((url) => url.endsWith('/messages') ? json({ messages: [{ id: 'm1', content: 'one' }, { id: 'm2', content: 'two' }] }) : json({ conversations: [{ id: 'c1', title: 'Demo' }] }));
    expect(body(await call('get_conversation', { project, conversationId: 'c1' }))).toEqual({ conversation: { id: 'c1', title: 'Demo' } });
    expect(body(await call('list_messages', { project, conversationId: 'c1', offset: 1, limit: 1 }))).toMatchObject({ messages: [{ id: 'm2' }], total: 2 });
    expect(body(await call('get_message', { project, conversationId: 'c1', messageId: 'm1' }))).toMatchObject({ message: { content: 'one' } });
    expect((await call('get_message', { project, conversationId: 'c1', messageId: 'other' })).isError).toBe(true);
  });

  it.each([-1, 201, 1.5, '10'])('rejects invalid history limit %s before HTTP', async (limit) => {
    const mock = mockDaemon(() => json({}));
    expect((await call('list_messages', { project, conversationId: 'c1', limit })).isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  it('bounds message pages without breaking JSON or UTF-8 and marks omitted event logs', async () => {
    mockDaemon(() => json({ messages: Array.from({ length: 100 }, (_, index) => ({ id: `m${index}`, role: 'assistant', content: '设计\u0000😀'.repeat(2000), events: ['large event log'] })) }));
    const result = await call('list_messages', { project, conversationId: 'c1', limit: 100 });
    const page = body(result);
    expect(page.messages).toHaveLength(100);
    expect(page.messages.every((message: Record<string, unknown>) => message.truncated === true && message.omittedFieldCount === 1)).toBe(true);
    expect(page.messages[0].content).not.toContain('\ufffd');
    expect(Buffer.byteLength(result.content[0]!.text, 'utf8')).toBeLessThan(512 * 1024);
    expect(page.nextOffset).toBeNull();
  });

  it('refuses a repeated mutation after the workspace identity changes', async () => {
    const session = owner();
    mockDaemon(() => json({ ok: true }));
    const args = { project, conversationId: 'c1', title: 'new', requestId: 'r1' };
    expect((await call('rename_conversation', args, session)).isError).not.toBe(true);
    const changed = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/directory') ? json({ items: [{ ...directory.items[0], workspaceId: 'ws-b' }] }) : json({ ok: true }));
    vi.stubGlobal('fetch', changed);
    expect((await call('rename_conversation', args, session)).content[0]!.text).toContain('IDEMPOTENCY_CONFLICT');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it.each(['agentCliEnv', 'agentCliEnvIntent', 'apiKey', 'token', 'mcpTokens', 'orbit', 'customInstructions', '__proto__'])('rejects forbidden settings key %s before HTTP', async (key) => {
    const mock = mockDaemon(() => json({}));
    expect((await call('update_settings', { settings: { [key]: 'SECRET' }, requestId: 'r' })).isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  it('projects preference GET and PUT outputs and never round-trips credentials', async () => {
    const config = { agentId: 'codex', skillId: 'web', agentCliEnv: { codex: { OPENAI_API_KEY: 'SECRET' } }, mcpTokens: 'SECRET', orbit: { enabled: true }, agentModels: { codex: { model: 'model-a', apiKey: 'SECRET' }, claude: { reasoning: 'high' } } };
    const seen: RequestInit[] = [];
    mockDaemon((url, init) => { seen.push(init); return url.endsWith('/api/agents') ? json({ agents: [{ id: 'codex', available: true, modelsSource: 'live', models: [{ id: 'model-a', serviceTierOptions: [{ id: 'fast' }] }] }] }) : json({ config }); });
    expect(body(await call('get_settings'))).toEqual({ settings: { agentId: 'codex', skillId: 'web' } });
    expect(body(await call('get_model_preferences'))).toEqual({ agentModels: { codex: { model: 'model-a' }, claude: { reasoning: 'high' } } });
    const updated = await call('update_settings', { settings: { skillId: 'new' }, requestId: 's1' });
    expect(JSON.stringify(updated)).not.toContain('SECRET');
    expect(JSON.parse(String(seen.at(-1)!.body))).toEqual({ skillId: 'new' });
    const model = await call('update_model_preferences', { agent: 'codex', preferences: { serviceTier: 'fast' }, requestId: 'm1' });
    expect(JSON.stringify(model)).not.toContain('SECRET');
    expect(JSON.parse(String(seen.at(-1)!.body))).toEqual({ agentModels: { codex: { model: 'model-a', serviceTier: 'fast' }, claude: { reasoning: 'high' } } });
  });

  it('refuses nested model credential injection', async () => {
    const mock = mockDaemon(() => json({}));
    expect((await call('update_model_preferences', { agent: 'codex', preferences: { apiKey: 'SECRET' }, requestId: 'r1' })).isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    [{ agents: [] }, {}, 'MODEL_CATALOG_UNAVAILABLE'],
    [{ agents: [{ id: 'codex', available: false, modelsSource: 'live', models: [] }] }, {}, 'MODEL_CATALOG_UNAVAILABLE'],
    [{ agents: [{ id: 'codex', available: true, modelsSource: 'fallback', models: [{ id: 'current' }] }] }, {}, 'MODEL_CATALOG_UNAVAILABLE'],
    [{ agents: [{ id: 'codex', available: true, authStatus: 'missing', modelsSource: 'live', models: [{ id: 'current' }] }] }, {}, 'MODEL_CATALOG_UNAVAILABLE'],
    [{ agents: [{ id: 'codex', available: true, modelsSource: 'live', models: [{ id: 'current', enabled: false }] }] }, {}, 'MODEL_NOT_AVAILABLE'],
    [{ agents: [{ id: 'codex', available: true, modelsSource: 'live', models: [{ id: 'current' }] }] }, { model: 'unknown' }, 'MODEL_NOT_AVAILABLE'],
    [{ agents: [{ id: 'codex', available: true, modelsSource: 'live', models: [{ id: 'current' }] }] }, { reasoning: 'unknown' }, 'MODEL_OPTION_NOT_AVAILABLE'],
    [{ agents: [{ id: 'codex', available: true, modelsSource: 'live', models: [{ id: 'current', serviceTierOptions: [{ id: 'fast', enabled: false }] }] }] }, { serviceTier: 'fast' }, 'MODEL_OPTION_NOT_AVAILABLE'],
  ] as const)('rejects unavailable catalog/model/options without config writes: %s', async (catalog, preferences, code) => {
    const mock = mockDaemon((url) => url.endsWith('/api/agents') ? json(catalog) : json({ config: { agentModels: { codex: { model: 'current' } } } }));
    const result = await call('update_model_preferences', { agent: 'codex', preferences: { model: 'current', ...preferences }, requestId: 'update' });
    expect(result.content[0]!.text).toContain(code);
    expect(mock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('does not reset incompatible old fields when changing models', async () => {
    const mock = mockDaemon((url) => url.endsWith('/api/agents') ? json({ agents: [{ id: 'codex', available: true, modelsSource: 'live', models: [{ id: 'new', reasoningOptions: [{ id: 'low' }] }] }] }) : json({ config: { agentModels: { codex: { model: 'old', reasoning: 'high' } } } }));
    const result = await call('update_model_preferences', { agent: 'codex', preferences: { model: 'new' }, requestId: 'update' });
    expect(result.content[0]!.text).toContain('MODEL_OPTION_NOT_AVAILABLE');
    expect(mock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });
});

describe('MCP export, design and mutation contracts', () => {
  it.each(['../secret', '/absolute', 'a/../b', 'a%2fb', '.file-versions/x', 'a\\b', 'a?x=y', 'a#hash'])('rejects unsafe path %s before project API', async (path) => {
    const mock = mockDaemon(() => json({}));
    expect((await call('get_preview_url', { project, path })).isError).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1); // Directory only, never project/files.
  });

  it.each([
    ['get_export_manifest', {}, '/export/manifest', 'GET'],
    ['deployment_preflight', { path: 'pages/home.html', providerId: 'cloudflare-pages' }, '/deploy/preflight', 'POST'],
    ['list_deployments', {}, '/deployments', 'GET'],
    ['list_file_versions', { path: 'pages/home.html' }, '/files/pages/home.html/versions', 'GET'],
    ['get_file_version', { path: 'pages/home.html', versionId: 'v1' }, '/files/pages/home.html/versions/v1', 'GET'],
    ['create_file_version', { path: 'pages/home.html', requestId: 'v1' }, '/files/pages/home.html/versions', 'POST'],
    ['restore_file_version', { path: 'pages/home.html', versionId: 'v1', confirm: true, requestId: 'v1' }, '/files/pages/home.html/versions/v1/restore', 'POST'],
    ['get_preview_url', { path: 'pages/home.html' }, '/preview-url?file=pages%2Fhome.html', 'GET'],
  ] as const)('%s uses existing REST endpoint and workspace headers', async (name, extra, suffix, method) => {
    const mock = mockDaemon(() => json({ ok: true }));
    expect((await call(name, { project, ...extra })).isError).not.toBe(true);
    expect(mock.mock.calls.at(-1)![0]).toBe(`${base}/api/projects/${project}${suffix}`);
    expect(mock.mock.calls.at(-1)![1]).toMatchObject({ method, redirect: 'error', headers: { 'x-od-workspace-id': 'ws-a', 'x-od-workspace-member-id': 'member-a' } });
  });

  it('returns actual export bytes without treating them as JSON', async () => {
    mockDaemon((_url, init) => { expect(JSON.parse(String(init.body))).toEqual({ fileName: 'index.html', format: 'html' }); return new Response('<h1>exported</h1>', { headers: { 'content-type': 'text/html' } }); });
    const result = body(await call('export_project', { project, path: 'index.html', format: 'html' }));
    expect(Buffer.from(result.data, 'base64').toString()).toBe('<h1>exported</h1>');
    expect(result).toMatchObject({ mimeType: 'text/html', encoding: 'base64', size: 17 });
  });

  it('caps streamed export bytes and reports unavailable renderer without leaking its body', async () => {
    mockDaemon(() => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    expect((await call('export_project', { project, path: 'index.html', format: 'html' })).content[0]!.text).toContain('RESPONSE_TOO_LARGE');
    mockDaemon(() => json({ error: { code: 'DESKTOP_REQUIRED', message: 'SECRET' } }, 503));
    const result = await call('export_project', { project, path: 'index.html', format: 'pdf' });
    expect(result.content[0]!.text).toContain('DESKTOP_REQUIRED');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each(['rename_conversation', 'delete_conversation', 'publish_project'])('deduplicates concurrent %s and detects requestId reuse', async (name) => {
    const session = owner();
    const mock = mockDaemon(() => json({ ok: true }));
    const args = name === 'publish_project' ? { project, path: 'index.html', providerId: 'vercel-self', target: 'preview', confirm: true, requestId: 'same' } : name === 'delete_conversation' ? { project, conversationId: 'c1', confirm: true, requestId: 'same' } : { project, conversationId: 'c1', title: 'new', requestId: 'same' };
    const results = await Promise.all([call(name, args, session), call(name, args, session)]);
    expect(results[0]).toEqual(results[1]);
    expect(mock.mock.calls.filter(([url]) => !String(url).endsWith('/directory'))).toHaveLength(1);
    const changed = { ...args, project: '22222222-2222-2222-2222-222222222222' };
    expect((await call(name, changed, session)).content[0]!.text).toContain('IDEMPOTENCY_CONFLICT');
  });

  it('retains ambiguous publish failure instead of replaying it', async () => {
    const session = owner();
    const mock = mockDaemon(() => { throw new TypeError('connection lost SECRET'); });
    const args = { project, path: 'index.html', providerId: 'vercel-self', target: 'preview', confirm: true, requestId: 'once' };
    expect((await call('publish_project', args, session)).content[0]!.text).toContain('outcome may be unknown');
    expect((await call('publish_project', args, session)).isError).toBe(true);
    expect(mock.mock.calls.filter(([url]) => !String(url).endsWith('/directory'))).toHaveLength(1);
  });

  it('never automatically replays new mutations after daemon rediscovery', async () => {
    const target = createMcpDaemonTarget({ daemonUrl: base, resolveDaemonUrl: async () => base });
    const invoke = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'cannot reach the OpenDesign daemon' }], isError: true }));
    await target.call('publish_project', {}, invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});


describe('MCP bounded visual editing', () => {
  const patchArgs = { project, path: 'index.html', requestId: 'visual-1', expectedHash: 'a'.repeat(64), confirm: true, patch: { kind: 'set-text', id: 'title', value: '' } };
  it('exposes owner-only read/write tools and accurate capabilities', async () => {
    expect(localMcpToolDefinitions({ localOwner: true }).map((t) => t.name)).toContain('get_visual_edit_targets');
    expect(localMcpToolDefinitions({ localOwner: true }).map((t) => t.name)).not.toContain('apply_visual_edit_patch');
    expect(body(await call('get_mcp_capabilities')).visualEditing).toMatchObject({ supported: true, staticHtmlOnly: true, requiresHash: true });
  });
  it('requires write opt-in and explicit confirmation before HTTP access', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    expect((await call('apply_visual_edit_patch', patchArgs, new McpExtendedTools({ localOwner: true }))).content[0]!.text).toContain('MCP_WRITE_AUTHORITY_REQUIRED');
    expect((await call('apply_visual_edit_patch', { ...patchArgs, confirm: false })).content[0]!.text).toContain('CONFIRMATION_REQUIRED');
    expect(mock).not.toHaveBeenCalled();
  });
  it('sends strict patch with workspace headers and deduplicates a write', async () => {
    const mock = mockDaemon(() => json({ hash: 'b'.repeat(64), versionId: 'v1' }));
    const session = owner();
    const first = await call('apply_visual_edit_patch', patchArgs, session);
    expect(first.isError).not.toBe(true);
    expect(await call('apply_visual_edit_patch', patchArgs, session)).toEqual(first);
    const writes = mock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toContain(`/api/projects/${project}/files/index.html/visual-patch`);
    expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({ patch: patchArgs.patch, expectedHash: patchArgs.expectedHash, confirm: true });
    expect(writes[0]![1]?.headers).toMatchObject({ 'x-od-workspace-id': 'ws-a' });
  });
  it.each([{ kind: 'set-text', id: 'title', value: 'x', onclick: 'evil' }, { kind: 'set-link', id: 'title', text: 'x', href: 'javascript:evil()' }, { kind: 'set-style', id: 'title', styles: { color: 'red; background:url(x)' } }])('rejects injection before daemon access %j', async (patch) => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    expect((await call('apply_visual_edit_patch', { ...patchArgs, patch })).isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });
});
