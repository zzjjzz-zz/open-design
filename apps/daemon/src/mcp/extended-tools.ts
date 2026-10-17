import { createHash } from 'node:crypto';
import { CLOUDFLARE_PAGES_PROVIDER_ID, VERCEL_PROVIDER_ID } from '../deploy.js';
import { resolveMcpWorkspaceContext } from '../mcp-workspace-context.js';

type ObjectValue = Record<string, unknown>;
export type Schema = { type: string; enum?: string[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema };
const string: Schema = { type: 'string' };
const boolean: Schema = { type: 'boolean' };
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const settingProperties: Record<string, Schema> = {
  onboardingCompleted: boolean,
  agentId: string,
  skillId: string,
  designSystemId: string,
  disabledSkills: { type: 'array', items: string },
  disabledDesignSystems: { type: 'array', items: string },
};
const modelProperties = { model: string, reasoning: string, serviceTier: string };
const project = { project: string };
const conversation = { ...project, conversationId: string };
const file = { ...project, path: string };
const provider = { ...file, providerId: choice(VERCEL_PROVIDER_ID, CLOUDFLARE_PAGES_PROVIDER_ID) };
const write = { requestId: string };

function tool(name: string, description: string, properties: Record<string, Schema>, required: string[], mutation = false, destructive = false) {
  return {
    name,
    description: `${description} Sensitive extensions require an explicitly local-owner stdio session; shared ToolHive callers are denied until caller-to-workspace authority exists.`,
    inputSchema: object(properties, required),
    annotations: { title: name.replaceAll('_', ' '), readOnlyHint: !mutation, destructiveHint: destructive, idempotentHint: name !== 'get_preview_url', openWorldHint: name === 'publish_project' },
  };
}

export const EXTENDED_TOOL_DEFS = [
  { name: 'get_mcp_capabilities', description: 'Report extension availability and authorization limitations without accessing daemon data.', inputSchema: object({}), annotations: { title: 'MCP extension availability', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  tool('list_conversations', 'List project conversations.', project, ['project']),
  tool('get_conversation', 'Get conversation metadata by exact id.', conversation, ['project', 'conversationId']),
  tool('list_messages', 'Bridge-side history slice (offset/limit default 0/50, max 200). REST returns full history: responses above 8 MiB are rejected, not database-paginated. Output is bounded to 512 KiB and large messages carry truncation markers.', { ...conversation, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['project', 'conversationId']),
  tool('get_message', 'Read one persisted message by exact id.', { ...conversation, messageId: string }, ['project', 'conversationId', 'messageId']),
  tool('rename_conversation', 'Rename a conversation. requestId deduplicates within this MCP process.', { ...conversation, ...write, title: string }, ['project', 'conversationId', 'title', 'requestId'], true),
  tool('delete_conversation', 'Delete a conversation and cancel its active runs. Requires explicit user confirmation and requestId.', { ...conversation, ...write, confirm: boolean }, ['project', 'conversationId', 'confirm', 'requestId'], true, true),
  tool('get_settings', 'Get only ordinary preference fields; credentials, paths, tokens and policy controls are excluded.', {}, []),
  tool('update_settings', 'Patch only ordinary preference fields; unknown fields are rejected.', { settings: object(settingProperties), ...write }, ['settings', 'requestId'], true),
  tool('get_model_preferences', 'Get model/reasoning/serviceTier preferences only. Never reads provider credentials through MCP output.', {}, []),
  tool('update_model_preferences', 'Set model preferences for one available agent using only its current live /api/agents model IDs and enabled options. Missing/fallback catalogs fail closed. Existing fields/other agents are preserved; concurrent external updates are not CAS-protected by REST.', { agent: string, preferences: object(modelProperties), ...write }, ['agent', 'preferences', 'requestId'], true),
  tool('get_export_manifest', 'Get the existing export manifest.', project, ['project']),
  tool('export_project', 'Export HTML/PDF/image/PPTX using the daemon renderer. Returns bounded base64 bytes; renderer availability is required for visual formats.', { ...file, format: choice('html', 'pdf', 'image', 'pptx'), versionId: string }, ['project', 'path', 'format']),
  tool('deployment_preflight', 'Inspect the deployment file plan; does not publish or prove provider credentials work.', provider, ['project', 'path', 'providerId']),
  tool('list_deployments', 'List existing project deployments.', project, ['project']),
  tool('publish_project', 'Publish through existing deployment API. Requires local-owner write opt-in, explicit confirm, requestId and daemon writeFiles authorization. Never automatically retries.', { ...provider, ...write, target: choice('preview', 'production'), confirm: boolean }, ['project', 'path', 'providerId', 'target', 'confirm', 'requestId'], true, true),
  tool('list_file_versions', 'List existing HTML file versions.', file, ['project', 'path']),
  tool('get_file_version', 'Read one HTML file version.', { ...file, versionId: string }, ['project', 'path', 'versionId']),
  tool('create_file_version', 'Snapshot the current HTML file using the existing version API.', { ...file, ...write, label: string }, ['project', 'path', 'requestId'], true),
  tool('restore_file_version', 'Restore an HTML version. Requires explicit confirm.', { ...file, ...write, versionId: string, confirm: boolean }, ['project', 'path', 'versionId', 'confirm', 'requestId'], true, true),
  tool('get_preview_url', 'Mint an expiring daemon-authorized preview URL. Treat it as sensitive; use the returned CSP and iframe sandbox.', file, ['project', 'path']),
];

export const EXTENDED_TOOL_NAMES = new Set(EXTENDED_TOOL_DEFS.map((item) => item.name));

function record(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validate(value: unknown, schema: Schema, field: string): void {
  if (schema.type === 'object') {
    if (!record(value)) throw new Error(`INVALID_ARGUMENT: ${field} must be an object`);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`INVALID_ARGUMENT: ${field}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const nested = schema.properties?.[key];
      if (!nested || !Object.hasOwn(schema.properties!, key)) throw new Error(`INVALID_ARGUMENT: unsupported field in ${field}`);
      validate(child, nested, `${field}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 200) throw new Error(`INVALID_ARGUMENT: ${field} must be a bounded array`);
    for (const item of value) validate(item, schema.items!, field);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`INVALID_ARGUMENT: ${field} must be an integer`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f]/u.test(value)) throw new Error(`INVALID_ARGUMENT: ${field} must be a nonempty bounded string`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`INVALID_ARGUMENT: invalid ${field}`);
  } else if (typeof value !== schema.type) {
    throw new Error(`INVALID_ARGUMENT: invalid ${field}`);
  }
}

function pick(value: unknown, properties: Record<string, Schema>): ObjectValue {
  const result: ObjectValue = {};
  if (!record(value)) return result;
  for (const key of Object.keys(properties)) {
    if (!Object.hasOwn(value, key)) continue;
    try { validate(value[key], properties[key]!, key); result[key] = value[key]; } catch { /* Fail closed on unexpected response fields. */ }
  }
  return result;
}

function modelPreferences(value: unknown): ObjectValue {
  const result: ObjectValue = Object.create(null);
  if (!record(value)) return result;
  for (const [agent, prefs] of Object.entries(value)) {
    if (/^[a-z][a-z0-9-]{0,63}$/u.test(agent)) result[agent] = pick(prefs, modelProperties);
  }
  return result;
}

function segment(value: unknown): string {
  const text = String(value);
  if (text === '.' || text === '..' || /[\\/%?#]/u.test(text)) throw new Error('INVALID_ARGUMENT: invalid identifier');
  return encodeURIComponent(text);
}

function filePath(value: unknown): string {
  const text = String(value);
  if (text.startsWith('/') || /[\\%?#]/u.test(text) || text.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('INVALID_ARGUMENT: path must be a public project-relative file');
  return text.split('/').map(segment).join('/');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const HISTORY_PAGE_BYTES = 512 * 1024;

function boundedMessage(value: unknown, budget: number): unknown {
  const originalBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (originalBytes <= budget) return value;
  if (!record(value)) throw new Error('INVALID_DAEMON_RESPONSE: expected message');
  // Truncate a complete field, never a serialized JSON document or a UTF-8
  // character. Event logs/attachments are explicitly omitted for large rows.
  // Reserve envelope space so even a 200-message page remains bounded.
  const contentBytes = Buffer.from(typeof value.content === 'string' ? value.content : '', 'utf8');
  // JSON can expand one control byte to six bytes (e.g. \u0000).
  const content = new TextDecoder().decode(contentBytes.subarray(0, Math.max(0, Math.floor((budget - 2304) / 6))), { stream: true });
  return {
    id: typeof value.id === 'string' && value.id.length <= 128 ? value.id : null,
    role: typeof value.role === 'string' ? value.role.slice(0, 32) : null,
    content, truncated: true, originalBytes,
    omittedFieldCount: Object.keys(value).filter((key) => !['id', 'role', 'content'].includes(key)).length,
  };
}

/** An operator-selected, single-owner stdio mode, NOT an OIDC identity mapping.
 * Never enable this mode on a shared ToolHive backend. No tool argument or
 * client metadata can opt into it. The normal shared entry point stays closed.
 */
export class McpExtendedTools {
  private readonly requests = new Map<string, { digest: string; task: Promise<unknown> }>();

  constructor(private readonly access: { localOwner?: boolean; allowWrites?: boolean } = {}) {}

  async call(baseUrl: string, name: string, args: ObjectValue, resolveProject: (project: string, headers: Record<string, string>) => Promise<string>): Promise<unknown> {
    const definition = EXTENDED_TOOL_DEFS.find((item) => item.name === name);
    if (!definition) throw new Error('UNKNOWN_TOOL');
    validate(args, definition.inputSchema, name);
    if (name === 'list_messages' && (Number(args.offset ?? 0) < 0 || Number(args.limit ?? 50) < 1 || Number(args.limit ?? 50) > 200)) throw new Error('INVALID_ARGUMENT: invalid history page');
    if (name === 'get_mcp_capabilities') return {
      mode: this.access.localOwner ? 'local-owner' : 'shared-unbound',
      scope: 'new-extensions-only',
      sensitiveReads: this.access.localOwner === true,
      writes: this.access.localOwner === true && this.access.allowWrites === true,
      callerWorkspaceBinding: false,
      legacyTools: 'Unchanged tools can mutate the daemon owner workspace. Their trust boundary is a single daemon owner, not per-user vMCP isolation.',
      sharedAuthorization: 'BLOCKED: ToolHive OIDC does not bind the caller to the daemon workspace',
      futureRequirement: 'Bind the verified per-user OIDC principal to daemon workspace authority and enforce vMCP authorization rules before shared enablement. Headers cannot cross the current unauthenticated stdio bridge as verified identity.',
      unsupported: ['message deletion/rename (no REST API)', 'browser DOM visual editing (no daemon API)'],
      idempotency: 'Mutation requestIds live only for this MCP process. After restart or ambiguous failure, inspect state before retrying.',
      history: 'Bridge-side slicing only: full REST history is capped at 8 MiB; page output at 512 KiB. No database pagination API is available.',
      modelUpdates: 'Require an available agent, live catalog, enabled model and matching reasoning/serviceTier options. Catalog availability is not inference/entitlement verification; REST has no conditional update.',
    };
    if (!this.access.localOwner) throw new Error('MCP_CALLER_AUTHORITY_REQUIRED: shared callers have no verified daemon workspace identity; ToolHive OIDC alone is insufficient');
    const daemon = new URL(baseUrl);
    if (!['http:', 'https:'].includes(daemon.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(daemon.hostname) || daemon.username || daemon.password || daemon.search || daemon.hash || !['', '/'].includes(daemon.pathname)) throw new Error('MCP_LOCAL_OWNER_ONLY: a loopback daemon origin is required');
    const mutation = definition.annotations.readOnlyHint === false;
    if (mutation && !this.access.allowWrites) throw new Error('MCP_WRITE_AUTHORITY_REQUIRED: writes require the local operator startup option');
    if (['delete_conversation', 'restore_file_version', 'publish_project'].includes(name) && args.confirm !== true) throw new Error('CONFIRMATION_REQUIRED: explicit confirm=true is required');
    const workspace = await resolveMcpWorkspaceContext(baseUrl, { force: true });
    if (!workspace) throw new Error('WORKSPACE_CONTEXT_REQUIRED: no active daemon workspace; no headerless fallback is allowed');
    const execute = async () => {
      const id = args.project === undefined ? null : await resolveProject(String(args.project), workspace.headers);
      return this.execute(baseUrl, name, args, workspace.headers, id);
    };
    if (!mutation) return execute();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(String(args.requestId))) throw new Error('INVALID_ARGUMENT: invalid requestId');
    const digest = createHash('sha256').update(canonical({ baseUrl, name, args, workspace: workspace.headers })).digest('hex');
    const key = String(args.requestId);
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new Error('IDEMPOTENCY_CONFLICT: requestId was used for a different request or workspace');
      return previous.task;
    }
    // Never evict a key and silently replay an old publication. Fail closed
    // when the bounded process-local ledger fills. Keep failures, too: a
    // timeout does not prove the daemon did not commit the write.
    if (this.requests.size >= 1000) throw new Error('IDEMPOTENCY_CAPACITY: inspect state and start a new owner session');
    const task = execute();
    this.requests.set(key, { digest, task });
    return task;
  }

  private async execute(baseUrl: string, name: string, args: ObjectValue, headers: Record<string, string>, id: string | null): Promise<unknown> {
    const root = id === null ? '' : `/api/projects/${segment(id)}`;
    const cid = args.conversationId === undefined ? '' : segment(args.conversationId);
    const encodedFile = args.path === undefined ? '' : filePath(args.path);
    const versions = `${root}/files/${encodedFile}/versions`;
    const request = async (route: string, method = 'GET', body?: unknown, binary = false): Promise<unknown> => {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${route}`, {
          method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(binary ? 120_000 : 30_000), redirect: 'error',
        });
      } catch {
        throw new Error(`DAEMON_TRANSPORT_ERROR: ${method} failed; ${method === 'GET' ? 'check daemon availability' : 'outcome may be unknown; inspect state before retrying with a new requestId'}`);
      }
      if (!response.ok) {
        // Upstream errors can contain deployment/provider credentials or local
        // paths. Expose only status and a validated daemon machine code.
        let code = 'DAEMON_REQUEST_FAILED';
        try {
          const payload: unknown = await response.json();
          const error = record(payload) && record(payload.error) ? payload.error : payload;
          if (record(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.code)) code = error.code;
        } catch { /* No response body is echoed. */ }
        throw new Error(`${code}: daemon HTTP ${response.status}`);
      }
      const maxBytes = 8 * 1024 * 1024;
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxBytes) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE: use the existing CLI export or narrower history'); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      const bytes = Buffer.concat(chunks);
      if (binary) return { mimeType: response.headers.get('content-type') ?? 'application/octet-stream', encoding: 'base64', size: bytes.length, data: bytes.toString('base64') };
      try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('INVALID_DAEMON_RESPONSE: expected JSON'); }
    };
    const config = async (): Promise<ObjectValue> => {
      const result = await request('/api/app-config');
      if (!record(result) || !record(result.config)) throw new Error('INVALID_DAEMON_RESPONSE: expected config');
      return result.config;
    };
    const list = async (route: string, key: string): Promise<unknown[]> => {
      const result = await request(route);
      if (!record(result) || !Array.isArray(result[key])) throw new Error('INVALID_DAEMON_RESPONSE: expected list');
      return result[key];
    };
    switch (name) {
      case 'list_conversations': return request(`${root}/conversations`);
      case 'get_conversation': {
        const conversations = await list(`${root}/conversations`, 'conversations');
        const found = conversations.find((item) => record(item) && item.id === args.conversationId);
        if (!found) throw new Error('CONVERSATION_NOT_FOUND');
        return { conversation: found };
      }
      case 'list_messages':
      case 'get_message': {
        const messages = await list(`${root}/conversations/${cid}/messages`, 'messages');
        if (name === 'get_message') {
          const found = messages.find((item) => record(item) && item.id === args.messageId);
          if (!found) throw new Error('MESSAGE_NOT_FOUND');
          return { message: boundedMessage(found, HISTORY_PAGE_BYTES) };
        }
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? 50 : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('INVALID_ARGUMENT: invalid history page');
        const page = messages.slice(offset, offset + limit);
        const budget = Math.floor(HISTORY_PAGE_BYTES / Math.max(1, page.length));
        return { messages: page.map((message) => boundedMessage(message, budget)), total: messages.length, offset, limit, nextOffset: offset + page.length < messages.length ? offset + page.length : null, pagination: 'bridge-slice', upstreamLimitBytes: 8 * 1024 * 1024 };
      }
      case 'rename_conversation': return request(`${root}/conversations/${cid}`, 'PATCH', { title: args.title });
      case 'delete_conversation': return request(`${root}/conversations/${cid}`, 'DELETE');
      case 'get_settings': return { settings: pick(await config(), settingProperties) };
      case 'get_model_preferences': return { agentModels: modelPreferences((await config()).agentModels) };
      case 'update_settings': {
        if (Object.keys(args.settings as ObjectValue).length === 0) throw new Error('INVALID_ARGUMENT: empty settings patch');
        const result = await request('/api/app-config', 'PUT', args.settings);
        if (!record(result) || !record(result.config)) throw new Error('INVALID_DAEMON_RESPONSE: expected config');
        return { settings: pick(result.config, settingProperties) };
      }
      case 'update_model_preferences': {
        if (!/^[a-z][a-z0-9-]{0,63}$/u.test(String(args.agent)) || Object.keys(args.preferences as ObjectValue).length === 0) throw new Error('INVALID_ARGUMENT: invalid agent/preferences');
        const models = modelPreferences((await config()).agentModels);
        const preferences = { ...(models[String(args.agent)] as ObjectValue ?? {}), ...args.preferences as ObjectValue };
        const catalog = await request('/api/agents');
        const agents = record(catalog) && Array.isArray(catalog.agents)
          ? catalog.agents.filter((agent) => record(agent) && agent.id === args.agent) : [];
        const agent = agents.length === 1 ? agents[0] : null;
        if (!record(agent) || agent.available !== true || agent.authStatus === 'missing' || agent.modelsSource !== 'live' || !Array.isArray(agent.models)) throw new Error('MODEL_CATALOG_UNAVAILABLE: an available agent with a live model catalog is required; preferences unchanged');
        const choices = agent.models.filter((model) => record(model) && model.id === preferences.model && model.enabled !== false);
        const model = choices.length === 1 ? choices[0] : null;
        if (!record(model) || typeof preferences.model !== 'string') throw new Error('MODEL_NOT_AVAILABLE: select an enabled model ID from the current agent catalog; preferences unchanged');
        for (const [key, optionsKey] of [['reasoning', 'reasoningOptions'], ['serviceTier', 'serviceTierOptions']] as const) {
          if (preferences[key] === undefined) continue;
          const options = model[optionsKey] ?? (key === 'reasoning' ? agent.reasoningOptions : undefined);
          if (!Array.isArray(options) || !options.some((option) => record(option) && option.id === preferences[key] && option.enabled !== false)) throw new Error('MODEL_OPTION_NOT_AVAILABLE: merged preferences must match the selected model catalog; preferences unchanged');
        }
        models[String(args.agent)] = preferences;
        const result = await request('/api/app-config', 'PUT', { agentModels: models });
        if (!record(result) || !record(result.config)) throw new Error('INVALID_DAEMON_RESPONSE: expected config');
        return { agentModels: modelPreferences(result.config.agentModels) };
      }
      case 'get_export_manifest': return request(`${root}/export/manifest`);
      case 'export_project': return request(`${root}/export`, 'POST', { fileName: args.path, format: args.format, ...(args.versionId === undefined ? {} : { versionId: args.versionId }) }, true);
      case 'deployment_preflight': return request(`${root}/deploy/preflight`, 'POST', { fileName: args.path, providerId: args.providerId });
      case 'list_deployments': return request(`${root}/deployments`);
      case 'publish_project': return request(`${root}/deploy`, 'POST', { fileName: args.path, providerId: args.providerId, target: args.target });
      case 'list_file_versions': return request(versions);
      case 'get_file_version': return request(`${versions}/${segment(args.versionId)}`);
      case 'create_file_version': return request(versions, 'POST', { source: 'manual', ...(args.label === undefined ? {} : { label: args.label }) });
      case 'restore_file_version': return request(`${versions}/${segment(args.versionId)}/restore`, 'POST', {});
      case 'get_preview_url': return request(`${root}/preview-url?file=${encodeURIComponent(String(args.path))}`);
      default: throw new Error('UNKNOWN_TOOL');
    }
  }
}
