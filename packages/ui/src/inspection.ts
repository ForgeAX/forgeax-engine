import { parse } from 'css-tree/dist/csstree.esm';
import { type UiResult, uiInspectionFailed } from './errors.js';

/** These functions read the receiving document, never a retained DOM projection. */
export interface UiInspectionReader {
  getComputedStyle(element: Element): Pick<CSSStyleDeclaration, 'getPropertyValue'>;
  elementFromPoint(x: number, y: number): Element | null;
}

export interface UiInspectionRequest {
  /** Match independently within each open shadow tree. */
  readonly selector?: string;
  readonly styles?: readonly string[];
  /** Maximum visited elements, including unmatched elements: 1–512, default 256. */
  readonly limit?: number;
  readonly point?: { readonly x: number; readonly y: number };
}

export interface UiInspectionNode {
  /** Element-child path from the inspected root; `/shadow` enters an open root. */
  readonly path: string;
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly text: string;
  /** Owning asset/source, not an inferred author line for dynamically created nodes. */
  readonly source: { readonly guid: string | null; readonly path: string | null } | null;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly scroll: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly clientWidth: number;
    readonly clientHeight: number;
  };
  readonly style: Readonly<Record<string, string>>;
  readonly control?: {
    readonly value: string;
    readonly disabled: boolean;
    readonly validity: Pick<
      ValidityState,
      'valid' | 'badInput' | 'valueMissing' | 'rangeUnderflow' | 'rangeOverflow' | 'stepMismatch'
    >;
    readonly checked?: boolean;
    readonly valueAsNumber?: number | null;
    readonly validationMessage: string;
  };
}

export interface UiInspection {
  readonly nodes: readonly UiInspectionNode[];
  readonly visited: number;
  /** Element, depth, attribute or string bounds omitted part of this observation. */
  readonly truncated: boolean;
  /** Snapshot paths only. They are not handles and must not be replayed after mutation. */
  readonly focused: string | null;
  readonly hit: string | null;
}

const defaultStyles = [
  'display',
  'position',
  'pointer-events',
  'visibility',
  'overflow-x',
  'overflow-y',
  'font-family',
  'font-size',
  'line-height',
  'opacity',
];

type InspectionSource = UiInspectionNode['source'];
type InspectionControl = NonNullable<UiInspectionNode['control']>;

interface PendingElement {
  element: Element;
  path: string;
  depth: number;
  source: InspectionSource;
}

/** Synchronous, bounded observation of actual DOM/Blitz nodes, including open shadows. */
export function inspectUi(
  root: HTMLElement | null | undefined,
  request: UiInspectionRequest = {},
  reader?: UiInspectionReader,
): UiResult<UiInspection> {
  try {
    if (!root || root.nodeType !== 1 || !root.isConnected)
      throw new Error('UI inspection requires a connected root in the current document');
    const { limit, styles } = validateInspectionRequest(request);
    const observation = new UiObservation(resolveReader(root.ownerDocument, reader), styles, limit);
    const focused = observation.focusedElement(root.ownerDocument);
    const hit = observation.hitElement(request.point);
    const nodes: UiInspectionNode[] = [];
    let visited = 0;
    let focusPath: string | null = null;
    let hitPath: string | null = null;
    const pending: PendingElement[] = [
      { element: root, path: '.', depth: 0, source: observation.ancestorSource(root) },
    ];
    while (pending.length && visited < limit) {
      const next = pending.pop();
      if (!next) break;
      const { element, path } = next;
      visited++;
      if (element === focused) focusPath = path;
      if (element === hit) hitPath = path;
      const source = observation.source(element) ?? next.source;
      if (request.selector === undefined || element.matches(request.selector))
        nodes.push(observation.node(element, path, source));
      observation.enqueueChildren(pending, next, source);
    }
    return {
      ok: true,
      value: {
        nodes,
        visited,
        truncated: observation.truncated || pending.length > 0,
        focused: focusPath,
        hit: hitPath,
      },
    };
  } catch (cause) {
    return uiInspectionFailed(cause);
  }
}

function validateInspectionRequest(request: UiInspectionRequest): {
  readonly limit: number;
  readonly styles: readonly string[];
} {
  if (request === null || typeof request !== 'object' || Array.isArray(request))
    throw new TypeError('UI inspection request must be an object');
  const limit = request.limit ?? 256;
  const styles = request.styles ?? defaultStyles;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512)
    throw new TypeError('UI inspection limit must be an integer from 1 to 512');
  if (
    !Array.isArray(styles) ||
    styles.length > 32 ||
    styles.some(
      (name) =>
        typeof name !== 'string' || name.length > 80 || !/^(?:--)?[a-z][a-z0-9-]*$/i.test(name),
    )
  )
    throw new TypeError('UI inspection styles must contain at most 32 CSS property names');
  if (request.selector !== undefined) validateSelector(request.selector);
  const point = request.point;
  if (point !== undefined && (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)))
    throw new TypeError('UI inspection point must contain finite logical coordinates');
  return { limit, styles };
}

function validateSelector(selector: string): void {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 512)
    throw new TypeError('UI inspection selector must contain 1–512 characters');
  parse(selector, { context: 'selectorList' });
}

function resolveReader(document: Document, reader: UiInspectionReader | undefined) {
  if (reader) return reader;
  const view = document.defaultView;
  if (!view) throw new Error('Provide the native UI document reader');
  return {
    getComputedStyle: (element: Element) => view.getComputedStyle(element),
    elementFromPoint: (x: number, y: number) => document.elementFromPoint(x, y),
  };
}

/** One bounded observation: the reader, requested styles, limits and truncation evidence. */
class UiObservation {
  truncated = false;

  constructor(
    private readonly reader: UiInspectionReader,
    private readonly styles: readonly string[],
    private readonly limit: number,
  ) {}

  bounded(value: string): string {
    if (value.length > 512) this.truncated = true;
    return value.slice(0, 512);
  }

  focusedElement(document: Document): Element | null {
    let focused = document.activeElement;
    for (let depth = 0; focused?.shadowRoot?.activeElement; depth++) {
      if (depth >= 64) {
        this.truncated = true;
        break;
      }
      focused = focused.shadowRoot.activeElement;
    }
    return focused;
  }

  hitElement(point: UiInspectionRequest['point']): Element | null {
    if (!point) return null;
    let hit = this.reader.elementFromPoint(point.x, point.y);
    // Browsers retarget a document hit to the shadow host; Blitz returns the core node.
    for (let depth = 0; hit?.shadowRoot; depth++) {
      if (depth >= 64) {
        this.truncated = true;
        break;
      }
      const inner = hit.shadowRoot.elementFromPoint?.(point.x, point.y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  /** The element's own asset/source attribution, or null when it inherits one. */
  source(element: Element): InspectionSource {
    const guid = element.getAttribute('data-ui-asset');
    const path = element.getAttribute('data-ui-source');
    if (!guid && !path) return null;
    return {
      guid: guid === null ? null : this.bounded(guid),
      path: path === null ? null : this.bounded(path),
    };
  }

  /** Attribution inherited by the inspected root from its nearest attributed ancestor. */
  ancestorSource(root: Element): InspectionSource {
    for (let node: Element | null = root, depth = 0; node; depth++) {
      if (depth >= 64) {
        this.truncated = true;
        break;
      }
      const source = this.source(node);
      if (source) return source;
      const tree = node.getRootNode();
      node = node.parentElement ?? (tree.nodeType === 11 ? (tree as ShadowRoot).host : null);
    }
    return null;
  }

  node(element: Element, path: string, source: InspectionSource): UiInspectionNode {
    const rect = element.getBoundingClientRect();
    const computed = this.reader.getComputedStyle(element);
    const names = element.getAttributeNames();
    if (names.length > 32) this.truncated = true;
    const text = this.text(element);
    const control = this.control(element);
    return {
      path,
      tag: element.localName,
      source,
      attributes: Object.fromEntries(
        names.slice(0, 32).map((name) => [name, this.bounded(element.getAttribute(name) ?? '')]),
      ),
      text: this.bounded(text),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scroll: {
        left: element.scrollLeft,
        top: element.scrollTop,
        width: element.scrollWidth,
        height: element.scrollHeight,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      },
      style: Object.fromEntries(
        this.styles.map((name) => [name, this.bounded(computed.getPropertyValue(name))]),
      ),
      ...(control ? { control } : {}),
    };
  }

  private text(element: Element): string {
    let text = '';
    if (element.localName === 'style') return text;
    const children = element.childNodes;
    const count = Math.min(children.length, this.limit);
    if (count < children.length) this.truncated = true;
    for (let index = 0; index < count; index++) {
      const node = children[index];
      if (!node) continue;
      if (node.nodeType === 3) text += this.bounded(node.textContent ?? '');
      if (text.length > 512) {
        this.truncated = true;
        break;
      }
    }
    return text;
  }

  private control(element: Element): InspectionControl | undefined {
    const control = ['input', 'textarea', 'select'].includes(element.localName)
      ? (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
      : undefined;
    const validity = control?.validity;
    if (!control || !validity) return undefined;
    return {
      value: this.bounded(control.value),
      disabled: control.disabled,
      validity: {
        valid: validity.valid,
        badInput: validity.badInput,
        valueMissing: validity.valueMissing,
        rangeUnderflow: validity.rangeUnderflow,
        rangeOverflow: validity.rangeOverflow,
        stepMismatch: validity.stepMismatch,
      },
      ...(element.localName === 'input' &&
      ['checkbox', 'radio'].includes((control as HTMLInputElement).type)
        ? { checked: (control as HTMLInputElement).checked }
        : {}),
      ...(element.localName === 'input' && (control as HTMLInputElement).type === 'number'
        ? {
            valueAsNumber: Number.isFinite((control as HTMLInputElement).valueAsNumber)
              ? (control as HTMLInputElement).valueAsNumber
              : null,
          }
        : {}),
      validationMessage: this.bounded(control.validationMessage),
    };
  }

  /** Light children then open-shadow children, popped in document order. */
  enqueueChildren(pending: PendingElement[], parent: PendingElement, source: InspectionSource) {
    const { element, path, depth } = parent;
    const children: PendingElement[] = [];
    const branches = [{ children: element.children, path }];
    if (element.shadowRoot)
      branches.push({ children: element.shadowRoot.children, path: `${path}/shadow` });
    for (const branch of branches) {
      const count =
        depth >= 64
          ? 0
          : Math.min(branch.children.length, this.limit - pending.length - children.length);
      if (count < branch.children.length) this.truncated = true;
      for (let index = 0; index < count; index++) {
        const child = branch.children[index];
        if (child)
          children.push({
            element: child,
            path: `${branch.path}/${index}`,
            depth: depth + 1,
            source,
          });
      }
    }
    pending.push(...children.reverse());
  }
}
