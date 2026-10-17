/** Read the existing progressive probe, never promote a fallback catalogue.
 * The caller supplies the operator-validated loopback origin and workspace.
 * No model inference is performed. Probe text, paths and credentials stay out
 * of the returned projection and every error.
 */
export async function readLiveAgentModels(baseUrl: string, headers: Record<string, string>, agentId: string): Promise<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(agentId)) throw new Error('INVALID_ARGUMENT: invalid agent');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${baseUrl}/api/agents?stream=1`, { headers, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`MODEL_CATALOG_UNAVAILABLE: daemon HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('MODEL_CATALOG_UNAVAILABLE: expected progressive probe');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('MODEL_CATALOG_UNAVAILABLE: probe exceeds limit');
      // Preserve a trailing CR until the next chunk, including split CRLF.
      pending += decoder.decode(chunk.value, { stream: true });
      pending = pending.replace(/\r\n/gu, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const lines = event.split('\n');
        const kind = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        if (kind === 'error' || kind === 'done') throw new Error('MODEL_CATALOG_UNAVAILABLE: no live result for requested agent');
        if (kind !== 'agent') continue;
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        const agent: unknown = JSON.parse(data);
        if (!record(agent) || agent.id !== agentId) continue;
        if (agent.available !== true || agent.authStatus === 'missing' || agent.modelsSource !== 'live' || !Array.isArray(agent.models) || agent.models.length === 0 || agent.models.length > 500) throw new Error('MODEL_CATALOG_UNAVAILABLE: requested agent has no available live catalogue');
        const models = agent.models.map((model) => {
          if (!record(model) || typeof model.id !== 'string' || !model.id || model.id.length > 1024) throw new Error('MODEL_CATALOG_UNAVAILABLE: invalid model');
          return { id: model.id, ...textFields(model, ['label', 'name']), ...(typeof model.enabled === 'boolean' ? { enabled: model.enabled } : {}), ...options(model) };
        });
        if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('MODEL_CATALOG_UNAVAILABLE: ambiguous model ids');
        return { id: agentId, available: true, modelsSource: 'live', models, ...options(agent) };
      }
    }
    throw new Error('MODEL_CATALOG_UNAVAILABLE: incomplete progressive probe');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MODEL_CATALOG_UNAVAILABLE:')) throw error;
    throw new Error('MODEL_CATALOG_UNAVAILABLE: progressive probe failed or timed out');
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { try { await reader.cancel(); } catch { /* Already aborted. */ } reader.releaseLock(); }
  }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function textFields(value: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => typeof value[key] === 'string' && value[key].length <= 1024 ? [[key, value[key]]] : []));
}
function options(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['reasoningOptions', 'serviceTierOptions']) {
    if (!Array.isArray(value[key])) continue;
    if (value[key].length > 100) throw new Error('MODEL_CATALOG_UNAVAILABLE: invalid options');
    result[key] = value[key].map((option: unknown) => {
      if (!record(option) || typeof option.id !== 'string' || !option.id || option.id.length > 1024) throw new Error('MODEL_CATALOG_UNAVAILABLE: invalid option');
      return { id: option.id, ...textFields(option, ['label', 'name']), ...(typeof option.enabled === 'boolean' ? { enabled: option.enabled } : {}) };
    });
  }
  return result;
}
