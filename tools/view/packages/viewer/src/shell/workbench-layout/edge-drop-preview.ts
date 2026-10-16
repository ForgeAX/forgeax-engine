import type { DockviewApi } from 'dockview';

import { resolveEdgeStripHit } from './edge-strip-hit.ts';
import { rectOf } from '../ue-drag/drop-target.ts';
import { stripInsertion, type Point, type Rect } from '../ue-drag/geometry.ts';

const PREVIEW_TAB_CLASS = 'fx-edge-preview-tab';
const PREVIEW_EDGE_CLASS = 'fx-edge-drop-preview';

type PreviewRecord = {
  edge: string;
  groupId: string;
  tabEl: HTMLDivElement;
  wasEmpty: boolean;
  restoredVisible: boolean;
};

const records = new WeakMap<DockviewApi, PreviewRecord>();

function tabElements(tabsEl: Element) {
  return Array.from(tabsEl.querySelectorAll(':scope > .dv-tab:not(.fx-edge-preview-tab)'));
}

function revealEdgeForPreview(api: DockviewApi, side: string, group: DockviewApi['groups'][number]) {
  const wasEmpty = group.panels.length === 0;
  try {
    api.setEdgeGroupVisible?.(side as 'left' | 'right' | 'bottom' | 'top', true);
  } catch {
    /* noop */
  }
  const el = group.element;
  if (el instanceof HTMLElement) {
    el.classList.remove('fx-edge-empty');
    el.classList.add(PREVIEW_EDGE_CLASS);
  }
  return wasEmpty;
}

function hideEdgeAfterPreview(api: DockviewApi, side: string, group: DockviewApi['groups'][number], wasEmpty: boolean) {
  const el = group.element;
  if (el instanceof HTMLElement) {
    el.classList.remove(PREVIEW_EDGE_CLASS);
    if (wasEmpty) el.classList.add('fx-edge-empty');
  }
  if (!wasEmpty) return;
  try {
    api.setEdgeGroupVisible?.(side as 'left' | 'right' | 'bottom' | 'top', false);
  } catch {
    /* noop */
  }
}

export function clearEdgeDropPreview(api: DockviewApi) {
  const record = records.get(api);
  if (!record) return;
  record.tabEl.remove();
  const group = api.groups.find((g) => g.id === record.groupId);
  if (group) hideEdgeAfterPreview(api, record.edge, group, record.wasEmpty);
  records.delete(api);
}

export function syncEdgeDropPreview(
  api: DockviewApi,
  input: {
    edgeSide: string;
    group: DockviewApi['groups'][number];
    tabsEl: HTMLElement;
    rect: Rect;
    pointer: Point;
    title: string;
  } | null,
) {
  if (!input) {
    clearEdgeDropPreview(api);
    return;
  }
  const { edgeSide, group, tabsEl, rect, pointer, title } = input;
  let record = records.get(api);
  if (!record || record.groupId !== group.id) {
    clearEdgeDropPreview(api);
    const wasEmpty = revealEdgeForPreview(api, edgeSide, group);
    const tabEl = document.createElement('div');
    tabEl.className = `dv-tab ${PREVIEW_TAB_CLASS}`;
    tabEl.textContent = title;
    tabEl.setAttribute('aria-hidden', 'true');
    record = {
      edge: edgeSide,
      groupId: group.id,
      tabEl,
      wasEmpty,
      restoredVisible: false,
    };
    records.set(api, record);
  }
  record.tabEl.textContent = title;
  const tabs = tabElements(tabsEl).map((tab) => rectOf(tab)).filter((r): r is Rect => r !== null);
  const axis = edgeSide === 'left' || edgeSide === 'right' ? 'y' : 'x';
  const { index } = stripInsertion(tabs, rect, pointer, axis);
  const refs = tabElements(tabsEl);
  const ref = refs[index] ?? null;
  if (record.tabEl.parentElement !== tabsEl || record.tabEl.nextElementSibling !== ref) {
    tabsEl.insertBefore(record.tabEl, ref);
  }
}

export function edgeStripHitFromPoint(
  api: DockviewApi,
  root: HTMLElement,
  pointer: Point,
  title: string,
): Parameters<typeof syncEdgeDropPreview>[1] {
  const hit = resolveEdgeStripHit(api, root, pointer, title);
  if (!hit) return null;
  return {
    edgeSide: hit.edgeSide,
    group: hit.group,
    tabsEl: hit.tabsEl,
    rect: hit.rect,
    pointer: hit.pointer,
    title: hit.title,
  };
}
