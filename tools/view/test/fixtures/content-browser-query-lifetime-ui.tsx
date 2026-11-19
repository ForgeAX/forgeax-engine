import { Profiler, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '@forgeax/view-components/styles.css';
import '../../packages/view-plugin-content-browser/src/ui/content-browser.css';
import { ContentBrowserPanel } from '../../packages/view-plugin-content-browser/src/ui/ContentBrowserPanel';
import { setLocale } from '../../packages/view-plugin-content-browser/src/i18n/index';
import { CONTENT_BROWSER_ACTIONS } from '../../packages/view-plugin-content-browser/src/schema';
import { createViewWorkspaceClient, type WorkspaceTransport } from '../../packages/view-workspace-core/src/client';
import { createWorkspaceStateReader } from '../../packages/view-workspace-core/src/workspace-state';
import { subscribeWorkspaceCommandErrors } from '../../packages/view-workspace-core/src/command-error';
import { ViewWorkspaceError, VIEW_WORKSPACE_SERVICES, VIEW_WORKSPACE_STATE_TOPIC, VIEW_PACK_SOURCES_SERVICE, VIEW_HTML_FILES_SERVICE, VIEW_PACK_REVEAL_TOPIC, VIEW_PACK_REVEAL_ACK_SERVICE, VIEW_FILE_GET_SERVICE,
  type WorkspaceState, type WorkspaceRequest } from '../../packages/view-workspace-core/src/contract';

setLocale('en');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ticks = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const deferred = () => {
  let accept!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  return { promise, accept, reject };
};
type Lease = ReturnType<typeof deferred> & { projectId: string; signal?: AbortSignal; transportSignal?: AbortSignal; started?: boolean; held: boolean };
type Case = { name: string; checks: Record<string, boolean>; [key: string]: unknown };
const state = (id = 'project-A', revision = 1): WorkspaceState => ({ revision,
  project: { id, root: `/fixture/${id}`, name: id, assetRoots: ['assets'] },
  projectTarget: { targetId: `target-${id}`, sessionId: `session-${id}`, worldId: `world-${id}` },
  projectPhase: 'running', browserGeneration: 1, catalogEpoch: 1, assets: [],
  preview: null, scenePreview: null, previews: [], play: null, sceneSelection: null, openRequest: null, resourceOpens: {} });

function harness(initial = state(), trackReader = true) {
  let owner = initial, hold = false, holdSources = false, publishEpoch = false;
  const subscriptions = new Set<{ topic: string; listener: (value: unknown) => unknown }>();
  const leases: Lease[] = [], reports: { code: string; operation?: string; signalAborted?: boolean }[] = [];
  const signals: { lease: Lease; service: string; signal?: AbortSignal }[] = [];
  const commands: string[] = [], acknowledgments: unknown[] = [];
  let inventory: (ReturnType<typeof deferred> & { signal?: AbortSignal; started?: boolean }) | undefined;
  const heldCalls = new Map<string, ReturnType<typeof deferred> & { signal?: AbortSignal; started?: boolean }>();
  const bootstrapSignals: (AbortSignal | undefined)[] = [];
  const publish = (next: WorkspaceState) => {
    owner = next;
    for (const entry of [...subscriptions]) if (entry.topic === VIEW_WORKSPACE_STATE_TOPIC) entry.listener(next);
  };
  const transport = {
    connected: true,
    subscribe(topic: string, listener: (value: unknown) => unknown) { const entry = { topic, listener }; subscriptions.add(entry); return () => subscriptions.delete(entry); },
    onDisconnect() { return () => {}; },
    request(service: string, request: WorkspaceRequest | { projectId?: string }, options: { signal?: AbortSignal } = {}) {
      if (service === VIEW_WORKSPACE_SERVICES.call) {
        const call = request as WorkspaceRequest;
        const held = heldCalls.get(call.operation);
        if (held && !held.started) { held.started = true; held.signal = options.signal; return held.promise; }
        if (call.operation === 'tabs.get') return Promise.resolve(owner);
        if (call.operation === 'project.close') {
          publish({ ...owner, revision: (owner.revision ?? 0) + 1, project: null, projectTarget: null, projectPhase: undefined,
            assets: [], preview: null, scenePreview: null, previews: [], play: null, sceneSelection: null, openRequest: null, resourceOpens: {} });
          return Promise.resolve(owner);
        }
        if (call.operation === 'tabs.select') { commands.push('tabs.select'); return Promise.resolve(owner); }
        if (call.operation === 'asset.inspect') return Promise.resolve({ inspection: { guid: call.args.guid, asset: { guid: call.args.guid, kind: 'mesh' } } });
        if (call.operation === 'assets.thumbnails') return Promise.resolve({ thumbnails: (call.args.guids as string[]).map(guid => ({ guid, state: 'unsupported' })) });
        if (call.operation === 'assets.list') {
          const lease = leases.find(entry => !entry.started && entry.projectId === call.args.projectId)!;
          lease.started = true; lease.transportSignal = options.signal;
          signals.push({ lease, service: 'assets.list', signal: options.signal });
          if (lease.held) return lease.promise;
          if (publishEpoch) publish({ ...owner, revision: (owner.revision ?? 0) + 1, catalogEpoch: (owner.catalogEpoch ?? 0) + 1, assets: [] });
          return Promise.resolve({ assets: [] });
        }
        throw new Error(`Unexpected fixture operation ${call.operation}`);
      }
      const held = heldCalls.get(service);
      if (held && !held.started) { held.started = true; held.signal = options.signal; return held.promise; }
      if (service === VIEW_FILE_GET_SERVICE) return Promise.resolve({ path: 'assets/Cached-A.pack.ts', kind: 'text',
        mime: 'text/plain', size: 10_000_000, mtime: 1,
        content: owner.project?.root === initial.project?.root ? 'FILE-A-CACHED' : 'FILE-B-CURRENT' });
      if (service === VIEW_PACK_SOURCES_SERVICE) {
        if (inventory && !inventory.started) { inventory.started = true; inventory.signal = options.signal; return inventory.promise; }
        signals.push({ lease: leases.at(-1)!, service: 'pack.sources', signal: options.signal });
        return holdSources ? new Promise(() => {})
          : Promise.resolve({ sources: [{ sourcePath: leases.at(-1)?.held ? 'assets/Retired-query.pack.ts' : 'assets/Cached-A.pack.ts' }] });
      }
      if (service === VIEW_PACK_REVEAL_ACK_SERVICE) { acknowledgments.push(request); return Promise.resolve({ accepted: true }); }
      if (service === VIEW_HTML_FILES_SERVICE) {
        signals.push({ lease: leases.at(-1)!, service: 'html.files', signal: options.signal });
        return holdSources ? new Promise(() => {}) : Promise.resolve({
          files: [leases.at(-1)?.held ? 'assets/Retired-query.html' : 'assets/Cached-A.html'], hasMore: false });
      }
      throw new Error(`Unexpected fixture service ${service}`);
    },
  };
  const client = createViewWorkspaceClient({ clientId: 'catalog-lifetime-fixture', transport: transport as unknown as WorkspaceTransport });
  const list = client.listAssets.bind(client);
  client.listAssets = (projectId, options = {}) => {
    leases.push({ ...deferred(), projectId, signal: options.signal, held: hold });
    return list(projectId, options);
  };
  const getState = client.getState.bind(client);
  client.getState = (options = {}) => { bootstrapSignals.push(options.signal); return getState(options); };
  const reader = createWorkspaceStateReader(client);
  const stop = trackReader ? reader.subscribe(() => {}) : () => {};
  const stopErrors = subscribeWorkspaceCommandErrors((error, context) => reports.push({
    code: (error as { code: string }).code, operation: context.operation, signalAborted: context.signal?.aborted }));
  return { client, reader, leases, reports, signals, commands, acknowledgments, bootstrapSignals, publish,
    holdCall(operation: string) { const held = deferred(); heldCalls.set(operation, held); return heldCalls.get(operation)!; },
    holdInventory() { inventory = deferred(); return inventory; },
    emit(intent: unknown) { return Promise.all([...subscriptions].filter(entry => entry.topic === VIEW_PACK_REVEAL_TOPIC).map(entry => entry.listener(intent))); },
    hold(value = true, sources = false) { hold = value; holdSources = sources; },
    epoch() { publishEpoch = true; },
    dispose() { stopErrors(); stop(); reader.dispose(); } };
}

const failure = () => new ViewWorkspaceError('view-workspace-project-mismatch', 'The current project', 'The same fixture error must remain visible on a current scope');

async function runRead(mode: 'auto' | 'manual', outcome: 'failure' | 'success', close: boolean): Promise<Case> {
  const h = harness();
  const host = document.getElementById('app')!;
  const root = createRoot(host);
  let phase = 'mount', retiredVisible = false;
  if (mode === 'auto') h.hold();
  const draw = () => root.render(createElement(Profiler, { id: 'catalog', onRender() {
    if (phase === 'retired' && /Retired-query\.(?:pack\.ts|html)/.test(host.textContent ?? '')) retiredVisible = true;
  } }, createElement(ContentBrowserPanel, { client: h.client })));
  try {
    await act(async () => { draw(); await ticks(); });
    if (mode === 'manual') {
      h.hold();
      await act(async () => {
        const button = host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.refresh}"]`);
        if (!button || button.disabled) throw new Error('Actual Refresh control is unavailable');
        button.click(); await ticks();
      });
    }
    const lease = h.leases.at(-1)!;
    let abortedAtPublication = false, allDirectoryQueriesCancelled = false;
    await act(async () => {
      if (close) {
        await h.client.closeProject('project-A');
        if (outcome === 'success') { h.hold(true, true); h.publish(state('project-B', 3)); }
        phase = 'retired';
      }
      abortedAtPublication = lease.signal?.aborted === true;
      const group = h.signals.filter(entry => entry.lease === lease);
      allDirectoryQueriesCancelled = group.length === 3 && group.every(entry => entry.signal?.aborted === true);
      if (outcome === 'failure') lease.reject(failure()); else lease.accept({ assets: [] });
      await ticks();
    });
    const closedSpinner = close && outcome === 'failure' && host.textContent?.includes('Loading assets...');
    return { name: `${mode}-${close ? 'retired' : 'current'}-${outcome}`, checks: close ? {
      hasLease: Boolean(lease.signal), abortedAtPublication, allDirectoryQueriesCancelled,
      retiredFailureNotReported: outcome !== 'failure' || h.reports.length === 0,
      retiredSuccessNotVisible: outcome !== 'success' || !retiredVisible,
      noClosedSpinner: !closedSpinner,
    } : { currentFailureReported: h.reports.some(entry => entry.operation === 'assets.list' && entry.code === 'view-workspace-project-mismatch') },
    reports: h.reports, retiredVisible, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

async function runCached(change: (value: WorkspaceState) => WorkspaceState, name: string): Promise<Case> {
  const initial = state(), h = harness(initial);
  const host = document.getElementById('app')!, root = createRoot(host);
  let replaced = false, cachedVisible = false, htmlVisible = false;
  try {
    await act(async () => { root.render(createElement(Profiler, { id: 'cached', onRender() {
      if (replaced && host.textContent?.includes('Cached-A.pack.ts')) cachedVisible = true;
      if (replaced && host.textContent?.includes('Cached-A.html')) htmlVisible = true;
    } }, createElement(ContentBrowserPanel, { client: h.client }))); await ticks(); });
    if (!host.textContent?.includes('Cached-A.pack.ts')) throw new Error('The old scope must first load real source facts');
    h.hold();
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.refresh}"]`)!.click(); await ticks();
    });
    const old = h.leases.at(-1)!;
    let abortedAtPublication = false;
    await act(async () => {
      h.hold(true, true); replaced = true; h.publish(change({ ...initial, revision: 2 }));
      abortedAtPublication = old.signal?.aborted === true;
      old.reject(failure()); await ticks();
    });
    return { name: `cached-${name}`, checks: { abortedAtPublication, noPriorCachedFacts: !cachedVisible, noPriorHtmlFacts: !htmlVisible,
      freshQueryStarted: h.leases.length === 3, retiredFailureNotReported: h.reports.length === 0 },
    cachedVisible, htmlVisible, reports: h.reports, reads: h.leases.length, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

async function runClientReplacement(): Promise<Case> {
  const a = harness(), b = harness();
  b.hold(true, true);
  const host = document.getElementById('app')!, root = createRoot(host);
  let replaced = false, cachedVisible = false, htmlVisible = false;
  const draw = (client: typeof a.client) => root.render(createElement(Profiler, { id: 'client', onRender() {
    if (replaced && host.textContent?.includes('Cached-A.pack.ts')) cachedVisible = true;
    if (replaced && host.textContent?.includes('Cached-A.html')) htmlVisible = true;
  } }, createElement(ContentBrowserPanel, { client })));
  try {
    await act(async () => { draw(a.client); await ticks(); });
    a.hold();
    await act(async () => { host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.refresh}"]`)!.click(); await ticks(); });
    const lease = a.leases.at(-1)!;
    await act(async () => { replaced = true; draw(b.client); await ticks(); });
    const abortedAtReplacement = lease.signal?.aborted === true;
    await act(async () => { lease.reject(failure()); await ticks(); });
    return { name: 'client-replacement-same-public-identity', checks: { abortedAtReplacement, noPriorCachedFacts: !cachedVisible,
      noPriorHtmlFacts: !htmlVisible, retiredFailureNotReported: a.reports.length === 0 && b.reports.length === 0 },
    cachedVisible, htmlVisible, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); a.dispose(); b.dispose(); }
}

async function runUnmount(mode: 'auto' | 'manual'): Promise<Case> {
  const h = harness(), host = document.getElementById('app')!, root = createRoot(host);
  if (mode === 'auto') h.hold();
  let mounted = true;
  try {
    await act(async () => { root.render(createElement(ContentBrowserPanel, { client: h.client })); await ticks(); });
    if (mode === 'manual') {
      h.hold(); await act(async () => { host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.refresh}"]`)!.click(); await ticks(); });
    }
    const lease = h.leases.at(-1)!;
    await act(async () => { root.unmount(); mounted = false; });
    const abortedOnUnmount = lease.signal?.aborted === true;
    await act(async () => { lease.reject(failure()); await ticks(); });
    return { name: `unmount-${mode}`, checks: { abortedOnUnmount, retiredFailureNotReported: h.reports.length === 0 }, reports: h.reports, domainSurfaces: 0 };
  } finally { if (mounted) await act(async () => root.unmount()); h.dispose(); }
}

async function runEpoch(): Promise<Case> {
  const h = harness(), host = document.getElementById('app')!, root = createRoot(host);
  h.epoch();
  try {
    await act(async () => { root.render(createElement(ContentBrowserPanel, { client: h.client })); await ticks(); });
    return { name: 'catalog-readback-does-not-retire-own-query', checks: { oneQuery: h.leases.length === 1,
      sourceAccepted: host.textContent?.includes('Cached-A.pack.ts') === true,
      noSpinner: !host.textContent?.includes('Loading assets...'), noErrors: h.reports.length === 0 },
    reads: h.leases.length, reports: h.reports, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

async function runPackReveal(boundary: 'project' | 'close' | 'target' | 'client' | 'current', outcome: 'success' | 'failure'): Promise<Case> {
  const h = harness(), replacement = boundary === 'client' ? harness() : null;
  const host = document.getElementById('app')!, root = createRoot(host);
  const intent = { requestId: 'fixture-reveal', projectId: 'project-A', sourcePath: 'assets/RevealTarget.pack.ts', revision: 'revision-A' };
  let reveals = 0, task: Promise<unknown> | undefined;
  const draw = (client: typeof h.client) => root.render(createElement(ContentBrowserPanel, { client, revealPanel: async () => { reveals++; return true; } }));
  try {
    await act(async () => { draw(h.client); await ticks(); });
    const inventory = h.holdInventory();
    await act(async () => { task = h.emit(intent); await ticks(); });
    if (!inventory.started) throw new Error('Actual Pack reveal must request its inventory');
    let abortedAtRetirement = false;
    if (replacement) await act(async () => { draw(replacement.client); await ticks(); });
    await act(async () => {
      if (boundary === 'close') await h.client.closeProject('project-A');
      if (boundary === 'project') { h.hold(true, true); h.publish(state('project-B', 3)); }
      if (boundary === 'target') h.publish({ ...state('project-A', 3), projectTarget: { ...state().projectTarget!, targetId: 'new-target' } });
      abortedAtRetirement = inventory.signal?.aborted === true;
      if (outcome === 'failure') inventory.reject(failure());
      else inventory.accept({ sources: [{ sourcePath: intent.sourcePath, revision: intent.revision }] });
      await ticks();
    });
    const commandsBeforeCancel = h.commands.length, revealsBeforeCancel = reveals;
    if (boundary === 'current') await act(async () => { await h.emit({ ...intent, cancelled: true }); await ticks(); });
    await task;
    return { name: `pack-reveal-${boundary}-${outcome}`, checks: boundary === 'current'
      ? outcome === 'success' ? { validContinuation: commandsBeforeCancel === 1 && revealsBeforeCancel === 1 }
        : { currentErrorAcknowledged: h.acknowledgments.some(value => String((value as { reason?: string }).reason).startsWith('reveal-error:')), noFailedContinuation: commandsBeforeCancel === 0 && revealsBeforeCancel === 0 }
      : { hasLease: Boolean(inventory.signal), abortedAtRetirement, noRetiredCommands: commandsBeforeCancel === 0, noRetiredReveal: revealsBeforeCancel === 0 },
    commands: h.commands, reveals, acknowledgments: h.acknowledgments, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); replacement?.dispose(); }
}

function assetState() {
  const value = state();
  value.assets = [{ guid: 'asset-A', kind: 'mesh', name: 'Asset A', path: 'assets/asset-A.mesh.json', lifecycle: 'current' }];
  value.preview = { target: { targetId: 'preview-A', generation: 1, sessionId: 'session-A', worldId: 'world-A' } };
  return value;
}

async function runInspection(route: 'selection' | 'reveal', retire: boolean): Promise<Case> {
  const initial = assetState(), h = harness(initial), host = document.getElementById('app')!, root = createRoot(host);
  const held = h.holdCall('asset.inspect');
  let reveal: ((input: { projectId: string; guid: string; targetId: string; targetGeneration: number }) => Promise<boolean>) | undefined;
  let revealTask: Promise<unknown> | undefined;
  try {
    await act(async () => {
      root.render(createElement(ContentBrowserPanel, { client: h.client, revealPanel: async () => true,
        registerAssetReveal: handler => { reveal = handler; return () => { reveal = undefined; }; } }));
      await ticks();
    });
    await act(async () => {
      if (route === 'selection') {
        const card = host.querySelector<HTMLElement>('[data-cb-guid="asset-A"]');
        if (!card) throw new Error('Actual asset card must be rendered');
        card.click();
      } else revealTask = reveal!({ projectId: 'project-A', guid: 'asset-A', targetId: 'preview-A', targetGeneration: 1 });
      await ticks();
    });
    if (!held.started) throw new Error(`Actual ${route} inspection command did not start`);
    let abortedAtPublication = false;
    await act(async () => {
      if (retire) await h.client.closeProject('project-A');
      abortedAtPublication = held.signal?.aborted === true;
      held.reject(failure()); await ticks();
    });
    await revealTask;
    return { name: `inspect-${route}-${retire ? 'retired' : 'current'}`, checks: retire ? {
      hasLease: Boolean(held.signal), abortedAtPublication, noRetiredError: h.reports.length === 0,
    } : { currentFailureReported: h.reports.some(report => report.operation === 'asset.inspect') },
    reports: h.reports, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

async function runFilePreview(preload: boolean): Promise<Case> {
  const initial = state(), h = harness(initial), host = document.getElementById('app')!, root = createRoot(host);
  let held = preload ? undefined : h.holdCall(VIEW_FILE_GET_SERVICE);
  let replaced = false, oldTextVisible = false;
  try {
    await act(async () => {
      root.render(createElement(Profiler, { id: 'file', onRender() {
        if (replaced && host.textContent?.includes('FILE-A-CACHED')) oldTextVisible = true;
      } }, createElement(ContentBrowserPanel, { client: h.client }))); await ticks();
    });
    await act(async () => {
      const file = host.querySelector<HTMLElement>('[data-cb-path="assets/Cached-A.pack.ts"]');
      if (!file) throw new Error('Actual source file must be rendered');
      file.click(); await ticks();
      host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.toggleDetailPanel}"]`)!.click();
      await ticks();
    });
    if (preload && !host.textContent?.includes('FILE-A-CACHED')) throw new Error('File cache must first be visible');
    if (!preload && !held?.started) throw new Error('Actual file read must start');
    if (preload) held = h.holdCall(VIEW_FILE_GET_SERVICE);
    let abortedAtPublication = false;
    await act(async () => {
      replaced = true;
      h.publish({ ...initial, revision: 3, project: { ...initial.project!, root: '/fixture/replaced-root' } });
      abortedAtPublication = preload || held?.signal?.aborted === true;
      if (!preload) held!.accept({ path: 'assets/Cached-A.pack.ts', kind: 'text', mime: 'text/plain', size: 10_000_000, mtime: 1, content: 'FILE-A-CACHED' });
      await ticks();
    });
    return { name: `file-preview-${preload ? 'preloaded-same-path' : 'late-success'}`, checks: { abortedAtPublication, noOldFileText: !oldTextVisible },
      oldTextVisible, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

async function runThumbnails(): Promise<Case> {
  const initial = assetState(), h = harness(initial), host = document.getElementById('app')!, root = createRoot(host);
  const held = h.holdCall('assets.thumbnails');
  try {
    await act(async () => { root.render(createElement(ContentBrowserPanel, { client: h.client })); await ticks(); });
    await act(async () => {
      host.querySelector<HTMLElement>('[data-cb-guid="asset-A"]')!.click(); await ticks();
      host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.toggleDetailPanel}"]`)!.click(); await ticks();
    });
    await act(async () => { await new Promise<void>(done => requestAnimationFrame(() => done())); await ticks(); });
    if (!held.started) throw new Error('Actual visible assets must start their thumbnail read');
    let abortedAtPublication = false;
    await act(async () => {
      h.publish({ ...initial, revision: 3, projectTarget: { ...initial.projectTarget!, worldId: 'world-replaced' } });
      abortedAtPublication = held.signal?.aborted === true;
      held.accept({ thumbnails: [{ guid: 'asset-A', state: 'failed', error: { code: 'old-thumbnail', expected: 'old scope', hint: 'OLD-THUMBNAIL' } }] });
      await ticks();
    });
    return { name: 'thumbnail-retired-world', checks: { hasLease: Boolean(held.signal), abortedAtPublication,
      noOldThumbnail: !host.innerHTML.includes('OLD-THUMBNAIL') }, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

async function runBootstrap(mode: 'unmount' | 'client' | 'project' | 'shared' | 'current'): Promise<Case> {
  const h = harness(state(), false), other = mode === 'client' ? harness(state(), false) : null;
  const host = document.getElementById('app')!, root = createRoot(host);
  const held = h.holdCall('tabs.get');
  const external = mode === 'shared' ? h.client.getState() : undefined;
  let mounted = true;
  try {
    await act(async () => { root.render(createElement(ContentBrowserPanel, { client: h.client })); await ticks(); });
    if (!held.started) throw new Error('Actual reader bootstrap must start');
    const consumer = h.bootstrapSignals.at(-1);
    if (mode === 'client') await act(async () => { root.render(createElement(ContentBrowserPanel, { client: other!.client })); await ticks(); });
    if (mode === 'unmount' || mode === 'shared') await act(async () => { root.unmount(); mounted = false; });
    if (mode === 'project') await act(async () => { await h.client.closeProject('project-A'); await ticks(); });
    const consumerAborted = consumer?.aborted === true, transportAborted = held.signal?.aborted === true;
    await act(async () => {
      if (mode === 'shared' || mode === 'project') held.accept(state()); else held.reject(failure());
      await ticks();
    });
    const sharedResult = external ? await external : null;
    const checks = mode === 'current' ? { currentFailureReported: h.reports.some(report => report.operation === 'tabs.get') }
      : mode === 'project' ? { clientReadSurvivesProjectChange: Boolean(consumer) && !consumerAborted, oldStatusNotApplied: !host.textContent?.includes('Cached-A.pack.ts') }
        : { consumerAborted, noRetiredError: h.reports.length === 0,
          ...(mode === 'shared' ? { sharedTransportNotAborted: !transportAborted, otherReaderStillCompletes: sharedResult?.project?.id === 'project-A' } : {}) };
    return { name: `reader-bootstrap-${mode}`, checks, reports: h.reports, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { if (mounted) await act(async () => root.unmount()); h.dispose(); other?.dispose(); }
}

async function runLocalIntent(mode: 'pack-cancel' | 'pack-new' | 'pack-navigation' | 'inspection-selection' | 'file-navigation'): Promise<Case> {
  const h = harness(mode === 'inspection-selection' ? assetState() : state());
  const host = document.getElementById('app')!, root = createRoot(host);
  const intent = { requestId: 'local-intent', projectId: 'project-A', sourcePath: 'assets/RevealTarget.pack.ts', revision: 'revision-A' };
  let reveals = 0, task: Promise<unknown> | undefined, nextTask: Promise<unknown> | undefined;
  let held: ReturnType<typeof h.holdCall>, next: ReturnType<typeof h.holdInventory> | undefined;
  try {
    await act(async () => { root.render(createElement(ContentBrowserPanel, { client: h.client, revealPanel: async () => { reveals++; return true; } })); await ticks(); });
    await act(async () => {
      if (mode.startsWith('pack-')) { held = h.holdInventory(); task = h.emit(intent); }
      else if (mode === 'inspection-selection') { held = h.holdCall('asset.inspect'); host.querySelector<HTMLElement>('[data-cb-guid="asset-A"]')!.click(); }
      else {
        held = h.holdCall(VIEW_FILE_GET_SERVICE);
        host.querySelector<HTMLElement>('[data-cb-path="assets/Cached-A.pack.ts"]')!.click();
        await ticks();
        host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.toggleDetailPanel}"]`)!.click();
      }
      await ticks();
    });
    if (!held!.started) throw new Error(`Actual local intent ${mode} did not start`);
    let abortedSynchronously = false;
    await act(async () => {
      if (mode === 'pack-cancel') void h.emit({ ...intent, cancelled: true });
      else if (mode === 'pack-new') { next = h.holdInventory(); nextTask = h.emit({ ...intent, requestId: 'next-intent' }); }
      else if (mode === 'inspection-selection') host.querySelector<HTMLElement>('[data-cb-guid="asset-A"]')!.click();
      else {
        const projectNavigation = [...host.querySelectorAll<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.toggleSourceGroup}"]`)]
          .find(button => button.textContent?.includes('project-A'));
        if (!projectNavigation) throw new Error('The actual project navigation header must be present');
        projectNavigation.click();
      }
      abortedSynchronously = held!.signal?.aborted === true;
      if (mode.startsWith('pack-')) held!.accept({ sources: [{ sourcePath: intent.sourcePath, revision: intent.revision }] });
      else if (mode === 'inspection-selection') held!.reject(failure());
      else held!.accept({ path: 'assets/Cached-A.pack.ts', kind: 'text', mime: 'text/plain', size: 10_000_000, mtime: 1, content: 'LATE-LOCAL-FILE' });
      if (next) { void h.emit({ ...intent, requestId: 'next-intent', cancelled: true }); next.reject(failure()); }
      await ticks();
    });
    await task; await nextTask;
    return { name: `local-${mode}`, checks: { abortedSynchronously, noRetiredError: h.reports.length === 0,
      noRetiredReveal: reveals === 0, noRetiredTabCommand: h.commands.length === 0, noOldFile: !host.textContent?.includes('LATE-LOCAL-FILE') },
    reports: h.reports, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

async function runThumbnailCache(): Promise<Case> {
  const initial = assetState(), h = harness(initial), host = document.getElementById('app')!, root = createRoot(host);
  const held = h.holdCall('assets.thumbnails');
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8LpbIAAAAASUVORK5CYII=';
  let replaced = false, oldImageVisible = false;
  try {
    await act(async () => { root.render(createElement(Profiler, { id: 'thumbnail-cache', onRender() {
      if (replaced && [...host.querySelectorAll('img')].some(element => element.getAttribute('src') === image)) oldImageVisible = true;
    } }, createElement(ContentBrowserPanel, { client: h.client }))); await ticks(); });
    await act(async () => {
      host.querySelector<HTMLElement>('[data-cb-guid="asset-A"]')!.click(); await ticks();
      host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.toggleDetailPanel}"]`)!.click(); await ticks();
    });
    await act(async () => { await new Promise<void>(done => requestAnimationFrame(() => done())); await ticks(); });
    if (!held.started) throw new Error('Thumbnail cache must first request its image');
    await act(async () => { held.accept({ thumbnails: [{ guid: 'asset-A', state: 'ready', dataUrl: image }] }); await ticks(); });
    if (![...host.querySelectorAll('img')].some(element => element.getAttribute('src') === image)) throw new Error('Thumbnail cache must first be rendered');
    const next = h.holdCall('assets.thumbnails');
    await act(async () => {
      replaced = true;
      h.publish({ ...initial, revision: 4, projectTarget: { ...initial.projectTarget!, worldId: 'new-thumbnail-world' } });
      await ticks();
    });
    return { name: 'thumbnail-preloaded-world-pending', checks: { noOldThumbnail: !oldImageVisible, freshReadStarted: next.started === true },
      oldImageVisible, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

async function runPackSelectionHandoff(kind: 'inspection' | 'file'): Promise<Case> {
  const h = harness(kind === 'inspection' ? assetState() : state());
  const host = document.getElementById('app')!, root = createRoot(host);
  const old = h.holdCall(kind === 'inspection' ? 'asset.inspect' : VIEW_FILE_GET_SERVICE);
  const intent = { requestId: 'selection-handoff', projectId: 'project-A', sourcePath: 'assets/NewSelection.pack.ts', revision: 'handoff-revision' };
  let task: Promise<unknown> | undefined, reveals = 0;
  try {
    await act(async () => { root.render(createElement(ContentBrowserPanel, { client: h.client, revealPanel: async () => { reveals++; return true; } })); await ticks(); });
    await act(async () => {
      if (kind === 'inspection') host.querySelector<HTMLElement>('[data-cb-guid="asset-A"]')!.click();
      else {
        host.querySelector<HTMLElement>('[data-cb-path="assets/Cached-A.pack.ts"]')!.click(); await ticks();
        host.querySelector<HTMLButtonElement>(`[data-action="${CONTENT_BROWSER_ACTIONS.toggleDetailPanel}"]`)!.click();
      }
      await ticks();
    });
    if (!old.started) throw new Error(`Old ${kind} request must be in flight before the handoff`);
    const inventory = h.holdInventory();
    await act(async () => { task = h.emit(intent); await ticks(); });
    let oldSelectionAborted = false, currentIntentStillLive = false;
    await act(async () => {
      inventory.accept({ sources: [{ sourcePath: intent.sourcePath, revision: intent.revision }] });
      await ticks();
      oldSelectionAborted = old.signal?.aborted === true;
      currentIntentStillLive = inventory.signal?.aborted === false;
      old.reject(failure()); await ticks();
      void h.emit({ ...intent, cancelled: true });
    });
    await task;
    return { name: `pack-selection-handoff-${kind}`, checks: { oldSelectionAborted, currentIntentStillLive,
      validNavigationPreserved: h.commands.length === 1 && reveals === 1, noOldInspectionError: h.reports.length === 0 },
    reports: h.reports, domainSurfaces: host.querySelectorAll('canvas,iframe').length };
  } finally { await act(async () => root.unmount()); h.dispose(); }
}

export async function runContentBrowserQueryLifetimeCases() {
  const cases: Case[] = [];
  for (const mode of ['auto', 'manual'] as const) {
    for (const outcome of ['failure', 'success'] as const) cases.push(await runRead(mode, outcome, true));
    cases.push(await runRead(mode, 'failure', false));
  }
  const changes: [string, (value: WorkspaceState) => WorkspaceState][] = [
    ['project', value => ({ ...value, project: { ...value.project!, id: 'project-B' } })],
    ['root', value => ({ ...value, project: { ...value.project!, root: '/fixture/new-root' } })],
    ['target', value => ({ ...value, projectTarget: { ...value.projectTarget!, targetId: 'target-replaced' } })],
    ['generation', value => ({ ...value, projectTarget: { ...value.projectTarget!, generation: 2 } })],
    ['session', value => ({ ...value, projectTarget: { ...value.projectTarget!, sessionId: 'session-replaced' } })],
    ['world', value => ({ ...value, projectTarget: { ...value.projectTarget!, worldId: 'world-replaced' } })],
    ['browser', value => ({ ...value, browserGeneration: 2 })],
  ];
  for (const [name, change] of changes) cases.push(await runCached(change, name));
  cases.push(await runClientReplacement());
  for (const mode of ['auto', 'manual'] as const) cases.push(await runUnmount(mode));
  cases.push(await runEpoch());
  for (const boundary of ['project', 'close', 'target', 'client'] as const) for (const outcome of ['success', 'failure'] as const)
    cases.push(await runPackReveal(boundary, outcome));
  cases.push(await runPackReveal('current', 'success'));
  cases.push(await runPackReveal('current', 'failure'));
  for (const route of ['selection', 'reveal'] as const) for (const retire of [true, false]) cases.push(await runInspection(route, retire));
  for (const preload of [false, true]) cases.push(await runFilePreview(preload));
  cases.push(await runThumbnails());
  for (const mode of ['unmount', 'client', 'project', 'shared', 'current'] as const) cases.push(await runBootstrap(mode));
  for (const mode of ['pack-cancel', 'pack-new', 'pack-navigation', 'inspection-selection', 'file-navigation'] as const) cases.push(await runLocalIntent(mode));
  cases.push(await runThumbnailCache());
  for (const kind of ['inspection', 'file'] as const) cases.push(await runPackSelectionHandoff(kind));
  return { ok: cases.every(entry => Object.values(entry.checks).every(Boolean) && entry.domainSurfaces === 0), cases,
    boundary: 'Controlled public DTO transport, actual complete ContentBrowserPanel, ViewWorkspaceClient, reader and error reporting. No Engine App, renderer, Host or GPU scene.' };
}

Object.assign(globalThis, { contentBrowserLifetimeFixture: { run: runContentBrowserQueryLifetimeCases } });
