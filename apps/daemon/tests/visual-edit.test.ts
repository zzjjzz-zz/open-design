import { describe, expect, it } from 'vitest';
import { applyVisualEdit, getVisualEditTargets, parseVisualEditRequest, visualHash } from '../src/artifacts/visual-edit.js';
import type { VisualEditPatch } from '@open-design/contracts';

const source = '<!DOCTYPE html>\n<html><body><h1 data-od-id="title">Hello</h1><a data-od-id="link" href="old.html">Old</a><img data-od-id="image" src="old.png"><script>throw new Error("MUST NOT RUN")</script></body></html>';
const request = (patch: unknown) => ({ expectedHash: visualHash(source), confirm: true, patch });
describe('restricted static HTML edits', () => {
  it('lists only exact unique static source targets without executing scripts', () => {
    expect(getVisualEditTargets(source)).toMatchObject({ hash: visualHash(source), targets: [{ id: 'title' }, { id: 'link' }, { id: 'image' }] });
    const unsafe = '<p data-od-id="dup">a</p><p data-od-id="dup">b</p><script data-od-id="script">x</script><p data-od-id="event" onclick="x()">x</p><svg><a data-od-id="svg">x</a></svg><template><p data-od-id="tpl">x</p></template>';
    expect(getVisualEditTargets(unsafe).targets).toEqual([]);
  });
  it('escapes text and preserves all untouched source bytes', () => {
    const result = applyVisualEdit(source, { id: 'title', kind: 'set-text', value: '<script>alert(1)</script>&"' });
    expect(result).toBe(source.replace('Hello', '&lt;script&gt;alert(1)&lt;/script&gt;&amp;"'));
    expect(applyVisualEdit(source, { id: 'title', kind: 'set-text', value: '' })).toContain('data-od-id="title"></h1>');
  });
  it('edits links, images and constrained styles', () => {
    expect(applyVisualEdit(source, { id: 'link', kind: 'set-link', text: 'Visit', href: 'https://example.com/?x=1&y=2' })).toContain('href="https://example.com/?x=1&amp;y=2">Visit');
    expect(applyVisualEdit(source, { id: 'image', kind: 'set-image', src: 'assets/photo.png', alt: 'A "photo"' })).toContain('alt="A &quot;photo&quot;"');
    expect(applyVisualEdit(source, { id: 'title', kind: 'set-style', styles: { color: '#fff', fontSize: '24px' } })).toContain('font-size: 24px;');
  });
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,test', '//evil.test/x', '/api/projects/foreign/raw/a', '../foreign/a', 'java\nscript:alert(1)', 'https://user:pass@example.com', 'assets/%2e%2e/a', 'https:\\evil.test'])('rejects URL %s', (href) => {
    expect(() => parseVisualEditRequest(request({ id: 'link', kind: 'set-link', text: 'x', href }))).toThrow();
  });
  it.each(['http://example.com/a.png', 'data:image/svg+xml,test', 'file:///etc/passwd'])('rejects image URL %s', (src) => {
    expect(() => parseVisualEditRequest(request({ id: 'image', kind: 'set-image', src, alt: '' }))).toThrow();
  });
  it.each([{ color: 'red; background:url(https://evil)' }, { color: 'var(--evil)' }, { color: 'red!important' }, { backgroundImage: 'url(https://evil)' }, { width: 'expression(alert(1))' }, { color: 'r\\65 d' }, { onload: 'x' }, { __proto__: { color: 'red' } }])('rejects CSS or property injection %j', (styles) => {
    expect(() => parseVisualEditRequest(request({ id: 'title', kind: 'set-style', styles }))).toThrow();
  });
  it.each([
    { id: 'title', kind: 'set-text', value: 'ok', onclick: 'evil()' },
    { id: 'title', kind: 'set-outer-html', html: '<script>evil()</script>' },
    { id: 'title', kind: 'set-attributes', attributes: { onload: 'evil()' } },
  ])('rejects extra attributes and arbitrary HTML %j', (patch) => expect(() => parseVisualEditRequest(request(patch))).toThrow());
  it('rejects script/raw text/foreign/nested/ambiguous or absent targets', () => {
    for (const html of ['<script data-od-id="x">a</script>', '<style data-od-id="x">a</style>', '<textarea data-od-id="x">a</textarea>', '<svg><text data-od-id="x">a</text></svg>', '<p data-od-id="x"><b>nested</b></p>', '<p data-od-id="x">a</p><p data-od-id="x">b</p>', '<p>absent</p>']) {
      expect(() => applyVisualEdit(html, { id: 'x', kind: 'set-text', value: 'text' })).toThrow();
    }
    expect(() => applyVisualEdit(source, { id: 'title', kind: 'set-image', src: 'ok.png', alt: '' })).toThrow();
  });
  it('does not silently apply malformed or duplicate attributes to a different value', () => {
    for (const html of ['<img data-od-id="x" src=x/>', '<img data-od-id="x" src="first.png" src="second.png">']) {
      try {
        const changed = applyVisualEdit(html, { id: 'x', kind: 'set-image', src: 'safe.png', alt: 'safe' });
        expect(changed).toContain('src="safe.png"');
        expect(changed).toContain('alt="safe"');
      } catch (error) { expect(String(error)).toContain('INVALID_VISUAL_PATCH'); }
    }
  });
  it('requires exact SHA256, confirmation and strict envelope', () => {
    const patch: VisualEditPatch = { kind: 'set-text', id: 'title', value: 'ok' };
    for (const body of [{ ...request(patch), expectedHash: 'bad' }, { ...request(patch), confirm: false }, { ...request(patch), html: 'extra' }]) expect(() => parseVisualEditRequest(body)).toThrow();
  });
});
