import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VisualEditRequest, VisualEditResponse, VisualEditTargetsResponse } from '@open-design/contracts';
import { resolveProjectDir, resolveProjectFilePath, sanitizePath } from '../projects.js';
import { withProjectFileVersionLock } from '../project-file-versions.js';
import { applyVisualEdit, getVisualEditTargets, VisualEditError, visualHash, VISUAL_HTML_MAX_BYTES } from './visual-edit.js';

function validateName(name: string): void {
  if (!/\.html?$/iu.test(name) || name.length > 512 || /[\\%?#]/u.test(name) || name.split('/').some((part) => !part || part.startsWith('.')) || sanitizePath(name) !== name) {
    throw new VisualEditError('INVALID_VISUAL_FILE');
  }
}
// Reject aliases as well as escapes: otherwise two names for one file can
// acquire different version locks. Imported workspaces still use baseDir.
function checkedPath(root: string, name: string): string {
  if (fs.realpathSync(root) !== path.resolve(root)) throw new VisualEditError('VISUAL_PATH_ALIAS');
  let current = root;
  for (const segment of name.split('/')) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new VisualEditError('VISUAL_PATH_ALIAS');
  }
  const st = fs.statSync(current);
  if (!st.isFile() || st.nlink !== 1) throw new VisualEditError('INVALID_VISUAL_FILE');
  if (st.size > VISUAL_HTML_MAX_BYTES) throw new VisualEditError('VISUAL_HTML_TOO_LARGE', 413);
  return current;
}
function read(root: string, name: string): string {
  const bytes = fs.readFileSync(checkedPath(root, name));
  const source = bytes.toString('utf8');
  if (!Buffer.from(source).equals(bytes)) throw new VisualEditError('VISUAL_UTF8_REQUIRED');
  return source;
}
function atomicReplace(root: string, name: string, expectedHash: string, source: string): void {
  const target = checkedPath(root, name);
  const temporary = path.join(path.dirname(target), `.od-visual-${randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, 'wx', fs.statSync(target).mode & 0o777);
    try { fs.writeFileSync(descriptor, source, 'utf8'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    // No await between final path/hash check and rename. Existing daemon HTML
    // writers share our version lock; arbitrary external processes do not.
    if (checkedPath(root, name) !== target || visualHash(read(root, name)) !== expectedHash) throw new VisualEditError('VISUAL_HASH_CONFLICT', 409);
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function checkVersionPaths(projectsRoot: string, projectId: string, name: string): void {
  const root = path.join(projectsRoot, projectId);
  const directory = path.join(root, '.file-versions', createHash('sha256').update(name).digest('hex').slice(0, 24));
  for (const candidate of [root, path.dirname(directory), directory]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink() || fs.realpathSync(candidate) !== path.resolve(candidate)) throw new VisualEditError('VISUAL_PATH_ALIAS');
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory)) {
      const st = fs.lstatSync(path.join(directory, entry));
      if (!st.isFile() || st.nlink !== 1) throw new VisualEditError('VISUAL_PATH_ALIAS');
    }
  }
}
export async function readVisualTargets(projectsRoot: string, projectId: string, name: string, metadata: unknown): Promise<VisualEditTargetsResponse> {
  validateName(name);
  // Retain existing project visibility + real-path confinement policy.
  await resolveProjectFilePath(projectsRoot, projectId, name, metadata);
  return withProjectFileVersionLock(projectsRoot, projectId, name, metadata, async () => getVisualEditTargets(read(resolveProjectDir(projectsRoot, projectId, metadata), name)));
}
export async function patchVisualFile(projectsRoot: string, projectId: string, name: string, metadata: unknown, request: VisualEditRequest): Promise<VisualEditResponse> {
  validateName(name);
  await resolveProjectFilePath(projectsRoot, projectId, name, metadata);
  return withProjectFileVersionLock(projectsRoot, projectId, name, metadata, async (lock) => {
    const root = resolveProjectDir(projectsRoot, projectId, metadata);
    const source = read(root, name);
    const previousHash = visualHash(source);
    if (previousHash !== request.expectedHash) throw new VisualEditError('VISUAL_HASH_CONFLICT', 409);
    const next = applyVisualEdit(source, request.patch);
    checkVersionPaths(projectsRoot, projectId, name);
    const previous = await lock.ensureCurrentVersion(source, { source: 'manual', label: 'Before visual edit' });
    if (!previous) throw new VisualEditError('VISUAL_VERSION_REQUIRED', 500);
    // Persist recoverable content before changing the working file. If either
    // history write fails, the working file is untouched. History and working
    // file are not a filesystem transaction; reconcile on failed final CAS.
    const version = await lock.createVersion(next, { source: 'manual', parentVersionId: previous.id, label: 'Visual edit' });
    try { atomicReplace(root, name, previousHash, next); }
    catch (error) {
      await lock.ensureCurrentVersion(read(root, name), { source: 'manual' });
      throw error;
    }
    return { hash: visualHash(next), previousHash, versionId: version.id, previousVersionId: previous.id };
  });
}
