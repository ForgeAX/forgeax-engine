import { err, ok, type Result } from '@forgeax/engine/types';
import { SHOW_ANALYSES, type ShowAnalysis } from './analysis.ts';
import { type ReadyControlKind, SHOW_CONTROL_KINDS, type ShowControl, type ShowControlErrorCode } from './controls.ts';
import type { ShowCommand, ShowState, ShowSubjectPanel, ShowView } from './show.ts';

/**
 * The debug panel: one row per applicable control of the subject on stage, built from its
 * declared controls through the slot table. Every row sends ordinary Show commands and renders
 * from the mirrored ShowState; hook names keep the data-ui-part / data-ui-action convention.
 */
export interface PanelContext {
  readonly document: Document;
  readonly state: () => ShowState | undefined;
  readonly command: (command: ShowCommand) => void;
  readonly subject: ShowSubjectPanel;
  /** Index of the subject in the program. */
  readonly index: number;
}

export interface PanelRow {
  readonly node: HTMLElement;
  render(state: ShowState): void;
}

type SlotOf<K extends ReadyControlKind> = (control: Extract<ShowControl, { kind: K }>, context: PanelContext) => PanelRow;

/**
 * Preset camera directions in the subject's frame (yaw from its +z about +y, pitch); the
 * distance stays the current one.
 */
const PRESETS: Readonly<Record<string, { readonly label: string; readonly yaw: number; readonly pitch: number }>> = {
  front: { label: 'Front', yaw: 0, pitch: 0.12 },
  side: { label: 'Side', yaw: Math.PI / 2, pitch: 0.1 },
  rear: { label: 'Rear 3/4', yaw: (-3 * Math.PI) / 4, pitch: 0.3 },
  top: { label: 'Top', yaw: 0, pitch: 1.5 },
};

const ANALYSIS_LABELS: Readonly<Record<ShowAnalysis, string>> = { off: 'Lit', curvature: 'Curvature', zebra: 'Zebra', edges: 'Facet edges' };

function row(document: Document, label: string, ...children: HTMLElement[]): HTMLElement {
  const node = document.createElement('div');
  node.className = 'row';
  const title = document.createElement('small');
  title.textContent = label;
  node.append(title, ...children);
  return node;
}

function button(document: Document, text: string, hook: { readonly action?: string; readonly part?: string }, click: () => void) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = text;
  if (hook.action !== undefined) node.dataset.uiAction = hook.action;
  if (hook.part !== undefined) node.dataset.uiPart = hook.part;
  node.addEventListener('click', click);
  return node;
}

const SLOTS: { readonly [K in ReadyControlKind]: SlotOf<K> } = {
  camera: (_, { document, state, command }) => {
    const auto = button(document, 'Auto', { action: 'view-auto' }, () => command({ kind: 'view' }));
    const presets = Object.entries(PRESETS).map(([name, preset]) =>
      button(document, preset.label, { action: `view-${name}` }, () => {
        const s = state();
        if (s === undefined) return;
        const view: ShowView = { yaw: preset.yaw + s.spin, pitch: preset.pitch, distance: s.view.distance, pan: [0, 0, 0] };
        command({ kind: 'view', view });
      }),
    );
    const hint = document.createElement('small');
    hint.textContent = 'Drag to orbit · Shift or right drag to pan · wheel to zoom';
    const node = row(document, 'Camera', auto, ...presets, hint);
    return { node, render: (s) => auto.classList.toggle('current', !s.free) };
  },
  floor: (_, { document, state, command }) => {
    const node = button(document, 'Floor on', { part: 'floor' }, () => command({ kind: 'floor', visible: state()?.floor === false }));
    return {
      node: row(document, 'Floor', node),
      render(s) {
        node.textContent = s.floor ? 'Floor on' : 'Floor off';
        node.classList.toggle('current', s.floor);
      },
    };
  },
  finish: (_, { document, state, command }) => {
    const node = button(document, 'Paint clean', { part: 'finish' }, () =>
      command({ kind: 'finish', mode: state()?.finish.mode === 'clean' ? 'weathered' : 'clean' }),
    );
    return {
      node: row(document, 'Finish', node),
      render(s) {
        node.textContent = s.finish.mode === 'clean' ? 'Paint clean' : 'Paint weathered';
        node.classList.toggle('current', s.finish.mode === 'clean');
      },
    };
  },
  shading: (_, { document, command }) => {
    const modes = SHOW_ANALYSES.map((mode) =>
      button(document, ANALYSIS_LABELS[mode], { action: `analysis-${mode}` }, () => command({ kind: 'analysis', mode })),
    );
    const progress = document.createElement('small');
    progress.dataset.uiPart = 'analysis-progress';
    return {
      node: row(document, 'Shading', ...modes, progress),
      render(s) {
        for (const [i, node] of modes.entries()) node.classList.toggle('current', SHOW_ANALYSES[i] === s.analysis.mode);
        const { mode, done, total } = s.analysis;
        progress.textContent = mode !== 'off' && done < total ? `computing ${done}/${total} parts` : '';
      },
    };
  },
  bake: (_, { document, command }) => {
    const levels = (['low', 'high'] as const).map((mesh) =>
      button(document, mesh === 'low' ? 'Low mesh' : 'High mesh', { action: `bake-mesh-${mesh}` }, () => command({ kind: 'bake', mesh })),
    );
    const looks = (['baked', 'plain'] as const).map((material) =>
      button(document, material === 'baked' ? 'Baked maps' : 'Plain', { action: `bake-material-${material}` }, () =>
        command({ kind: 'bake', material }),
      ),
    );
    return {
      node: row(document, 'Bake', ...levels, ...looks),
      render(s) {
        for (const [i, node] of levels.entries()) node.classList.toggle('current', ['low', 'high'][i] === s.bake.mesh);
        for (const [i, node] of looks.entries()) node.classList.toggle('current', ['baked', 'plain'][i] === s.bake.material);
      },
    };
  },
  parts: (_, { document, state, command, subject, index }) => {
    const hide = (parts: readonly number[]) => command({ kind: 'hide', subject: index, parts });
    const all = button(document, 'Show all', { action: 'parts-all' }, () => hide([]));
    const list = document.createElement('div');
    list.className = 'parts';
    list.dataset.uiPart = 'parts';
    const boxes = subject.parts.map((name, i) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.partIndex = String(i);
      box.addEventListener('change', () => {
        const hidden = new Set(state()?.hidden ?? []);
        if (box.checked) hidden.delete(i);
        else hidden.add(i);
        hide([...hidden].sort((a, b) => a - b));
      });
      label.append(box, document.createTextNode(name));
      list.append(label);
      return box;
    });
    return {
      node: row(document, `Parts (${subject.parts.length})`, all, list),
      render(s) {
        for (const [i, box] of boxes.entries()) box.checked = !s.hidden.includes(i);
      },
    };
  },
};

/** The slot builder of a control kind; unknown and not yet implemented kinds are errors. */
export function panelSlot(kind: string): Result<(control: ShowControl, context: PanelContext) => PanelRow, ShowControlErrorCode> {
  if (!Object.hasOwn(SHOW_CONTROL_KINDS, kind)) return err('control-unknown');
  if (!Object.hasOwn(SLOTS, kind)) return err('control-not-ready');
  return ok(SLOTS[kind as ReadyControlKind] as (control: ShowControl, context: PanelContext) => PanelRow);
}

/** The rows of a subject's panel, in declaration order. */
export function panelRows(context: Omit<PanelContext, 'subject' | 'index'>, subject: ShowSubjectPanel, index: number): PanelRow[] {
  return subject.controls.map((control) => {
    const slot = panelSlot(control.kind);
    if (!slot.ok) throw new Error(`Show panel: ${slot.error} ${control.kind} on subject ${subject.name}`);
    return slot.value(control, { ...context, subject, index });
  });
}
