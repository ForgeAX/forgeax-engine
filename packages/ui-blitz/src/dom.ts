import {
  parseCssAuthoring,
  parseHtmlAuthoring,
  UI_AUTHORING_PROFILE,
} from '@forgeax/engine-ui/authoring';
import type { UiDocument } from '../pkg/ui-native.mjs';

type UiDiagnostics = ReturnType<typeof parseHtmlAuthoring>['diagnostics'];

type Listener = EventListenerOrEventListenerObject;
type FocusSource = 'script' | 'pointer' | 'sequential';
interface Subscription {
  readonly callback: Listener;
  readonly capture: boolean;
  readonly once: boolean;
  readonly passive: boolean;
  readonly release?: () => void;
}

export class UiDomError extends Error {
  readonly code = 'ui-dom-operation-failed';
  constructor(
    readonly operation: string,
    cause: unknown,
    readonly diagnostics: UiDiagnostics = [],
  ) {
    super(`UI DOM operation failed: ${operation}`, { cause });
  }
}

export function assertUiSupport(operation: string, diagnostics: UiDiagnostics): void {
  if (diagnostics.some((entry) => entry.severity === 'error'))
    throw new UiDomError(operation, 'Unsupported or invalid portable UI source', diagnostics);
}

function checkCss(
  source: string,
  operation: string,
  context: 'stylesheet' | 'declarationList' | 'declaration' = 'stylesheet',
): void {
  assertUiSupport(
    operation,
    parseCssAuthoring(source, `<ui-dom:${operation}>`, { portableOnly: true, context }).diagnostics,
  );
}

function checkHtml(source: string, operation: string, contextElement?: string): void {
  assertUiSupport(
    operation,
    parseHtmlAuthoring(source, `<ui-dom:${operation}>`, {
      portableOnly: true,
      ...(contextElement ? { contextElement } : {}),
    }).diagnostics,
  );
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

export class UiEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly isTrusted = false;
  readonly timeStamp: number;
  target: UiNode | null = null;
  currentTarget: UiNode | null = null;
  eventPhase = 0;
  defaultPrevented = false;
  cancelBubble = false;
  immediate = false;
  passive = false;
  dispatching = false;
  path: UiNode[] = [];
  readonly submitter?: UiElement;
  relatedTarget?: UiElement | null;
  exposed: Event | UiEvent = this;
  nativePreventDefault?: () => void;
  constructor(
    type: string,
    init: EventInit & {
      timeStamp?: number;
      submitter?: UiElement;
      relatedTarget?: UiElement | null;
    } = {},
  ) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    this.composed = init.composed ?? false;
    this.timeStamp = init.timeStamp ?? 0;
    if (init.submitter) this.submitter = init.submitter;
    if ('relatedTarget' in init) this.relatedTarget = init.relatedTarget;
  }
  preventDefault(): void {
    if (this.cancelable && !this.passive) {
      this.defaultPrevented = true;
      this.nativePreventDefault?.();
    }
  }
  stopPropagation(): void {
    this.cancelBubble = true;
  }
  stopImmediatePropagation(): void {
    this.cancelBubble = this.immediate = true;
  }
  composedPath(): UiNode[] {
    return [...this.path];
  }
}

const dispatchStates = new WeakMap<Event, UiEvent>();
function dispatchState(input: Event | UiEvent): UiEvent {
  if (input instanceof UiEvent) return input;
  const previous = dispatchStates.get(input);
  if (previous) return previous;
  const state = new UiEvent(input.type, input);
  state.exposed = input;
  state.defaultPrevented = input.defaultPrevented;
  state.nativePreventDefault = input.preventDefault.bind(input);
  for (const key of ['target', 'currentTarget', 'eventPhase', 'defaultPrevented'] as const) {
    Object.defineProperty(input, key, { configurable: true, get: () => state[key] });
  }
  Object.defineProperties(input, {
    cancelBubble: {
      configurable: true,
      get: () => state.cancelBubble,
      set: (value: boolean) => {
        if (value) state.cancelBubble = true;
      },
    },
    preventDefault: { configurable: true, value: () => state.preventDefault() },
    stopPropagation: { configurable: true, value: () => state.stopPropagation() },
    stopImmediatePropagation: { configurable: true, value: () => state.stopImmediatePropagation() },
    composedPath: { configurable: true, value: () => state.composedPath() },
  });
  dispatchStates.set(input, state);
  return state;
}

/** The cache retains facade identity, never parent/child/value/layout state. */
export class BlitzDocument {
  readonly nodes = new Map<bigint, WeakRef<UiNode>>();
  readonly listenerNodes = new Set<UiNode>();
  readonly root: UiDocumentNode;
  private disposed = false;
  get isDisposed(): boolean {
    return this.disposed;
  }
  readonly focusListeners = new Set<() => void>();
  readonly formResetListeners = new Set<(form: UiElement) => void>();
  private focusRevision = 0;
  time = 0;
  constructor(
    readonly core: UiDocument,
    readonly reportError: (error: unknown) => void,
  ) {
    this.root = this.wrap(core.root()) as UiDocumentNode;
  }
  read<T>(operation: string, action: (core: UiDocument) => T): T {
    if (this.disposed) throw new UiDomError(operation, 'UI document disposed');
    try {
      return action(this.core);
    } catch (cause) {
      throw new UiDomError(operation, cause);
    }
  }
  wrap(id: bigint): UiNode {
    const existing = this.nodes.get(id)?.deref();
    if (existing) return existing;
    const type = this.read('nodeType', (core) => core.node_type(id));
    const node =
      type === 9
        ? new UiDocumentNode(this, id)
        : type === 1
          ? new UiElement(this, id)
          : type === 11
            ? this.core.shadow_host(id) === 0n
              ? new UiFragment(this, id)
              : new UiShadowRoot(this, id)
            : new UiNode(this, id);
    this.nodes.set(id, new WeakRef(node));
    return node;
  }
  focused(): UiElement | null {
    const id = this.read('focused', (core) => core.focused());
    if (id === 0n) return null;
    const element = this.wrap(id) as UiElement;
    return ['html', 'body'].includes(element.localName) && element.tabIndex < 0 ? null : element;
  }
  focus(element: UiElement | null, source: FocusSource = 'script'): boolean {
    if (element && isInert(element)) return false;
    const previous = this.focused();
    if (!previous && !element) return true;
    // Resolve eligibility without provisionally focusing the next editor. Change/blur
    // callbacks must observe the body and may redirect or retire that target.
    if (element && !this.read('focus', (core) => core.can_focus(element.coreId))) return false;
    if (previous === element) {
      this.read('focus', (core) => core.focus(element?.coreId ?? 0n, source === 'pointer'));
      return this.focused() === element;
    }
    const revision = ++this.focusRevision;
    if (previous) {
      this.read('focus', (core) => core.focus(0n, source === 'pointer'));
      this.notifyFocus();
      if (this.disposed) return true;
      previous.dispatchEvent(new UiEvent('blur', { composed: true, relatedTarget: element }));
      if (this.disposed) return true;
      previous.dispatchEvent(
        new UiEvent('focusout', {
          bubbles: true,
          composed: true,
          relatedTarget: revision === this.focusRevision ? element : null,
        }),
      );
      if (this.disposed) return true;
    }
    // A callback-directed focus is accepted: interactive validation must not
    // overwrite it by moving on to another invalid field.
    if (revision !== this.focusRevision) return true;
    if (element && isInert(element)) return false;
    this.read('focus', (core) => core.focus(element?.coreId ?? 0n, source === 'pointer'));
    const current = this.focused();
    const accepted = current === element;
    if (current) {
      if (source === 'sequential')
        this.read('focus.select', (core) => core.select_input_text(current.coreId));
      current.dispatchEvent(new UiEvent('focus', { composed: true, relatedTarget: previous }));
      if (this.disposed) return accepted;
      if (revision === this.focusRevision)
        current.dispatchEvent(
          new UiEvent('focusin', { bubbles: true, composed: true, relatedTarget: previous }),
        );
    }
    this.notifyFocus();
    return accepted;
  }
  private notifyFocus(): void {
    for (const listener of [...this.focusListeners]) {
      if (this.disposed) return;
      if (this.focusListeners.has(listener)) listener();
    }
  }
  /** Mutations can detach or disable an editor without dispatching a blur event. */
  reconcileFocus(): void {
    const current = this.focused();
    if (current && (!current.isConnected || current.disabled || isInert(current))) this.focus(null);
    else this.notifyFocus();
  }
  /** Called at the App frame boundary, after all script mutations have returned. */
  collect(): number {
    const retained: bigint[] = [];
    for (const [id, reference] of this.nodes) {
      if (reference.deref()) retained.push(id);
      else this.nodes.delete(id);
    }
    return this.read('collect', (core) => core.collect_detached(BigUint64Array.from(retained)));
  }
  dispose(): void {
    if (this.disposed) return;
    try {
      this.focus(null);
    } finally {
      this.disposed = true;
      this.focusListeners.clear();
      this.formResetListeners.clear();
      for (const node of this.listenerNodes) node.releaseListeners();
      this.listenerNodes.clear();
      this.nodes.clear();
      this.core.free();
    }
  }
}

export class UiNode {
  private readonly subscriptions = new Map<string, Subscription[]>();
  constructor(
    readonly realm: BlitzDocument,
    readonly coreId: bigint,
  ) {}
  protected read<T>(operation: string, action: (core: UiDocument) => T): T {
    return this.realm.read(operation, action);
  }
  get ownerDocument(): UiDocumentNode | null {
    return this.nodeType === 9 ? null : this.realm.root;
  }
  get nodeType(): number {
    return this.read('nodeType', (core) => core.node_type(this.coreId));
  }
  get nodeName(): string {
    return this.nodeType === 1
      ? (this as unknown as UiElement).tagName
      : this.nodeType === 9
        ? '#document'
        : this.nodeType === 11
          ? '#document-fragment'
          : '#text';
  }
  get parentNode(): UiNode | null {
    const id = this.read('parentNode', (core) => core.parent(this.coreId));
    return id === 0n ? null : this.realm.wrap(id);
  }
  get parentElement(): UiElement | null {
    const parent = this.parentNode;
    return parent?.nodeType === 1 ? (parent as UiElement) : null;
  }
  get childNodes(): UiNode[] {
    return Array.from(
      this.read('childNodes', (core) => core.children(this.coreId)),
      (id) => this.realm.wrap(id),
    );
  }
  get children(): UiElement[] {
    return this.childNodes.filter((node): node is UiElement => node.nodeType === 1);
  }
  get firstChild(): UiNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): UiNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get firstElementChild(): UiElement | null {
    return this.children[0] ?? null;
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get nextElementSibling(): UiElement | null {
    let next = this.nextSibling;
    while (next && next.nodeType !== 1) next = next.nextSibling;
    return next as UiElement | null;
  }
  get previousElementSibling(): UiElement | null {
    let previous = this.previousSibling;
    while (previous && previous.nodeType !== 1) previous = previous.previousSibling;
    return previous as UiElement | null;
  }
  get lastElementChild(): UiElement | null {
    return this.children.at(-1) ?? null;
  }
  get nextSibling(): UiNode | null {
    const children = this.parentNode?.childNodes ?? [];
    return children[children.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): UiNode | null {
    const children = this.parentNode?.childNodes ?? [];
    return children[children.indexOf(this) - 1] ?? null;
  }
  get isConnected(): boolean {
    return this.getRootNode({ composed: true }) === this.realm.root;
  }
  get textContent(): string {
    return this.read('textContent', (core) => core.text_content(this.coreId));
  }
  set textContent(value: string | null) {
    if (this instanceof UiElement && this.localName === 'style')
      checkCss(value ?? '', 'textContent');
    else if (this.parentElement?.localName === 'style') {
      checkCss(
        this.parentElement.childNodes
          .map((node) => (node === this ? (value ?? '') : node.textContent))
          .join(''),
        'textContent',
      );
    }
    this.read('textContent', (core) => core.set_text_content(this.coreId, value ?? ''));
    this.realm.reconcileFocus();
  }
  getRootNode(options: GetRootNodeOptions = {}): UiNode {
    let root: UiNode = this;
    while (root.parentNode) root = root.parentNode;
    return options.composed && root instanceof UiShadowRoot ? root.host.getRootNode(options) : root;
  }
  contains(node: UiNode | null): boolean {
    for (; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  querySelector(selector: string): UiElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): UiElement[] {
    return Array.from(
      this.read('querySelectorAll', (core) => core.query(this.coreId, selector)),
      (id) => this.realm.wrap(id) as UiElement,
    );
  }
  cloneNode(deep = false): UiNode {
    return this.realm.wrap(this.read('cloneNode', (core) => core.clone_node(this.coreId, deep)));
  }
  appendChild<T extends UiNode>(node: T): T {
    return this.insertBefore(node, null);
  }
  insertBefore<T extends UiNode>(node: T, before: UiNode | null): T {
    if (node.realm !== this.realm || (before && before.realm !== this.realm)) {
      throw new UiDomError(
        'insertBefore',
        'Cross-document adoption is outside the portable UI subset',
      );
    }
    if (this instanceof UiElement && this.localName === 'style') {
      const children = this.childNodes.filter((child) => child !== node);
      const position = before === null ? children.length : children.indexOf(before);
      children.splice(Math.max(position, 0), 0, node);
      checkCss(children.map((child) => child.textContent).join(''), 'insertBefore:style');
    }
    if (node instanceof UiFragment && !(node instanceof UiShadowRoot)) {
      for (const child of node.childNodes) this.insertBefore(child, before);
    } else
      this.read('insertBefore', (core) =>
        core.insert(this.coreId, node.coreId, before?.coreId ?? 0n),
      );
    return node;
  }
  append(...nodes: (UiNode | string)[]): void {
    for (const node of nodes)
      this.appendChild(typeof node === 'string' ? this.realm.root.createTextNode(node) : node);
  }
  prepend(...nodes: (UiNode | string)[]): void {
    const first = this.firstChild;
    for (const node of nodes)
      this.insertBefore(
        typeof node === 'string' ? this.realm.root.createTextNode(node) : node,
        first,
      );
  }
  removeChild<T extends UiNode>(node: T): T {
    if (node.parentNode !== this) throw new UiDomError('removeChild', 'NotFoundError');
    node.remove();
    return node;
  }
  replaceChildren(...nodes: (UiNode | string)[]): void {
    if (this instanceof UiElement && this.localName === 'style')
      checkCss(
        nodes.map((node) => (typeof node === 'string' ? node : node.textContent)).join(''),
        'replaceChildren:style',
      );
    for (const child of this.childNodes) child.remove();
    this.append(...nodes);
  }
  remove(): void {
    this.read('remove', (core) => core.remove(this.coreId));
    this.realm.reconcileFocus();
  }
  before(...nodes: (UiNode | string)[]): void {
    const parent = this.parentNode;
    for (const node of nodes)
      parent?.insertBefore(
        typeof node === 'string' ? this.realm.root.createTextNode(node) : node,
        this,
      );
  }
  after(...nodes: (UiNode | string)[]): void {
    const parent = this.parentNode,
      next = this.nextSibling;
    for (const node of nodes)
      parent?.insertBefore(
        typeof node === 'string' ? this.realm.root.createTextNode(node) : node,
        next,
      );
  }
  replaceWith(...nodes: (UiNode | string)[]): void {
    this.before(...nodes);
    this.remove();
  }
  replaceChild<T extends UiNode>(node: UiNode, child: T): T {
    if (child.parentNode !== this) throw new UiDomError('replaceChild', 'NotFoundError');
    if (node === child) return child;
    this.insertBefore(node, child);
    child.remove();
    return child;
  }
  addEventListener(
    type: string,
    callback: Listener | null,
    options: boolean | AddEventListenerOptions = {},
  ): void {
    if (!callback) return;
    const opts = typeof options === 'boolean' ? { capture: options } : options;
    if (opts.signal?.aborted) return;
    const capture = opts.capture ?? false;
    const rows = this.subscriptions.get(type) ?? [];
    if (rows.some((row) => row.callback === callback && row.capture === capture)) return;
    const abort = () => this.removeEventListener(type, callback, { capture });
    const entry: Subscription = {
      callback,
      capture,
      once: opts.once ?? false,
      passive: opts.passive ?? false,
      ...(opts.signal ? { release: () => opts.signal?.removeEventListener('abort', abort) } : {}),
    };
    rows.push(entry);
    this.subscriptions.set(type, rows);
    opts.signal?.addEventListener('abort', abort, { once: true });
    this.realm.listenerNodes.add(this);
  }
  removeEventListener(
    type: string,
    callback: Listener | null,
    options: boolean | EventListenerOptions = {},
  ): void {
    const capture = typeof options === 'boolean' ? options : (options.capture ?? false);
    const rows = this.subscriptions.get(type);
    if (!rows) return;
    const index = rows.findIndex((row) => row.callback === callback && row.capture === capture);
    if (index !== -1) rows.splice(index, 1)[0]?.release?.();
    if (!rows.length) this.subscriptions.delete(type);
    if (!this.subscriptions.size) this.realm.listenerNodes.delete(this);
  }
  releaseListeners(): void {
    for (const rows of this.subscriptions.values()) for (const row of rows) row.release?.();
    this.subscriptions.clear();
  }
  private invoke(event: UiEvent, capture: boolean): void {
    const rows = this.subscriptions.get(event.type) ?? [];
    for (const row of [...rows]) {
      if (event.immediate || this.realm.isDisposed) break;
      if (row.capture !== capture || !this.subscriptions.get(event.type)?.includes(row)) continue;
      if (row.once) this.removeEventListener(event.type, row.callback, { capture });
      event.passive = row.passive;
      try {
        if (typeof row.callback === 'function')
          row.callback.call(this as unknown as EventTarget, event.exposed as Event);
        else row.callback.handleEvent(event.exposed as Event);
      } catch (cause) {
        this.realm.reportError(cause);
      } finally {
        event.passive = false;
      }
    }
  }
  dispatchEvent(input: Event | UiEvent): boolean {
    const event = dispatchState(input);
    if (event.dispatching || !event.type)
      throw new UiDomError('dispatchEvent', 'InvalidStateError');
    event.dispatching = true;
    event.target = this;
    event.path = [];
    // Freeze both the path and each boundary's retarget before entering JS.
    // A callback may remove/reparent the host without changing this dispatch.
    const path: {
      node: UiNode;
      target: UiNode;
      relatedTarget: UiElement | null | undefined;
      atTarget: boolean;
    }[] = [];
    const related = event.relatedTarget;
    const retarget = (
      value: UiElement | null | undefined,
      against: UiNode,
    ): UiElement | null | undefined => {
      while (value) {
        const root = value.getRootNode();
        if (!(root instanceof UiShadowRoot) || root === against || root.contains(against))
          return value;
        value = root.host;
      }
      return value;
    };
    let target: UiNode = this;
    for (let node: UiNode | null = this; node; ) {
      const relatedTarget = retarget(related, node);
      if (relatedTarget === target) break;
      path.push({ node, target, relatedTarget, atTarget: node === target });
      if (node instanceof UiShadowRoot) {
        if (!event.composed) break;
        target = node.host;
        node = target;
      } else node = node.parentNode;
    }
    event.path = path.map((entry) => entry.node);
    const activation =
      event.type === 'click'
        ? (event.path.find(
            (node) =>
              node instanceof UiElement &&
              ['button', 'input', 'select', 'textarea', 'label', 'summary'].includes(
                node.localName,
              ),
          ) as UiElement | undefined)
        : undefined;
    try {
      const finishActivation = activation?.prepareActivation();
      for (const entry of path.slice(1).reverse()) {
        if (event.cancelBubble) break;
        event.target = entry.target;
        if (related !== undefined) event.relatedTarget = entry.relatedTarget ?? null;
        event.currentTarget = entry.node;
        event.eventPhase = entry.atTarget ? 2 : 1;
        entry.node.invoke(event, true);
      }
      if (!event.cancelBubble) {
        event.target = this;
        if (related !== undefined) event.relatedTarget = related;
        event.currentTarget = this;
        event.eventPhase = 2;
        this.invoke(event, true);
        this.invoke(event, false);
      }
      for (const entry of path.slice(1)) {
        if (event.cancelBubble) break;
        if (!event.bubbles && !entry.atTarget) continue;
        event.target = entry.target;
        if (related !== undefined) event.relatedTarget = entry.relatedTarget ?? null;
        event.currentTarget = entry.node;
        event.eventPhase = entry.atTarget ? 2 : 3;
        entry.node.invoke(event, false);
      }
      if (!this.realm.isDisposed) finishActivation?.(event.defaultPrevented);
      if (!this.realm.isDisposed && !event.defaultPrevented) activation?.activate(event);
      return !event.defaultPrevented;
    } finally {
      event.currentTarget = null;
      event.eventPhase = 0;
      event.path = [];
      event.target = path.at(-1)?.target ?? this;
      if (related !== undefined) event.relatedTarget = path.at(-1)?.relatedTarget ?? null;
      if (!this.realm.isDisposed && event.target.getRootNode() instanceof UiShadowRoot)
        event.target = null;
      event.dispatching = event.cancelBubble = event.immediate = false;
    }
  }
}

class UiDocumentNode extends UiNode {
  get documentElement(): UiElement {
    return this.realm.wrap(
      this.read('documentElement', (core) => core.document_element()),
    ) as UiElement;
  }
  get body(): UiElement | null {
    return this.querySelector('body');
  }
  get head(): UiElement | null {
    return this.querySelector('head');
  }
  get activeElement(): UiElement | null {
    const id = this.read('activeElement', (core) => core.focused());
    if (id === 0n) return this.body;
    let active = this.realm.wrap(id) as UiElement;
    for (let root = active.getRootNode(); root instanceof UiShadowRoot; root = active.getRootNode())
      active = root.host;
    return active;
  }
  createElement(tag: string): UiElement {
    const name = String(tag).toLowerCase();
    if (
      !UI_AUTHORING_PROFILE.html.nativeElements.includes(name) &&
      !UI_AUTHORING_PROFILE.html.documentElements.includes(name)
    ) {
      throw new UiDomError('createElement', `Unsupported element: ${name}`, [
        {
          code: 'runtime-html-surface',
          severity: 'error',
          sourcePath: '<ui-dom:createElement>',
          sourceRange: { start: 0, end: Math.max(name.length, 1), line: 1, column: 1 },
          rule: 'html-native-elements',
          actual: name,
          expected: 'an element in UI_AUTHORING_PROFILE.html',
          hint: 'Use an ordinary supported element; qualify native behavior before extending the support table.',
        },
      ]);
    }
    return this.realm.wrap(
      this.read('createElement', (core) => core.create_element(String(tag))),
    ) as UiElement;
  }
  createTextNode(text: string): UiNode {
    return this.realm.wrap(this.read('createTextNode', (core) => core.create_text(String(text))));
  }
  createDocumentFragment(): UiFragment {
    return this.realm.wrap(
      this.read('createDocumentFragment', (core) => core.create_fragment()),
    ) as UiFragment;
  }
  importNode(node: UiNode, deep = false): UiNode {
    if (node.realm !== this.realm)
      throw new UiDomError('importNode', 'Cross-document import is outside the portable UI subset');
    return node.cloneNode(deep);
  }
  getElementById(id: string): UiElement | null {
    return this.querySelectorAll('[id]').find((node) => node.id === id) ?? null;
  }
}

class UiFragment extends UiNode {
  get innerHTML(): string {
    return this.read('innerHTML', (core) => core.inner_html(this.coreId));
  }
  set innerHTML(html: string) {
    checkHtml(String(html), 'innerHTML');
    this.read('innerHTML', (core) => core.set_inner_html(this.coreId, String(html)));
    this.realm.reconcileFocus();
  }
}

class UiShadowRoot extends UiFragment {
  readonly mode = 'open';
  get host(): UiElement {
    return this.realm.wrap(this.read('host', (core) => core.shadow_host(this.coreId))) as UiElement;
  }
  get activeElement(): UiElement | null {
    const id = this.read('activeElement', (core) => core.focused());
    if (id === 0n) return null;
    let active = this.realm.wrap(id) as UiElement;
    for (;;) {
      const root = active.getRootNode();
      if (root === this) return active;
      if (!(root instanceof UiShadowRoot)) return null;
      active = root.host;
    }
  }
}

const attributeName = (name: string): string =>
  `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
const cssName = (name: string): string =>
  name.startsWith('--') ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const validNumber = (value: string): boolean =>
  /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));

/** Inertness follows the composed ancestry while the attribute remains native DOM state. */
export function isInert(node: UiNode | null): boolean {
  for (
    let current = node;
    current;
    current = current instanceof UiShadowRoot ? current.host : current.parentNode
  ) {
    if (current instanceof UiElement && current.inert) return true;
  }
  return false;
}

export class UiElement extends UiNode {
  private resetting = false;
  readonly dataset: DOMStringMap;
  readonly style: CSSStyleDeclaration;
  readonly classList: DOMTokenList;
  constructor(document: BlitzDocument, id: bigint) {
    super(document, id);
    this.dataset = new Proxy({} as DOMStringMap, {
      get: (_, name) =>
        typeof name === 'string'
          ? (this.getAttribute(attributeName(name)) ?? undefined)
          : undefined,
      set: (_, name, value) => {
        if (typeof name !== 'string') return false;
        this.setAttribute(attributeName(name), String(value));
        return true;
      },
      deleteProperty: (_, name) => {
        if (typeof name !== 'string') return false;
        this.removeAttribute(attributeName(name));
        return true;
      },
      has: (_, name) => typeof name === 'string' && this.hasAttribute(attributeName(name)),
      ownKeys: () =>
        this.getAttributeNames()
          .filter((name) => name.startsWith('data-'))
          .map((name) =>
            name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          ),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
    const style = {
      get cssText() {
        return '';
      },
      setProperty: (name: string, value: string | null, priority = '') => {
        if (value)
          checkCss(
            `${name}:${value}${priority ? ` !${priority}` : ''}`,
            'style.setProperty',
            'declaration',
          );
        return this.read('style.setProperty', (core) =>
          core.set_style(this.coreId, name, value ?? '', priority),
        );
      },
      getPropertyValue: (name: string) =>
        this.read('style.getPropertyValue', (core) => core.style_value(this.coreId, name)),
      removeProperty: (name: string) => {
        const old = style.getPropertyValue(name);
        style.setProperty(name, '');
        return old;
      },
    };
    this.style = new Proxy(style, {
      get: (target, name) =>
        name === 'cssText'
          ? (this.getAttribute('style') ?? '')
          : Reflect.has(target, name)
            ? Reflect.get(target, name)
            : typeof name === 'string'
              ? style.getPropertyValue(cssName(name))
              : undefined,
      set: (_, name, value) => {
        if (typeof name !== 'string') return false;
        if (name === 'cssText') this.setAttribute('style', String(value));
        else style.setProperty(cssName(name), String(value));
        return true;
      },
    }) as unknown as CSSStyleDeclaration;
    const tokens = () => [
      ...new Set((this.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/).filter(Boolean)),
    ];
    const validate = (values: string[]) => {
      if (values.some((value) => !value || /[\t\n\f\r ]/.test(value)))
        throw new UiDomError('classList', 'InvalidCharacterError');
    };
    const element = this;
    this.classList = {
      get length() {
        return tokens().length;
      },
      get value() {
        return element.className;
      },
      set value(value: string) {
        element.className = String(value);
      },
      toString: () => this.className,
      replace: (oldToken: string, newToken: string) => {
        validate([oldToken, newToken]);
        if (!tokens().includes(oldToken)) return false;
        this.className = [
          ...new Set(tokens().map((token) => (token === oldToken ? newToken : token))),
        ].join(' ');
        return true;
      },
      forEach: (
        callback: (value: string, index: number, list: DOMTokenList) => void,
        thisArg?: unknown,
      ) =>
        tokens().forEach((token, index) => {
          callback.call(thisArg, token, index, this.classList);
        }),
      contains: (token: string) => tokens().includes(token),
      add: (...values: string[]) => {
        validate(values);
        this.className = [...new Set([...tokens(), ...values])].join(' ');
      },
      remove: (...values: string[]) => {
        validate(values);
        this.className = tokens()
          .filter((token) => !values.includes(token))
          .join(' ');
      },
      toggle: (token: string, force?: boolean) => {
        validate([token]);
        const next = force ?? !tokens().includes(token);
        if (next) this.classList.add(token);
        else this.classList.remove(token);
        return next;
      },
      item: (index: number) => tokens()[index] ?? null,
      [Symbol.iterator]: () => tokens()[Symbol.iterator](),
    } as unknown as DOMTokenList;
  }
  get localName(): string {
    return this.read('localName', (core) => core.tag_name(this.coreId));
  }
  get tagName(): string {
    return this.localName.toUpperCase();
  }
  getAttribute(name: string): string | null {
    return (
      this.read('getAttribute', (core) => core.attribute(this.coreId, name.toLowerCase())) ?? null
    );
  }
  getAttributeNames(): string[] {
    return this.read('getAttributeNames', (core) => core.attribute_names(this.coreId));
  }
  setAttribute(name: string, value: string): void {
    const attribute = name.toLowerCase();
    if (attribute === 'style') checkCss(String(value), 'setAttribute:style', 'declarationList');
    else {
      const tag = ['input', 'select', 'option'].includes(this.localName) ? this.localName : 'div';
      checkHtml(
        `<${tag} ${name}="${escapeAttribute(String(value))}">${tag === 'input' ? '' : `</${tag}>`}`,
        'setAttribute',
      );
    }
    this.read('setAttribute', (core) =>
      core.set_attribute(this.coreId, name.toLowerCase(), String(value)),
    );
    if (
      name.toLowerCase() === 'disabled' ||
      name.toLowerCase() === 'hidden' ||
      name.toLowerCase() === 'inert' ||
      name.toLowerCase() === 'style'
    )
      this.realm.reconcileFocus();
  }
  removeAttribute(name: string): void {
    this.read('removeAttribute', (core) =>
      core.set_attribute(this.coreId, name.toLowerCase(), undefined),
    );
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const next = force ?? !this.hasAttribute(name);
    if (next) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return next;
  }
  matches(selector: string): boolean {
    return this.read('matches', (core) => core.matches(this.coreId, selector));
  }
  closest(selector: string): UiElement | null {
    for (let node: UiElement | null = this; node; node = node.parentElement)
      if (node.matches(selector)) return node;
    return null;
  }
  get innerHTML(): string {
    return this.read('innerHTML', (core) => core.inner_html(this.coreId));
  }
  set innerHTML(html: string) {
    if (this.localName === 'style') checkCss(String(html), 'innerHTML');
    else checkHtml(String(html), 'innerHTML', this.localName);
    this.read('innerHTML', (core) => core.set_inner_html(this.coreId, String(html)));
    this.realm.reconcileFocus();
  }
  get content(): UiFragment {
    if (this.localName !== 'template') throw new UiDomError('content', 'Expected template');
    return this.realm.wrap(
      this.read('content', (core) => core.template_content(this.coreId)),
    ) as UiFragment;
  }
  get htmlFor(): string {
    return this.getAttribute('for') ?? '';
  }
  set htmlFor(value: string) {
    this.setAttribute('for', value);
  }
  get control(): UiElement | null {
    if (this.localName !== 'label') return null;
    if (this.htmlFor)
      return (
        this.getRootNode()
          .querySelectorAll('[id]')
          .find((node) => node.id === this.htmlFor) ?? null
      );
    return this.querySelector('input,button,textarea,select');
  }
  get open(): boolean {
    return this.hasAttribute('open');
  }
  set open(value: boolean) {
    this.toggleAttribute('open', Boolean(value));
  }
  get tabIndex(): number {
    const attribute = this.getAttribute('tabindex');
    return attribute === null
      ? ['input', 'button', 'textarea', 'select', 'summary'].includes(this.localName)
        ? 0
        : -1
      : Number.parseInt(attribute, 10) || 0;
  }
  set tabIndex(value: number) {
    this.setAttribute('tabindex', String(value));
  }
  get readOnly(): boolean {
    return this.hasAttribute('readonly');
  }
  set readOnly(value: boolean) {
    this.toggleAttribute('readonly', Boolean(value));
  }
  get maxLength(): number {
    return this.hasAttribute('maxlength') ? Number(this.getAttribute('maxlength')) : -1;
  }
  set maxLength(value: number) {
    if (value < 0) throw new UiDomError('maxLength', 'IndexSizeError');
    this.setAttribute('maxlength', String(value));
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  set id(value: string) {
    this.setAttribute('id', value);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  get title(): string {
    return this.getAttribute('title') ?? '';
  }
  set title(value: string) {
    this.setAttribute('title', value);
  }
  get lang(): string {
    return this.getAttribute('lang') ?? '';
  }
  set lang(value: string) {
    this.setAttribute('lang', value);
  }
  get dir(): string {
    return this.getAttribute('dir') ?? '';
  }
  set dir(value: string) {
    this.setAttribute('dir', value);
  }
  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }
  set disabled(value: boolean) {
    this.toggleAttribute('disabled', Boolean(value));
  }
  get hidden(): boolean {
    return this.hasAttribute('hidden');
  }
  set hidden(value: boolean) {
    this.toggleAttribute('hidden', Boolean(value));
  }
  get inert(): boolean {
    return this.hasAttribute('inert');
  }
  set inert(value: boolean) {
    this.toggleAttribute('inert', Boolean(value));
  }
  get required(): boolean {
    return this.hasAttribute('required');
  }
  set required(value: boolean) {
    this.toggleAttribute('required', Boolean(value));
  }
  get checkable(): boolean {
    return this.localName === 'input' && ['checkbox', 'radio'].includes(this.type);
  }
  get checked(): boolean {
    return this.read('checked', (core) => core.input_checked(this.coreId));
  }
  set checked(value: boolean) {
    this.read('checked', (core) => core.set_input_checked(this.coreId, Boolean(value)));
  }
  get defaultChecked(): boolean {
    return this.hasAttribute('checked');
  }
  set defaultChecked(value: boolean) {
    this.toggleAttribute('checked', Boolean(value));
  }
  get options(): UiElement[] {
    return Array.from(
      this.read('options', (core) => core.select_options(this.coreId)),
      (id) => this.realm.wrap(id) as UiElement,
    );
  }
  get selectedOptions(): UiElement[] {
    return this.options.filter((option) => option.selected);
  }
  get selectedIndex(): number {
    return this.read('selectedIndex', (core) => core.select_index(this.coreId));
  }
  set selectedIndex(value: number) {
    this.read('selectedIndex', (core) => core.set_select_index(this.coreId, Number(value) | 0));
  }
  get selected(): boolean {
    return this.read('selected', (core) => core.option_selected(this.coreId));
  }
  set selected(value: boolean) {
    this.read('selected', (core) => core.set_option_selected(this.coreId, Boolean(value)));
  }
  get defaultSelected(): boolean {
    return this.hasAttribute('selected');
  }
  set defaultSelected(value: boolean) {
    this.toggleAttribute('selected', Boolean(value));
  }
  get text(): string {
    return (this.textContent ?? '').replace(/[\t\n\f\r ]+/g, ' ').trim();
  }
  set text(value: string) {
    this.textContent = String(value);
  }
  get label(): string {
    return this.getAttribute('label') ?? this.text;
  }
  set label(value: string) {
    this.setAttribute('label', value);
  }
  get multiple(): boolean {
    return this.hasAttribute('multiple');
  }
  set multiple(value: boolean) {
    this.toggleAttribute('multiple', Boolean(value));
  }
  get size(): number {
    return Math.max(0, Number(this.getAttribute('size')) || 0);
  }
  set size(value: number) {
    this.setAttribute('size', String(Number(value) >>> 0));
  }
  radioGroup(): UiElement[] {
    return Array.from(
      this.read('radioGroup', (core) => core.radio_group(this.coreId)),
      (id) => this.realm.wrap(id) as UiElement,
    );
  }
  get name(): string {
    return this.getAttribute('name') ?? '';
  }
  set name(value: string) {
    this.setAttribute('name', value);
  }
  get type(): string {
    if (this.localName === 'select') return this.multiple ? 'select-multiple' : 'select-one';
    return this.getAttribute('type') ?? (this.localName === 'button' ? 'submit' : 'text');
  }
  set type(value: string) {
    this.setAttribute('type', value);
  }
  get min(): string {
    return this.getAttribute('min') ?? '';
  }
  set min(value: string) {
    this.setAttribute('min', value);
  }
  get max(): string {
    return this.getAttribute('max') ?? '';
  }
  set max(value: string) {
    this.setAttribute('max', value);
  }
  get step(): string {
    return this.getAttribute('step') ?? '';
  }
  set step(value: string) {
    this.setAttribute('step', value);
  }
  get value(): string {
    return this.read('value', (core) => core.input_value(this.coreId));
  }
  get defaultValue(): string {
    return this.getAttribute('value') ?? '';
  }
  set defaultValue(value: string) {
    this.setAttribute('value', value);
  }
  set value(value: string) {
    const text = String(value);
    this.read('value', (core) =>
      core.set_input_value(this.coreId, this.type === 'number' && !validNumber(text) ? '' : text),
    );
  }
  get valueAsNumber(): number {
    return ['number', 'range'].includes(this.type) && validNumber(this.value)
      ? Number(this.value)
      : NaN;
  }
  set valueAsNumber(value: number) {
    if (!['number', 'range'].includes(this.type))
      throw new UiDomError('valueAsNumber', 'InvalidStateError');
    if (!Number.isFinite(value) && !Number.isNaN(value))
      throw new TypeError('valueAsNumber must be finite or NaN');
    this.value = Number.isNaN(value) ? '' : String(value);
  }
  stepUp(count = 1): void {
    this.read('stepUp', (core) => core.input_step(this.coreId, count));
  }
  stepDown(count = 1): void {
    this.stepUp(-count);
  }
  get validity(): ValidityState {
    const value = this.value;
    const number = this.valueAsNumber;
    const numeric = this.type === 'number' && !Number.isNaN(number);
    const base = validNumber(this.min)
      ? Number(this.min)
      : validNumber(this.getAttribute('value') ?? '')
        ? Number(this.getAttribute('value'))
        : 0;
    const step = validNumber(this.step) && Number(this.step) > 0 ? Number(this.step) : 1;
    const count = (number - base) / step;
    const radioGroup = this.type === 'radio' ? this.radioGroup() : null;
    const flags = {
      badInput:
        this.type === 'number' &&
        this.read('validity', (core) => core.input_bad_input(this.coreId)),
      customError: false,
      patternMismatch: false,
      tooLong: false,
      tooShort: false,
      typeMismatch: false,
      valueMissing: radioGroup
        ? radioGroup.some((input) => input.required) && !radioGroup.some((input) => input.checked)
        : this.required &&
          (this.localName === 'select'
            ? this.selectedIndex < 0 ||
              (this.selectedIndex === 0 && this.options[0]?.parentElement === this && value === '')
            : this.type === 'checkbox'
              ? !this.checked
              : this.localName === 'textarea'
                ? this.willValidate && value === ''
                : value === ''),
      rangeUnderflow: numeric && validNumber(this.min) && number < Number(this.min),
      rangeOverflow: numeric && validNumber(this.max) && number > Number(this.max),
      stepMismatch:
        numeric &&
        this.step !== 'any' &&
        Math.abs(count - Math.round(count)) > Number.EPSILON * Math.max(1, Math.abs(count)) * 8,
    };
    return { ...flags, valid: !Object.values(flags).some(Boolean) };
  }
  get willValidate(): boolean {
    if (this.localName === 'select') return !this.disabled;
    return (
      (this.localName === 'textarea' || (this.localName === 'input' && this.type !== 'hidden')) &&
      !this.disabled &&
      !this.hasAttribute('readonly')
    );
  }
  get validationMessage(): string {
    if (!this.willValidate) return '';
    const validity = this.validity;
    if (validity.badInput) return 'Please enter a number.';
    if (validity.valueMissing)
      return this.type === 'checkbox' || this.type === 'radio'
        ? 'Please select this option.'
        : this.localName === 'select'
          ? 'Please select an item in the list.'
          : 'Please fill out this field.';
    if (validity.rangeUnderflow) return `Value must be greater than or equal to ${this.min}.`;
    if (validity.rangeOverflow) return `Value must be less than or equal to ${this.max}.`;
    if (validity.stepMismatch) {
      const step = validNumber(this.step) && Number(this.step) > 0 ? this.step : '1';
      return `Please enter a valid value in steps of ${step}.`;
    }
    return '';
  }
  checkValidity(): boolean {
    if (this.localName === 'form') {
      let valid = true;
      for (const input of this.querySelectorAll('input,select,textarea')) {
        if (input.closest('form') !== this) continue;
        valid = input.checkValidity() && valid;
        if (this.realm.isDisposed) break;
      }
      return valid;
    }
    if (!this.willValidate || this.validity.valid) return true;
    this.dispatchEvent(new UiEvent('invalid', { cancelable: true }));
    return false;
  }
  reportValidity(): boolean {
    if (this.localName === 'form') {
      let valid = true;
      const unhandled: UiElement[] = [];
      for (const input of this.querySelectorAll('input,select,textarea')) {
        if (input.closest('form') !== this || !input.willValidate || input.validity.valid) continue;
        valid = false;
        if (input.dispatchEvent(new UiEvent('invalid', { cancelable: true })))
          unhandled.push(input);
        if (this.realm.isDisposed) return false;
      }
      for (const input of unhandled) {
        if (input.closest('form') !== this) continue;
        const accepted = this.realm.focus(input);
        if (this.realm.isDisposed) return false;
        if (!accepted) continue;
        if (this.realm.focused() === input) input.reveal('center-if-needed', 'center-if-needed');
        if (!this.realm.isDisposed) input.showValidationMessage();
        break;
      }
      return valid;
    }
    if (!this.willValidate || this.validity.valid) {
      this.showValidationMessage();
      return true;
    }
    if (
      this.dispatchEvent(new UiEvent('invalid', { cancelable: true })) &&
      !this.realm.isDisposed
    ) {
      this.focus();
      if (!this.realm.isDisposed) this.showValidationMessage();
    }
    return false;
  }
  private showValidationMessage(): void {
    this.read('reportValidity', (core) =>
      core.show_validation_message(this.coreId, this.validationMessage),
    );
  }
  focus(options?: FocusOptions, source: FocusSource = 'script'): void {
    this.realm.focus(this, source);
    if (!this.realm.isDisposed && !options?.preventScroll && this.realm.focused() === this)
      this.reveal('center-if-needed', 'center-if-needed');
  }
  blur(): void {
    if (this.realm.focused() === this) this.realm.focus(null);
  }
  private scrollMetrics(): Float64Array {
    return this.read('scroll', (core) => core.scroll_metrics(this.coreId));
  }
  get scrollLeft(): number {
    return this.scrollMetrics()[0] ?? 0;
  }
  set scrollLeft(value: number) {
    this.scrollTo(value, this.scrollTop);
  }
  get scrollTop(): number {
    return this.scrollMetrics()[1] ?? 0;
  }
  set scrollTop(value: number) {
    this.scrollTo(this.scrollLeft, value);
  }
  get scrollWidth(): number {
    return this.scrollMetrics()[2] ?? 0;
  }
  get scrollHeight(): number {
    return this.scrollMetrics()[3] ?? 0;
  }
  get clientWidth(): number {
    return this.scrollMetrics()[4] ?? 0;
  }
  get clientHeight(): number {
    return this.scrollMetrics()[5] ?? 0;
  }
  scrollTo(x: number | ScrollToOptions = {}, y?: number): void {
    const left = typeof x === 'number' ? x : (x.left ?? this.scrollLeft);
    const top = typeof x === 'number' ? (y ?? 0) : (x.top ?? this.scrollTop);
    const before = [this.scrollLeft, this.scrollTop];
    this.read('scrollTo', (core) =>
      core.scroll_to(this.coreId, Number.isFinite(left) ? left : 0, Number.isFinite(top) ? top : 0),
    );
    if (before[0] !== this.scrollLeft || before[1] !== this.scrollTop)
      this.dispatchEvent(new UiEvent('scroll'));
  }
  scroll(x: number | ScrollToOptions = {}, y?: number): void {
    this.scrollTo(x, y);
  }
  scrollBy(x: number | ScrollToOptions = {}, y?: number): void {
    this.scrollTo(
      this.scrollLeft + (typeof x === 'number' ? x : (x.left ?? 0)),
      this.scrollTop + (typeof x === 'number' ? (y ?? 0) : (x.top ?? 0)),
    );
  }
  scrollIntoView(options: boolean | ScrollIntoViewOptions = {}): void {
    const block =
      typeof options === 'boolean' ? (options ? 'start' : 'end') : (options.block ?? 'start');
    const inline = typeof options === 'boolean' ? 'nearest' : (options.inline ?? 'nearest');
    this.reveal(block, inline);
  }
  private reveal(block: string, inline: string): void {
    const changed = this.read('scrollIntoView', (core) =>
      core.scroll_into_view(this.coreId, block, inline),
    );
    for (const id of changed) {
      if (this.realm.isDisposed) break;
      this.realm.wrap(id).dispatchEvent(new UiEvent('scroll'));
    }
  }
  getBoundingClientRect(): DOMRect {
    const [x = 0, y = 0, width = 0, height = 0] = this.read('getBoundingClientRect', (core) =>
      core.rect(this.coreId),
    );
    return {
      x,
      y,
      width,
      height,
      top: y,
      left: x,
      right: x + width,
      bottom: y + height,
      toJSON() {
        return { x, y, width, height };
      },
    } as DOMRect;
  }
  click(): void {
    if (!this.disabled)
      this.dispatchEvent(
        new UiEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          timeStamp: this.realm.time,
        }),
      );
  }
  requestSubmit(submitter?: UiElement): void {
    if (this.localName !== 'form') throw new UiDomError('requestSubmit', 'Expected form');
    if (submitter && (submitter.type !== 'submit' || submitter.closest('form') !== this))
      throw new UiDomError('requestSubmit', 'Invalid submitter');
    if (!this.reportValidity()) return;
    this.dispatchEvent(
      new UiEvent('submit', {
        bubbles: true,
        cancelable: true,
        ...(submitter ? { submitter } : {}),
      }),
    );
  }
  reset(): void {
    if (this.localName !== 'form') throw new UiDomError('reset', 'Expected form');
    if (this.resetting) return;
    this.resetting = true;
    try {
      if (
        this.dispatchEvent(new UiEvent('reset', { bubbles: true, cancelable: true })) &&
        !this.realm.isDisposed
      ) {
        this.read('reset', (core) => core.reset_form(this.coreId));
        for (const listener of [...this.realm.formResetListeners]) {
          if (this.realm.isDisposed) return;
          if (this.realm.formResetListeners.has(listener)) listener(this);
        }
      }
    } finally {
      this.resetting = false;
    }
  }
  /** HTML legacy preactivation exposes the new state during click and rolls it back on cancel. */
  prepareActivation(): ((canceled: boolean) => void) | undefined {
    if (!this.checkable || this.disabled) return undefined;
    const checked = this.checked;
    const radio = this.type === 'radio';
    const previous = radio ? this.radioGroup().find((input) => input.checked) : undefined;
    this.checked = radio || !checked;
    return (canceled) => {
      if (canceled) {
        this.checked = radio ? false : checked;
        if (previous && this.radioGroup().includes(previous)) previous.checked = true;
      } else if (this.isConnected && (!radio || !checked)) {
        this.dispatchEvent(new UiEvent('input', { bubbles: true, composed: true }));
        if (!this.realm.isDisposed) this.dispatchEvent(new UiEvent('change', { bubbles: true }));
      }
    };
  }
  activate(event: UiEvent): void {
    if (event.type !== 'click' || this.disabled) return;
    const byPointer = 'pointerType' in event && Boolean(event.pointerType);
    if ((this.localName === 'button' || this.localName === 'input') && this.type === 'submit')
      this.closest('form')?.requestSubmit(this);
    else if ((this.localName === 'button' || this.localName === 'input') && this.type === 'reset') {
      const owner = this.read('reset.form', (core) => core.form_owner(this.coreId));
      if (owner !== 0n) (this.realm.wrap(owner) as UiElement).reset();
    } else if (this.localName === 'label') {
      const control = this.control;
      if (control && !control.disabled) {
        control.focus(undefined, byPointer ? 'pointer' : 'script');
        if (!this.realm.isDisposed) control.click();
      }
    } else if (this.localName === 'summary' && this.parentElement?.localName === 'details') {
      const details = this.parentElement;
      details.open = !details.open;
      details.dispatchEvent(new UiEvent('toggle'));
    } else if (this.localName === 'input') this.focus(undefined, byPointer ? 'pointer' : 'script');
  }
  get shadowRoot(): UiShadowRoot | null {
    const id = this.read('shadowRoot', (core) => core.shadow_root(this.coreId));
    return id === 0n ? null : (this.realm.wrap(id) as UiShadowRoot);
  }
  attachShadow(init: ShadowRootInit): UiShadowRoot {
    if (init.mode !== 'open' || init.delegatesFocus || init.slotAssignment === 'manual') {
      throw new UiDomError(
        'attachShadow',
        'Only open shadow roots without delegated focus or manual slots are supported',
      );
    }
    return this.realm.wrap(
      this.read('attachShadow', (core) => core.attach_shadow(this.coreId)),
    ) as UiShadowRoot;
  }
}
