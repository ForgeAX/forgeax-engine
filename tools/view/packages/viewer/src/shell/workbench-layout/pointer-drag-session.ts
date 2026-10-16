type PointerDragFinishReason =
  | 'pointerup'
  | 'pointercancel'
  | 'lostpointercapture'
  | 'dispose'
  | 'error';

export type PointerDragSessionOptions<T> = {
  element: HTMLElement;
  begin: (event: PointerEvent) => T | null;
  move: (session: T, event: PointerEvent) => void;
  end?: (session: T, reason: PointerDragFinishReason) => void;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  draggingClassName?: string;
};

export type PointerDragSessionHandle = {
  dispose: () => void;
  /** End capture, listeners, and dragging class without uninstalling the grip listener. */
  abortActiveSession: () => void;
};

/** Minimal port of @forgeax/app-shell `installPointerDragSession` for edge drawer grip. */
export function installPointerDragSession<T>(options: PointerDragSessionOptions<T>): PointerDragSessionHandle {
  const { element } = options;
  let disposed = false;
  let starting = false;
  let active: { pointerId: number; session: T; releaseClass: () => void } | null = null;

  const removeSessionListeners = () => {
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', onPointerFinish);
    element.removeEventListener('pointercancel', onPointerFinish);
    element.removeEventListener('lostpointercapture', onPointerFinish);
  };

  const finish = (reason: PointerDragFinishReason) => {
    const current = active;
    if (!current) return;
    active = null;
    removeSessionListeners();
    try {
      element.releasePointerCapture(current.pointerId);
    } catch {
      /* noop */
    }
    try {
      current.releaseClass();
    } catch {
      /* noop */
    }
    try {
      options.end?.(current.session, reason);
    } catch {
      /* noop */
    }
  };

  function onPointerMove(event: PointerEvent) {
    const current = active;
    if (!current || current.pointerId !== event.pointerId) return;
    try {
      options.move(current.session, event);
    } catch {
      finish('error');
    }
  }

  function onPointerFinish(event: PointerEvent) {
    if (!active || active.pointerId !== event.pointerId) return;
    const reason =
      event.type === 'pointercancel'
        ? 'pointercancel'
        : event.type === 'lostpointercapture'
          ? 'lostpointercapture'
          : 'pointerup';
    finish(reason);
  }

  const onPointerDown = (event: PointerEvent) => {
    if (disposed || active || starting) return;
    starting = true;
    let session: T | null;
    try {
      session = options.begin(event);
    } catch {
      starting = false;
      return;
    }
    starting = false;
    if (session === null) return;
    if (disposed) {
      try {
        options.end?.(session, 'dispose');
      } catch {
        /* noop */
      }
      return;
    }
    if (options.preventDefault) event.preventDefault();
    if (options.stopPropagation) event.stopPropagation();
    const classTokens = options.draggingClassName?.trim().split(/\s+/).filter(Boolean) ?? [];
    const prior = new Map<string, string>();
    for (const token of classTokens) prior.set(token, element.classList.contains(token) ? '1' : '0');
    for (const token of classTokens) element.classList.add(token);
    active = {
      pointerId: event.pointerId,
      session,
      releaseClass: () => {
        for (const token of classTokens) {
          if (prior.get(token) === '0') element.classList.remove(token);
        }
      },
    };
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerFinish);
    element.addEventListener('pointercancel', onPointerFinish);
    element.addEventListener('lostpointercapture', onPointerFinish);
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      finish('error');
    }
  };

  element.addEventListener('pointerdown', onPointerDown);
  return {
    abortActiveSession: () => finish('dispose'),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      element.removeEventListener('pointerdown', onPointerDown);
      finish('dispose');
    },
  };
}
