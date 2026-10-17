import { createHash } from 'node:crypto';
import { JSDOM, type HtmlElement } from 'jsdom';
import type { VisualEditPatch, VisualEditRequest, VisualEditTarget, VisualEditTargetsResponse } from '@open-design/contracts';

export class VisualEditError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
function invalid(): never { throw new VisualEditError('INVALID_VISUAL_PATCH'); }
const safeTags = new Set('a img p span div section main article nav header footer aside h1 h2 h3 h4 h5 h6 strong em b i u small label li ul ol blockquote figcaption figure button td th tr tbody thead table caption dl dt dd pre code'.split(' '));
const blockedAncestors = new Set('script style noscript template iframe object embed svg math textarea title xmp plaintext noembed noframes'.split(' '));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
export const VISUAL_HTML_MAX_BYTES = 2 * 1024 * 1024;
export const visualHash = (source: string | Buffer): string => createHash('sha256').update(source).digest('hex');

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x08\x0b-\x1f\x7f]/u.test(value)) invalid();
}
function safeUrl(value: unknown, image: boolean): void {
  text(value);
  if (!value || /[\s\\<>"'`%]/u.test(value)) invalid();
  if (/^https?:\/\//iu.test(value)) {
    const url = new URL(value);
    if ((image && url.protocol !== 'https:') || url.username || url.password) invalid();
    return;
  }
  // No root-relative, protocol-relative, scheme, encoded or parent paths.
  // This also prevents references to another project's daemon route.
  if (value.startsWith('/') || value.includes(':') || value.split(/[/?#]/u).some((part) => part === '..' || part.startsWith('.file-'))) invalid();
}
const colors = /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|black|white|red|green|blue|gray|transparent|currentColor)$/iu;
const length = /^(?:0|(?:\d{1,3}|1000)(?:\.\d{1,2})?(?:px|rem|em|%))$/u;
const styleRules: Record<string, RegExp> = {
  color: colors, backgroundColor: colors, borderColor: colors,
  fontSize: length, letterSpacing: length, width: length, height: length,
  padding: length, margin: length, gap: length, borderRadius: length,
  fontWeight: /^(?:normal|bold|[1-9]00)$/u,
  textAlign: /^(?:left|right|center|start|end)$/u,
  opacity: /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/u,
};
export const visualStyleProperties = Object.keys(styleRules);
export function parseVisualEditRequest(value: unknown): VisualEditRequest {
  fields(value, ['expectedHash', 'patch', 'confirm']);
  if (value.confirm !== true) throw new VisualEditError('CONFIRMATION_REQUIRED');
  if (typeof value.expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.expectedHash)) invalid();
  const patch = value.patch;
  if (!record(patch) || typeof patch.id !== 'string' || !idPattern.test(patch.id)) invalid();
  switch (patch.kind) {
    case 'set-text': fields(patch, ['kind', 'id', 'value']); text(patch.value); break;
    case 'set-link': fields(patch, ['kind', 'id', 'href', 'text']); safeUrl(patch.href, false); text(patch.text); break;
    case 'set-image': fields(patch, ['kind', 'id', 'src', 'alt']); safeUrl(patch.src, true); text(patch.alt); break;
    case 'set-style':
      fields(patch, ['kind', 'id', 'styles']);
      if (!record(patch.styles) || Object.keys(patch.styles).length < 1 || Object.keys(patch.styles).length > 16) invalid();
      for (const [key, val] of Object.entries(patch.styles)) {
        if (!Object.hasOwn(styleRules, key) || typeof val !== 'string' || !styleRules[key]!.test(val)) invalid();
      }
      break;
    default: invalid();
  }
  return value as unknown as VisualEditRequest;
}
function parse(source: string): JSDOM {
  if (Buffer.byteLength(source) > VISUAL_HTML_MAX_BYTES) throw new VisualEditError('VISUAL_HTML_TOO_LARGE', 413);
  // Default runScripts/resources are disabled. Source offsets let us preserve
  // every byte outside the edited ranges, including existing scripts.
  return new JSDOM(source, { includeNodeLocations: true });
}
function allowed(el: HtmlElement): boolean {
  if (!safeTags.has(el.localName) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
  for (let node: HtmlElement | null = el; node; node = node.parentElement) {
    if (blockedAncestors.has(node.localName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
  }
  return !Array.from(el.attributes).some((attr) => /^on/iu.test(attr.name) || attr.name === 'is');
}
function operations(el: HtmlElement): VisualEditPatch['kind'][] {
  const ops: VisualEditPatch['kind'][] = ['set-style'];
  if (el.localName === 'img') return [...ops, 'set-image'];
  if (el.children.length === 0) ops.push('set-text');
  if (el.localName === 'a' && el.children.length === 0) ops.push('set-link');
  return ops;
}
export function getVisualEditTargets(source: string): VisualEditTargetsResponse {
  const dom = parse(source);
  try {
    const nodes = Array.from(dom.window.document.querySelectorAll('[data-od-id]'));
    const counts = new Map<string, number>();
    for (const el of nodes) { const id = el.getAttribute('data-od-id')!; counts.set(id, (counts.get(id) ?? 0) + 1); }
    const targets: VisualEditTarget[] = [];
    for (const el of nodes) {
      const id = el.getAttribute('data-od-id')!;
      if (!idPattern.test(id) || counts.get(id) !== 1 || !allowed(el) || !dom.nodeLocation(el)?.startTag) continue;
      if (targets.length === 500) throw new VisualEditError('VISUAL_TARGET_LIMIT', 413);
      targets.push({ id, tag: el.localName, operations: operations(el), text: (el.textContent ?? '').slice(0, 256) });
    }
    return { hash: visualHash(source), targets };
  } finally { dom.window.close(); }
}
const escapeText = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttr = (value: string): string => escapeText(value).replaceAll('"', '&quot;');

export function applyVisualEdit(source: string, patch: VisualEditPatch): string {
  // Revalidate even when invoked without an HTTP boundary.
  parseVisualEditRequest({ expectedHash: visualHash(source), patch, confirm: true });
  const dom = parse(source);
  try {
    const nodes = Array.from(dom.window.document.querySelectorAll('[data-od-id]')).filter((el) => el.getAttribute('data-od-id') === patch.id);
    if (nodes.length !== 1) throw new VisualEditError('VISUAL_TARGET_CONFLICT', 409);
    const el = nodes[0]!;
    const loc = dom.nodeLocation(el);
    if (!allowed(el) || !loc?.startTag || !operations(el).includes(patch.kind)) invalid();
    const changes: Array<{ start: number; end: number; value: string }> = [];
    const expectedAttrs = new Map<string, string>();
    function attr(name: string, value: string): void {
      expectedAttrs.set(name, value);
      const range = loc!.attrs?.[name];
      changes.push(range ? { start: range.startOffset, end: range.endOffset, value: `${name}="${escapeAttr(value)}"` }
        : { start: loc!.startTag!.endOffset - (source[loc!.startTag!.endOffset - 2] === '/' ? 2 : 1), end: loc!.startTag!.endOffset - (source[loc!.startTag!.endOffset - 2] === '/' ? 2 : 1), value: ` ${name}="${escapeAttr(value)}"` });
    }
    if (patch.kind === 'set-text' || patch.kind === 'set-link') {
      if (!loc.endTag) invalid();
      changes.push({ start: loc.startTag.endOffset, end: loc.endTag.startOffset, value: escapeText(patch.kind === 'set-text' ? patch.value : patch.text) });
    }
    if (patch.kind === 'set-link') attr('href', patch.href);
    if (patch.kind === 'set-image') { attr('src', patch.src); attr('alt', patch.alt); }
    if (patch.kind === 'set-style') {
      const style = el.style;
      for (const [key, value] of Object.entries(patch.styles)) style.setProperty(key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`), value);
      attr('style', style.cssText);
    }
    let output = source;
    for (const change of changes.sort((a, b) => b.start - a.start)) output = output.slice(0, change.start) + change.value + output.slice(change.end);
    // Fail closed on malformed/duplicate attributes or parser recovery that
    // makes a source offset ambiguous (notably unquoted self-closing tags).
    const verified = parse(output);
    try {
      const matches = Array.from(verified.window.document.querySelectorAll('[data-od-id]')).filter((node) => node.getAttribute('data-od-id') === patch.id);
      if (matches.length !== 1 || !allowed(matches[0]!)) invalid();
      const normalize = (value: string): string => value.replace(/\r\n?/gu, '\n');
      for (const [name, value] of expectedAttrs) if (matches[0]!.getAttribute(name) !== normalize(value)) invalid();
      if (patch.kind === 'set-text' || patch.kind === 'set-link') {
        if (matches[0]!.textContent !== normalize(patch.kind === 'set-text' ? patch.value : patch.text) || matches[0]!.children.length !== 0) invalid();
      }
    } finally { verified.window.close(); }
    return output;
  } finally { dom.window.close(); }
}
