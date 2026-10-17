import type { VisualEditResponse, ProjectFileVersionResponse, ProjectFileVersionsResponse } from '@open-design/contracts';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type StartServerResult } from '../src/server.js';
import { ensureWorkspaceProject, insertProject, openDatabase, updateWorkspaceProject } from '../src/db.js';
import { visualHash } from '../src/artifacts/visual-edit.js';

const html = '<!doctype html>\n<html><body><h1 data-od-id="title">Hello</h1><a data-od-id="link" href="old.html">Old</a><img data-od-id="image" src="old.png"></body></html>';
const ws = 'ws-visual-owner';
const headers = { 'x-od-workspace-id': ws, 'x-od-workspace-member-id': 'owner', 'content-type': 'application/json' };
const dataDir = process.env.OD_DATA_DIR!;
const projectsRoot = path.join(dataDir, 'projects');
let daemon: StartServerResult;
let db: ReturnType<typeof openDatabase>;
async function seed(workspace = ws) {
  const id = randomUUID();
  const now = Date.now();
  insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
  ensureWorkspaceProject(db, { projectId: id, workspaceId: workspace, createdByWorkspaceMemberId: 'owner' });
  const dir = path.join(projectsRoot, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), html);
  return { id, dir, route: `${daemon.url}/api/projects/${id}/files/index.html/visual-patch` };
}
const body = (patch: unknown, hash = visualHash(html)) => ({ expectedHash: hash, patch, confirm: true });
const patch = { kind: 'set-text', id: 'title', value: 'Edited' };
const post = (route: string, payload: unknown, authority = headers) => fetch(route, { method: 'POST', headers: authority, body: JSON.stringify(payload) });
describe('visual patch REST authority, CAS and history', () => {
  beforeAll(async () => {
    daemon = await startServer({ port: 0, host: '127.0.0.1', returnServer: true }) as StartServerResult;
    db = openDatabase(process.cwd(), { dataDir });
  });
  afterAll(async () => {
    await daemon.shutdown();
    await new Promise<void>((resolve, reject) => daemon.server.close((error) => error ? reject(error) : resolve()));
  });
  it('reads targets without creating history and atomically edits with recoverable before/after IDs', async () => {
    const p = await seed();
    const targets = await fetch(p.route, { headers });
    expect(targets.status).toBe(200);
    expect(await targets.json()).toMatchObject({ hash: visualHash(html), targets: [{ id: 'title' }, { id: 'link' }, { id: 'image' }] });
    await expect(fs.stat(path.join(p.dir, '.file-versions'))).rejects.toThrow();
    const response = await post(p.route, body(patch));
    expect(response.status).toBe(200);
    const changed = await response.json() as VisualEditResponse;
    expect(changed).toMatchObject({ hash: visualHash(html.replace('Hello', 'Edited')), previousHash: visualHash(html), versionId: expect.any(String), previousVersionId: expect.any(String) });
    expect(await fs.readFile(path.join(p.dir, 'index.html'), 'utf8')).toBe(html.replace('Hello', 'Edited'));
    const base = `${daemon.url}/api/projects/${p.id}/files/index.html/versions`;
    const before = await fetch(`${base}/${changed.previousVersionId}`, { headers });
    expect((await before.json() as ProjectFileVersionResponse).content).toBe(html);
    const after = await fetch(`${base}/${changed.versionId}`, { headers });
    expect((await after.json() as ProjectFileVersionResponse).content).toBe(html.replace('Hello', 'Edited'));
    expect((await post(`${base}/${changed.previousVersionId}/restore`, {})).status).toBe(200);
    expect(await fs.readFile(path.join(p.dir, 'index.html'), 'utf8')).toBe(html);
    expect((await post(p.route, body(patch, changed.hash))).status).toBe(409);
    expect((await fs.readdir(p.dir)).some((name) => name.startsWith('.od-visual-'))).toBe(false);
  });
  it('allows exactly one concurrent patch from the same hash; conflict writes no extra history', async () => {
    const p = await seed();
    const responses = await Promise.all([post(p.route, body(patch)), post(p.route, body({ ...patch, value: 'Other' }))]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const history = await fetch(`${daemon.url}/api/projects/${p.id}/files/index.html/versions`, { headers });
    expect((await history.json() as ProjectFileVersionsResponse).versions).toHaveLength(2);
  });
  it('rejects absent writer identity and cross-workspace reads/writes', async () => {
    const p = await seed();
    expect((await post(p.route, body(patch), { 'content-type': 'application/json' } as typeof headers)).status).toBe(401);
    for (const authority of [
      { ...headers, 'x-od-workspace-member-id': '' },
      { ...headers, 'x-od-workspace-id': '' },
      { ...headers, 'x-od-workspace-member-id': 'forged-reader', 'x-od-workspace-role': 'owner' },
      { ...headers, 'x-od-workspace-member-status': 'removed' },
      { ...headers, 'x-forwarded-for': '127.0.0.1' },
      { ...headers, forwarded: 'for=127.0.0.1' },
    ]) expect((await post(p.route, body(patch), authority)).status).toBeGreaterThanOrEqual(400);
    expect((await post(`${p.route}?workspaceId=${ws}&workspaceMemberId=owner`, body(patch), { 'content-type': 'application/json' } as typeof headers)).status).toBe(401);
    expect(await fs.readFile(path.join(p.dir, 'index.html'), 'utf8')).toBe(html);
    const foreign = await seed('ws-visual-foreign');
    expect((await fetch(foreign.route, { headers })).status).toBe(403);
    expect((await post(foreign.route, body(patch))).status).toBe(403);
    expect(await fs.readFile(path.join(foreign.dir, 'index.html'), 'utf8')).toBe(html);
  });
  it('enforces writeFiles on a readonly team mirror while allowing reads', async () => {
    const p = await seed();
    updateWorkspaceProject(db, ws, p.id, { visibility: 'team', syncState: 'synced', resourceHubResourceId: `hub-${p.id}` });
    const reader = { ...headers, 'x-od-workspace-member-id': 'reader', 'x-od-workspace-type': 'team', 'x-od-workspace-role': 'member', 'x-od-workspace-lifecycle-state': 'active', 'x-od-workspace-member-status': 'active', 'x-od-workspace-can-write-synced-files': 'true' };
    expect((await fetch(p.route, { headers: reader })).status).toBe(200);
    const denied = await post(p.route, body(patch), reader);
    expect(denied.status).toBe(403);
    expect((await denied.json() as { error: { code: string } }).error.code).toBe('WORKSPACE_PROJECT_PERMISSION_DENIED');
    await expect(fs.stat(path.join(p.dir, '.file-versions'))).rejects.toThrow();
  });
  it('rejects injections before saving and preserves both file and history', async () => {
    const p = await seed();
    const unsafe = [
      { kind: 'set-link', id: 'link', text: 'x', href: 'javascript:alert(1)' },
      { kind: 'set-image', id: 'image', src: 'data:image/svg+xml,x', alt: '' },
      { kind: 'set-style', id: 'title', styles: { color: 'red; background:url(x)' } },
      { kind: 'set-text', id: 'title', value: 'x', onload: 'x()' },
      { kind: 'set-outer-html', id: 'title', html: '<script>x()</script>' },
    ];
    for (const attempt of unsafe) expect((await post(p.route, body(attempt))).status).toBe(400);
    expect((await post(p.route, { ...body(patch), confirm: false })).status).toBe(400);
    expect(await fs.readFile(path.join(p.dir, 'index.html'), 'utf8')).toBe(html);
    await expect(fs.stat(path.join(p.dir, '.file-versions'))).rejects.toThrow();
  });
  it('supports nested HTML and refuses symlink aliases, traversal and non-HTML', async () => {
    const p = await seed();
    await fs.mkdir(path.join(p.dir, 'pages'));
    await fs.writeFile(path.join(p.dir, 'pages', 'nested.html'), html);
    const nested = p.route.replace('index.html', 'pages/nested.html');
    expect((await post(nested, body(patch))).status).toBe(200);
    await fs.symlink(path.join(p.dir, 'index.html'), path.join(p.dir, 'alias.html'));
    expect((await post(p.route.replace('index.html', 'alias.html'), body(patch))).status).toBe(400);
    const other = await seed();
    await fs.symlink(other.dir, path.join(p.dir, 'outside'));
    expect((await post(p.route.replace('index.html', 'outside/index.html'), body(patch))).status).toBe(400);
    for (const name of ['%2e%2e%2findex.html', '.file-versions/x.html', 'index.txt']) {
      expect((await post(p.route.replace('index.html', name), body(patch))).status).toBeGreaterThanOrEqual(400);
    }
  });
  it('refuses version-store symlink escapes without writing another project', async () => {
    const p = await seed();
    const foreign = await seed();
    await fs.mkdir(path.join(foreign.dir, 'history'));
    await fs.symlink(path.join(foreign.dir, 'history'), path.join(p.dir, '.file-versions'));
    expect((await post(p.route, body(patch))).status).toBe(400);
    expect(await fs.readdir(path.join(foreign.dir, 'history'))).toEqual([]);
    expect(await fs.readFile(path.join(p.dir, 'index.html'), 'utf8')).toBe(html);
  });
  it('fails closed when version storage is unavailable', async () => {
    const p = await seed();
    await fs.writeFile(path.join(p.dir, '.file-versions'), 'unavailable');
    expect((await post(p.route, body(patch))).status).toBeGreaterThanOrEqual(400);
    expect(await fs.readFile(path.join(p.dir, 'index.html'), 'utf8')).toBe(html);
  });
});
