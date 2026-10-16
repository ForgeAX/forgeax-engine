import { ImportError } from '@forgeax/engine-types';
import type { UiAsset, UiError } from '@forgeax/engine-ui';
import { type UiAuthoringResult, validateUiAuthoring } from '@forgeax/engine-ui/authoring';
import {
  captureUiPreview,
  createDomPartScenario,
  createUiPreviewSession,
  type UiPreviewAssetChanged,
  type UiPreviewAssetSource,
  type UiPreviewCaptureAdapter,
  type UiPreviewScenario,
  type UiPreviewSession,
} from '@forgeax/engine-ui/preview';

export const PREVIEW_UI_GUID = 'ui-preview-default';
export const PREVIEW_UI_SOURCE_GUID = '019f8354-6386-4386-849d-f2ab4b96229d';

const defaultAsset: UiAsset = {
  guid: PREVIEW_UI_GUID,
  html: '<section data-ui-part="root" aria-label="Preview HUD"><strong data-ui-part="score">Score 0</strong><span data-ui-part="stress-meter">Ready</span></section>',
  css: ':host { display: block; color: white; font: 16px sans-serif; } section { padding: 12px; }',
};

export interface UiAuthoringCatalogEntry {
  readonly guid: string;
  readonly kind: 'ui';
  readonly sourcePath?: string;
}

export interface UiAuthoringAssetGateway {
  readonly preferredGuid?: string;
  readonly listCatalog: () => readonly UiAuthoringCatalogEntry[];
  readonly loadByGuid: (guid: string) => Promise<UiPreviewAssetSourceLoadResult>;
  readonly invalidate: (guid: string) => void;
  readonly replace: (asset: UiAsset) => Promise<UiPreviewAssetSourceLoadResult>;
  readonly subscribe: (listener: (change: UiPreviewAssetChanged) => void) => () => void;
}

export type UiPreviewAssetSourceLoadResult = Awaited<
  ReturnType<UiPreviewAssetSource['loadByGuid']>
>;

export interface UiAuthoringHostHandle {
  readonly guid: string;
  readonly root: HTMLElement;
  readonly bind: (gateway: UiAuthoringAssetGateway) => void;
  readonly discover: () => readonly UiAuthoringCatalogEntry[];
  readonly validate: (source?: {
    readonly html: string;
    readonly css: string;
  }) => Promise<UiAuthoringResult>;
  readonly open: (scenario?: 'default' | 'extreme') => ReturnType<UiPreviewSession['open']>;
  readonly capture: (adapter: UiPreviewCaptureAdapter) => Promise<UiPreviewCaptureResult>;
  readonly getCaptureTarget: () => HTMLElement | null;
  readonly getLastAction: () => string | undefined;
  readonly getLastRefreshError: () => UiError | undefined;
  readonly repair: (source: {
    readonly html: string;
    readonly css: string;
  }) => Promise<UiAuthoringResult>;
  readonly dispose: () => void;
  readonly getSession: () => UiPreviewSession | null;
}

export type UiPreviewCaptureResult = Awaited<ReturnType<typeof captureUiPreview>>;

interface SourceOverride {
  readonly asset?: UiAsset;
  readonly error?: ImportError;
}

function invalidAssetError(guid: string): UiPreviewAssetSourceLoadResult {
  return {
    ok: false,
    error: {
      code: 'invalid-asset',
      expected: 'a registered preview UI asset',
      hint: 'Discover a valid UI GUID before opening preview.',
      detail: { message: `Unknown UI GUID: ${guid}`, asset: guid },
    },
  };
}

function createFallbackGateway(): UiAuthoringAssetGateway {
  let asset = defaultAsset;
  return {
    preferredGuid: PREVIEW_UI_GUID,
    listCatalog: () => [
      { guid: PREVIEW_UI_GUID, kind: 'ui', sourcePath: 'ui-preview-default.ui.html' },
    ],
    loadByGuid: async (guid) =>
      guid === asset.guid ? { ok: true, value: asset } : invalidAssetError(guid),
    invalidate: () => {},
    replace: async (next) => {
      asset = next;
      return { ok: true, value: asset };
    },
    subscribe: () => () => {},
  };
}

function preferredGuidFor(gateway: UiAuthoringAssetGateway): string {
  const entries = gateway.listCatalog();
  if (gateway.preferredGuid !== undefined) {
    const preferred = entries.find(
      (entry) => entry.guid.toLowerCase() === gateway.preferredGuid?.toLowerCase(),
    );
    if (preferred !== undefined) return preferred.guid;
  }
  return entries[0]?.guid ?? PREVIEW_UI_GUID;
}

function toImportError(error: UiError | ImportError): ImportError {
  if (error instanceof ImportError) return error;
  return new ImportError({
    code: 'import-internal-error',
    expected: 'the preview UI asset to load through the catalog',
    hint: 'Inspect the asset loading error and retry after repairing the catalog entry.',
    detail: { reason: error.detail.message },
  });
}

export function createUiAuthoringHost(
  parent: HTMLElement,
  initialGateway?: UiAuthoringAssetGateway,
): UiAuthoringHostHandle {
  const root = document.createElement('div');
  root.dataset.uiAuthoringRoot = 'true';
  root.style.position = 'absolute';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  parent.append(root);

  let gateway = initialGateway ?? createFallbackGateway();
  let selectedGuid = preferredGuidFor(gateway);
  // Keep the selected source identity while an authoring override is active.
  // A session rebuild invalidates the registry entry before retrying the
  // edited asset, so the registry may temporarily omit the row even though
  // the authoring session still owns that source. Do not let that cache
  // lifecycle turn a valid selected source into an unselectable one.
  let selectedCatalogEntry = gateway
    .listCatalog()
    .find((entry) => entry.guid.toLowerCase() === selectedGuid.toLowerCase());
  let sourceOverride: SourceOverride | undefined;
  let session: UiPreviewSession | null = null;
  let lastAction: string | undefined;
  let lastRefreshError: UiError | undefined;
  let revision = 0;
  const subscribeToGateway = (): (() => void) =>
    gateway.subscribe((change) => {
      if (!change.guids.some((guid) => guid.toLowerCase() === selectedGuid.toLowerCase())) return;
      sourceOverride = undefined;
      const activeSession = session;
      if (!activeSession) return;
      void activeSession.handleAssetChanged(change).then((result) => {
        lastRefreshError = result.ok ? undefined : result.error;
      });
    });
  let stopGatewaySubscription = subscribeToGateway();

  const discover = (): readonly UiAuthoringCatalogEntry[] => {
    const entries = gateway.listCatalog();
    const currentSelected = entries.find(
      (entry) => entry.guid.toLowerCase() === selectedGuid.toLowerCase(),
    );
    if (currentSelected !== undefined) selectedCatalogEntry = currentSelected;
    if (
      sourceOverride === undefined ||
      selectedCatalogEntry === undefined ||
      currentSelected !== undefined
    ) {
      return entries;
    }
    return [...entries, selectedCatalogEntry];
  };

  const sourcePath = (): string =>
    gateway.listCatalog().find((entry) => entry.guid.toLowerCase() === selectedGuid.toLowerCase())
      ?.sourcePath ?? `${selectedGuid}.ui.html`;

  const source: UiPreviewAssetSource = {
    invalidate: (guid) => gateway.invalidate(guid),
    loadByGuid: async (guid) => {
      if (guid.toLowerCase() === selectedGuid.toLowerCase() && sourceOverride !== undefined) {
        if (sourceOverride.error !== undefined) return { ok: false, error: sourceOverride.error };
        if (sourceOverride.asset !== undefined) return { ok: true, value: sourceOverride.asset };
      }
      return gateway.loadByGuid(guid);
    },
  };

  const scenarioFor = (name: 'default' | 'extreme' = 'default'): UiPreviewScenario =>
    createDomPartScenario({
      requiredParts: name === 'extreme' ? ['root', 'score', 'stress-meter'] : ['root', 'score'],
    });

  const validate = async (input?: Pick<UiAsset, 'html' | 'css'>): Promise<UiAuthoringResult> => {
    let candidate = input;
    if (candidate === undefined) {
      if (sourceOverride?.asset !== undefined) candidate = sourceOverride.asset;
      else {
        const loaded = await source.loadByGuid(selectedGuid);
        if (!loaded.ok) return { ok: false, error: toImportError(loaded.error) };
        candidate = loaded.value;
      }
    }
    return validateUiAuthoring({
      sourcePath: sourcePath(),
      html: candidate.html,
      css: candidate.css,
    });
  };

  const refresh = async (): Promise<void> => {
    if (session === null || session.state === 'disposed') return;
    const result = await session.handleAssetChanged({
      guids: [selectedGuid],
      sourcePath: sourcePath(),
      revision: ++revision,
    });
    lastRefreshError = result.ok ? undefined : result.error;
  };

  const handle: UiAuthoringHostHandle = {
    get guid() {
      return selectedGuid;
    },
    root,
    bind(nextGateway) {
      session?.dispose();
      session = null;
      stopGatewaySubscription();
      gateway = nextGateway;
      selectedGuid = preferredGuidFor(gateway);
      selectedCatalogEntry = gateway
        .listCatalog()
        .find((entry) => entry.guid.toLowerCase() === selectedGuid.toLowerCase());
      sourceOverride = undefined;
      lastRefreshError = undefined;
      stopGatewaySubscription = subscribeToGateway();
    },
    discover,
    validate,
    async repair(nextSource) {
      const checked = await validate(nextSource);
      if (!checked.ok) {
        sourceOverride = { error: checked.error };
        await refresh();
        return checked;
      }
      const replacement = await gateway.replace({
        guid: selectedGuid,
        html: nextSource.html,
        css: nextSource.css,
      });
      if (!replacement.ok) return { ok: false, error: toImportError(replacement.error) };
      sourceOverride = { asset: replacement.value };
      return checked;
    },
    async open(name = 'default') {
      session?.dispose();
      lastRefreshError = undefined;
      session = createUiPreviewSession({
        guid: selectedGuid,
        assets: source,
        root,
        rect: { width: 320, height: 180 },
        onAction: (action) => {
          lastAction = action;
        },
        scenario: scenarioFor(name),
      });
      return session.open();
    },
    async capture(adapter) {
      if (!session) {
        return {
          ok: false,
          error: {
            code: 'capture-not-ready',
            expected: 'an opened preview session',
            hint: 'Call open() before capture().',
            detail: { message: 'No preview session is open.', unmet: ['session'] },
          },
        };
      }
      return captureUiPreview(session, adapter);
    },
    getCaptureTarget: () => {
      const target = session?.state === 'mounted' ? session.instance?.host : null;
      return target?.isConnected ? target : null;
    },
    getLastAction: () => lastAction,
    getLastRefreshError: () => lastRefreshError,
    getSession: () => session,
    dispose() {
      stopGatewaySubscription();
      session?.dispose();
      session = null;
      root.replaceChildren();
      root.remove();
    },
  };
  return handle;
}
