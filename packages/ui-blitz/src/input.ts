import { type BlitzDocument, isInert, UiElement, UiEvent, type UiNode } from './dom.js';

/** Logical viewport coordinates, independent of the display drawing-buffer scale. */
export interface UiPointerInput {
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly pointerType?: 'touch' | 'mouse' | 'pen';
  readonly pressure?: number;
}
export interface UiKeyInput {
  readonly type: 'keydown' | 'keyup';
  readonly key: string;
  readonly code?: string;
  readonly repeat?: boolean;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}
export interface UiTextEditor {
  readonly value: string;
  readonly type: string;
  readonly multiline: boolean;
  readonly maxLength: number;
}
/** Native providers supply facts; the document owns defaults, focus, values and validation. */
export interface BlitzUiInput {
  pointer(event: UiPointerInput): boolean;
  wheel(event: {
    readonly x: number;
    readonly y: number;
    readonly deltaX: number;
    readonly deltaY: number;
  }): boolean;
  key(event: UiKeyInput): boolean;
  text(value: string): void;
  /** Commit an accepted edit without submitting a form or changing DOM focus. */
  commitText(): void;
  confirm(): void;
  cancel(): void;
  focusedText(): UiTextEditor | null;
  subscribeFocus(listener: () => void): () => void;
  /** Explicit user activation of an editable control; focus alone is not an edit request. */
  subscribeTextEdit(listener: () => void): () => void;
  ownsInput(): boolean;
}
interface Contact {
  readonly target: UiElement;
  readonly startX: number;
  readonly startY: number;
  readonly panAxes: number;
  x: number;
  y: number;
  scrolling: boolean;
  cancelled: boolean;
  rangeValue?: string;
  select?: boolean;
  numberStep?: boolean;
}
function parent(node: UiNode): UiNode | null {
  return (
    node.parentNode ??
    (node.nodeType === 11 ? ((node as unknown as { host?: UiElement }).host ?? null) : null)
  );
}
function parentElement(node: UiNode): UiElement | null {
  let next = parent(node);
  while (next && !(next instanceof UiElement)) next = parent(next);
  return next as UiElement | null;
}
function dispatch(
  target: UiElement,
  type: string,
  properties: object = {},
  cancelable = true,
): boolean {
  if (target.realm.isDisposed) return false;
  const accepted = target.dispatchEvent(
    Object.assign(
      new UiEvent(type, {
        bubbles: true,
        cancelable,
        composed: true,
        timeStamp: target.realm.time,
      }),
      properties,
    ),
  );
  return accepted && !target.realm.isDisposed;
}
function isButton(node: UiElement): boolean {
  return (
    node.localName === 'button' ||
    (node.localName === 'input' && ['button', 'submit', 'reset'].includes(node.type))
  );
}
function isEditor(node: UiElement | null): node is UiElement {
  return (
    node !== null &&
    !node.disabled &&
    !node.readOnly &&
    (node.localName === 'textarea' ||
      (node.localName === 'input' &&
        ![
          'button',
          'submit',
          'reset',
          'hidden',
          'checkbox',
          'radio',
          'file',
          'range',
          'color',
        ].includes(node.type)))
  );
}

export class BlitzInput implements BlitzUiInput {
  private readonly contacts = new Map<number, Contact>();
  private readonly listeners = new Set<() => void>();
  private readonly editListeners = new Set<() => void>();
  private focused: UiElement | null = null;
  private editor: UiElement | null = null;
  private committedValue = '';
  private spaceTarget: UiElement | null = null;
  private disposed = false;
  constructor(private readonly dom: BlitzDocument) {
    dom.focusListeners.add(this.focusChanged);
    dom.formResetListeners.add(this.formReset);
    this.focusChanged();
  }
  private readonly formReset = (form: UiElement): void => {
    const editor = this.editor;
    if (
      !this.disposed &&
      editor &&
      this.dom.read('input.reset.form', (core) => core.form_owner(editor.coreId)) === form.coreId
    )
      this.committedValue = editor.value;
  };
  private readonly focusChanged = (): void => {
    if (this.disposed) return;
    for (const contact of this.contacts.values()) {
      if (isInert(contact.target)) contact.cancelled = true;
    }
    const focused = this.dom.focused();
    const editor = isEditor(focused) ? focused : null;
    if (focused === this.focused && editor === this.editor) return;
    const previous = this.editor;
    const committed = this.committedValue;
    const previousFocus = this.focused;
    if (previousFocus?.localName === 'select')
      this.dom.read('input.select.close', (core) => core.select_close(previousFocus.coreId));
    this.focused = focused;
    this.editor = editor;
    this.committedValue = editor?.value ?? '';
    this.spaceTarget = null;
    if (previous?.isConnected && previous.value !== committed)
      dispatch(previous, 'change', {}, false);
    for (const listener of [...this.listeners]) {
      if (this.disposed) return;
      if (this.listeners.has(listener)) listener();
    }
  };
  private hit(x: number, y: number): UiElement | null {
    const id = this.dom.read('input.hit', (core) => core.hit(x, y));
    if (id === 0n) return null;
    let node = this.dom.wrap(id);
    while (node.nodeType !== 1 && node.parentNode) node = node.parentNode;
    return node instanceof UiElement &&
      !isInert(node) &&
      !['html', 'body', 'canvas'].includes(node.localName)
      ? node
      : null;
  }
  private pointerProperties(event: UiPointerInput) {
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType ?? 'touch',
      clientX: event.x,
      clientY: event.y,
      pageX: event.x,
      pageY: event.y,
      button: 0,
      buttons: event.phase === 'up' || event.phase === 'cancel' ? 0 : 1,
      pressure: event.phase === 'up' || event.phase === 'cancel' ? 0 : (event.pressure ?? 0.5),
      isPrimary: this.contacts.keys().next().value === event.pointerId,
    };
  }
  pointer(event: UiPointerInput): boolean {
    if (this.disposed) return false;
    if (![event.x, event.y].every(Number.isFinite) || !Number.isSafeInteger(event.pointerId))
      throw new TypeError('UI pointer coordinates and identity must be finite');
    const hit = this.hit(event.x, event.y);
    if (event.phase === 'down') {
      if (this.contacts.has(event.pointerId)) return true;
      if (!hit) {
        this.dom.focus(null);
        return false;
      }
      const contact: Contact = {
        target: hit,
        startX: event.x,
        startY: event.y,
        panAxes:
          event.pointerType === 'mouse'
            ? 0
            : this.dom.read('input.touchAction', (core) => core.touch_pan_axes(hit.coreId)),
        x: event.x,
        y: event.y,
        scrolling: false,
        cancelled: false,
      };
      this.contacts.set(event.pointerId, contact);
      this.dom.read('input.active', (core) => core.set_active(hit.coreId));
      this.dom.read('input.hover', (core) => core.set_hover(hit.coreId));
      const properties = this.pointerProperties(event);
      if (
        dispatch(hit, 'pointerdown', properties) &&
        !isInert(hit) &&
        dispatch(hit, 'mousedown', properties) &&
        !isInert(hit)
      ) {
        let focus: UiElement | null = hit;
        while (focus && focus.tabIndex < 0) focus = parentElement(focus);
        if (focus && !focus.disabled) focus.focus(undefined, 'pointer');
        else this.dom.focus(null);
        if (this.disposed) return true;
        if (hit.localName === 'input' && hit.type === 'range' && !hit.disabled) {
          contact.rangeValue = hit.value;
          this.rangePointer(hit, event.x, event.y);
        } else if (hit.localName === 'input' && hit.type === 'number' && isEditor(hit)) {
          const direction = this.dom.read('input.number.hit', (core) =>
            core.number_stepper_hit(hit.coreId, event.x, event.y),
          );
          if (direction) {
            contact.numberStep = true;
            this.numberStep(hit, direction);
          }
        } else if (hit.localName === 'select' && !hit.disabled) {
          contact.select = true;
          this.selectPointer(hit, event.x, event.y, false);
        }
      }
      return true;
    }
    const contact = this.contacts.get(event.pointerId);
    if (!contact) {
      if (event.pointerType === 'mouse' && event.phase === 'move')
        this.dom.read('input.hover', (core) => core.set_hover(hit?.coreId ?? 0n));
      return false;
    }
    const properties = this.pointerProperties(event);
    if (!contact.target.isConnected || isInert(contact.target)) contact.cancelled = true;
    if (event.phase === 'move') {
      const dx = contact.x - event.x,
        dy = contact.y - event.y;
      contact.x = event.x;
      contact.y = event.y;
      if (!contact.cancelled && !contact.scrolling)
        dispatch(contact.target, 'pointermove', properties);
      if (this.disposed) return true;
      if (contact.rangeValue !== undefined) {
        if (!contact.cancelled && !contact.target.disabled)
          this.rangePointer(contact.target, event.x, event.y);
        return true;
      }
      if (contact.select || contact.numberStep) return true;
      const moved = Math.hypot(event.x - contact.startX, event.y - contact.startY) > 6;
      if (!contact.cancelled && moved && contact.panAxes !== 0) {
        const changed = this.scroll(
          contact.target,
          contact.panAxes & 1 ? dx : 0,
          contact.panAxes & 2 ? dy : 0,
        );
        if (this.disposed) return true;
        if (changed && !contact.scrolling) {
          contact.scrolling = true;
          dispatch(contact.target, 'pointercancel', properties, false);
          if (this.disposed) return true;
          this.dom.read('input.active', (core) => core.set_active(0n));
        }
      }
      return true;
    }
    this.contacts.delete(event.pointerId);
    this.dom.read('input.active', (core) => core.set_active(0n));
    if (event.pointerType !== 'mouse') this.dom.read('input.hover', (core) => core.set_hover(0n));
    if (!contact.cancelled && !contact.scrolling) {
      const pointerAccepted = dispatch(
        contact.target,
        event.phase === 'cancel' ? 'pointercancel' : 'pointerup',
        properties,
        event.phase !== 'cancel',
      );
      if (this.disposed) return true;
      if (event.phase === 'up') {
        const mouseAccepted = dispatch(contact.target, 'mouseup', properties);
        if (this.disposed) return true;
        if (contact.rangeValue !== undefined && contact.target.value !== contact.rangeValue)
          dispatch(contact.target, 'change', {}, false);
        if (contact.numberStep) this.commitText();
        if (this.disposed) return true;
        let clickAccepted = true;
        if (
          hit &&
          (hit === contact.target || contact.target.contains(hit)) &&
          Math.hypot(event.x - contact.startX, event.y - contact.startY) <= 6
        ) {
          if (!contact.target.closest('button:disabled,input:disabled,select:disabled')) {
            clickAccepted = dispatch(contact.target, 'click', properties);
            if (this.disposed) return true;
            const label = contact.target.closest('label');
            const editor = isEditor(contact.target) ? contact.target : (label?.control ?? null);
            if (
              pointerAccepted &&
              mouseAccepted &&
              clickAccepted &&
              !contact.numberStep &&
              isEditor(editor) &&
              this.dom.focused() === editor
            )
              for (const listener of [...this.editListeners]) {
                if (this.disposed) return true;
                if (this.editListeners.has(listener)) listener();
              }
          }
        }
        if (
          contact.select &&
          !contact.target.disabled &&
          pointerAccepted &&
          mouseAccepted &&
          clickAccepted
        )
          this.selectPointer(contact.target, event.x, event.y, true);
      } else if (contact.select) {
        this.dom.read('input.select.close', (core) => core.select_close(contact.target.coreId));
      }
    }
    return true;
  }
  private numberStep(target: UiElement, direction: number): void {
    if (!isEditor(target) || !target.isConnected || isInert(target)) return;
    if (
      !dispatch(target, 'beforeinput', { inputType: 'insertText', data: null, isComposing: false })
    )
      return;
    if (!isEditor(target) || !target.isConnected || isInert(target)) return;
    const previous = target.value;
    this.dom.read('input.number.step', (core) => core.number_step(target.coreId, direction));
    if (target.value !== previous) dispatch(target, 'input', {}, false);
  }
  private rangePointer(target: UiElement, x: number, y: number): void {
    const previous = target.value;
    this.dom.read('input.range', (core) => core.range_pointer(target.coreId, x, y));
    if (target.value !== previous) dispatch(target, 'input', {}, false);
  }
  private selectChanged(target: UiElement): void {
    target.dispatchEvent(new UiEvent('input', { bubbles: true, composed: true }));
    if (!this.disposed) target.dispatchEvent(new UiEvent('change', { bubbles: true }));
  }
  private selectPointer(target: UiElement, x: number, y: number, commit: boolean): void {
    if (
      this.dom.read('input.select.pointer', (core) =>
        core.select_pointer(target.coreId, x, y, commit),
      )
    )
      this.selectChanged(target);
  }
  private scroll(target: UiElement, deltaX: number, deltaY: number): boolean {
    const changed = this.dom.read('input.scroll', (core) =>
      core.scroll_by_user(target.coreId, deltaX, deltaY),
    );
    for (const id of changed) {
      if (this.disposed) break;
      this.dom.wrap(id).dispatchEvent(new UiEvent('scroll'));
    }
    return changed.length > 0;
  }
  wheel(event: { x: number; y: number; deltaX: number; deltaY: number }): boolean {
    if (this.disposed) return false;
    const hit = this.hit(event.x, event.y);
    if (!hit) return false;
    if (
      dispatch(hit, 'wheel', {
        clientX: event.x,
        clientY: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: 0,
      })
    )
      this.scroll(hit, event.deltaX, event.deltaY);
    return true;
  }
  key(event: UiKeyInput): boolean {
    if (this.disposed) return false;
    if (
      event.type === 'keydown' &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !['Control', 'Alt', 'Meta'].includes(event.key)
    )
      this.dom.read('input.focusVisible', (core) => core.keyboard_focus());
    const focused = this.dom.focused() ?? (event.key === 'Tab' ? this.dom.root.body : null);
    if (!focused) return false;
    if (!dispatch(focused, event.type, event) || isInert(focused)) return true;
    if (event.type === 'keydown') {
      if (
        focused.localName === 'select' &&
        !focused.disabled &&
        event.key !== 'Tab' &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const key =
          event.altKey && event.key === 'ArrowDown'
            ? ' '
            : event.altKey && event.key === 'ArrowUp'
              ? 'Enter'
              : event.key;
        if (this.dom.read('input.select.key', (core) => core.select_key(focused.coreId, key)))
          this.selectChanged(focused);
      } else if (
        focused.localName === 'input' &&
        focused.type === 'range' &&
        !focused.disabled &&
        [
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(event.key)
      ) {
        const previous = focused.value;
        this.dom.read('input.range', (core) => core.range_key(focused.coreId, event.key));
        if (focused.value !== previous) {
          dispatch(focused, 'input', {}, false);
          dispatch(focused, 'change', {}, false);
        }
      } else if (
        focused.localName === 'input' &&
        focused.type === 'number' &&
        isEditor(focused) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        this.numberStep(focused, event.key === 'ArrowUp' ? 1 : -1);
        this.commitText();
      } else if (event.key === 'Tab') {
        const id = this.dom.read('input.tab', (core) =>
          core.sequential_focus_target(event.shiftKey ?? false),
        );
        if (id !== 0n) (this.dom.wrap(id) as UiElement).focus(undefined, 'sequential');
      } else if (event.key === 'Enter' && !event.repeat) {
        if (isButton(focused) || focused.localName === 'summary') focused.click();
        else if (focused.localName === 'input') this.confirm();
      } else if (
        event.key === ' ' &&
        !event.repeat &&
        (isButton(focused) || focused.localName === 'summary' || focused.checkable)
      )
        this.spaceTarget = focused;
      else if (
        focused.checkable &&
        focused.type === 'radio' &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      ) {
        const group = focused.radioGroup().filter((input) => !input.disabled);
        const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        const next = group[(group.indexOf(focused) + direction + group.length) % group.length];
        next?.focus();
        if (!this.disposed) next?.click();
      }
    } else if (event.key === ' ' && this.spaceTarget === focused) {
      this.spaceTarget = null;
      focused.click();
    }
    return true;
  }
  text(value: string): void {
    if (this.disposed) return;
    const editor = this.dom.focused();
    if (!isEditor(editor)) return;
    const text = String(value);
    if (
      !dispatch(editor, 'beforeinput', {
        data: text,
        inputType: 'insertReplacementText',
        isComposing: false,
      })
    )
      return;
    // The callback can remove, hide or change the control before its default edit.
    if (!editor.isConnected || !isEditor(editor) || isInert(editor)) return;
    // Editing drafts, number sanitization and badInput remain in the core.
    if (!this.dom.read('input.text', (core) => core.set_input_text(editor.coreId, text))) return;
    dispatch(
      editor,
      'input',
      { data: text, inputType: 'insertReplacementText', isComposing: false },
      false,
    );
  }
  commitText(): void {
    if (this.disposed) return;
    const editor = this.dom.focused();
    if (!isEditor(editor)) return;
    if (editor.value !== this.committedValue) {
      this.committedValue = editor.value;
      dispatch(editor, 'change', {}, false);
    }
  }
  confirm(): void {
    if (this.disposed) return;
    const control = this.dom.focused();
    if (!control) return;
    this.commitText();
    if (
      this.disposed ||
      this.dom.focused() !== control ||
      control.localName !== 'input' ||
      control.disabled ||
      isButton(control)
    )
      return;
    const form = control.closest('form');
    if (!form) return;
    const submitter = form.querySelectorAll('button,input').find((node) => node.type === 'submit');
    if (submitter) submitter.click();
    else {
      const fields = form
        .querySelectorAll('input')
        .filter(
          (node) =>
            !['hidden', 'checkbox', 'radio', 'range', 'button', 'submit', 'reset'].includes(
              node.type,
            ),
        );
      if (fields.length === 1 && fields[0] === control) form.requestSubmit();
    }
  }
  cancel(): void {
    if (this.disposed) return;
    const contacts = [...this.contacts];
    this.contacts.clear();
    const failures: unknown[] = [];
    for (const [pointerId, contact] of contacts) {
      if (this.disposed) break;
      if (!contact.cancelled && !contact.scrolling) {
        try {
          dispatch(
            contact.target,
            'pointercancel',
            { pointerId, pointerType: 'touch', clientX: contact.x, clientY: contact.y },
            false,
          );
        } catch (cause) {
          failures.push(cause);
        }
      }
    }
    if (!this.disposed) {
      try {
        this.dom.read('input.active', (core) => core.set_active(0n));
        this.dom.read('input.hover', (core) => core.set_hover(0n));
        this.dom.focus(null);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'UI input cancellation failed');
  }
  focusedText(): UiTextEditor | null {
    if (this.disposed) return null;
    const editor = this.dom.focused();
    return isEditor(editor)
      ? {
          value: this.dom.read('input.editor', (core) => core.input_text(editor.coreId)),
          type: editor.type,
          multiline: editor.localName === 'textarea',
          maxLength: editor.maxLength,
        }
      : null;
  }
  subscribeFocus(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeTextEdit(listener: () => void): () => void {
    this.editListeners.add(listener);
    return () => {
      this.editListeners.delete(listener);
    };
  }
  ownsInput(): boolean {
    return !this.disposed && (this.contacts.size > 0 || this.dom.focused() !== null);
  }
  dispose(): void {
    if (this.disposed) return;
    try {
      this.cancel();
    } finally {
      this.disposed = true;
      this.dom.focusListeners.delete(this.focusChanged);
      this.dom.formResetListeners.delete(this.formReset);
      this.listeners.clear();
      this.editListeners.clear();
    }
  }
}
