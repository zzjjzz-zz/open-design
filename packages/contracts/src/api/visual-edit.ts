/** Bounded edits to static HTML source, not browser/runtime DOM editing. */
export type VisualEditPatch =
  | { kind: 'set-text'; id: string; value: string }
  | { kind: 'set-link'; id: string; href: string; text: string }
  | { kind: 'set-image'; id: string; src: string; alt: string }
  | { kind: 'set-style'; id: string; styles: Record<string, string> };

export interface VisualEditRequest {
  expectedHash: string;
  patch: VisualEditPatch;
  confirm: true;
}

export interface VisualEditTarget {
  id: string;
  tag: string;
  operations: VisualEditPatch['kind'][];
  text: string;
}

export interface VisualEditTargetsResponse {
  hash: string;
  targets: VisualEditTarget[];
}

export interface VisualEditResponse {
  hash: string;
  previousHash: string;
  versionId: string;
  previousVersionId: string;
}
