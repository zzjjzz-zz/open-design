import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import {
  antigravityAgentDef,
  antigravityModelRequiresSettings,
  encodeAntigravityStdinPrompt,
  writeAntigravityModelSelection,
} from '../../src/runtimes/defs/antigravity.js';

describe('local Antigravity compatibility patch', () => {
  afterEach(() => {
    agentCapabilities.delete('antigravity');
  });

  it('delivers the full prompt over stream-json stdin, never argv', () => {
    agentCapabilities.set('antigravity', {
      skipPermissions: true,
      addDir: true,
      modelFlag: true,
    });

    const longPrompt = 'x'.repeat(80_000);
    const args = antigravityAgentDef.buildArgs(
      longPrompt,
      [],
      ['/srv/project'],
      { model: 'Gemini 3.1 Pro (High)' },
      {
        promptFilePath: '/tmp/od-agy-run/prompt.md',
        agentLogFilePath: '/tmp/od-agy.log',
        linkedDirs: ['/srv/project'],
      },
    );

    expect(antigravityAgentDef.promptViaStdin).toBe(true);
    expect(antigravityAgentDef.streamFormat).toBe('json-event-stream');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('/srv/project');
    expect(args).toContain('--model');
    expect(args).toContain('Gemini 3.1 Pro (High)');
    expect(args).toContain('stream-json');
    expect(args.join(' ')).not.toContain(longPrompt);
    expect(args.join(' ')).not.toContain('/tmp/od-agy-run/prompt.md');
    expect(JSON.parse(encodeAntigravityStdinPrompt(longPrompt)).message.content).toBe(longPrompt);
  });

  it('fails closed when the installed CLI cannot grant a requested directory', () => {
    agentCapabilities.set('antigravity', {
      skipPermissions: true,
      addDir: false,
      modelFlag: false,
    });

    expect(() =>
      antigravityAgentDef.buildArgs(
        'hello',
        [],
        ['/srv/project'],
        {},
        {},
      ),
    ).toThrow(/does not support --add-dir/);
  });

  it('uses --model when supported and the settings fallback otherwise', () => {
    agentCapabilities.set('antigravity', {
      addDir: true,
      modelFlag: true,
    });
    expect(
      antigravityModelRequiresSettings('Gemini 3.1 Pro (High)'),
    ).toBe(false);

    agentCapabilities.set('antigravity', {
      addDir: true,
      modelFlag: false,
    });
    expect(
      antigravityModelRequiresSettings('Gemini 3.1 Pro (High)'),
    ).toBe(true);
  });

  it('atomically replaces settings while preserving restrictive file mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-agy-settings-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({
          model: 'old',
          trustedWorkspaces: ['/srv/project'],
        }),
      );
      chmodSync(settingsPath, 0o600);

      writeAntigravityModelSelection(
        'Gemini 3.1 Pro (High)',
        settingsPath,
      );

      const next = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(next.model).toBe('Gemini 3.1 Pro (High)');
      expect(next.trustedWorkspaces).toEqual(['/srv/project']);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
