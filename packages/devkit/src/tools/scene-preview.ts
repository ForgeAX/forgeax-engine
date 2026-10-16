import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { createEngineWorkspaceRuntime, type EngineWorkspaceAsset } from '@forgeax/engine-app';
import type { ArtifactRef, JsonValue, ToolTerminal } from '@forgeax/engine-tool-runtime';
import { createBrowserCapture } from '../software-capture.js';
import { createDevKitWorkspaceProvider } from '../workspace-provider.js';

const DEFAULT_SIZE = 1024;
const DEFAULT_BACKEND = 'auto' as const;

type ScenePreviewBackend = 'auto' | 'hardware' | 'software';

interface ScenePreviewArgs {
  readonly guid: string;
  readonly width: number;
  readonly height: number;
  readonly backend: ScenePreviewBackend;
  readonly headless?: boolean;
  readonly output?: string;
}

interface WorkspaceCapture {
  readonly targetId: string;
  readonly frameId: number;
  readonly width: number;
  readonly height: number;
  readonly png: string;
  readonly errors?: readonly Readonly<Record<string, string>>[];
}

function failure(
  code: string,
  expected: string,
  hint: string,
  detail: Record<string, unknown> = {},
  artifacts: readonly ArtifactRef[] = [],
): ToolTerminal<never> {
  return {
    outcome: 'failed',
    failure: {
      code: 'tool-domain-failed',
      expected,
      hint,
      detail: { code, payload: detail as unknown as JsonValue },
    },
    artifacts,
  };
}

function positiveExtent(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

function parseArgs(
  value: unknown,
):
  | { readonly ok: true; readonly value: ScenePreviewArgs }
  | { readonly ok: false; readonly error: ToolTerminal<never> } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      error: failure(
        'tool-invalid-args',
        'scene preview arguments to be an object with a GUID',
        'Pass { kind: "scene", guid } and retry.',
      ),
    };
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.guid !== 'string' || candidate.guid.trim() === '') {
    return {
      ok: false,
      error: failure(
        'tool-invalid-args',
        'scene preview arguments to include a non-empty guid',
        'Pass the published SceneAsset GUID from `asset list`.',
      ),
    };
  }
  const widthValue = positiveExtent(candidate.width, DEFAULT_SIZE);
  const heightValue = positiveExtent(candidate.height, DEFAULT_SIZE);
  if (widthValue === undefined || heightValue === undefined) {
    return {
      ok: false,
      error: failure(
        'tool-invalid-args',
        'width and height to be positive safe integers',
        'Pass positive integer viewport dimensions.',
        { width: candidate.width ?? null, height: candidate.height ?? null },
      ),
    };
  }
  const width = widthValue;
  const height = heightValue;
  const backend = candidate.backend;
  if (
    backend !== undefined &&
    backend !== 'auto' &&
    backend !== 'hardware' &&
    backend !== 'software'
  ) {
    return {
      ok: false,
      error: failure(
        'tool-invalid-args',
        'backend to be auto, hardware, or software',
        'Use backend: auto for hardware-first fallback.',
        { backend },
      ),
    };
  }
  if (candidate.headless !== undefined && typeof candidate.headless !== 'boolean') {
    return {
      ok: false,
      error: failure(
        'tool-invalid-args',
        'headless to be boolean',
        'Pass headless: true or false.',
        { headless: candidate.headless },
      ),
    };
  }
  if (candidate.output !== undefined && typeof candidate.output !== 'string') {
    return {
      ok: false,
      error: failure(
        'tool-invalid-args',
        'output to be a project-relative path',
        'Pass a relative PNG output path.',
        { output: candidate.output },
      ),
    };
  }
  return {
    ok: true,
    value: {
      guid: candidate.guid,
      width,
      height,
      backend: (backend as ScenePreviewBackend | undefined) ?? DEFAULT_BACKEND,
      ...(candidate.headless === undefined ? {} : { headless: candidate.headless }),
      ...(candidate.output === undefined ? {} : { output: candidate.output }),
    },
  };
}

function dataUriBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (comma < 0 || !uri.startsWith('data:image/png;base64,')) {
    throw new TypeError('workspace capture did not return a base64 PNG data URI');
  }
  return Buffer.from(uri.slice(comma + 1), 'base64');
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function projectUri(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function jsonCopy(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('workspace result is not JSON serializable');
  return JSON.parse(encoded) as unknown;
}

function sceneAsset(
  assets: readonly EngineWorkspaceAsset[],
  guid: string,
): EngineWorkspaceAsset | undefined {
  return assets.find(
    (asset) => asset.kind === 'scene' && asset.guid.toLowerCase() === guid.toLowerCase(),
  );
}

/**
 * Run one SceneAsset preview through the same Engine workspace provider used
 * by display host. The CLI owns only the short-lived browser/session adapters; the
 * browser page owns App, World, AssetRegistry, scene instantiation and the
 * observation camera.
 */
export async function runScenePreviewTool(
  args: unknown,
  projectRoot: string,
): Promise<ToolTerminal<unknown>> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return parsed.error;
  const input = parsed.value;
  const runId = `scene.preview:${randomUUID()}`;
  const outputRoot = resolve(
    projectRoot,
    '.forgeax',
    'tool-runs',
    runId.replace(/[^a-zA-Z0-9._-]/g, '_'),
  );
  const output = resolve(
    projectRoot,
    input.output ?? `${projectUri(projectRoot, outputRoot)}/engine-canvas.png`,
  );
  const provider = createDevKitWorkspaceProvider({
    width: input.width,
    height: input.height,
    headed: input.headless === false,
    // Scene packs can contain a cold producer closure (for example the
    // character pack in game-3d). Keep the workspace contract bounded while
    // allowing that one cold start to finish before the catalog is queried.
    readyTimeoutMs: 120_000,
  });
  const runtime = createEngineWorkspaceRuntime(provider);
  const browser = createBrowserCapture(projectRoot);
  let browserSession: Awaited<ReturnType<typeof browser.open>> | undefined;
  let opened: Awaited<ReturnType<typeof runtime.openProject>> | undefined;
  let preview: Awaited<ReturnType<typeof runtime.openPreview>> | undefined;
  // Capture writes the Engine PNG before the compositor validation runs. Keep
  // every completed artifact/error in scope so a later validation failure
  // cannot hide evidence that is already on disk.
  let engineArtifact: ArtifactRef | undefined;
  let compositorArtifact: ArtifactRef | undefined;
  let captureErrors: WorkspaceCapture['errors'] | undefined;
  let reportUri: string | undefined;
  try {
    opened = await runtime.openProject({ root: projectRoot });
    const serverUrl = opened.target?.url;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
      return failure(
        'scene-preview-target-url-missing',
        'the workspace provider to publish a browser target URL',
        'Reopen the project through the Engine workspace provider.',
      );
    }
    browserSession = await browser.open({
      serverUrl,
      target: { kind: 'project' },
      backend: input.backend,
      headless: input.headless ?? true,
      width: input.width,
      height: input.height,
      runId,
      outputDir: projectUri(projectRoot, outputRoot),
    });
    const assets = await runtime.listAssets({
      project: opened.project,
      handle: opened.handle,
    });
    const asset = sceneAsset(assets, input.guid);
    if (asset === undefined) {
      return failure(
        'scene-preview-asset-not-found',
        'the requested GUID to resolve to a published SceneAsset',
        'Run `asset list --type scene` and retry with a current GUID.',
        { guid: input.guid },
      );
    }
    preview = await runtime.openPreview({
      project: opened.project,
      projectHandle: opened.handle,
      asset,
      width: input.width,
      height: input.height,
    });
    const camera = jsonCopy(await preview.getCamera({ targetId: preview.target.targetId }));
    if (preview.capture === undefined) {
      return failure(
        'scene-preview-capture-unavailable',
        'the SceneAsset workspace preview to expose Engine canvas capture',
        'Use a workspace target with capture support and retry.',
        { guid: asset.guid },
      );
    }
    const capture = (await preview.capture({
      targetId: preview.target.targetId,
      width: input.width,
      height: input.height,
    })) as WorkspaceCapture;
    const bytes = dataUriBytes(capture.png);
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, bytes);
    const imageDigest = digest(bytes);
    const compositorPath = resolve(outputRoot, 'compositor.png');
    engineArtifact = {
      kind: 'png',
      digest: imageDigest,
      uri: projectUri(projectRoot, output),
      mediaType: 'image/png',
      sizeBytes: bytes.byteLength,
    };
    captureErrors = capture.errors;
    const compositor = await browserSession.capture(undefined, {
      purpose: 'validate',
      output: projectUri(projectRoot, compositorPath),
    });
    const report = browserSession.report();
    reportUri = projectUri(projectRoot, report.report);
    const artifact = engineArtifact;
    if (artifact === undefined) {
      throw new Error('workspace Engine capture artifact was not retained');
    }
    const compositorSize = (await stat(compositorPath)).size;
    compositorArtifact = {
      kind: 'png',
      digest: compositor.digest,
      uri: projectUri(projectRoot, compositorPath),
      mediaType: 'image/png',
      sizeBytes: compositorSize,
    };
    if (capture.errors !== undefined && capture.errors.length > 0) {
      return failure(
        'scene-preview-render-errors',
        'the SceneAsset workspace preview to complete without Engine renderer errors',
        'Inspect capture.errors and the retained PNG/report artifacts before retrying.',
        {
          guid: asset.guid,
          errors: jsonCopy(capture.errors) as JsonValue,
          engineCapture: artifact.uri,
          compositorCapture: compositorArtifact.uri,
          report: reportUri,
        },
        [artifact, compositorArtifact],
      );
    }
    return {
      outcome: 'succeeded',
      result: {
        kind: 'scene',
        guid: asset.guid,
        asset,
        target: preview.target,
        camera,
        capture: {
          frameId: capture.frameId,
          width: capture.width,
          height: capture.height,
          digest: imageDigest,
          uri: artifact.uri,
          ...(capture.errors === undefined ? {} : { errors: capture.errors }),
          compositor: {
            digest: compositor.digest,
            uri: compositorArtifact.uri,
            width: compositor.pixels.width,
            height: compositor.pixels.height,
          },
        },
        backend: {
          requested: report.backendRequested,
          observed: report.backend,
          ...(report.fallbackReason === undefined ? {} : { fallbackReason: report.fallbackReason }),
          report: reportUri,
        },
      },
      artifacts: [artifact, compositorArtifact],
    };
  } catch (cause) {
    if (reportUri === undefined && browserSession !== undefined) {
      try {
        reportUri = projectUri(projectRoot, browserSession.report().report);
      } catch {
        // The browser may fail before its diagnostic report is available.
      }
    }
    const retainedArtifacts = [engineArtifact, compositorArtifact].filter(
      (value): value is ArtifactRef => value !== undefined,
    );
    const detail: Record<string, unknown> = { guid: input.guid };
    if (captureErrors !== undefined && captureErrors.length > 0) {
      detail.errors = jsonCopy(captureErrors);
    }
    if (engineArtifact !== undefined) detail.engineCapture = engineArtifact.uri;
    if (compositorArtifact !== undefined) detail.compositorCapture = compositorArtifact.uri;
    if (reportUri !== undefined) detail.report = reportUri;
    return failure(
      'scene-preview-failed',
      'the SceneAsset workspace preview and capture to complete',
      cause instanceof Error ? cause.message : String(cause),
      detail,
      retainedArtifacts,
    );
  } finally {
    if (preview !== undefined) await runtime.closePreview(preview).catch(() => {});
    await runtime.dispose().catch(() => {});
    await browserSession?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
