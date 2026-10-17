import type { Express } from 'express';
import type { ValidateLinkedDirRequest, ValidateLinkedDirResponse } from '@open-design/contracts';
import { validateLinkedDirs } from '../linked-dirs.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterLinkedDirRoutesDeps extends RouteDeps<'http'> {}

export function registerLinkedDirRoutes(app: Express, ctx: RegisterLinkedDirRoutesDeps): void {
  const { isLocalSameOrigin, resolvedPortRef, sendApiError } = ctx.http;
  app.post('/api/linked-dirs/validate', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return sendApiError(res, 403, 'FORBIDDEN', 'cross-origin request rejected');
    }
    const input = req.body as Partial<ValidateLinkedDirRequest> | undefined;
    const candidate = typeof input?.path === 'string' ? input.path.trim() : input?.path;
    const result = validateLinkedDirs([candidate]);
    if ('error' in result) return sendApiError(res, 400, 'BAD_REQUEST', result.error);
    const response: ValidateLinkedDirResponse = { path: result.dirs[0]! };
    return res.json(response);
  });
}
