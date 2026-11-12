import { type ShowSegment, timeOf } from './director.ts';
import { isShowMessage, SHOW_CHANNEL, type ShowMessage } from './protocol.ts';
import { type PanelRow, panelRows } from './panel.ts';
import type { ShowCommand, ShowState, ShowSubjectPanel } from './show.ts';

/** Position text of a history step: stage, index, operation, label and author line. */
export function stepCaption(step: NonNullable<ShowState['step']>): string {
  const file = step.source === undefined ? '' : ` · ${step.source.path.split('/').pop()}:${step.source.line}`;
  const label = step.label === undefined ? '' : ` "${step.label}"`;
  return `${step.stage} · step ${step.index + 1}/${step.count} · #${step.opIndex} ${step.op}${label}${file} · ${step.faces} faces`;
}

/**
 * The state a command leads to, shown until the Show's next state arrives (seeks predict
 * their own position).
 */
export function predict(state: ShowState, command: ShowCommand): ShowState {
  switch (command.kind) {
    case 'play':
      return { ...state, playing: true };
    case 'pause':
      return { ...state, playing: false };
    case 'seek':
      return state;
    case 'view':
      return { ...state, free: command.view !== undefined };
    case 'floor':
      return { ...state, floor: command.visible };
    case 'analysis':
      return { ...state, analysis: { ...state.analysis, mode: command.mode, done: 0 } };
    case 'finish':
      return { ...state, finish: { ...state.finish, mode: command.mode } };
    case 'hide':
      return { ...state, hidden: command.parts };
    case 'bake':
      return { ...state, bake: { ...state.bake, mesh: command.mesh ?? state.bake.mesh, material: command.material ?? state.bake.material } };
  }
}

/**
 * Bind the timeline UI (segment chips, play/pause, scrub slider, captions) and the debug
 * panel of the subject on stage to the Show over its port. Arrow keys move one history step
 * (or 5 % of other segments); Space plays or pauses. Returns the unbinding function.
 */
export function bindTimeline(root: ShadowRoot, port: MessagePort): () => void {
  const part = <T extends HTMLElement>(name: string): T => {
    const node = root.querySelector<T>(`[data-ui-part="${name}"]`);
    if (node === null) throw new Error(`the timeline UI needs data-ui-part="${name}"`);
    return node;
  };
  const segmentsNode = part('segments');
  const toggle = part<HTMLButtonElement>('toggle');
  const scrub = part<HTMLInputElement>('scrub');
  const position = part('position');
  const title = part('title');
  const beat = part('beat');
  const stepNode = part('step');
  const labelNode = part('label');
  const legendNode = part('legend');
  const sourceNode = part('source');
  const panelNode = part('panel');
  const panelToggle = part<HTMLButtonElement>('panel-toggle');
  const document = root.ownerDocument;
  let segments: readonly ShowSegment[] = [];
  let subjects: readonly ShowSubjectPanel[] = [];
  let state: ShowState | undefined;
  let panel: { readonly subject: number; readonly rows: readonly PanelRow[] } | undefined;
  let dragging = false;
  const send = (command: ShowCommand) =>
    port.postMessage({ channel: SHOW_CHANNEL, kind: 'command', command } satisfies ShowMessage);
  const command = (c: ShowCommand) => {
    send(c);
    if (state !== undefined) state = predict(state, c);
    render();
  };
  // Seeks apply on the Show's next frame. Until a state at the sought time arrives, the
  // UI shows the sought position itself and ignores older states, so chained inputs
  // (a chip then the slider, repeated arrow keys) build on the latest request.
  let pending: number | undefined;
  const seek = (segment: number, u: number) => {
    const clamped = Math.min(1, Math.max(0, u));
    send({ kind: 'pause' });
    send({ kind: 'seek', segment, u: clamped });
    pending = timeOf(segments, segment, clamped);
    const kind = segments[segment]?.kind;
    if (state !== undefined && kind !== undefined) {
      const step = state.step;
      state = {
        ...state,
        playing: false,
        time: pending,
        segment,
        kind,
        u: clamped,
        ...(step === undefined || state.segment !== segment
          ? {}
          : { step: { ...step, index: Math.min(step.count - 1, Math.floor(clamped * step.count)) } }),
      };
      render();
    }
  };
  const releases: (() => void)[] = [];
  const listen = (target: EventTarget, name: string, listener: EventListener) => {
    target.addEventListener(name, listener);
    releases.push(() => target.removeEventListener(name, listener));
  };
  const render = () => {
    if (state === undefined) return;
    for (const [i, button] of [...segmentsNode.querySelectorAll('button')].entries()) {
      button.classList.toggle('current', i === state.segment);
    }
    toggle.textContent = state.playing ? 'Pause' : 'Play';
    if (!dragging) scrub.value = String(Math.round(state.u * 1000));
    position.textContent = `${Math.round(state.u * 100)}%`;
    title.textContent = `Modeling Show · ${state.subject}`;
    beat.textContent = `${state.segment + 1}/${segments.length} · ${state.kind}`;
    stepNode.textContent = state.step === undefined ? '' : stepCaption(state.step);
    const index = segments[state.segment]?.subject ?? 0;
    const subject = subjects[index];
    legendNode.textContent = subject?.legend ?? '';
    sourceNode.textContent = subject === undefined || subject.source === '' ? '' : `Source: ${subject.source}`;
    if (subject !== undefined && panel?.subject !== index) {
      const rows = panelRows({ document, state: () => state, command }, subject, index);
      panelNode.replaceChildren(...rows.map((r) => r.node));
      panel = { subject: index, rows };
    }
    for (const r of panel?.rows ?? []) r.render(state);
  };
  listen(port, 'message', ((event: MessageEvent) => {
    const message = event.data;
    if (!isShowMessage(message)) return;
    if (message.kind === 'program') {
      segments = message.segments;
      subjects = message.subjects;
      panel = undefined;
      labelNode.textContent = message.label ?? '';
      segmentsNode.replaceChildren(
        ...segments.map((segment, i) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `${subjects[segment.subject]?.name ?? segment.subject} · ${segment.kind}`;
          button.addEventListener('click', () => seek(i, 0));
          return button;
        }),
      );
    } else if (message.kind === 'state') {
      if (pending !== undefined && Math.abs(message.state.time - pending) > 1e-6) return;
      pending = undefined;
      state = message.state;
    }
    render();
  }) as EventListener);
  port.start();
  const togglePlay = () => {
    pending = undefined;
    command({ kind: state?.playing === false ? 'play' : 'pause' });
  };
  listen(toggle, 'click', togglePlay);
  listen(panelToggle, 'click', () => {
    const open = panelToggle.getAttribute('aria-expanded') !== 'true';
    panelToggle.setAttribute('aria-expanded', String(open));
    panelNode.classList.toggle('open', open);
  });
  listen(scrub, 'pointerdown', () => {
    dragging = true;
  });
  listen(scrub, 'change', () => {
    dragging = false;
  });
  listen(scrub, 'input', () => {
    if (state !== undefined) seek(state.segment, Number(scrub.value) / 1000);
  });
  listen(document, 'keydown', ((event: KeyboardEvent) => {
    if (state === undefined) return;
    if (event.key === ' ') {
      togglePlay();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const step = state.step;
      seek(state.segment, step === undefined ? state.u + 0.05 * direction : (step.index + direction + 0.5) / step.count);
    } else {
      return;
    }
    event.preventDefault();
  }) as EventListener);
  return () => {
    for (const release of releases.reverse()) release();
  };
}
