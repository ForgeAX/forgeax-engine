import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer as createTcpServer } from 'node:net';
import { join, relative, sep } from 'node:path';
import type {
  ToolPreviewCaptureResult,
  ToolPreviewRecipe,
  ToolPreviewResourceRequest,
} from '@forgeax/engine-app';
import { createResourcePreviewReport, type ResourcePreviewReport } from '@forgeax/engine-preview';
import {
  type ArtifactRef,
  createArtifactRef,
  createPreviewArtifactManifest,
  type JsonValue,
  type PreviewArtifactManifestEntry,
  type SnapshotRef,
  type ToolDomainFailure,
  validatePreviewArtifactManifest,
} from '@forgeax/engine-tool-runtime';
import {
  type Browser,
  type BrowserServer,
  type ConsoleMessage,
  chromium,
  type Frame,
  type Page,
  type Response,
} from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import type { BootstrapRoot } from '../host/base-host.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import {
  browserLaunchArgs,
  captureBrowserExecutionSurface,
  resolveBrowserExecutable,
  type SoftwareBrowserOpenOptions,
} from '../software-capture.js';
import type { CaptureBackend } from '../types.js';
import {
  acquireBrowserCarrierPage,
  type BrowserCarrierAttachment,
  type BrowserExecutionTarget,
} from './display-carrier.js';
import type { PreviewHostResult } from './preview-host.js';

export type BrowserHostResult =
  | { readonly ok: true; readonly value: PreviewHostResult }
  | {
      readonly ok: false;
      readonly error: ToolDomainFailure;
      readonly artifacts?: readonly ArtifactRef[];
    };

/** Observe the generated Host's readiness within its existing startup budget. */
export async function waitForBrowserToolHost(
  realm: Page | Frame,
  name: '__forgeaxToolHost' | '__forgeaxToolReplayHost',
  timeoutMs = 45_000,
): Promise<void> {
  const observation = await realm.waitForFunction(
    (key) => {
      const fatal = document.querySelector('#forgeax-fatal');
      if (fatal?.checkVisibility())
        return (
          document.querySelector('#forgeax-fatal-details')?.textContent?.trim() ||
          fatal.textContent?.trim() ||
          'Engine startup failed'
        ).slice(0, 16_384);
      return (globalThis as unknown as Record<string, { ready?: boolean }>)[key]?.ready === true;
    },
    name,
    { timeout: timeoutMs },
  );
  let failure: unknown;
  try {
    failure = await observation.jsonValue();
  } finally {
    await observation.dispose();
  }
  if (typeof failure === 'string')
    throw {
      code: 'tool-preview-startup-failed',
      expected: 'the generated Engine Host to start without a terminal failure',
      hint: 'Repair the reported startup cause before retrying this preview.',
      detail: { cause: failure },
    };
}

function transportCause(cause: unknown): JsonValue {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
    };
  }
  if (cause === undefined) return 'undefined';
  try {
    return JSON.parse(JSON.stringify(cause)) as JsonValue;
  } catch {
    return String(cause);
  }
}

function dataUriBytes(uri: string): Uint8Array {
  const separator = uri.indexOf(',');
  if (separator < 0) throw new TypeError('preview artifact must be a data URI before publication');
  return Buffer.from(uri.slice(separator + 1), 'base64');
}

function projectUri(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join('/');
}

export interface ResourcePreviewReportInput {
  readonly snapshot: SnapshotRef;
  readonly subject: ResourcePreviewReport['subject'];
  readonly presentation: ResourcePreviewReport['presentation'];
  readonly oracle: ResourcePreviewReport['oracle'];
}

export interface BrowserHostOptions
  extends Pick<
    SoftwareBrowserOpenOptions,
    'backend' | 'headless' | 'carrier' | 'carrierRun' | 'carrierGeneration'
  > {
  readonly publish?: boolean;
}

type BrowserBackendObserved = 'software' | 'hardware' | 'unknown';

function classifyBrowserAdapter(adapter: Record<string, unknown> | null): BrowserBackendObserved {
  if (adapter === null) return 'unknown';
  const witness = Object.values(adapter)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  return ['swiftshader', 'llvmpipe', 'lavapipe', 'software'].some((token) =>
    witness.includes(token),
  )
    ? 'software'
    : 'hardware';
}

async function observeBrowserAdapter(realm: Page | Frame): Promise<{
  readonly observed: BrowserBackendObserved;
  readonly adapter: Record<string, unknown> | null;
}> {
  return realm
    .evaluate(async () => {
      try {
        const gpuAdapter = await navigator.gpu?.requestAdapter();
        if (gpuAdapter === null || gpuAdapter === undefined)
          return { observed: 'unknown', adapter: null };
        const info = gpuAdapter.info;
        return {
          observed: 'unknown',
          adapter: {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description,
          },
        };
      } catch {
        return { observed: 'unknown', adapter: null };
      }
    })
    .then((result) => {
      const adapter =
        result.adapter !== null &&
        typeof result.adapter === 'object' &&
        !Array.isArray(result.adapter)
          ? result.adapter
          : null;
      return { observed: classifyBrowserAdapter(adapter), adapter };
    });
}

/** @internal Vite treats port 0 as its default 5173, not as an OS-assigned port. */
export async function allocateLoopbackPort(): Promise<number> {
  const probe = createTcpServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        probe.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        probe.off('error', onError);
        resolve();
      };
      probe.once('error', onError);
      probe.once('listening', onListening);
      probe.listen(0, '127.0.0.1');
    });
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      throw new Error('loopback port probe did not expose a TCP address');
    }
    return address.port;
  } finally {
    if (probe.listening) {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactRef(artifact: PreviewArtifactManifestEntry) {
  const kind =
    artifact.kind === 'report' || artifact.kind === 'contact-sheet'
      ? ('tool-result' as const)
      : artifact.kind;
  return {
    kind,
    digest: artifact.digest,
    uri: artifact.uri,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.byteLength,
  };
}

export async function publishPreviewArtifacts(
  projectRoot: string,
  runId: string,
  result: PreviewHostResult,
  reportInput?: ResourcePreviewReportInput,
): Promise<PreviewHostResult> {
  if (result.manifest.identity.runId !== runId) {
    throw new Error(
      `preview artifact run identity mismatch: manifest=${result.manifest.identity.runId} requested=${runId}`,
    );
  }
  const runsRoot = join(projectRoot, '.forgeax', 'tool-runs');
  await mkdir(runsRoot, { recursive: true });
  const directoryName = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const published = join(runsRoot, directoryName);
  const finalPaths = {
    tapeJson: join(published, 'rhi-tape.json'),
    tapeBlob: join(published, 'rhi-tape.bin'),
    capturePng: join(published, 'capture.png'),
    freshReplayPng: join(published, 'fresh-replay.png'),
    profile: join(published, 'profile.json'),
    manifest: join(published, 'manifest.json'),
    report: join(published, 'report.json'),
  };
  const tapeJson = dataUriBytes(result.tape.jsonUri);
  const tapeBlob = dataUriBytes(result.tape.blobUri);
  const capturePng = dataUriBytes(result.capturePng.uri);
  const freshReplayPng = dataUriBytes(result.png.uri);
  const profile = dataUriBytes(result.profile.uri);
  const bytesByRole = {
    'rhi-tape': tapeJson,
    capture: capturePng,
    'fresh-replay': freshReplayPng,
    'profile-capture': profile,
  } as const;
  const uriByRole = {
    'rhi-tape': projectUri(projectRoot, finalPaths.tapeJson),
    capture: projectUri(projectRoot, finalPaths.capturePng),
    'fresh-replay': projectUri(projectRoot, finalPaths.freshReplayPng),
    'profile-capture': projectUri(projectRoot, finalPaths.profile),
  } as const;
  const mediaTypeByRole = {
    'rhi-tape': 'application/vnd.forgeax.rhi-tape+json',
    capture: 'image/png',
    'fresh-replay': 'image/png',
    'profile-capture': 'application/vnd.forgeax.profile+json',
  } as const;
  const requiredRoles = ['rhi-tape', 'capture', 'fresh-replay', 'profile-capture'] as const;
  const nonReportArtifacts = result.manifest.artifacts
    .filter((artifact) => artifact.role !== 'report')
    .map((artifact) => {
      if (!(artifact.role in bytesByRole)) {
        return artifact;
      }
      const role = artifact.role as keyof typeof bytesByRole;
      const bytes = bytesByRole[role];
      const digest = sha256(bytes);
      if (artifact.digest !== digest) {
        throw new Error(`preview artifact digest mismatch for ${artifact.role}`);
      }
      return {
        ...artifact,
        uri: uriByRole[role],
        digest,
        byteLength: bytes.byteLength,
        mediaType: mediaTypeByRole[role],
      };
    });
  if (
    requiredRoles.some((role) => !nonReportArtifacts.some((artifact) => artifact.role === role))
  ) {
    throw new Error(
      'preview publication is missing capture, fresh-replay, tape, or profile artifact',
    );
  }
  let report: ResourcePreviewReport | undefined;
  let reportBytes: Uint8Array | undefined;
  if (reportInput !== undefined) {
    if (reportInput.snapshot.digest !== result.manifest.identity.snapshotDigest) {
      throw new Error('preview report snapshot identity does not match the artifact manifest');
    }
    report = createResourcePreviewReport({
      runId,
      snapshot: reportInput.snapshot,
      subject: reportInput.subject,
      presentation: reportInput.presentation,
      oracle: reportInput.oracle,
      artifacts: nonReportArtifacts,
    });
    reportBytes = new TextEncoder().encode(JSON.stringify(report));
  }
  const reportArtifact: PreviewArtifactManifestEntry | undefined =
    reportBytes === undefined
      ? undefined
      : {
          owner: 'resource-preview',
          kind: 'report',
          role: 'report',
          uri: projectUri(projectRoot, finalPaths.report),
          digest: sha256(reportBytes),
          byteLength: reportBytes.byteLength,
          mediaType: 'application/vnd.forgeax.resource-preview+json',
          derivedFrom: nonReportArtifacts.map((artifact) => artifact.digest),
        };
  const manifest = createPreviewArtifactManifest({
    ...result.manifest,
    artifacts:
      reportArtifact === undefined ? nonReportArtifacts : [reportArtifact, ...nonReportArtifacts],
  });
  const validated = validatePreviewArtifactManifest(
    manifest,
    reportArtifact === undefined ? requiredRoles : ['report', ...requiredRoles],
  );
  if (!validated.ok) throw new Error(JSON.stringify(validated.error.detail));
  const staging = await mkdtemp(join(runsRoot, '.staging-'));
  const paths = {
    tapeJson: join(staging, 'rhi-tape.json'),
    tapeBlob: join(staging, 'rhi-tape.bin'),
    capturePng: join(staging, 'capture.png'),
    freshReplayPng: join(staging, 'fresh-replay.png'),
    profile: join(staging, 'profile.json'),
    manifest: join(staging, 'manifest.json'),
    report: join(staging, 'report.json'),
  };
  try {
    await Promise.all([
      writeFile(paths.tapeJson, tapeJson),
      writeFile(paths.tapeBlob, tapeBlob),
      writeFile(paths.capturePng, capturePng),
      writeFile(paths.freshReplayPng, freshReplayPng),
      writeFile(paths.profile, profile),
      ...(reportBytes === undefined ? [] : [writeFile(paths.report, reportBytes)]),
    ]);
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staging, published);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
  return {
    ...result,
    tape: {
      ...result.tape,
      jsonUri: projectUri(projectRoot, finalPaths.tapeJson),
      blobUri: projectUri(projectRoot, finalPaths.tapeBlob),
    },
    profile: { ...result.profile, uri: projectUri(projectRoot, finalPaths.profile) },
    capturePng: { ...result.capturePng, uri: projectUri(projectRoot, finalPaths.capturePng) },
    png: { ...result.png, uri: projectUri(projectRoot, finalPaths.freshReplayPng) },
    manifest,
    artifacts: manifest.artifacts.map(artifactRef),
  };
}

/** A failed replay still owns the real capture evidence; it has no successful preview manifest. */
export async function publishFailedPreviewCapture(
  projectRoot: string,
  runId: string,
  capture: ToolPreviewCaptureResult,
): Promise<readonly ArtifactRef[]> {
  const root = join(projectRoot, '.forgeax', 'tool-runs');
  await mkdir(root, { recursive: true });
  const published = join(
    root,
    `${runId.replace(/[^a-zA-Z0-9._-]/g, '_')}-${capture.captureId.replace(/[^a-zA-Z0-9._-]/g, '_')}-failed-capture`,
  );
  const parts = [
    {
      name: 'capture.rhitape',
      kind: 'rhi-tape' as const,
      mediaType: 'application/octet-stream',
      bytes: dataUriBytes(capture.tape.jsonUri),
    },
    {
      name: 'capture.png',
      kind: 'png' as const,
      mediaType: 'image/png',
      bytes: dataUriBytes(capture.capturePng.uri),
    },
    {
      name: 'profile.json',
      kind: 'profile-capture' as const,
      mediaType: 'application/json',
      bytes: dataUriBytes(capture.profile.uri),
    },
  ];
  const staging = await mkdtemp(join(root, '.staging-'));
  try {
    await Promise.all(parts.map((part) => writeFile(join(staging, part.name), part.bytes)));
    await rename(staging, published);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return parts.map((part) =>
    createArtifactRef({
      kind: part.kind,
      mediaType: part.mediaType,
      digest: sha256(part.bytes),
      sizeBytes: part.bytes.byteLength,
      uri: projectUri(projectRoot, join(published, part.name)),
    }),
  );
}

function browserFailure(
  phase: string,
  cause: unknown,
  pageErrors: readonly string[] = [],
): Extract<BrowserHostResult, { ok: false }> {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    (cause as { readonly code?: unknown }).code === 'tool-preview-capability-unavailable'
  ) {
    const failure = cause as ToolDomainFailure;
    return {
      ok: false,
      error: {
        ...failure,
        detail: failure.detail as never,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'tool-preview-browser-host-failed',
      expected: 'a real Chromium page, project bootstrap, WebGPU device, and bounded preview run',
      hint: 'Inspect the Browser Host phase and repair the project or local WebGPU capability.',
      detail: {
        phase,
        cause: transportCause(cause),
        pageErrors,
      },
    },
  };
}

function skinCapabilityFailure(
  resourceKind: ToolPreviewResourceRequest['kind'] | undefined,
  errors: readonly unknown[] | undefined,
): ToolDomainFailure | undefined {
  if (resourceKind !== 'material') return undefined;
  if (!Array.isArray(errors)) return undefined;
  const cause = errors.find(isSkinCapabilityError);
  if (cause === undefined) return undefined;
  return {
    code: 'tool-preview-capability-unavailable',
    expected: 'a skinned material preview mesh with skinIndex, skinWeight, and Skin bindings',
    hint: 'Preview this material through a scene or mesh that supplies the skinning contract.',
    detail: { phase: 'capture-render', cause: transportCause(cause) },
  };
}

function isSkinCapabilityError(error: unknown): boolean {
  return (
    (error !== null &&
      typeof error === 'object' &&
      (error as { readonly code?: unknown }).code === 'material-skin-attr-missing') ||
    (typeof error === 'string' &&
      /\[RenderSystem\.extract \(material-skin-attr-missing\)\]\s*MaterialSkinAttrMissingError:/.test(
        error,
      ))
  );
}

export async function runBrowserPreviewHost(
  projectRoot: string,
  recipe: ToolPreviewRecipe,
  snapshot: SnapshotRef,
  runId: string,
  signal: AbortSignal,
  bootstrapRoot: BootstrapRoot = 'project-bootstrap',
  resource?: ToolPreviewResourceRequest,
  options: BrowserHostOptions = {},
): Promise<BrowserHostResult> {
  const facts = await readProjectFacts(projectRoot);
  if (!facts.ok)
    return { ok: false, error: { ...facts.error, detail: facts.error.detail as never } };
  if (signal.aborted) throw new Error('Browser Host aborted before configuration');
  const config = await createViteConfig(facts.value, 'serve', '/', { bootstrapRoot });
  // Configuration may load project cookers and execute Pack discovery before a
  // Vite server exists. A timed-out caller must not continue into server
  // creation after that work completes.
  if (signal.aborted) throw new Error('Browser Host aborted before server creation');
  // A Browser Host is a disposable Vite realm. A shared cache lets adjacent
  // coverage groups observe a partially-written optimized dependency graph.
  // Keep the cache inside the project lifecycle and remove it with the Host.
  const cacheDir = await mkdtemp(join(facts.value.root, '.forgeax', '.browser-host-vite-'));
  let server: ViteDevServer;
  try {
    if (signal.aborted) throw new Error('Browser Host aborted before server creation');
    const port = await allocateLoopbackPort();
    if (signal.aborted) throw new Error('Browser Host aborted before server creation');
    server = await createServer({
      ...config,
      cacheDir,
      logLevel: 'silent',
      optimizeDeps: {
        ...config.optimizeDeps,
        // Tool runs must observe the current workspace build, even when a
        // persistent runner retains Vite's optimized-dependency cache.
        force: true,
      },
      server: {
        ...config.server,
        host: '127.0.0.1',
        port,
        // Vite's port 0 means its default 5173. Bind the probed port exactly so
        // another project or runner cannot be mistaken for this Browser Host.
        strictPort: true,
      },
    });
    if (signal.aborted) {
      await server.close();
      throw new Error('Browser Host aborted before server listen');
    }
  } catch (cause) {
    await rm(cacheDir, { recursive: true, force: true });
    throw cause;
  }
  const hostStartedAtMs = performance.now();
  let phase = 'server-listen';
  let browser: Browser | undefined;
  let browserServer: BrowserServer | undefined;
  let page: Page | undefined;
  let carrierAttachment: BrowserCarrierAttachment | undefined;
  let carrierFallbackReason: string | undefined;
  let pageErrors: string[] = [];
  let completedCapture: ToolPreviewCaptureResult | undefined;
  const failedWithCapture = async (
    cause: unknown,
  ): Promise<Extract<BrowserHostResult, { ok: false }>> => {
    const failure = browserFailure(phase, cause, pageErrors);
    if (!completedCapture) return failure;
    try {
      return {
        ...failure,
        artifacts: await publishFailedPreviewCapture(projectRoot, runId, completedCapture),
      };
    } catch (error) {
      return {
        ...failure,
        error: {
          ...failure.error,
          detail: {
            phase,
            cause: transportCause(cause),
            evidencePublicationError: transportCause(error),
          },
        },
      };
    }
  };
  let removePageListeners: () => void = () => {};
  const requestedBackend = options.backend ?? 'auto';
  const launchBackend: CaptureBackend = requestedBackend === 'software' ? 'software' : 'hardware';
  const headless = options.headless ?? recipe.presentation === 'hidden';
  const channel = process.env.FORGEAX_CHROME_CHANNEL;
  const executablePath =
    channel === undefined ? await resolveBrowserExecutable(undefined) : undefined;
  const launchBrowser = async (
    headlessMode: boolean,
    backend: CaptureBackend,
  ): Promise<Browser> => {
    // Keep the native process owner independently of the protocol connection.
    // A crashed/disconnected client may close without terminating Chromium.
    const owner = await chromium.launchServer({
      ...(channel === undefined ? {} : { channel }),
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: headlessMode,
      args: [
        ...browserLaunchArgs(backend, 'development', false),
        '--autoplay-policy=no-user-gesture-required',
      ],
      ...(backend === 'software'
        ? {
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              LIBGL_ALWAYS_SOFTWARE: '1',
            },
          }
        : {}),
      chromiumSandbox: true,
    });
    browserServer = owner;
    try {
      if (signal.aborted) throw new Error('Browser Host aborted during browser launch');
      const connected = await chromium.connect(owner.wsEndpoint());
      if (signal.aborted) throw new Error('Browser Host aborted during browser connection');
      return connected;
    } catch (cause) {
      if (browserServer === owner) browserServer = undefined;
      await owner.kill();
      throw cause;
    }
  };
  const observePage = (target: Page, execution: BrowserExecutionTarget): void => {
    removePageListeners();
    const targetFrame = execution.kind === 'frame' ? execution.realm : undefined;
    const onPageError = (error: Error) => {
      // Playwright's PageError has no frame accessor. Never classify an
      // unrelated workspace error as a borrowed display-frame failure.
      if (targetFrame === undefined) pageErrors.push(error.message);
    };
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      if (targetFrame !== undefined) {
        const location = message.location().url;
        const targetUrl = typeof targetFrame.url === 'function' ? targetFrame.url() : '';
        if (location !== '' && targetUrl !== '' && location !== targetUrl) return;
      }
      pageErrors.push(`${message.type()}: ${message.text()}`);
    };
    const onResponse = (response: Response) => {
      if (targetFrame !== undefined && response.frame() !== targetFrame) return;
      if (response.status() >= 400) {
        // A failed response is diagnostic evidence, not part of the Host
        // lifecycle. Reading an error body through a live Vite/WebSocket
        // response can remain pending and otherwise block a valid capture.
        pageErrors.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    };
    target.on('pageerror', onPageError);
    target.on('console', onConsole);
    target.on('response', onResponse);
    removePageListeners = () => {
      target.off?.('pageerror', onPageError);
      target.off?.('console', onConsole);
      target.off?.('response', onResponse);
      removePageListeners = () => {};
    };
  };
  let browserRetirement: Promise<unknown> = Promise.resolve();
  const closeBrowserProcess = async (releaseCarrier = false): Promise<void> => {
    const activePage = page;
    const activeBrowser = browser;
    const activeBrowserServer = browserServer;
    const activeCarrier = carrierAttachment;
    page = undefined;
    browser = undefined;
    browserServer = undefined;
    removePageListeners();
    if (releaseCarrier) carrierAttachment = undefined;
    browserRetirement = Promise.allSettled([
      browserRetirement,
      ...(activeCarrier === undefined && activePage !== undefined
        ? [activePage.close().catch(() => undefined)]
        : []),
      activeBrowser?.close(),
      // These private preview realms have no borrowed application lifetime.
      // Retire the actual process even if its client has already disconnected.
      activeBrowserServer?.kill(),
      ...(releaseCarrier && activeCarrier !== undefined
        ? [activeCarrier.close('tool-preview-close')]
        : []),
    ]);
    await browserRetirement;
  };
  const abort = (): void => {
    void closeBrowserProcess(true);
    void server.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('Browser Host aborted before launch');
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo | null | undefined;
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('Vite Browser Host did not expose a loopback TCP address');
    }

    phase = 'server-transform';
    const entryTransform = await server.transformRequest('/main.ts');
    if (entryTransform === null) {
      throw new Error('Vite Browser Host entry transform returned no module');
    }

    const captureUrl = new URL(`http://127.0.0.1:${address.port}/`);
    captureUrl.searchParams.set('forgeax-tool-recipe', JSON.stringify(recipe));
    captureUrl.searchParams.set('forgeax-tool-snapshot', JSON.stringify(snapshot));
    captureUrl.searchParams.set('forgeax-tool-run-id', runId);
    if (resource !== undefined)
      captureUrl.searchParams.set('forgeax-resource-preview', JSON.stringify(resource));
    if (!headless && recipe.presentation !== 'hidden' && options.carrier !== undefined) {
      if (options.carrierRun === undefined || options.carrierGeneration === undefined) {
        throw new Error(
          'browser host carrier requires carrierRun and carrierGeneration for a visible page',
        );
      }
      phase = 'capture-carrier-select';
      const acquired = await acquireBrowserCarrierPage(
        options.carrier,
        {
          run: options.carrierRun,
          generation: options.carrierGeneration,
          headless: false,
          gpu: 'auto',
          width: recipe.viewport.width,
          height: recipe.viewport.height,
          url: captureUrl.href,
        },
        { signal, releaseReason: 'tool-preview-attach-failed' },
      );
      carrierAttachment = acquired.attachment;
      carrierFallbackReason = acquired.fallbackReason;
      if (carrierAttachment !== undefined) page = carrierAttachment.page;
    }
    if (page === undefined) {
      phase = 'capture-browser-launch';
      browser = await launchBrowser(headless, launchBackend);
      phase = 'capture-page-bootstrap';
      page = await browser.newPage({
        viewport: recipe.viewport,
        deviceScaleFactor: 1,
      });
    }
    const capturePage = page;
    if (capturePage === undefined) throw new Error('Browser Host did not provide a capture page');
    const captureExecution: BrowserExecutionTarget = carrierAttachment?.execution ?? {
      kind: 'page',
      ownerPage: capturePage,
      realm: capturePage,
    };
    const captureRealm = captureExecution.realm;
    observePage(capturePage, captureExecution);
    // Vite keeps a development WebSocket open for the host bridge, so
    // `networkidle` is not a lifecycle signal here. The generated page marks
    // the actual Engine Host ready below; wait for DOM parsing and that owner
    // signal instead of waiting for a connection that is intentionally live.
    await captureRealm.goto(captureUrl.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBrowserToolHost(captureRealm, '__forgeaxToolHost');
    phase = 'capture-run';
    const captured = await captureRealm.evaluate(async () => {
      const host = (
        globalThis as unknown as {
          __forgeaxToolHost: {
            capture(): Promise<
              | { readonly ok: true; readonly result: ToolPreviewCaptureResult }
              | { readonly ok: false; readonly error: ToolDomainFailure }
            >;
          };
        }
      ).__forgeaxToolHost;
      const value = await host.capture();
      return JSON.parse(
        JSON.stringify(value, (_key, nested) =>
          nested instanceof Error
            ? {
                ...nested,
                name: nested.name,
                message: nested.message,
                stack: nested.stack,
              }
            : nested,
        ),
      ) as Awaited<ReturnType<typeof host.capture>>;
    });
    if (!captured.ok) return browserFailure('capture-run', captured.error, pageErrors);
    completedCapture = captured.result;
    const captureCapabilityFailure = skinCapabilityFailure(resource?.kind, [
      ...(Array.isArray(captured.result.appErrors) ? captured.result.appErrors : []),
      ...pageErrors,
    ]);
    // The render system reports a known resource capability limit through the
    // App error channel. That same error is also surfaced as a console error
    // by the browser page, but it does not invalidate the capture: the RHI
    // tape, profile, and canvas have already been produced and the replay
    // phase can still make them durable. Keep unrelated page errors fatal;
    // native-preview will return the capability failure after publishing the
    // complete capture bundle without a success report.
    const unexpectedPageErrors =
      captureCapabilityFailure === undefined
        ? pageErrors
        : pageErrors.filter((error) => !isSkinCapabilityError(error));
    if (unexpectedPageErrors.length > 0)
      return browserFailure('capture-page-runtime', unexpectedPageErrors[0], unexpectedPageErrors);
    const observedCapture = await observeBrowserAdapter(captureRealm);
    if (requestedBackend !== 'auto' && observedCapture.observed !== requestedBackend) {
      return {
        ok: false,
        error: {
          code: 'tool-preview-backend-unavailable',
          expected: `the explicitly requested ${requestedBackend} browser adapter`,
          hint: 'Use backend: auto to allow fallback, or repair the requested browser backend.',
          detail: {
            requested: requestedBackend,
            actual: observedCapture.observed,
            adapter: observedCapture.adapter as JsonValue,
          },
        },
      };
    }
    const canvasCaptureUri = captured.result.capturePng?.uri;
    const reuseCanvasCapture =
      resource !== undefined && canvasCaptureUri?.startsWith('data:image/png;base64,') === true;
    const capturePng = reuseCanvasCapture
      ? dataUriBytes(canvasCaptureUri)
      : await captureBrowserExecutionSurface(
          captureExecution,
          Date.now() + 45_000,
          recipe.viewport,
        );
    const capturedResult: ToolPreviewCaptureResult = {
      ...captured.result,
      capturePng: {
        uri: `data:image/png;base64,${Buffer.from(capturePng).toString('base64')}`,
        width: reuseCanvasCapture ? captured.result.capturePng.width : recipe.viewport.width,
        height: reuseCanvasCapture ? captured.result.capturePng.height : recipe.viewport.height,
      },
    };
    completedCapture = capturedResult;

    await closeBrowserProcess();
    pageErrors = [];

    phase = 'replay-browser-launch';
    const replayBackend: CaptureBackend =
      observedCapture.observed === 'software' ? 'software' : launchBackend;
    browser = await launchBrowser(true, replayBackend);
    phase = 'replay-page-bootstrap';
    page = await browser.newPage({
      viewport: recipe.viewport,
      deviceScaleFactor: 1,
    });
    observePage(page, { kind: 'page', ownerPage: page, realm: page });
    const replayUrl = new URL(`http://127.0.0.1:${address.port}/`);
    replayUrl.searchParams.set('forgeax-tool-replay', '1');
    await page.goto(replayUrl.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBrowserToolHost(page, '__forgeaxToolReplayHost');
    phase = 'replay-run';
    const result = (await page.evaluate(async (serializedCapture: string): Promise<unknown> => {
      const host = (
        globalThis as unknown as {
          __forgeaxToolReplayHost: {
            run(value: ToolPreviewCaptureResult): Promise<unknown>;
          };
        }
      ).__forgeaxToolReplayHost;
      const value = await host.run(JSON.parse(serializedCapture) as ToolPreviewCaptureResult);
      return JSON.parse(
        JSON.stringify(value, (_key, nested) =>
          nested instanceof Error
            ? {
                ...nested,
                name: nested.name,
                message: nested.message,
                stack: nested.stack,
              }
            : nested,
        ),
      ) as unknown;
    }, JSON.stringify(capturedResult))) as
      | { readonly ok: true; readonly result: PreviewHostResult }
      | { readonly ok: false; readonly error: ToolDomainFailure };
    if (!result.ok) return failedWithCapture(result.error);
    if (pageErrors.length > 0)
      return browserFailure('replay-page-runtime', pageErrors[0], pageErrors);

    const endedAtMs = performance.now();
    const phases = result.result.operationTiming.phases;
    const observedDurationMs =
      phases === undefined
        ? 0
        : Object.values(phases).reduce(
            (total, observation) =>
              total + (observation.status === 'observed' ? observation.durationMs : 0),
            0,
          );
    const durationMs = endedAtMs - hostStartedAtMs;
    const value: PreviewHostResult = {
      ...result.result,
      operationTiming: {
        ...result.result.operationTiming,
        startedAtMs: hostStartedAtMs,
        endedAtMs,
        durationMs,
        ...(phases === undefined
          ? { unattributedMs: durationMs }
          : {
              phases: {
                ...phases,
                transport: {
                  status: 'observed',
                  durationMs: Math.max(0, durationMs - observedDurationMs),
                },
              },
              unattributedMs: 0,
            }),
      },
      actualCarrier: headless
        ? 'headless-private'
        : carrierAttachment === undefined
          ? 'headed-private'
          : 'visible-consumer',
      ...(carrierAttachment === undefined ? {} : { carrierTarget: carrierAttachment.target }),
      ...(carrierFallbackReason === undefined ? {} : { carrierFallbackReason }),
      backendRequested: requestedBackend,
      backendObserved: observedCapture.observed,
      ...(captureCapabilityFailure === undefined
        ? {}
        : { capabilityFailure: captureCapabilityFailure }),
      ...(requestedBackend === 'auto' && observedCapture.observed === 'software'
        ? { backendFallbackReason: 'browser adapter reported a software implementation' }
        : {}),
    };
    phase = 'artifact-publish';
    return {
      ok: true,
      value:
        options.publish === false
          ? value
          : await publishPreviewArtifacts(projectRoot, runId, value),
    };
  } catch (cause) {
    return await failedWithCapture(cause);
  } finally {
    signal.removeEventListener('abort', abort);
    await closeBrowserProcess(true);
    await server.close().catch(() => undefined);
    await rm(cacheDir, { recursive: true, force: true });
  }
}

export function runBrowserResourcePreviewHost(
  projectRoot: string,
  recipe: ToolPreviewRecipe,
  snapshot: SnapshotRef,
  runId: string,
  signal: AbortSignal,
  resource: ToolPreviewResourceRequest,
  options: BrowserHostOptions = {},
): Promise<BrowserHostResult> {
  return runBrowserPreviewHost(
    projectRoot,
    recipe,
    snapshot,
    runId,
    signal,
    'resource-bootstrap',
    resource,
    options,
  );
}
