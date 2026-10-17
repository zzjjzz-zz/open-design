import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_MODEL_OPTION } from './shared.js';
import { getRememberedLiveModels } from '../models.js';
import type { RuntimeModelOption } from '../types.js';
import { agentCapabilities } from '../capabilities.js';
import type { RuntimeAgentDef } from '../types.js';

const ANTIGRAVITY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

// Headless runs use agy's documented stdin channel (agy >= 1.1.15):
//   agy --input-format stream-json --output-format stream-json
// with the prompt written to stdin as one NDJSON `user` message. The prompt
// must never ride argv: on Windows the composed OD prompt routinely exceeds
// CreateProcess's 32_767-char command line and the spawn dies with
// `ENAMETOOLONG` before agy starts (OPEND-3495). And agy has no other way to
// read stdin — with `-p <text>` it ignores stdin entirely (agy 1.1.1: "no
// longer reading stdin when a prompt is provided via a flag"), while `-p -`
// is the literal prompt "-" (#7161). Every stream-json message runs one turn;
// the daemon hands the frame over as a complete file-backed stdin, so agy
// sees EOF after it and ends the session once the turn finishes.
const ANTIGRAVITY_STREAM_JSON_ARGS = [
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
] as const;

export function encodeAntigravityStdinPrompt(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

// agy 1.2.x exposes account-scoped models as tab-separated ID and display
// label pairs. Pass the opaque ID unchanged to `--model`; never pass a stale
// human-readable label as an ID. Older CLIs may lack this command or flag.
// Those versions can still use the CLI-configured default model.
export function parseAntigravityModels(stdout: string): RuntimeModelOption[] | null {
  const models: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>(['default']);
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9._-]{1,127})\t([^\t\r\n]{1,160})$/.exec(line.trim());
    if (!match) continue;
    const id = match[1]!;
    const label = match[2]!.trim();
    if (!label || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
    if (models.length >= 201) break;
  }
  return models.length > 1 ? models : null;
}

// Old agy versions use a process-global settings.json to select a model; newer
// builds accept `--model` per process without mutating that file. Preserve the
// older fallback and its lock for installations that do not have `--model`.
const ANTIGRAVITY_SETTINGS_PATH = join(
  homedir(),
  '.gemini',
  'antigravity-cli',
  'settings.json',
);

export function writeAntigravityModelSelection(
  label: string,
  settingsPath: string = ANTIGRAVITY_SETTINGS_PATH,
): void {
  let fileMode = 0o600;
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      fileMode = statSync(settingsPath).mode & 0o777;
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON — fall through and rewrite the file from scratch so
      // the next spawn starts from a known-good state.
    }
  }
  existing.model = label;
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(existing, null, 2)}\n`, {
    mode: fileMode,
  });
  renameSync(tempPath, settingsPath);
}

// Per-process serialization for write-settings → spawn → agy-reads
// cycles on antigravity. `~/.gemini/antigravity-cli/settings.json` is
// process-global, so two OD runs that both pick concrete (non-default)
// models can race: run A writes model A, spawn A starts, run B writes
// model B before A's agy has read settings.json — A then executes on
// model B. The daemon serialises non-default antigravity spawns
// through this chain: each acquire awaits the previous release, and
// each release fires only after the spawned agy actually emits
// `Propagating selected model override to backend: label="<X>"` in
// its `--log-file` (which is the upstream signal that settings.json
// has been read).
let antigravityLockChain: Promise<void> = Promise.resolve();

export function antigravityModelRequiresSettings(model: unknown): boolean {
  return typeof model === 'string' && model.length > 0 && model !== DEFAULT_MODEL_OPTION.id
    && agentCapabilities.get('antigravity')?.modelFlag !== true;
}

export async function acquireAntigravityModelLock(): Promise<() => void> {
  const previous = antigravityLockChain;
  let release: () => void = () => {};
  antigravityLockChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

// Visible for tests. Resets the module-level lock chain so a test that
// installed a hanging acquirer can release it without leaking state to
// subsequent test cases. Production code never calls this.
export function _resetAntigravityModelLockForTests(): void {
  antigravityLockChain = Promise.resolve();
}

export interface WaitForAgyModelOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  // Override for tests; production reads the daemon-owned log file path.
  readFile?: (path: string) => Promise<string>;
  // Override `Date.now` for tests; production uses the wall clock.
  now?: () => number;
  // Stops polling when fired. Production wires this to `child.once('exit')`
  // so the watcher cancels as soon as agy exits — the lock release is
  // then driven by the exit handler rather than the helper's return
  // value, eliminating the slow-startup race the looper review at
  // 263fd2fe7 flagged: if a cold agy takes >timeoutMs to read its
  // settings.json, we'd otherwise return false, the caller would
  // release the lock, and a concurrent run B could rewrite
  // settings.json before A's agy actually read it.
  abortSignal?: AbortSignal;
}

// Polls agy's `--log-file` for the line
//   `Propagating selected model override to backend: label="<expectedModel>"`
// which `model_config_manager.go` emits once agy has finished reading
// `~/.gemini/antigravity-cli/settings.json` and sent the model
// override to the upstream backend. Returns true on observed signal,
// false on timeout OR abort. Never throws — a missing log file is
// treated as "not yet seen" so the polling loop keeps retrying until
// either the deadline or the abort signal fires.
//
// IMPORTANT: callers MUST NOT use a `false` return as a "go ahead and
// release the settings.json lock" signal — false means "I gave up
// polling," not "agy definitely didn't read this." Release the lock
// only on (a) a `true` return, OR (b) child exit. See server.ts for
// the wiring.
export async function waitForAgyToReadModel(
  logFilePath: string,
  expectedModel: string,
  options: WaitForAgyModelOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readFile =
    options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
  const now = options.now ?? Date.now;
  const abortSignal = options.abortSignal;
  if (abortSignal?.aborted) return false;
  const escaped = expectedModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `Propagating selected model override to backend: label="${escaped}"`,
  );
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (abortSignal?.aborted) return false;
    try {
      const content = await readFile(logFilePath);
      if (pattern.test(content)) return true;
    } catch {
      // Log file may not have appeared yet; keep polling.
    }
    if (now() >= deadline) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  return false;
}

export const antigravityAgentDef = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  capabilityFlags: {
    [ANTIGRAVITY_SKIP_PERMISSIONS_FLAG]: 'skipPermissions',
    '--add-dir': 'addDir',
    '--model': 'modelFlag',
  },
  // Always query the installed CLI; static dated names quickly become invalid.
  // Default-only is the safe fallback if the account catalog is unavailable.
  listModels: {
    args: ['models'],
    // Account-scoped catalogs can be slow when agy refreshes its backend.
    timeoutMs: 30_000,
    parse: parseAntigravityModels,
  },
  fallbackModels: [DEFAULT_MODEL_OPTION],
  // Only account-advertised IDs should be selectable; arbitrary strings cannot
  // be assumed to resolve even when the binary supports `--model`.
  supportsCustomModel: false,
  // We deliberately do NOT opt into `resumesSessionViaCli` / agy's `-c`
  // resume flag on follow-up turns. Tested both shapes; `-c` activates
  // agy's internal agentic loop (multi-step model retries, tool calls,
  // fallback-to-cached-response on tool errors) which can't be steered
  // from OD's system-prompt OVERRIDE — even with the strongest wording
  // we got an identical byte-for-byte form re-emission on turn 2 when
  // turn 1's tool-call retry path returned the cached form response.
  //
  // Instead we treat agy as a stateless adapter like qwen /
  // deepseek: every spawn gets the full OD-rendered transcript via
  // `buildDaemonTranscript`, and that transcript's prior assistant
  // turns are sanitized to strip `<question-form>` markup + form-schema
  // JSON fences (see `sanitizePriorAssistantTurnForTranscript` in
  // apps/web/src/providers/daemon.ts).
  buildArgs: (
    _prompt,
    _imagePaths,
    extraAllowedDirs = [],
    options = {},
    runtimeContext = {},
  ) => {
    const caps = agentCapabilities.get('antigravity') ?? {};
    const configuredModel =
      options.model && options.model !== DEFAULT_MODEL_OPTION.id
        ? options.model
        : null;
    const accountModels = getRememberedLiveModels('antigravity')
      .filter((model) => model.id !== DEFAULT_MODEL_OPTION.id);
    // Existing configurations used human-readable labels; a label that still
    // exists is resolved to its current opaque ID without changing config.
    const accountModel = configuredModel
      ? accountModels.find((model) =>
          model.id === configuredModel || model.label === configuredModel)
      : null;
    if (configuredModel && accountModels.length > 0 && !accountModel) {
      throw new Error(
        `Antigravity model "${configuredModel}" is not in the current agy catalog. Select a current model in OpenDesign settings.`,
      );
    }
    const selectedModel = accountModel?.id ?? configuredModel;

    // Preserve explicit directory permissions from the local deployment while
    // adopting upstream's stream-json stdin protocol for long prompts.
    const allowedDirs = [...new Set(
      [...extraAllowedDirs, ...(runtimeContext.linkedDirs ?? [])]
        .map((dir) => dir.trim())
        .filter(Boolean),
    )];
    if (allowedDirs.length > 0 && !caps.addDir) {
      throw new Error(
        'Installed Antigravity CLI does not support --add-dir. Upgrade Antigravity CLI and retry.',
      );
    }
    if (selectedModel && !caps.modelFlag) {
      const liveModel = getRememberedLiveModels('antigravity')
        .find((model) => model.id === selectedModel);
      // New catalogs expose opaque IDs, while old agy builds need the label
      // written to settings.json. Do not mistake an unresolved ID for a label.
      if (!liveModel && !selectedModel.includes(' ')) {
        throw new Error('Antigravity cannot select this model without --model support. Upgrade agy or choose Default.');
      }
      writeAntigravityModelSelection(
        liveModel?.label ?? selectedModel,
        runtimeContext.antigravitySettingsPath,
      );
    }
    const args: string[] = [];
    // Always opt into `--log-file` when the daemon supplied a path: the
    // model lock in server.ts waits for agy to log the settings.json model
    // override there, and the connection test folds its tail into auth /
    // quota classification.
    //
    // Flag order is load-bearing on agy: put `--log-file` first so
    // diagnostics (model override / auth / quota) land in the log.
    if (runtimeContext.agentLogFilePath) {
      args.push('--log-file', runtimeContext.agentLogFilePath);
    }
    // Daemon-managed headless runs have no interactive approval channel.
    if (caps.skipPermissions) {
      args.push(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG);
    }
    if (selectedModel && caps.modelFlag) {
      args.push('--model', selectedModel);
    }
    for (const dir of allowedDirs) {
      args.push('--add-dir', dir);
    }
    args.push(...ANTIGRAVITY_STREAM_JSON_ARGS);
    return args;
  },
  promptViaStdin: true,
  encodeStdinPrompt: encodeAntigravityStdinPrompt,
  streamFormat: 'json-event-stream',
  eventParser: 'antigravity',
  installUrl: 'https://antigravity.google/cli',
  docsUrl: 'https://antigravity.google/docs/cli-overview',
} satisfies RuntimeAgentDef;
