import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { prepareDeployPreflight } from '../src/deploy.js';

it('deployment preflight reads a local plan without fetching remote assets, publishing or writing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-mcp-preflight-'));
  const projectDir = path.join(root, 'fixture');
  const html = '<html><head><link rel="stylesheet" href="style.css"></head><body><img src="https://external.invalid/a.png"></body></html>';
  const css = '@import "https://external.invalid/style.css"; body { color: red; }';
  await mkdir(projectDir);
  await writeFile(path.join(projectDir, 'index.html'), html);
  await writeFile(path.join(projectDir, 'style.css'), css);
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('preflight must not access the network'); });
  try {
    for (const providerId of ['vercel-self', 'cloudflare-pages'] as const) {
      const result = await prepareDeployPreflight(root, 'fixture', 'index.html', { providerId, includeProjectFiles: true });
      expect(result.totalFiles).toBe(2);
      expect(result.providerId).toBe(providerId);
    }
    expect(network).not.toHaveBeenCalled();
    expect((await readdir(projectDir)).sort()).toEqual(['index.html', 'style.css']);
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe(html);
    expect(await readFile(path.join(projectDir, 'style.css'), 'utf8')).toBe(css);
  } finally {
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
