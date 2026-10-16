import { PLAYER_CONTROL_CHANNEL, type PlayerControl } from '../player/player-input.ts';

type Role = 'move' | 'look' | 'jump' | 'run';

/** Presentation-only gestures. Physics and the sampled control state stay in the World. */
export function installPlayerControls(root: ShadowRoot, port: MessagePort) {
  const required = <T extends HTMLElement>(part: string): T => {
    const node = root.querySelector<T>(`[data-ui-part="${part}"]`);
    if (!node) throw new Error(`Player UI requires ${part}`);
    return node;
  };
  const thumb = required('move-thumb');
  const elements = { move: required('move-stick'), look: required('look-pad'), jump: required('jump'), run: required('run') };
  const document = root.ownerDocument;
  const window = document.defaultView;
  const contacts: Partial<Record<Role, { id: number; x: number; y: number }>> = {};
  const releases: (() => void)[] = [];
  let enabled = false, disposed = false;
  let width = 0, height = 0;
  const send = (message: PlayerControl) => port.postMessage({ channel: PLAYER_CONTROL_CHANNEL, ...message });
  const mark = (role: Role, held: boolean) => {
    elements[role].classList.toggle('held', held);
    if (role === 'run' || role === 'jump') elements[role].setAttribute('aria-pressed', String(held));
  };
  const reset = () => {
    for (const role of Object.keys(elements) as Role[]) { delete contacts[role]; mark(role, false); }
    thumb.style.transform = 'translate(0px, 0px)';
    send({ kind: 'reset' });
  };
  const geometry = () => {
    const rect = root.host.getBoundingClientRect();
    if (width && (rect.width !== width || rect.height !== height)) reset();
    width = rect.width;
    height = rect.height;
    return Math.min(width, height);
  };
  const moveStick = (x: number, y: number) => {
    const rect = elements.move.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * 0.3;
    if (radius <= 0) return;
    const dx = x - (rect.left + rect.width / 2), dy = y - (rect.top + rect.height / 2);
    const length = Math.hypot(dx, dy);
    const scale = Math.max(radius, length);
    const horizontal = length < radius * 0.15 ? 0 : dx / scale;
    const vertical = length < radius * 0.15 ? 0 : -dy / scale;
    thumb.style.transform = `translate(${horizontal * radius}px, ${-vertical * radius}px)`;
    send({ kind: 'move', horizontal, vertical });
  };
  const listen = (target: EventTarget, name: string, listener: EventListener, options?: AddEventListenerOptions) => {
    target.addEventListener(name, listener, options);
    releases.push(() => target.removeEventListener(name, listener, options));
  };
  for (const role of Object.keys(elements) as Role[]) {
    listen(elements[role], 'pointerdown', ((event: PointerEvent) => {
      if (!enabled || disposed || contacts[role] || event.button > 0 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      geometry();
      event.preventDefault();
      contacts[role] = { id: event.pointerId, x: event.clientX, y: event.clientY };
      mark(role, true);
      if (role === 'move') moveStick(event.clientX, event.clientY);
      if (role === 'jump') send({ kind: 'jump' });
      if (role === 'run') send({ kind: 'run', held: true });
    }) as EventListener);
  }
  listen(document, 'pointermove', ((event: PointerEvent) => {
    if (!enabled || disposed) return;
    const extent = geometry();
    if (contacts.move?.id === event.pointerId) { event.preventDefault(); moveStick(event.clientX, event.clientY); }
    const look = contacts.look;
    if (look?.id === event.pointerId && extent > 0) {
      event.preventDefault();
      // Both native UI and browser PointerEvents use CSS pixels. Scaling by the
      // same live viewport geometry keeps sensitivity independent of DPR.
      send({ kind: 'look', x: (event.clientX - look.x) * 1000 / extent, y: (event.clientY - look.y) * 1000 / extent });
      look.x = event.clientX; look.y = event.clientY;
    }
  }) as EventListener, { capture: true, passive: false });
  const releaseContact = (event: PointerEvent) => {
    for (const role of Object.keys(elements) as Role[]) {
      if (contacts[role]?.id !== event.pointerId) continue;
      delete contacts[role]; mark(role, false);
      if (role === 'move') { thumb.style.transform = 'translate(0px, 0px)'; send({ kind: 'move', horizontal: 0, vertical: 0 }); }
      if (role === 'run') send({ kind: 'run', held: false });
    }
    if (event.type === 'pointercancel' && Object.keys(contacts).length === 0) reset();
  };
  listen(document, 'pointerup', releaseContact as EventListener, { capture: true });
  listen(document, 'pointercancel', releaseContact as EventListener, { capture: true });
  listen(document, 'pointerout', ((event: PointerEvent) => {
    if (event.pointerType !== 'touch' && event.relatedTarget === null) reset();
  }) as EventListener);
  listen(document, 'visibilitychange', reset);
  // Native platform visibility/display loss already dispatches pointercancel.
  // A browser additionally reports window loss and viewport changes here.
  if (window) { listen(window, 'blur', reset); listen(window, 'resize', reset); }
  listen(root, 'focusin', ((event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) reset();
  }) as EventListener);
  for (const role of ['jump', 'run'] as const) {
    listen(elements[role], 'keydown', ((event: KeyboardEvent) => {
      if (!enabled || event.repeat || !['Space', 'Enter'].includes(event.code)) return;
      event.preventDefault(); mark(role, true);
      send(role === 'jump' ? { kind: 'jump' } : { kind: 'run', held: true });
    }) as EventListener);
    listen(elements[role], 'keyup', ((event: KeyboardEvent) => {
      if (!['Space', 'Enter'].includes(event.code)) return;
      event.preventDefault(); mark(role, false);
      if (role === 'run') send({ kind: 'run', held: false });
    }) as EventListener);
    listen(elements[role], 'blur', () => {
      if (contacts[role]) return;
      mark(role, false);
      if (role === 'run') send({ kind: 'run', held: false });
    });
  }
  return {
    reset,
    setEnabled(value: boolean) {
      if (enabled === value) return;
      reset(); enabled = value;
    },
    dispose() {
      if (disposed) return;
      reset(); disposed = true;
      for (const release of releases.reverse()) release();
    },
  };
}
