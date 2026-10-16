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

/** Synchronous, bounded observation of actual DOM/Blitz nodes, including open shadows. */
export function inspectUi(
  root: HTMLElement | null | undefined,
  request: UiInspectionRequest = {},
  reader?: UiInspectionReader,
): UiResult<UiInspection> {
  try {
    if (!root || root.nodeType !== 1 || !root.isConnected)
      throw new Error('UI inspection requires a connected root in the current document');
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
    if (
      request.selector !== undefined &&
      (typeof request.selector !== 'string' ||
        !request.selector.trim() ||
        request.selector.length > 512)
    )
      throw new TypeError('UI inspection selector must contain 1–512 characters');
    if (request.selector !== undefined) parse(request.selector, { context: 'selectorList' });
    const point = request.point;
    if (point !== undefined && (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)))
      throw new TypeError('UI inspection point must contain finite logical coordinates');
    const document = root.ownerDocument;
    const view = document.defaultView;
    const resolved =
      reader ??
      (view
        ? {
            getComputedStyle: (element: Element) => view.getComputedStyle(element),
            elementFromPoint: (x: number, y: number) => document.elementFromPoint(x, y),
          }
        : undefined);
    if (!resolved) throw new Error('Provide the native UI document reader');
    let truncated = false;
    let focused = document.activeElement;
    for (let depth = 0; focused?.shadowRoot?.activeElement; depth++) {
      if (depth >= 64) {
        truncated = true;
        break;
      }
      focused = focused.shadowRoot.activeElement;
    }
    let hit = point ? resolved.elementFromPoint(point.x, point.y) : null;
    // Browsers retarget a document hit to the shadow host; Blitz returns the core node.
    if (point) {
      for (let depth = 0; hit?.shadowRoot; depth++) {
        if (depth >= 64) {
          truncated = true;
          break;
        }
        const inner = hit.shadowRoot.elementFromPoint?.(point.x, point.y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
    }
    const bounded = (value: string) => {
      if (value.length > 512) truncated = true;
      return value.slice(0, 512);
    };
    const nodes: UiInspectionNode[] = [];
    let visited = 0;
    let focusPath: string | null = null;
    let hitPath: string | null = null;
    let initialSource: UiInspectionNode['source'] = null;
    for (let node: Element | null = root, depth = 0; node; depth++) {
      if (depth >= 64) {
        truncated = true;
        break;
      }
      const guid = node.getAttribute('data-ui-asset');
      const path = node.getAttribute('data-ui-source');
      if (guid || path) {
        initialSource = {
          guid: guid === null ? null : bounded(guid),
          path: path === null ? null : bounded(path),
        };
        break;
      }
      const tree = node.getRootNode();
      node = node.parentElement ?? (tree.nodeType === 11 ? (tree as ShadowRoot).host : null);
    }
    const pending: {
      element: Element;
      path: string;
      depth: number;
      source: UiInspectionNode['source'];
    }[] = [{ element: root, path: '.', depth: 0, source: initialSource }];
    while (pending.length && visited < limit) {
      const next = pending.pop();
      if (!next) break;
      const { element, path, depth, source: inheritedSource } = next;
      visited++;
      if (element === focused) focusPath = path;
      if (element === hit) hitPath = path;
      const guid = element.getAttribute('data-ui-asset');
      const sourcePath = element.getAttribute('data-ui-source');
      const source =
        guid || sourcePath
          ? {
              guid: guid === null ? null : bounded(guid),
              path: sourcePath === null ? null : bounded(sourcePath),
            }
          : inheritedSource;
      if (request.selector === undefined || element.matches(request.selector)) {
        const rect = element.getBoundingClientRect();
        const computed = resolved.getComputedStyle(element);
        const names = element.getAttributeNames();
        if (names.length > 32) truncated = true;
        let text = '';
        if (element.localName !== 'style') {
          const children = element.childNodes;
          const count = Math.min(children.length, limit);
          if (count < children.length) truncated = true;
          for (let index = 0; index < count; index++) {
            const node = children[index];
            if (!node) continue;
            if (node.nodeType === 3) text += bounded(node.textContent ?? '');
            if (text.length > 512) {
              truncated = true;
              break;
            }
          }
        }
        const control = ['input', 'textarea', 'select'].includes(element.localName)
          ? (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
          : undefined;
        const validity = control?.validity;
        nodes.push({
          path,
          tag: element.localName,
          source,
          attributes: Object.fromEntries(
            names.slice(0, 32).map((name) => [name, bounded(element.getAttribute(name) ?? '')]),
          ),
          text: bounded(text),
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
            styles.map((name) => [name, bounded(computed.getPropertyValue(name))]),
          ),
          ...(control && validity
            ? {
                control: {
                  value: bounded(control.value),
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
                  ...(element.localName === 'input' &&
                  (control as HTMLInputElement).type === 'number'
                    ? {
                        valueAsNumber: Number.isFinite((control as HTMLInputElement).valueAsNumber)
                          ? (control as HTMLInputElement).valueAsNumber
                          : null,
                      }
                    : {}),
                  validationMessage: bounded(control.validationMessage),
                },
              }
            : {}),
        });
      }
      const children: typeof pending = [];
      const branches = [{ children: element.children, path }];
      if (element.shadowRoot)
        branches.push({ children: element.shadowRoot.children, path: `${path}/shadow` });
      for (const branch of branches) {
        const count =
          depth >= 64
            ? 0
            : Math.min(branch.children.length, limit - pending.length - children.length);
        if (count < branch.children.length) truncated = true;
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
    return {
      ok: true,
      value: {
        nodes,
        visited,
        truncated: truncated || pending.length > 0,
        focused: focusPath,
        hit: hitPath,
      },
    };
  } catch (cause) {
    return uiInspectionFailed(cause);
  }
}
