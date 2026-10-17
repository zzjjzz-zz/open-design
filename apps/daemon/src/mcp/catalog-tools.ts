import { createHash } from 'node:crypto';
import { resolveMcpWorkspaceContext } from '../mcp-workspace-context.js';
import { readLiveAgentModels } from './agent-models.js';

type ObjectValue = Record<string, unknown>;
export type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: false; items?: Schema; enum?: string[]; pattern?: string; minLength?: number; maxLength?: number; maxItems?: number; minProperties?: number; anyOf?: Schema[]; minimum?: number; maximum?: number };
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const text = (maxLength = 1024, minLength = 0): Schema => ({ type: 'string', minLength, maxLength });
const id: Schema = { ...text(128, 1), pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' };
const slug: Schema = { ...text(64, 1), pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' };
const boolean: Schema = { type: 'boolean' };
const array = (items: Schema, maxItems = 200): Schema => ({ type: 'array', items, maxItems });
const page = { offset: { type: 'integer', minimum: 0, maximum: 1_000_000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const write = { confirm: boolean, requestId: { ...text(128, 1), pattern: '^[A-Za-z0-9_-]{1,128}$' } };
const writeRequired = ['confirm', 'requestId'];
const skillInput = { description: text(5000), body: text(64 * 1024, 1), triggers: array(text(256, 1), 50) };
const settings = object({
  customInstructions: { anyOf: [text(5000), { type: 'null' }] },
  odNextStrategyMode: { anyOf: [{ type: 'string', enum: ['off', 'observe', 'active'] }, { type: 'null' }] },
  // REST replaces this nested object. Require both fields to avoid resetting
  // an omitted telemetry preference through a partial nested patch.
  telemetry: object({ metrics: boolean, content: boolean }, ['metrics', 'content']),
  disabledSkills: array(id), disabledDesignSystems: array(id),
});

function tool(name: string, description: string, properties: Record<string, Schema> = {}, required: string[] = [], mutation = false) {
  return { name, description: `${description} Requires operator-selected local-owner mode and a verified active workspace. Writes also require allowWrites, confirm:true and requestId (process-local replay ledger; inspect state after restart).`, inputSchema: object(properties, required), annotations: { title: name.replaceAll('_', ' '), readOnlyHint: !mutation, destructiveHint: mutation, idempotentHint: true, openWorldHint: false } };
}

export const CATALOG_TOOL_DEFS = [
  tool('list_catalog_skills', 'List workspace-visible skills with safe metadata only. Bridge-side pagination: offset/limit default 0/50, max 100; full upstream JSON is capped at 8 MiB.', page),
  tool('get_skill', 'Read a skill body and safe metadata by exact catalog id.', { id }, ['id']),
  tool('list_skill_files', 'List relative skill file names, kinds and sizes. Does not read arbitrary files.', { id }, ['id']),
  tool('import_skill', 'Import inline skill text only; no paths, URLs, archives or executable installation.', { name: slug, ...skillInput, ...write }, ['name', 'body', ...writeRequired], true),
  tool('update_skill', 'Replace a user skill body/description/triggers. Only existing user skills; no built-in shadow copies or Team edits. Omitted description/triggers are preserved.', { id: slug, ...skillInput, ...write }, ['id', 'body', ...writeRequired], true),
  tool('delete_skill', 'Delete an existing user skill through REST permission checks; refuses bundled and Team skills.', { id: slug, ...write }, ['id', ...writeRequired], true),
  tool('list_catalog_plugins', 'List workspace-visible plugins with safe metadata only. Bridge-side pagination: offset/limit default 0/50, max 100; full upstream JSON is capped at 8 MiB.', page),
  tool('get_plugin', 'Read safe plugin details including capability declarations and context references. Omits install sources, filesystem paths, credentials and arbitrary manifest extension data.', { id }, ['id']),
  tool('get_plugin_stats', 'Read workspace-scoped plugin and snapshot inventory counts.'),
  tool('doctor_plugin', 'Run existing plugin lint/connector-presence diagnostics without apply/install or model calls. Returns diagnostic codes/severity only; raw messages may contain sensitive data.', { id }, ['id']),
  tool('uninstall_plugin', 'Uninstall an existing non-bundled, non-Team plugin through REST permission checks. Does not accept paths or sources.', { id: slug, ...write }, ['id', ...writeRequired], true),
  tool('get_management_settings', 'Read additional safe preferences: customInstructions, odNextStrategyMode, telemetry, disabledSkills and disabledDesignSystems. Credentials and privacy/auth/policy controls are excluded.'),
  tool('update_management_settings', 'Patch the additional safe preference allowlist only. telemetry requires both metrics/content; null resets instructions/strategy. No key, privacy/auth, orbit or workspaceScope writes.', { settings: { ...settings, minProperties: 1 }, ...write }, ['settings', ...writeRequired], true),
  tool('create_conversation', 'Create an empty conversation in an explicitly selected project. Does not seed history, run an agent or call a model.', { project: id, title: text(256, 1), sessionMode: { type: 'string', enum: ['design', 'chat', 'plan'] }, ...write }, ['project', ...writeRequired], true),
  tool('list_available_agent_models', 'Probe the existing progressive agent SSE endpoint and return only the requested available agent live model IDs/options. Bounded to 30 seconds/2 MiB; fallback catalogs are refused. Discovery does not prove inference or entitlement.', { agent: { ...text(64, 1), pattern: '^[a-z][a-z0-9-]{0,63}$' } }, ['agent']),
];
export const CATALOG_TOOL_NAMES = new Set(CATALOG_TOOL_DEFS.map((definition) => definition.name));

function record(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(): never { throw new Error('INVALID_ARGUMENT: unsupported field or invalid value'); }
function validate(value: unknown, schema: Schema): void {
  if (schema.anyOf) {
    for (const variant of schema.anyOf) { try { validate(value, variant); return; } catch { /* Try the next declared variant. */ } }
    invalid();
  }
  if (schema.type === 'object') {
    if (!record(value) || Object.keys(value).length < (schema.minProperties ?? 0)) invalid();
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid();
    for (const [key, child] of Object.entries(value)) {
      if (!schema.properties || !Object.hasOwn(schema.properties, key)) invalid();
      validate(child, schema.properties[key]!);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 200)) invalid();
    value.forEach((child) => validate(child, schema.items!));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 1024) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) || (schema.minLength && !value.trim()) || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) || (schema.enum && !schema.enum.includes(value))) invalid();
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid();
  } else if (schema.type === 'null' ? value !== null : typeof value !== schema.type) invalid();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function pick(value: unknown, keys: string[]): ObjectValue {
  if (!record(value)) throw new Error('INVALID_DAEMON_RESPONSE: expected object');
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}
function scalars(value: unknown, keys: string[]): ObjectValue {
  return Object.fromEntries(Object.entries(pick(value, keys)).filter(([, item]) => item === null || ['string', 'boolean', 'number'].includes(typeof item)));
}
function stringLists(value: unknown, keys: string[]): ObjectValue {
  return Object.fromEntries(Object.entries(pick(value, keys)).filter(([, item]) => Array.isArray(item)).map(([key, item]) => [key, (item as unknown[]).filter((child) => typeof child === 'string')]));
}
function skill(value: unknown): ObjectValue {
  return { ...scalars(value, ['id', 'name', 'description', 'body', 'hasBody', 'mode', 'surface', 'source', 'category', 'teamSynced']), ...stringLists(value, ['triggers', 'craftRequires']) };
}
function plugin(value: unknown): ObjectValue {
  const result = { ...scalars(value, ['id', 'title', 'version', 'sourceKind', 'trust', 'installedAt', 'updatedAt']), ...stringLists(value, ['capabilitiesGranted']) };
  if (!record(value) || !record(value.manifest)) throw new Error('INVALID_DAEMON_RESPONSE: expected manifest');
  const manifest = scalars(value.manifest, ['name', 'title', 'version', 'description']);
  if (record(value.manifest.od)) {
    const od = value.manifest.od;
    const context: ObjectValue = record(od.context) ? stringLists(od.context, ['craft', 'atoms']) : {};
    const reference = (item: unknown): ObjectValue | null => record(item) && typeof item.ref === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(item.ref) ? { ref: item.ref } : null;
    if (record(od.context)) {
      if (Array.isArray(od.context.skills)) context.skills = od.context.skills.map(reference).filter((item) => item !== null);
      const designSystem = reference(od.context.designSystem);
      if (designSystem) context.designSystem = designSystem;
    }
    manifest.od = { ...scalars(od, ['taskKind']), ...stringLists(od, ['capabilities']), ...(record(od.context) ? { context } : {}) };
  }
  return { ...result, manifest };
}
function safeSettings(value: unknown): ObjectValue {
  if (!record(value)) throw new Error('INVALID_DAEMON_RESPONSE: expected config');
  const result: ObjectValue = {};
  for (const [key, schema] of Object.entries(settings.properties!)) {
    if (!Object.hasOwn(value, key)) continue;
    try { validate(value[key], schema); result[key] = value[key]; } catch { /* Omit malformed/expanded fields. */ }
  }
  return result;
}

/** Only fixed REST routes and inline content cross this boundary. The daemon
 * retains its existing authorization and resource ownership decisions. */
export class McpCatalogTools {
  private readonly requests = new Map<string, { digest: string; task: Promise<unknown> }>();
  constructor(private readonly access: { localOwner?: boolean; allowWrites?: boolean } = {}) {}

  async call(baseUrl: string, name: string, args: ObjectValue, resolveProject: (project: string, headers: Record<string, string>) => Promise<string>): Promise<unknown> {
    const definition = CATALOG_TOOL_DEFS.find((item) => item.name === name);
    if (!definition) throw new Error('UNKNOWN_TOOL');
    validate(args, definition.inputSchema);
    if (!this.access.localOwner) throw new Error('MCP_CALLER_AUTHORITY_REQUIRED: operator-selected owner mode is required');
    const origin = new URL(baseUrl);
    if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)) throw new Error('MCP_LOCAL_OWNER_ONLY: a loopback daemon origin is required');
    const mutation = !definition.annotations.readOnlyHint;
    if (mutation && !this.access.allowWrites) throw new Error('MCP_WRITE_AUTHORITY_REQUIRED: operator write opt-in is required');
    if (mutation && args.confirm !== true) throw new Error('CONFIRMATION_REQUIRED: explicit confirm=true is required');
    const workspace = await resolveMcpWorkspaceContext(baseUrl, { force: true });
    if (!workspace) throw new Error('WORKSPACE_CONTEXT_REQUIRED: no active verified workspace; no headerless fallback');
    const execute = () => this.execute(baseUrl, name, args, workspace.headers, resolveProject);
    if (!mutation) return execute();
    const key = String(args.requestId);
    const digest = createHash('sha256').update(canonical({ baseUrl, name, args, workspace: workspace.headers })).digest('hex');
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new Error('IDEMPOTENCY_CONFLICT: requestId already used for another payload or workspace');
      return previous.task;
    }
    if (this.requests.size >= 1000) throw new Error('IDEMPOTENCY_CAPACITY: inspect state before starting a new owner session');
    const task = execute();
    this.requests.set(key, { digest, task });
    return task;
  }

  private async execute(baseUrl: string, name: string, args: ObjectValue, headers: Record<string, string>, resolveProject: (project: string, headers: Record<string, string>) => Promise<string>): Promise<unknown> {
    const request = async (route: string, method = 'GET', body?: unknown): Promise<unknown> => {
      try {
        const response = await fetch(`${baseUrl}${route}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
        // Never echo upstream free-text errors (paths, auth and provider data).
        if (!response.ok) { await response.body?.cancel(); throw new Error(`DAEMON_REQUEST_FAILED: daemon HTTP ${response.status}`); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('INVALID_DAEMON_RESPONSE: missing body');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE: catalogue response exceeds 8 MiB limit'); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_DAEMON_RESPONSE: expected JSON'); }
      } catch (error) {
        if (error instanceof Error && /^(DAEMON_REQUEST_FAILED|INVALID_DAEMON_RESPONSE|RESPONSE_TOO_LARGE):/u.test(error.message)) throw error;
        throw new Error(`DAEMON_TRANSPORT_ERROR: request failed; ${method === 'GET' ? 'check daemon availability' : 'outcome may be unknown; inspect state before a new requestId'}`);
      }
    };
    const endpoint = `/api/${name.includes('plugin') ? 'plugins' : 'skills'}/${encodeURIComponent(String(args.id))}`;
    switch (name) {
      case 'list_catalog_skills':
      case 'list_catalog_plugins': {
        const key = name === 'list_catalog_skills' ? 'skills' : 'plugins';
        const value = await request(`/api/${key}`);
        if (!record(value) || !Array.isArray(value[key])) throw new Error('INVALID_DAEMON_RESPONSE: expected catalogue');
        const offset = Number(args.offset ?? 0);
        const limit = Number(args.limit ?? 50);
        const items = value[key].slice(offset, offset + limit).map((item) => {
          const summary = key === 'skills' ? skill(item) : plugin(item);
          delete summary.body;
          return summary;
        });
        return { [key]: items, total: value[key].length, offset, limit, nextOffset: offset + items.length < value[key].length ? offset + items.length : null, pagination: 'bridge-slice', upstreamLimitBytes: 8 * 1024 * 1024 };
      }
      case 'get_skill': return { skill: skill(await request(endpoint)) };
      case 'list_skill_files': {
        const value = await request(`${endpoint}/files`);
        if (!record(value) || !Array.isArray(value.files)) throw new Error('INVALID_DAEMON_RESPONSE: expected files');
        return { files: value.files.filter((entry) => record(entry) && typeof entry.path === 'string' && !entry.path.startsWith('/') && !/[\\:%?#]/u.test(entry.path) && entry.path.split('/').every((part) => part && !part.startsWith('.')) && ['file', 'directory'].includes(String(entry.kind))).map((entry) => scalars(entry, ['path', 'kind', 'size'])) };
      }
      case 'import_skill': {
        const value = await request('/api/skills/import', 'POST', { name: args.name, ...pick(args, ['description', 'body', 'triggers']) });
        return { skill: skill(record(value) ? value.skill : null) };
      }
      case 'update_skill':
      case 'delete_skill': {
        const existing = await request(endpoint);
        // Do not clone bundled side files (the REST shadow path dereferences
        // symlinks). Only already user-owned inline skill edits are exposed.
        if (!record(existing) || existing.source !== 'user' || existing.teamSynced === true || existing.id !== args.id || existing.name !== args.id) throw new Error('CATALOG_MUTATION_DENIED: only exact user-owned skills may be changed');
        if (name === 'delete_skill') {
          const value = await request(endpoint, 'DELETE');
          if (!record(value) || value.ok !== true) throw new Error('CATALOG_MUTATION_FAILED: skill deletion did not succeed');
          return { ok: true, id: args.id };
        }
        const body = { name: existing.name, description: existing.description ?? '', triggers: existing.triggers ?? [], ...pick(args, ['description', 'body', 'triggers']) };
        validate(body.description, skillInput.description); validate(body.triggers, skillInput.triggers);
        const value = await request(endpoint, 'PUT', body);
        return { skill: skill(record(value) ? value.skill : null) };
      }
      case 'get_plugin': return { plugin: plugin(await request(endpoint)) };
      case 'get_plugin_stats': {
        const value = await request('/api/plugins/stats');
        if (!record(value)) throw new Error('INVALID_DAEMON_RESPONSE: expected stats');
        const counts = (input: unknown, keys: string[]) => Object.fromEntries(Object.entries(pick(input, keys)).flatMap<[string, unknown]>(([key, item]) => {
          if (item === null || (typeof item === 'number' && Number.isFinite(item))) return [[key, item]];
          if (record(item)) return [[key, Object.fromEntries(Object.entries(item).filter(([label, count]) => /^[a-zA-Z0-9._:-]{1,64}$/u.test(label) && typeof count === 'number' && Number.isFinite(count)))]];
          return [];
        }));
        return { plugins: counts(value.plugins, ['total', 'bySourceKind', 'byTrust', 'byTaskKind', 'withElevatedCapabilities', 'bundled', 'thirdParty', 'lastInstalledAt', 'lastUpdatedAt']), snapshots: counts(value.snapshots, ['total', 'byStatus', 'withProject', 'withRun', 'oldestAppliedAt', 'newestAppliedAt']) };
      }
      case 'doctor_plugin': {
        const value = await request(`${endpoint}/doctor`, 'POST', {});
        if (!record(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.issues)) throw new Error('INVALID_DAEMON_RESPONSE: expected diagnostics');
        return { pluginId: args.id, ok: value.ok, issues: value.issues.filter((issue) => record(issue) && ['error', 'warning', 'info'].includes(String(issue.severity)) && typeof issue.code === 'string' && /^[a-zA-Z0-9._-]{1,80}$/u.test(issue.code)).map((issue) => pick(issue, ['severity', 'code'])) };
      }
      case 'uninstall_plugin': {
        const existing = await request(endpoint);
        if (!record(existing) || existing.id !== args.id || existing.sourceKind === 'bundled' || existing.trust === 'bundled' || (typeof existing.source === 'string' && existing.source.startsWith('team:'))) throw new Error('CATALOG_MUTATION_DENIED: bundled and Team plugins cannot be removed');
        const value = await request(`${endpoint}/uninstall`, 'POST', {});
        if (!record(value) || value.ok !== true || value.warning) throw new Error('CATALOG_MUTATION_FAILED: inspect plugin state before retrying');
        return { ok: true, id: args.id };
      }
      case 'get_management_settings': {
        const value = await request('/api/app-config');
        return { settings: safeSettings(record(value) ? value.config : null) };
      }
      case 'update_management_settings': {
        const value = await request('/api/app-config', 'PUT', args.settings);
        return { settings: safeSettings(record(value) ? value.config : null) };
      }
      case 'create_conversation': {
        const projectId = await resolveProject(String(args.project), headers);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(projectId)) throw new Error('PROJECT_RESOLUTION_FAILED: invalid project id');
        const value = await request(`/api/projects/${encodeURIComponent(projectId)}/conversations`, 'POST', pick(args, ['title', 'sessionMode']));
        return { conversation: scalars(record(value) ? value.conversation : null, ['id', 'projectId', 'title', 'sessionMode', 'createdAt', 'updatedAt']) };
      }
      case 'list_available_agent_models': return { agent: await readLiveAgentModels(baseUrl, headers, String(args.agent)) };
      default: throw new Error('UNKNOWN_TOOL');
    }
  }
}
