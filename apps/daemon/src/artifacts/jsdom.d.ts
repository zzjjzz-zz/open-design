/** The daemon intentionally excludes lib.dom: adding @types/jsdom globally
 * changes Node/undici fetch types throughout the daemon. This declaration
 * describes only our inert parser boundary and does not expose script loading.
 */
declare module 'jsdom' {
  export interface HtmlElement {
    localName: string;
    namespaceURI: string | null;
    parentElement: HtmlElement | null;
    children: ArrayLike<HtmlElement>;
    attributes: ArrayLike<{ name: string; value: string }>;
    textContent: string | null;
    getAttribute(name: string): string | null;
    style: { cssText: string; setProperty(name: string, value: string): void };
  }
  interface SourceRange { startOffset: number; endOffset: number }
  interface NodeLocation extends SourceRange {
    startTag?: SourceRange;
    endTag?: SourceRange;
    attrs?: Record<string, SourceRange>;
  }
  export class JSDOM {
    constructor(source: string, options: { includeNodeLocations: true });
    window: {
      document: { querySelectorAll(selector: string): ArrayLike<HtmlElement> };
      close(): void;
    };
    nodeLocation(node: HtmlElement): NodeLocation | null;
  }
}
