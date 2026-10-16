import { observeElementVisibility } from '@forgeax/view-components/visibility';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import {
  createWorkspaceStateReader,
  type WorkspaceStateClient,
} from '@forgeax/view-workspace-core/workspace-state';
import { getLocale, subscribeLocale, t } from '../i18n/index.ts';
import type {
  OperationHistoryEntry,
  OperationHistorySummary,
  OperationHistoryPage,
} from '@forgeax/engine/devkit';

type Client = Pick<ViewWorkspaceClient, 'call'> & Partial<WorkspaceStateClient>;

/** Presentation of Engine command receipts. It never executes or replays a recorded operation. */
export function mountOperationHistory({
  document,
  surface,
  client,
}: {
  document: Document;
  surface: HTMLElement;
  client: Client;
}) {
  let live = true,
    visible = false,
    root = '',
    projectName = '',
    generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller = new AbortController();
  let listing = false,
    before: string | undefined,
    nextCursor: string | undefined;
  let entries: OperationHistorySummary[] = [],
    selected: OperationHistoryEntry | undefined,
    error = '',
    imageGeneration = 0,
    selectionGeneration = 0;
  const toolbar = document.createElement('div');
  toolbar.className = 'fx-toolbar fx-history-toolbar';
  const heading = document.createElement('strong');
  const context = document.createElement('span');
  context.className = 'fx-history-project';
  const latest = document.createElement('button');
  latest.className = 'fx-button fx-button--secondary fx-button--compact';
  const older = document.createElement('button');
  older.className = 'fx-button fx-button--secondary fx-button--compact';
  toolbar.append(heading, context, latest, older);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const columns = document.createElement('div');
  columns.className = 'fx-history-columns';
  const list = document.createElement('div');
  list.className = 'fx-history-list';
  list.setAttribute('role', 'list');
  const detail = document.createElement('section');
  detail.className = 'fx-history-detail';
  columns.append(list, detail);
  surface.append(toolbar, status, columns);
  const time = (value: string) =>
    new Date(value).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US');
  const state = (entry: Pick<OperationHistoryEntry, 'state'>) => t(`history.${entry.state}`);
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const invalidate = () => {
    generation++;
    selectionGeneration++;
    imageGeneration++;
    controller.abort();
    controller = new AbortController();
    clearTimeout(timer);
    timer = undefined;
  };
  const loadImage = async (
    entry: OperationHistoryEntry,
    index: number,
    image: HTMLImageElement,
    note: HTMLElement,
  ) => {
    const token = ++imageGeneration,
      epoch = generation;
    image.removeAttribute('src');
    note.textContent = t('history.loadingImage');
    try {
      const result = await client.call<{ mediaType: string; data: string }>(
        'history.artifact.read',
        { id: entry.id, index },
        { signal: controller.signal, reportError: false },
      );
      if (!live || epoch !== generation || token !== imageGeneration) return;
      image.src = `${'data:'}${result.mediaType};base64,${result.data}`;
      note.textContent = '';
    } catch (cause) {
      if (live && epoch === generation && token === imageGeneration)
        note.textContent = message(cause);
    }
  };
  const renderDetail = () => {
    imageGeneration++;
    detail.replaceChildren();
    detail.scrollTop = 0;
    if (!selected) {
      detail.textContent = t('history.select');
      return;
    }
    const entry = selected;
    const title = document.createElement('h2');
    title.textContent = entry.operation;
    const metadata = document.createElement('p');
    metadata.textContent = `${time(entry.startedAt)} · ${state(entry)}${entry.durationMs === undefined ? '' : ` · ${entry.durationMs} ms`}`;
    detail.append(title, metadata);
    if (entry.artifacts?.length) {
      const label = document.createElement('label');
      label.textContent = t('history.artifacts');
      const choice = document.createElement('select');
      choice.className = 'fx-input';
      const image = document.createElement('img');
      image.alt = t('history.image');
      image.className = 'fx-history-image';
      const note = document.createElement('p');
      entry.artifacts.forEach((artifact, index) => {
        if (!artifact.available) return;
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = artifact.uri?.split(/[\\/]/).at(-1) ?? `${artifact.kind} ${index + 1}`;
        choice.append(option);
      });
      label.append(choice);
      detail.append(label, note, image);
      const choose = () => void loadImage(entry, Number(choice.value), image, note);
      choice.addEventListener('change', choose);
      if (choice.options.length) choose();
      else {
        label.hidden = true;
        image.hidden = true;
      }
      const refs = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = t('history.artifactRefs');
      const text = document.createElement('pre');
      text.textContent = JSON.stringify(entry.artifacts, null, 2);
      refs.append(summary, text);
      detail.append(refs);
    }
    for (const [label, value] of [
      [t('history.arguments'), entry.args],
      [t('history.result'), entry.result],
      [t('history.failure'), entry.failure],
    ] as const) {
      if (value === undefined) continue;
      const fold = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = label;
      const text = document.createElement('pre');
      text.textContent = JSON.stringify(value, null, 2);
      fold.append(summary, text);
      fold.open = value === entry.failure;
      detail.append(fold);
    }
  };
  const select = async (id: string) => {
    const epoch = generation,
      selection = ++selectionGeneration;
    try {
      const entry = await client.call<OperationHistoryEntry>(
        'history.get',
        { id },
        { signal: controller.signal, reportError: false },
      );
      if (!live || epoch !== generation || selection !== selectionGeneration) return;
      selected = entry;
      for (const row of Array.from(list.children))
        row.setAttribute(
          'aria-pressed',
          String((row as HTMLElement).dataset.historyId === entry.id),
        );
      renderDetail();
    } catch (cause) {
      if (live && epoch === generation) {
        error = message(cause);
        renderToolbar();
      }
    }
  };
  const renderList = () => {
    list.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'fx-history-row';
      row.dataset.historyId = entry.id;
      row.setAttribute('aria-pressed', String(selected?.id === entry.id));
      const title = document.createElement('strong');
      title.textContent = entry.operation;
      const metadata = document.createElement('span');
      metadata.textContent = `${time(entry.startedAt)} · ${state(entry)}`;
      row.append(title, metadata);
      row.addEventListener('click', () => void select(entry.id));
      list.append(row);
    }
  };
  const renderToolbar = () => {
    heading.textContent = t('history.title');
    context.textContent = projectName;
    latest.textContent = t('history.latest');
    latest.disabled = !root || listing;
    older.textContent = t('history.older');
    older.disabled = !nextCursor || listing;
    status.textContent =
      error ||
      (!root
        ? t('history.noProject')
        : entries.length
          ? ''
          : listing
            ? t('history.loading')
            : t('history.empty'));
  };
  const refresh = async () => {
    if (!live || !visible || !root || listing) return;
    const epoch = generation;
    listing = true;
    renderToolbar();
    try {
      const result = await client.call<OperationHistoryPage>(
        'history.list',
        { limit: 50, ...(before ? { before } : {}) },
        { signal: controller.signal, reportError: false },
      );
      if (!live || epoch !== generation) return;
      const changed = JSON.stringify(entries) !== JSON.stringify(result.items);
      entries = result.items;
      nextCursor = result.nextCursor;
      error = '';
      if (changed) renderList();
      if (!selected && entries[0]) await select(entries[0].id);
      else if (selected) {
        const current = entries.find((row) => row.id === selected!.id);
        if (current?.completedAt !== undefined && current.completedAt !== selected.completedAt)
          await select(current.id);
      }
    } catch (cause) {
      if (live && epoch === generation) error = message(cause);
    } finally {
      if (live && epoch === generation) {
        listing = false;
        renderToolbar();
        if (visible && !before) timer = setTimeout(() => void refresh(), 2000);
      }
    }
  };
  const showLatest = () => {
    before = undefined;
    selected = undefined;
    clearTimeout(timer);
    void refresh();
  };
  const showOlder = () => {
    if (!nextCursor) return;
    before = nextCursor;
    selected = undefined;
    clearTimeout(timer);
    void refresh();
  };
  latest.addEventListener('click', showLatest);
  older.addEventListener('click', showOlder);
  const reader = createWorkspaceStateReader(
    typeof client?.subscribe === 'function'
      ? {
          subscribe: client.subscribe.bind(client),
          ...(client.getState ? { getState: client.getState.bind(client) } : {}),
        }
      : undefined,
  );
  const unsubscribe = reader.subscribe(() => {
    const workspace = reader.getSnapshot();
    const next = workspace?.project?.root ?? '';
    projectName = workspace?.project?.name ?? '';
    if (root !== next) {
      invalidate();
      root = next;
      before = nextCursor = undefined;
      entries = [];
      selected = undefined;
      listing = false;
      error = '';
      renderList();
      renderDetail();
      void refresh();
    }
    renderToolbar();
  });
  const visibility = observeElementVisibility(surface, (value) => {
    visible = value;
    invalidate();
    listing = false;
    if (value) {
      renderDetail();
      void refresh();
    }
  });
  const locale = subscribeLocale(() => {
    renderToolbar();
    renderList();
    renderDetail();
  });
  renderToolbar();
  renderDetail();
  return () => {
    live = false;
    invalidate();
    unsubscribe();
    reader.dispose();
    visibility();
    locale();
    latest.removeEventListener('click', showLatest);
    older.removeEventListener('click', showOlder);
    surface.replaceChildren();
  };
}
