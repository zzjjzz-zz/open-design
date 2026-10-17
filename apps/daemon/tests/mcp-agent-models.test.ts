import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLiveAgentModels } from '../src/mcp/agent-models.js';
import { McpExtendedTools } from '../src/mcp/extended-tools.js';
import { _resetMcpWorkspaceContextCacheForTests } from '../src/mcp-workspace-context.js';

const base = 'http://127.0.0.1:19236';
const agent = { id: 'agy', available: true, modelsSource: 'live', models: Array.from({ length: 14 }, (_, index) => ({ id: `opaque-model-${index}`, label: `模型 ${index}`, reasoningOptions: [{ id: 'high', enabled: true }], apiKey: 'SECRET' })), executablePath: '/private/SECRET', stderr: 'SECRET' };
const event = (value: unknown) => `event: agent\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
function sse(text: string, step = 11) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) { controller.close(); return; } controller.enqueue(bytes.slice(offset, offset += step)); } }), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); _resetMcpWorkspaceContextCacheForTests(); });

describe('progressive live agent model catalogue', () => {
  it('handles chunked CRLF, UTF-8, comments and other agents, returning 14 opaque IDs without sensitive fields', async () => {
    const mock = vi.fn(async () => sse(`: heartbeat\r\n\r\n${event({ ...agent, id: 'other' })}${event(agent)}event: done\r\ndata: {}\r\n\r\n`, 1));
    vi.stubGlobal('fetch', mock);
    const value = await readLiveAgentModels(base, { 'x-od-workspace-id': 'ws' }, 'agy');
    expect(value).toMatchObject({ id: 'agy', modelsSource: 'live', models: expect.arrayContaining([expect.objectContaining({ id: 'opaque-model-13' })]) });
    expect(value.models).toHaveLength(14); expect(JSON.stringify(value)).not.toContain('SECRET'); expect(JSON.stringify(value)).not.toContain('\ufffd');
    expect(mock.mock.calls[0]).toHaveLength(2);
  });
  it.each([
    { ...agent, modelsSource: 'fallback', models: [{ id: 'default' }] },
    { ...agent, available: false }, { ...agent, authStatus: 'missing' }, { ...agent, models: [] },
    { ...agent, models: [{ id: 'duplicate' }, { id: 'duplicate' }] },
    { ...agent, models: [{ label: 'missing id' }] },
  ])('refuses unavailable, fallback or invalid catalogue %j', async (value) => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(event(value))));
    await expect(readLiveAgentModels(base, {}, 'agy')).rejects.toThrow('MODEL_CATALOG_UNAVAILABLE');
  });
  it.each(['event: done\ndata: {}\n\n', 'event: error\ndata: {"secret":"SECRET"}\n\n', 'event: agent\ndata: not-json SECRET\n\n', 'event: agent\ndata: {}'])('refuses missing, malformed and interrupted probes', async (text) => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(text)));
    await expect(readLiveAgentModels(base, {}, 'agy')).rejects.toThrow(/^MODEL_CATALOG_UNAVAILABLE:/);
  });
  it('caps bytes and rejects JSON bulk results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse('x'.repeat(2 * 1024 * 1024 + 1), 1024 * 1024)));
    await expect(readLiveAgentModels(base, {}, 'agy')).rejects.toThrow('exceeds limit');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agents: [agent] }), { headers: { 'content-type': 'application/json' } })));
    await expect(readLiveAgentModels(base, {}, 'agy')).rejects.toThrow('expected progressive probe');
  });
  it('aborts a stalled probe and closes the reader at the deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(controller) { init.signal!.addEventListener('abort', () => controller.error(new Error('SECRET'))); } }), { headers: { 'content-type': 'text/event-stream' } })));
    const result = readLiveAgentModels(base, {}, 'agy');
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000); await assertion;
  });
  it('model preference writes use progressive live data even when bulk returns fallback; mismatches never write', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/directory')) return new Response(JSON.stringify({ items: [{ workspaceId: 'ws', workspaceMemberId: 'm', workspaceType: 'personal', memberStatus: 'active', lifecycleState: 'active' }] }));
      if (url.endsWith('/api/agents?stream=1')) return sse(event(agent));
      if (url.endsWith('/api/agents')) return new Response(JSON.stringify({ agents: [{ ...agent, modelsSource: 'fallback', models: [{ id: 'default' }] }] }));
      seen.push(init);
      return new Response(JSON.stringify({ config: { agentModels: { agy: { model: 'opaque-model-13' } } } }));
    }));
    const tools = new McpExtendedTools({ localOwner: true, allowWrites: true });
    const resolve = async () => 'project';
    await tools.call(base, 'update_model_preferences', { agent: 'agy', preferences: { reasoning: 'high' }, requestId: 'live' }, resolve);
    expect(JSON.parse(String(seen.at(-1)?.body))).toEqual({ agentModels: { agy: { model: 'opaque-model-13', reasoning: 'high' } } });
    await expect(tools.call(base, 'update_model_preferences', { agent: 'agy', preferences: { model: 'default' }, requestId: 'fallback' }, resolve)).rejects.toThrow('MODEL_NOT_AVAILABLE');
    expect(seen.filter((init) => init.method === 'PUT')).toHaveLength(1);
  });
});
