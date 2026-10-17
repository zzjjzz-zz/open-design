import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import { rememberLiveModels } from '../../src/runtimes/models.js';
import {
  antigravityAgentDef,
  parseAntigravityModels,
} from '../../src/runtimes/defs/antigravity.js';

const catalog = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

describe('Antigravity account model catalog', () => {
  afterEach(() => {
    agentCapabilities.delete('antigravity');
  });

  it('parses opaque CLI ids and preserves distinct display names and order', () => {
    expect(parseAntigravityModels(catalog)).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    ]);
    expect(antigravityAgentDef.listModels?.args).toEqual(['models']);
    expect(antigravityAgentDef.listModels?.timeoutMs).toBe(30_000);
    expect(antigravityAgentDef.supportsCustomModel).toBe(false);
    expect(antigravityAgentDef.fallbackModels).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
    ]);
  });

  it('ignores banners, invalid ids and duplicate catalog entries', () => {
    expect(parseAntigravityModels([
      'Fetching available models...',
      'No models available',
      '--dangerously-skip-permissions\tUnexpected',
      'hello world\tUntrusted',
      'gemini-4-argon-high\tGemini 4 Argon (High)',
      'gemini-4-argon-high\tDuplicate',
      'gemini-4-argon-low\t',
    ].join('\n'))).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    ]);
    expect(parseAntigravityModels('Fetching available models...\nNo models available')).toBeNull();
    expect(parseAntigravityModels('')).toBeNull();
  });

  it('passes the exact discovered id to --model without rewriting global settings', () => {
    agentCapabilities.set('antigravity', { modelFlag: true, addDir: true });
    const args = antigravityAgentDef.buildArgs(
      'hello',
      [],
      [],
      { model: 'claude-opus-5-5-high' },
      {},
    );
    const modelAt = args.indexOf('--model');
    expect(args[modelAt + 1]).toBe('claude-opus-5-5-high');
    expect(args).not.toContain('Claude Opus 5.5 (High)');
    expect(args).toContain('stream-json');
  });

  it('resolves a saved legacy label to the live CLI id', () => {
    rememberLiveModels('antigravity', parseAntigravityModels(catalog)!);
    agentCapabilities.set('antigravity', { modelFlag: true, addDir: true });
    const args = antigravityAgentDef.buildArgs(
      'hello', [], [], { model: 'GPT-OSS 120B (Medium)' }, {},
    );
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-oss-120b-medium');
  });

  it('asks users to reselect a retired legacy model rather than guessing an alias', () => {
    rememberLiveModels('antigravity', parseAntigravityModels(catalog)!);
    agentCapabilities.set('antigravity', { modelFlag: true, addDir: true });
    expect(() => antigravityAgentDef.buildArgs(
      'hello', [], [], { model: 'Gemini 3.5 Flash (High)' }, {},
    )).toThrow(/Select a current model/);
  });

  it('writes the display label only when an old CLI lacks --model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-agy-model-catalog-'));
    try {
      rememberLiveModels('antigravity', parseAntigravityModels(catalog)!);
      agentCapabilities.set('antigravity', { modelFlag: false, addDir: true });
      const settingsPath = join(dir, 'settings.json');
      const args = antigravityAgentDef.buildArgs(
        'hello',
        [],
        [],
        { model: 'gemini-4-argon-high' },
        { antigravitySettingsPath: settingsPath },
      );
      expect(args).not.toContain('--model');
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).model).toBe(
        'Gemini 4 Argon (High)',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for unknown opaque ids on old CLI builds', () => {
    agentCapabilities.set('antigravity', { modelFlag: false, addDir: true });
    rememberLiveModels('antigravity', [{ id: 'default', label: 'Default (CLI config)' }]);
    expect(() => antigravityAgentDef.buildArgs(
      'hello',
      [],
      [],
      { model: 'missing-model-id' },
    )).toThrow(/without --model support/);
  });
});
