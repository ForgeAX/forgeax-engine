import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
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
} from '@forgeax/engine-tool-runtime';
import { type Browser, chromium, type Frame, type Page, type Response } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import {
  type BrowserCaptureOpenOptions,
  browserLaunchArgs,
  captureBrowserExecutionSurface,
  classifyCaptureAdapter,
  observeBrowserErrors,
  resolveBrowserExecutable,
} from '../browser-capture.js';
import {
  chromiumEnvironment,
  launchSandboxedBrowserServer,
  needsChromiumPrivilegeDrop,
} from '../chromium-sandbox.js';
import { observeBrowserStartup, readStartupObservation } from '../host/startup-ui.js';
import { createViteConfig } from '../host.js';
import { materializeViteDevPort } from '../loopback.js';
import { readProjectFacts } from '../project.js';
import type { BootstrapRoot, CaptureBackend, CaptureBackendObserved } from '../types.js';
import { completeCommand, failCommand, rejectCommand } from '../types.js';
import {
  acquireBrowserCarrierPage,
  type BrowserCarrierAttachment,
  type BrowserExecutionTarget,
} from './display-carrier.js';
import {
  artifactDigest,
  decodeArtifactDataUri,
  PNG_DATA_URI,
  previewArtifactRef,
  projectArtifactUri,
  toolRunDirectory,
} from './evidence-image.js';
import type { PreviewHostResult } from './preview-host.js';

export type BrowserHostResult =
  | { readonly ok: true; readonly value: PreviewHostResult }
  | {
      readonly ok: false;
      readonly error: ToolDomainFailure;
      readonly artifacts?: readonly ArtifactRef[];
    };

/** Serialized by Playwright into the owner realm. */
async function evaluatePreviewPhase(serializedCapture: string | null): Promise<unknown> {
  const host = globalThis as unknown as {
    __forgeaxToolHost: { capture(): Promise<unknown> };
    __forgeaxToolReplayHost: { run(value: ToolPreviewCaptureResult): Promise<unknown> };
  };
  const value =
    serializedCapture === null
      ? await host.__forgeaxToolHost.capture()
      : await host.__forgeaxToolReplayHost.run(
          JSON.parse(serializedCapture) as ToolPreviewCaptureResult,
        );
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      nested instanceof Error
        ? { ...nested, name: nested.name, message: nested.message, stack: nested.stack }
        : nested,
    ),
  );
}

/** Observe the generated Host's readiness within its existing startup budget. */
export async function waitForBrowserToolHost(
  realm: Page | Frame,
  name: '__forgeaxToolHost' | '__forgeaxToolReplayHost',
  timeoutMs = 45_000,
): Promise<void> {
  const observation = await realm.waitForFunction(observeBrowserStartup, name, {
    timeout: timeoutMs,
  });
  const failure = await readStartupObservation(observation);
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

export interface ResourcePreviewReportInput {
  readonly snapshot: SnapshotRef;
  readonly subject: ResourcePreviewReport['subject'];
  readonly presentation: ResourcePreviewReport['presentation'];
  readonly oracle: ResourcePreviewReport['oracle'];
}

export interface BrowserHostOptions
  extends Pick<
    BrowserCaptureOpenOptions,
    'backend' | 'headless' | 'carrier' | 'carrierRun' | 'carrierGeneration'
  > {
  readonly publish?: boolean;
}

async function observeBrowserAdapter(realm: Page | Frame): Promise<{
  readonly observed: CaptureBackendObserved;
  readonly adapter: Record<string, unknown> | null;
}> {
  return realm
    .evaluate(async () => {
      try {
        const gpuAdapter = await navigator.gpu?.requestAdapter();
        if (gpuAdapter === null || gpuAdapter === undefined) return { adapter: null };
        const info = gpuAdapter.info;
        return {
          adapter: {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description,
          },
        };
      } catch {
        return { adapter: null };
      }
    })
    .then((result) => {
      const adapter =
        result.adapter !== null &&
        typeof result.adapter === 'object' &&
        !Array.isArray(result.adapter)
          ? result.adapter
          : null;
      return { observed: classifyCaptureAdapter(adapter), adapter };
    });
}

async function publishPreviewDirectory(
  published: string,
  files: readonly { readonly name: string; readonly bytes: Uint8Array | string }[],
): Promise<void> {
  const parent = dirname(published);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.staging-'));
  try {
    const written = await Promise.allSettled(
      files.map(({ name, bytes }) => writeFile(join(staging, name), bytes)),
    );
    const failure = written.find((result) => result.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
    await rename(staging, published);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
}

type CapturedArtifacts = Pick<ToolPreviewCaptureResult, 'tape' | 'capturePng' | 'profile'>;

function capturedArtifacts(capture: CapturedArtifacts, failed = false) {
  return {
    'rhi-tape': {
      name: failed ? 'capture.rhitape' : 'rhi-tape.json',
      bytes: decodeArtifactDataUri(capture.tape.jsonUri),
      kind: 'rhi-tape',
      mediaType: failed ? 'application/octet-stream' : 'application/vnd.forgeax.rhi-tape+json',
    },
    capture: {
      name: 'capture.png',
      bytes: decodeArtifactDataUri(capture.capturePng.uri),
      kind: 'png',
      mediaType: 'image/png',
    },
    'profile-capture': {
      name: 'profile.json',
      bytes: decodeArtifactDataUri(capture.profile.uri),
      kind: 'profile-capture',
      mediaType: failed ? 'application/json' : 'application/vnd.forgeax.profile+json',
    },
  } as const;
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
  const published = toolRunDirectory(projectRoot, runId);
  const uri = (fileName: string) => projectArtifactUri(projectRoot, join(published, fileName));
  const parts = {
    ...capturedArtifacts(result),
    'fresh-replay': {
      name: 'fresh-replay.png',
      bytes: decodeArtifactDataUri(result.png.uri),
      mediaType: 'image/png',
    },
  } as const;
  const tapeBlob = decodeArtifactDataUri(result.tape.blobUri);
  const requiredRoles = Object.keys(parts) as (keyof typeof parts)[];
  const nonReportArtifacts = result.manifest.artifacts
    .filter((artifact) => artifact.role !== 'report')
    .map((artifact) => {
      if (!(artifact.role in parts)) {
        return artifact;
      }
      const { name, bytes, mediaType } = parts[artifact.role as keyof typeof parts];
      const digest = artifactDigest(bytes);
      if (artifact.digest !== digest) {
        throw new Error(`preview artifact digest mismatch for ${artifact.role}`);
      }
      return {
        ...artifact,
        uri: uri(name),
        digest,
        byteLength: bytes.byteLength,
        mediaType,
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
          uri: uri('report.json'),
          digest: artifactDigest(reportBytes),
          byteLength: reportBytes.byteLength,
          mediaType: 'application/vnd.forgeax.resource-preview+json',
          derivedFrom: nonReportArtifacts.map((artifact) => artifact.digest),
        };
  const manifest = createPreviewArtifactManifest({
    ...result.manifest,
    artifacts:
      reportArtifact === undefined ? nonReportArtifacts : [reportArtifact, ...nonReportArtifacts],
  });
  await publishPreviewDirectory(published, [
    ...Object.values(parts),
    { name: 'rhi-tape.bin', bytes: tapeBlob },
    ...(reportBytes === undefined ? [] : [{ name: 'report.json', bytes: reportBytes }]),
    { name: 'manifest.json', bytes: `${JSON.stringify(manifest, null, 2)}\n` },
  ]);
  return {
    ...result,
    tape: {
      ...result.tape,
      jsonUri: uri(parts['rhi-tape'].name),
      blobUri: uri('rhi-tape.bin'),
    },
    profile: { ...result.profile, uri: uri(parts['profile-capture'].name) },
    capturePng: {
      ...result.capturePng,
      uri: uri(parts.capture.name),
    },
    png: { ...result.png, uri: uri(parts['fresh-replay'].name) },
    manifest,
    artifacts: manifest.artifacts.map(previewArtifactRef),
  };
}

/** A failed replay still owns the real capture evidence; it has no successful preview manifest. */
export async function publishFailedPreviewCapture(
  projectRoot: string,
  runId: string,
  capture: ToolPreviewCaptureResult,
): Promise<readonly ArtifactRef[]> {
  const published = toolRunDirectory(projectRoot, `${runId}-${capture.captureId}-failed-capture`);
  const parts = Object.values(capturedArtifacts(capture, true));
  await publishPreviewDirectory(published, parts);
  return parts.map((part) =>
    createArtifactRef({
      kind: part.kind,
      mediaType: part.mediaType,
      digest: artifactDigest(part.bytes),
      sizeBytes: part.bytes.byteLength,
      uri: projectArtifactUri(projectRoot, join(published, part.name)),
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
    return rejectCommand({
      ...failure,
      detail: failure.detail as never,
    });
  }
  return failCommand(
    'tool-preview-browser-host-failed',
    'a real Chromium page, project bootstrap, WebGPU device, and bounded preview run',
    'Inspect the Browser Host phase and repair the project or local WebGPU capability.',
    {
      phase,
      cause: transportCause(cause),
      pageErrors,
    },
  );
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
  const requireServerCreation = () => {
    if (signal.aborted) throw new Error('Browser Host aborted before server creation');
  };
  requireServerCreation();
  // A Browser Host is a disposable Vite realm. A shared cache lets adjacent
  // coverage groups observe a partially-written optimized dependency graph.
  // Keep the cache inside the project lifecycle and remove it with the Host.
  const cacheDir = await mkdtemp(join(facts.value.root, '.forgeax', '.browser-host-vite-'));
  let server: ViteDevServer;
  try {
    requireServerCreation();
    const port = await materializeViteDevPort();
    requireServerCreation();
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
  let retirePrivateBrowser: (() => Promise<unknown>) | undefined;
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
  const channel = needsChromiumPrivilegeDrop() ? undefined : process.env.FORGEAX_CHROME_CHANNEL;
  let executablePath: string | undefined;
  const launchBrowser = async (
    headlessMode: boolean,
    backend: CaptureBackend,
  ): Promise<Browser> => {
    // Keep the native process owner independently of the protocol connection.
    // A crashed/disconnected client may close without terminating Chromium.
    const owner = await launchSandboxedBrowserServer({
      ...(channel === undefined ? {} : { channel }),
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: headlessMode,
      args: [
        ...browserLaunchArgs(backend, 'development', false),
        '--autoplay-policy=no-user-gesture-required',
      ],
      env: chromiumEnvironment(backend === 'software'),
    });
    let browser: Browser | undefined;
    retirePrivateBrowser = () => Promise.allSettled([browser?.close(), owner.kill()]);
    try {
      if (signal.aborted) throw new Error('Browser Host aborted during browser launch');
      const connected = await chromium.connect(owner.wsEndpoint());
      if (signal.aborted) {
        await connected.close().catch(() => undefined);
        throw new Error('Browser Host aborted during browser connection');
      }
      browser = connected;
      return connected;
    } catch (cause) {
      await closeBrowserProcess();
      throw cause;
    }
  };
  const observePage = (execution: BrowserExecutionTarget): void => {
    removePageListeners();
    const { ownerPage } = execution;
    const targetFrame = execution.kind === 'frame' ? execution.realm : undefined;
    const detachErrors = observeBrowserErrors(
      execution,
      (message) => pageErrors.push(`${message.type()}: ${message.text()}`),
      (error) => pageErrors.push(error.message),
      true,
    );
    const onResponse = (response: Response) => {
      if (targetFrame !== undefined && response.frame() !== targetFrame) return;
      if (response.status() >= 400) {
        // A failed response is diagnostic evidence, not part of the Host
        // lifecycle. Reading an error body through a live Vite/WebSocket
        // response can remain pending and otherwise block a valid capture.
        pageErrors.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    };
    ownerPage.on('response', onResponse);
    removePageListeners = () => {
      detachErrors();
      ownerPage.off?.('response', onResponse);
      removePageListeners = () => {};
    };
  };
  const openToolPage = async (
    mode: 'capture' | 'replay',
    url: URL,
    backend: CaptureBackend,
    borrowed?: BrowserCarrierAttachment,
  ): Promise<BrowserExecutionTarget> => {
    if (signal.aborted) throw new Error(`Browser Host aborted before ${mode} launch`);
    let execution = borrowed?.execution;
    if (execution === undefined) {
      phase = `${mode}-browser-launch`;
      const browser = await launchBrowser(mode === 'replay' || headless, backend);
      phase = `${mode}-page-bootstrap`;
      const page = await browser.newPage({ viewport: recipe.viewport, deviceScaleFactor: 1 });
      execution = { kind: 'page', ownerPage: page, realm: page };
    }
    observePage(execution);
    // The Vite WebSocket can remain open after the generated Host is ready.
    await execution.realm.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBrowserToolHost(
      execution.realm,
      mode === 'capture' ? '__forgeaxToolHost' : '__forgeaxToolReplayHost',
    );
    return execution;
  };
  let browserRetirement: Promise<unknown> = Promise.resolve();
  const closeBrowserProcess = (releaseCarrier = false): Promise<unknown> => {
    const retire = retirePrivateBrowser;
    const carrier = releaseCarrier ? carrierAttachment : undefined;
    retirePrivateBrowser = undefined;
    if (releaseCarrier) carrierAttachment = undefined;
    removePageListeners();
    browserRetirement = Promise.allSettled([
      browserRetirement,
      Promise.resolve().then(retire),
      Promise.resolve().then(() => carrier?.close('tool-preview-close')),
    ]);
    return browserRetirement;
  };
  const abort = (): void => {
    void closeBrowserProcess(true);
    void server.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (channel === undefined) executablePath = await resolveBrowserExecutable(undefined);
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
    }
    const captureExecution = await openToolPage(
      'capture',
      captureUrl,
      launchBackend,
      carrierAttachment,
    );
    const captureRealm = captureExecution.realm;
    phase = 'capture-run';
    const captured = (await captureRealm.evaluate(evaluatePreviewPhase, null)) as
      | { readonly ok: true; readonly result: ToolPreviewCaptureResult }
      | { readonly ok: false; readonly error: ToolDomainFailure };
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
      return failCommand(
        'tool-preview-backend-unavailable',
        `the explicitly requested ${requestedBackend} browser adapter`,
        'Use backend: auto to allow fallback, or repair the requested browser backend.',
        {
          requested: requestedBackend,
          actual: observedCapture.observed,
          adapter: observedCapture.adapter as JsonValue,
        },
      );
    }
    const capturedResult =
      resource !== undefined && captured.result.capturePng?.uri?.startsWith(PNG_DATA_URI)
        ? captured.result
        : {
            ...captured.result,
            capturePng: {
              width: recipe.viewport.width,
              height: recipe.viewport.height,
              uri:
                PNG_DATA_URI +
                Buffer.from(
                  await captureBrowserExecutionSurface(
                    captureExecution,
                    Date.now() + 45_000,
                    recipe.viewport,
                  ),
                ).toString('base64'),
            },
          };
    completedCapture = capturedResult;

    await closeBrowserProcess();
    pageErrors = [];

    const replayBackend: CaptureBackend =
      observedCapture.observed === 'software' ? 'software' : launchBackend;
    const replayUrl = new URL(`http://127.0.0.1:${address.port}/`);
    replayUrl.searchParams.set('forgeax-tool-replay', '1');
    const replayExecution = await openToolPage('replay', replayUrl, replayBackend);
    phase = 'replay-run';
    const result = (await replayExecution.realm.evaluate(
      evaluatePreviewPhase,
      JSON.stringify(capturedResult),
    )) as
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
    return completeCommand(
      options.publish === false ? value : await publishPreviewArtifacts(projectRoot, runId, value),
    );
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
