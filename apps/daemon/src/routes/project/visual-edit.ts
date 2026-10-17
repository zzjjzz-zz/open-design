import type { Express, Request, Response } from 'express';
import { patchVisualFile, readVisualTargets } from '../../artifacts/visual-edit-files.js';
import { parseVisualEditRequest, VisualEditError } from '../../artifacts/visual-edit.js';

interface VisualEditRouteDeps {
  projectsRoot: string;
  getProject: (id: string) => { id: string; metadata?: unknown } | null | undefined;
  authorizeRead: (req: Request, res: Response, id: string) => Promise<boolean>;
  authorizeWrite: (req: Request, res: Response, id: string) => Promise<boolean>;
  sendApiError: (res: Response, status: number, code: string, message: string) => unknown;
}
/** Mounted before the project file catch-all; uses the same authority gates. */
export function registerVisualEditRoutes(app: Express, deps: VisualEditRouteDeps): void {
  const route = /^\/api\/projects\/([^/]+)\/files\/(.+)\/visual-patch$/u;
  const handle = (write: boolean) => async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // Header attribution is not authentication. This single-owner surface
      // is available only over a direct loopback connection; shared/proxied
      // clients must not use it until caller-to-workspace binding exists.
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
        || ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'].some((name) => req.header(name) !== undefined)) {
        return deps.sendApiError(res, 403, 'VISUAL_LOCAL_OWNER_REQUIRED', 'direct local-owner connection required');
      }
      const params = req.params as unknown as { 0: string; 1: string };
      const project = deps.getProject(params[0]);
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      if (write && (!req.header('x-od-workspace-id')?.trim() || !req.header('x-od-workspace-member-id')?.trim())) {
        return deps.sendApiError(res, 401, 'WORKSPACE_CONTEXT_REQUIRED', 'explicit workspace writer context required');
      }
      if (!await (write ? deps.authorizeWrite : deps.authorizeRead)(req, res, project.id)) return;
      const result = write
        ? await patchVisualFile(deps.projectsRoot, project.id, params[1], project.metadata, parseVisualEditRequest(req.body))
        : await readVisualTargets(deps.projectsRoot, project.id, params[1], project.metadata);
      res.json(result);
    } catch (error) {
      // Never echo source, user-supplied URLs, filesystem paths or native errors.
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      const status = error instanceof VisualEditError ? error.status : missing ? 404 : 400;
      const code = error instanceof VisualEditError ? error.code : missing ? 'FILE_NOT_FOUND' : 'VISUAL_EDIT_FAILED';
      deps.sendApiError(res, status, code, code);
    }
  };
  app.get(route, handle(false));
  app.post(route, handle(true));
}
