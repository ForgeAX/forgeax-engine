import type { V7Tape } from '@forgeax/engine-rhi-debug';
import { err } from '@forgeax/engine-types';
import { Button, IconButton } from '@forgeax/view-components';
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
} from 'dockview-react';
import { Columns3, FileUp, Layers3, LayoutPanelTop, PanelTopOpen, RotateCcw } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EventBrowser } from './components/EventBrowser';
import { PipelineState } from './components/PipelineState';
import { ResourceInspector } from './components/ResourceInspector';
import { DrawCallViewer } from './components/TextureViewer';
import { PanelNavigationProvider } from './panel-navigation';
import { SelectionProvider, useSelection } from './selection-context';
import { loadStatusAnchor } from './selectors';
import { loadTapeFromFiles, loadTapeFromUrl, type TapeLoadError } from './tape-source';
import {
  openViewerReplay,
  type ReadResource,
  type RhiDebugViewerGlobal,
  ViewerContext,
  type ViewerReplay,
  type ViewerSelectionSnapshot,
  ViewModelContext,
  viewerNoWebGpuError,
  viewerShellCapability,
} from './viewer-context';
import {
  buildViewerModel,
  type InspectWork,
  type ViewerArtifactRef,
  type ViewerModel,
} from './viewer-model';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  LAYOUT_STORAGE_KEY,
  type LayoutRecovery,
  PANEL_IDS,
  readWorkspaceLayout,
  resetWorkspaceLayout,
  type WorkspaceLayout,
  writeWorkspaceLayout,
} from './workspace-layout';

interface ViewerPanelsProps {
  readonly model: ViewerModel;
  readonly tape?: V7Tape | null;
  readonly inspectWork?: InspectWork;
  readonly readResource?: ReadResource;
  readonly artifactRef?: ViewerArtifactRef | null;
  readonly capability?: ReturnType<typeof viewerShellCapability>;
}

function defaultInspectWork(): ReturnType<InspectWork> {
  return Promise.resolve(err(viewerNoWebGpuError()));
}

function defaultReadResource(): ReturnType<ReadResource> {
  return Promise.resolve(err(viewerNoWebGpuError()));
}

export function ViewerPanels({
  model,
  tape = null,
  inspectWork = defaultInspectWork,
  readResource = defaultReadResource,
  artifactRef = null,
  capability = viewerShellCapability(),
}: ViewerPanelsProps) {
  return (
    <ViewerContext.Provider value={{ model, tape, inspectWork, readResource, capability }}>
      <SelectionProvider>
        <ViewerGlobalBridge
          model={model}
          inspectWork={inspectWork}
          readResource={readResource}
          artifactRef={artifactRef}
          capability={capability}
        />
        <div className="forgeax-viewer-panels h-full min-h-0 grid" data-forgeax-viewer="v7">
          <div className="row-span-2 min-h-0">
            <EventBrowser />
          </div>
          <div className="row-span-2 min-h-0">
            <DrawCallViewer />
          </div>
          <div className="min-h-0">
            <PipelineState />
          </div>
          <div className="min-h-0">
            <ResourceInspector />
          </div>
        </div>
      </SelectionProvider>
    </ViewerContext.Provider>
  );
}

interface ViewerGlobalBridgeProps {
  readonly model: ViewerModel;
  readonly inspectWork: InspectWork;
  readonly readResource: ReadResource;
  readonly artifactRef: ViewerArtifactRef | null;
  readonly capability: ReturnType<typeof viewerShellCapability>;
}

function ViewerGlobalBridge({
  model,
  inspectWork,
  readResource,
  artifactRef,
  capability,
}: ViewerGlobalBridgeProps) {
  const selection = useSelection();
  const selectionSnapshot = useMemo<ViewerSelectionSnapshot>(
    () => ({
      selectedWorkIndex: selection.selectedWorkIndex,
      selectedCommandIndex: selection.selectedCommandIndex,
      selectedEventIndex: selection.selectedEventIndex,
      selectedPassIndex: selection.selectedPassIndex,
      selectedResourceId: selection.selectedResourceId,
      selectedSubresource: selection.selectedSubresource,
    }),
    [
      selection.selectedCommandIndex,
      selection.selectedEventIndex,
      selection.selectedPassIndex,
      selection.selectedResourceId,
      selection.selectedSubresource,
      selection.selectedWorkIndex,
    ],
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const globalApi: RhiDebugViewerGlobal = {
      model,
      artifactRef,
      inspectWork,
      readResource,
      capability,
      selection: selectionSnapshot,
    };
    (window as unknown as { __forgeaxRhiDebug?: RhiDebugViewerGlobal }).__forgeaxRhiDebug =
      globalApi;
  }, [artifactRef, capability, inspectWork, model, readResource, selectionSnapshot]);
  return null;
}

interface DockviewWorkspaceProps {
  readonly model: ViewerModel | null;
  readonly tape: V7Tape | null;
  readonly inspectWork: InspectWork;
  readonly readResource: ReadResource;
  readonly artifactRef: ViewerArtifactRef | null;
  readonly capability: ReturnType<typeof viewerShellCapability>;
  readonly onRecovery: (recovery: LayoutRecovery | null) => void;
  readonly onLayoutActions: (actions: LayoutActions | null) => void;
}

interface LayoutActions {
  readonly floatResource: () => void;
  readonly splitResource: () => void;
  readonly stackPipeline: () => void;
  readonly reset: () => void;
}

const FLOATING_PANEL_WIDTH = 460;
const FLOATING_PANEL_HEIGHT = 320;
const FLOATING_PANEL_MARGIN = 12;

function LayoutMenu({ actions }: { readonly actions: LayoutActions | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<'first' | 'last'>('first');
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    (initialFocusRef.current === 'last' ? items?.item(items.length - 1) : items?.item(0))?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const run = (action: (() => void) | undefined) => {
    action?.();
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      <IconButton
        ref={triggerRef}
        variant="quiet"
        size="compact"
        label="Layout menu"
        icon={<LayoutPanelTop className="fx-icon" />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={actions === null}
        onClick={() => {
          initialFocusRef.current = 'first';
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            initialFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first';
            setOpen(true);
          }
        }}
      />
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="forgeax-layout-menu"
          role="menu"
          aria-label="Layout actions"
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-forgeax-layout-action="float"
            onClick={() => run(actions?.floatResource)}
          >
            <PanelTopOpen className="fx-icon" />
            <span>
              <strong>Float resource</strong>
              <small>Detach Buffer / Resource</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-forgeax-layout-action="split"
            onClick={() => run(actions?.splitResource)}
          >
            <Columns3 className="fx-icon" />
            <span>
              <strong>Split resource</strong>
              <small>Move it beside inspectors</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-forgeax-layout-action="stack"
            onClick={() => run(actions?.stackPipeline)}
          >
            <Layers3 className="fx-icon" />
            <span>
              <strong>Stack pipeline</strong>
              <small>Return Pipeline to the Resource Inspector group</small>
            </span>
          </button>
          <hr className="forgeax-layout-menu-separator" />
          <button type="button" role="menuitem" onClick={() => run(actions?.reset)}>
            <RotateCcw className="fx-icon" />
            <span>
              <strong>Reset layout</strong>
              <small>Restore the three-region default</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function panelComponent(id: (typeof PANEL_IDS)[number], Component: () => ReactElement) {
  return function DockviewPanel() {
    return (
      <div className="h-full min-h-0" data-forgeax-panel={id}>
        <Component />
      </div>
    );
  };
}

const panelComponents = {
  eventBrowser: panelComponent(PANEL_IDS[0], EventBrowser),
  pipelineState: panelComponent(PANEL_IDS[1], PipelineState),
  drawCallViewer: panelComponent(PANEL_IDS[2], DrawCallViewer),
  resourceInspector: panelComponent(PANEL_IDS[3], ResourceInspector),
};

const FORGEAX_DOCKVIEW_THEME: DockviewTheme = {
  name: 'forgeax',
  className: 'dockview-theme-forgeax',
  tabGroupIndicator: 'none',
};

function addDefaultPanels(api: DockviewApi): void {
  api.addPanel({
    id: PANEL_IDS[0],
    component: 'eventBrowser',
    title: 'Event browser',
    renderer: 'always',
  });
  api.addPanel({
    id: PANEL_IDS[2],
    component: 'drawCallViewer',
    title: 'Draw Call Viewer',
    renderer: 'always',
    position: { referencePanel: PANEL_IDS[0], direction: 'right' },
  });
  api.addPanel({
    id: PANEL_IDS[1],
    component: 'pipelineState',
    title: 'Pipeline state',
    renderer: 'always',
    position: { referencePanel: PANEL_IDS[2], direction: 'right' },
  });
  api.addPanel({
    id: PANEL_IDS[3],
    component: 'resourceInspector',
    title: 'Resource Inspector',
    renderer: 'always',
    position: { referencePanel: PANEL_IDS[1], direction: 'within' },
    inactive: true,
  });
}

function hasDockviewShape(topology: unknown): topology is Parameters<DockviewApi['fromJSON']>[0] {
  return Boolean(topology && typeof topology === 'object' && 'grid' in topology);
}

function DockviewWorkspace({
  model,
  tape,
  inspectWork,
  readResource,
  artifactRef,
  capability,
  onRecovery,
  onLayoutActions,
}: DockviewWorkspaceProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const storage =
    typeof window === 'undefined'
      ? null
      : (() => {
          try {
            return window.localStorage;
          } catch {
            return null;
          }
        })();

  useEffect(() => {
    if (model !== null || typeof window === 'undefined') return;
    delete (window as unknown as { __forgeaxRhiDebug?: RhiDebugViewerGlobal }).__forgeaxRhiDebug;
  }, [model]);
  const persistLayout = useCallback(() => {
    const api = apiRef.current;
    if (!api || !storage) return;
    const result = writeWorkspaceLayout(storage, api.toJSON());
    if (!result.ok) onRecovery(result.error);
  }, [onRecovery, storage]);

  const handleReady = useCallback(
    ({ api }: DockviewReadyEvent) => {
      apiRef.current = api;
      let saved: { readonly layout: WorkspaceLayout; readonly recovery: LayoutRecovery | null } = {
        layout: DEFAULT_WORKSPACE_LAYOUT,
        recovery: null,
      };
      if (storage) saved = readWorkspaceLayout(storage);
      onRecovery(saved.recovery);
      api.clear();
      if (hasDockviewShape(saved.layout.topology)) {
        try {
          // `clear()` above removes every panel, so deserialization must create
          // the serialized panel records instead of looking for reusable ones.
          api.fromJSON(saved.layout.topology, { reuseExistingPanels: false });
        } catch (error) {
          onRecovery({
            code: 'layout-corrupt',
            detail: error instanceof Error ? error.message : 'Saved layout could not be restored.',
          });
          api.clear();
          addDefaultPanels(api);
        }
      } else {
        addDefaultPanels(api);
      }
      api.onDidLayoutChange(() => persistLayout());
      persistLayout();
    },
    [onRecovery, persistLayout, storage],
  );

  const reset = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    api.clear();
    addDefaultPanels(api);
    if (storage) {
      try {
        resetWorkspaceLayout(storage);
      } catch (error) {
        onRecovery({
          code: 'layout-storage-failed',
          detail: error instanceof Error ? error.message : 'Layout storage is unavailable.',
        });
        return;
      }
    }
    onRecovery(null);
    persistLayout();
  }, [onRecovery, persistLayout, storage]);

  const runLayoutAction = useCallback(
    (action: (api: DockviewApi) => void) => {
      const api = apiRef.current;
      if (!api) return;
      try {
        action(api);
        persistLayout();
      } catch (error) {
        onRecovery({
          code: 'layout-corrupt',
          detail: error instanceof Error ? error.message : 'Dockview layout action failed.',
        });
      }
    },
    [onRecovery, persistLayout],
  );

  const floatResource = useCallback(() => {
    runLayoutAction((api) => {
      const panel = api.getPanel(PANEL_IDS[3]);
      if (!panel) return;
      const bounds = dockRef.current?.getBoundingClientRect();
      if (!bounds) return;
      if (bounds.width <= FLOATING_PANEL_MARGIN * 2 || bounds.height <= FLOATING_PANEL_MARGIN * 2)
        return;
      const width = Math.min(FLOATING_PANEL_WIDTH, bounds.width - FLOATING_PANEL_MARGIN * 2);
      const height = Math.min(FLOATING_PANEL_HEIGHT, bounds.height - FLOATING_PANEL_MARGIN * 2);
      api.addFloatingGroup(panel, {
        x: Math.max(FLOATING_PANEL_MARGIN, bounds.width - width - FLOATING_PANEL_MARGIN),
        y: FLOATING_PANEL_MARGIN,
        width,
        height,
      });
    });
  }, [runLayoutAction]);

  const splitResource = useCallback(() => {
    runLayoutAction((api) => {
      const panel = api.getPanel(PANEL_IDS[3]);
      const reference = api.getPanel(PANEL_IDS[1]);
      if (!panel || !reference) return;
      panel.api.moveTo({ group: reference.group, position: 'right' });
    });
  }, [runLayoutAction]);

  const stackResource = useCallback(() => {
    runLayoutAction((api) => {
      const panel = api.getPanel(PANEL_IDS[1]);
      const target = api.getPanel(PANEL_IDS[3]);
      if (!panel || !target) return;
      panel.api.moveTo({ group: target.group, position: 'center' });
    });
  }, [runLayoutAction]);

  const openPanel = useCallback((panelId: (typeof PANEL_IDS)[number]) => {
    apiRef.current?.getPanel(panelId)?.api.setActive();
  }, []);

  useEffect(() => {
    onLayoutActions({
      floatResource,
      splitResource,
      stackPipeline: stackResource,
      reset,
    });
    return () => onLayoutActions(null);
  }, [floatResource, onLayoutActions, reset, splitResource, stackResource]);

  return (
    <div
      className="forgeax-workspace flex h-full min-h-0 flex-col"
      data-forgeax-workspace="dockview"
      data-forgeax-layout-key={LAYOUT_STORAGE_KEY}
    >
      <ViewModelContext.Provider value={model}>
        {model && tape ? (
          <ViewerContext.Provider value={{ model, tape, inspectWork, readResource, capability }}>
            <PanelNavigationProvider openPanel={openPanel}>
              <SelectionProvider>
                <ViewerGlobalBridge
                  model={model}
                  inspectWork={inspectWork}
                  readResource={readResource}
                  artifactRef={artifactRef}
                  capability={capability}
                />
                <div ref={dockRef} className="forgeax-dockview min-h-0 flex-1">
                  <DockviewReact
                    theme={FORGEAX_DOCKVIEW_THEME}
                    components={panelComponents}
                    onReady={handleReady}
                  />
                </div>
              </SelectionProvider>
            </PanelNavigationProvider>
          </ViewerContext.Provider>
        ) : (
          <PanelNavigationProvider openPanel={openPanel}>
            <SelectionProvider>
              <div ref={dockRef} className="forgeax-dockview min-h-0 flex-1">
                <DockviewReact
                  theme={FORGEAX_DOCKVIEW_THEME}
                  components={panelComponents}
                  onReady={handleReady}
                />
              </div>
            </SelectionProvider>
          </PanelNavigationProvider>
        )}
      </ViewModelContext.Provider>
    </div>
  );
}

type AppState =
  | { readonly status: 'empty' }
  | {
      readonly status: 'loading';
      readonly fileName: string;
      readonly source: 'drop' | 'picker';
    }
  | {
      readonly status: 'loaded';
      readonly model: ViewerModel;
      readonly tape: V7Tape;
      readonly artifactRef: ViewerArtifactRef;
      readonly replay: ViewerReplay;
    }
  | { readonly status: 'parse-error'; readonly error: TapeLoadError };

export function App() {
  const [state, setState] = useState<AppState>({ status: 'empty' });
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const generationRef = useRef(0);
  const replayRef = useRef<ViewerReplay | null>(null);
  const [layoutRecovery, setLayoutRecovery] = useState<LayoutRecovery | null>(null);
  const [layoutActions, setLayoutActions] = useState<LayoutActions | null>(null);

  const replaceReplay = useCallback((replay: ViewerReplay | null) => {
    const previous = replayRef.current;
    replayRef.current = replay;
    if (previous !== null) void previous.dispose();
  }, []);

  const loadFiles = useCallback(
    async (files: File[], source: 'drop' | 'picker') => {
      const generation = ++generationRef.current;
      setState({
        status: 'loading',
        fileName:
          files.length === 1 && files[0] !== undefined ? files[0].name : `${files.length} files`,
        source,
      });
      const result = await loadTapeFromFiles(files);
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        replaceReplay(null);
        setState({ status: 'parse-error', error: result.error });
        return;
      }
      const replay = await openViewerReplay(result.value.tape);
      if (generation !== generationRef.current) {
        await replay.dispose();
        return;
      }
      replaceReplay(replay);
      setState({
        status: 'loaded',
        tape: result.value.tape,
        model: buildViewerModel(result.value.tape),
        artifactRef: result.value.artifactRef,
        replay,
      });
    },
    [replaceReplay],
  );

  useEffect(() => {
    const tapeUrl = new URLSearchParams(window.location.search).get('tapeUrl');
    if (!tapeUrl) return;
    const generation = ++generationRef.current;
    void (async () => {
      const result = await loadTapeFromUrl(tapeUrl);
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        replaceReplay(null);
        setState({ status: 'parse-error', error: result.error });
        return;
      }
      const replay = await openViewerReplay(result.value.tape);
      if (generation !== generationRef.current) {
        await replay.dispose();
        return;
      }
      replaceReplay(replay);
      setState({
        status: 'loaded',
        tape: result.value.tape,
        model: buildViewerModel(result.value.tape),
        artifactRef: result.value.artifactRef,
        replay,
      });
    })();
    return () => {
      if (generationRef.current === generation) generationRef.current++;
    };
  }, [replaceReplay]);

  useEffect(
    () => () => {
      replaceReplay(null);
    },
    [replaceReplay],
  );

  useEffect(() => {
    const containsFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const handleDragEnter = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current++;
      setIsDragOver(true);
    };
    const handleDragOver = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
    };
    const handleDragLeave = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0 || event.relatedTarget === null) setIsDragOver(false);
    };
    const handleDrop = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      void loadFiles(Array.from(event.dataTransfer?.files ?? []), 'drop');
    };
    window.addEventListener('dragenter', handleDragEnter, true);
    window.addEventListener('dragover', handleDragOver, true);
    window.addEventListener('dragleave', handleDragLeave, true);
    window.addEventListener('drop', handleDrop, true);
    return () => {
      window.removeEventListener('dragenter', handleDragEnter, true);
      window.removeEventListener('dragover', handleDragOver, true);
      window.removeEventListener('dragleave', handleDragLeave, true);
      window.removeEventListener('drop', handleDrop, true);
    };
  }, [loadFiles]);

  const loaded = state.status === 'loaded';

  return (
    <section
      className="rhi-viewer h-screen min-h-0 flex flex-col bg-background text-foreground"
      aria-label="RHI tape drop area"
      {...{ [loadStatusAnchor()]: state.status }}
    >
      <div className="forgeax-appbar" role="toolbar" aria-label="Tape actions">
        <div className="flex items-center gap-fx-8">
          <LayoutMenu actions={layoutActions} />
          <Button
            leadingIcon={<FileUp className="fx-icon" />}
            onClick={() => fileInputRef.current?.click()}
          >
            Import tape
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".rhitape"
            className="hidden"
            aria-label="Select one v7 RHI tape"
            onChange={(event) => {
              void loadFiles(Array.from(event.target.files ?? []), 'picker');
              event.target.value = '';
            }}
          />
        </div>
      </div>
      {state.status === 'parse-error' && (
        <div
          className="forgeax-notice forgeax-notice-error"
          {...{ [loadStatusAnchor()]: 'parse-error' }}
        >
          <strong>{state.error.code}</strong>: {state.error.hint}
        </div>
      )}
      {state.status === 'loading' && (
        <div className="forgeax-notice" {...{ [loadStatusAnchor()]: 'loading' }}>
          Loading {state.fileName} from {state.source === 'drop' ? 'drop' : 'file picker'}…
        </div>
      )}
      {layoutRecovery && (
        <div
          className="forgeax-notice forgeax-notice-warning"
          data-forgeax-layout-recovery={layoutRecovery.code}
        >
          Layout reset: {layoutRecovery.code} — {layoutRecovery.detail}
        </div>
      )}
      <main
        className="flex-1 min-h-0"
        {...{ [loadStatusAnchor()]: loaded ? 'loaded' : state.status }}
      >
        <DockviewWorkspace
          model={state.status === 'loaded' ? state.model : null}
          tape={state.status === 'loaded' ? state.tape : null}
          inspectWork={state.status === 'loaded' ? state.replay.inspectWork : defaultInspectWork}
          readResource={state.status === 'loaded' ? state.replay.readResource : defaultReadResource}
          artifactRef={state.status === 'loaded' ? state.artifactRef : null}
          capability={state.status === 'loaded' ? state.replay.capability : viewerShellCapability()}
          onRecovery={setLayoutRecovery}
          onLayoutActions={setLayoutActions}
        />
      </main>
      {isDragOver && (
        <div className="forgeax-drop-overlay" data-forgeax-drop-overlay="ready">
          <div className="border border-border bg-card px-fx-24 py-fx-16 text-center">
            <FileUp className="mx-auto mb-fx-12 h-[var(--fx-component-control-height-compact)] w-[var(--fx-component-control-height-compact)] text-muted-foreground" />
            <strong>Drop one .rhitape file</strong>
            <p className="mt-fx-4 text-caption text-muted-foreground">
              It will replace the current tape.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
