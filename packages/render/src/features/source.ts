import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import { type Asset, AssetError, err, ok, type Result } from '@forgeax/engine-types';
import { prepareCloudShadowView } from '../cloud/lighting/shadow-view';
import { createCloudFeatureFrameContext } from '../cloud/reconstruction/frame-context';
import { stereoEyeCameras } from '../components/stereo-camera';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import type { ExtractedFrame } from '../render-system-extract';
import { captureHiddenEntityReports } from './hidden-entity-reports';
import type {
  RenderFeature,
  RenderFeatureExtractContext,
  RenderFeatureHiddenEntityReport,
} from './types';
import { renderFeatureCameraView } from './view';

/** One source extraction, delivered directly or encoded by the publication adapter. */
export interface RenderFeatureSource {
  readonly identity: string;
  readonly result: Result<unknown, RenderError>;
  readonly hiddenEntities: readonly RenderFeatureHiddenEntityReport[];
  readonly assetVersions?: readonly Readonly<{ handle: number; revision: number; value: Asset }>[];
}

/** Read through the source asset owner and register the exact version with its flight. */
export function captureFeatureSourceAssetVersion(
  context: RenderFeatureExtractContext,
  handle: number,
  captured?: Readonly<{ revision: number; value: Asset }>,
): Result<
  Readonly<{ handle: number; revision: number; value: Asset; contentRevision?: number }>,
  AssetError
> {
  if (captured !== undefined) {
    const version = { handle, ...captured };
    context.referenceAssetVersion?.(version);
    return ok(version);
  }
  const owner = context.world.assets;
  if (owner === undefined)
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: 'a source asset owner',
        hint: 'attach the source AssetRegistry before Feature extraction',
      }),
    );
  const snapshot = runtimeAssets(owner).snapshot(handle);
  if (!snapshot.ok) return snapshot;
  try {
    const revision = snapshot.value.version(handle);
    if (!revision.ok) return revision;
    const asset = snapshot.value.read<Asset>(handle);
    if (!asset.ok) return asset;
    const version = {
      handle,
      revision: revision.value,
      value: asset.value,
      contentRevision: revision.value,
    };
    context.referenceAssetVersion?.(version);
    return ok(version);
  } finally {
    snapshot.value.dispose();
  }
}
export function renderFeatureSourceContext(
  world: World,
  frame: ExtractedFrame,
  frameNumber: number,
  options: Omit<
    RenderFeatureExtractContext,
    'world' | 'frameNumber' | 'views' | 'visibilitySnapshot' | 'reportHiddenEntity'
  > = {},
  viewFacts?: (
    camera: import('../render-contract').CameraSnapshot,
  ) => import('./types').RenderFeatureViewContext | undefined,
  graphResources?: import('./types').RenderFeatureGraphResourceState,
): RenderFeatureExtractContext {
  return {
    ...options,
    world,
    frameNumber,
    views: frame.cameras
      .filter((camera) => camera.view?.enabled !== false)
      .flatMap(stereoEyeCameras)
      .map((camera) => {
        const view = viewFacts?.(camera);
        const cloud = frame.cloudLayer;
        return {
          ...renderFeatureCameraView(camera),
          ...(graphResources === undefined ? {} : { graphResources }),
          frame:
            cloud === undefined
              ? view === undefined
                ? {}
                : { view }
              : createCloudFeatureFrameContext(
                  prepareCloudShadowView(cloud, camera.position),
                  view,
                  frame.environment,
                  frame.lights.directional,
                ),
        };
      }),
    visibilitySnapshot: frame.visibilitySnapshot,
  };
}
/** A failed extract remains a result until the delivery owner applies its failure policy. */
export function captureRenderFeatureSource(
  feature: RenderFeature<unknown>,
  context: RenderFeatureExtractContext,
  order: number,
): RenderFeatureSource {
  const reports: RenderFeatureHiddenEntityReport[] = [];
  const assetVersions: NonNullable<RenderFeatureSource['assetVersions']>[number][] = [];
  let result: Result<unknown, RenderError>;
  try {
    result = feature.extract({
      ...context,
      reportHiddenEntity: (report) => reports.push(report),
      referenceAssetVersion: (version) => {
        assetVersions.push(version);
        context.referenceAssetVersion?.(version);
      },
    });
  } catch (cause) {
    result = err(
      new RenderFeatureStageFailedError(feature.identity, order, 'extract', 'next-frame', cause),
    );
  }
  return {
    identity: feature.identity,
    result,
    hiddenEntities: captureHiddenEntityReports(reports),
    ...(assetVersions.length === 0 ? {} : { assetVersions }),
  };
}

/** Error metadata crosses the same boundary as Feature data, without cloning class prototypes. */
export type RenderFeatureSourceFailure = Pick<
  RenderError,
  'name' | 'message' | 'code' | 'expected' | 'hint'
> & { readonly detail?: unknown; readonly cause?: unknown; readonly stack?: string };
/** Failure diagnostics must not make an otherwise valid scene uncloneable. */
function sourceFailureDiagnostic(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return String(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= 16) return '[Truncated]';
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.slice(0, 64).map((item) => sourceFailureDiagnostic(item, seen, depth + 1));
    const fields =
      value instanceof Error
        ? {
            ...value,
            name: value.name,
            message: value.message,
            stack: value.stack,
            cause: value.cause,
          }
        : value;
    return Object.fromEntries(
      Object.entries(fields)
        .slice(0, 64)
        .map(([key, item]) => [key, sourceFailureDiagnostic(item, seen, depth + 1)]),
    );
  } catch {
    return '[Unavailable]';
  }
}
export function renderFeatureSourceFailure(error: RenderError): RenderFeatureSourceFailure {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    ...('detail' in error ? { detail: sourceFailureDiagnostic(error.detail) } : {}),
    ...(error.cause === undefined ? {} : { cause: sourceFailureDiagnostic(error.cause) }),
    ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
  };
}
export function restoreRenderFeatureSourceFailure(
  failure: RenderFeatureSourceFailure,
): RenderError {
  if (failure.code === 'render-feature-stage-failed') {
    const detail = failure.detail as import('../errors/render').RenderFeatureStageFailedDetail;
    const error = new RenderFeatureStageFailedError(
      detail.featureIdentity,
      detail.order,
      'extract',
      detail.recovery,
      detail.cause,
    );
    if (failure.stack !== undefined) error.stack = failure.stack;
    return error;
  }
  // The existing Feature failure policy consumes the source-owned code and diagnostic fields.
  return Object.assign(new Error(failure.message), {
    name: failure.name,
    code: failure.code,
    expected: failure.expected,
    hint: failure.hint,
    ...('detail' in failure ? { detail: failure.detail } : {}),
    ...('cause' in failure ? { cause: failure.cause } : {}),
    ...(failure.stack === undefined ? {} : { stack: failure.stack }),
  }) as RenderError;
}

export function isRenderFeatureSourceFailure(value: unknown): value is RenderFeatureSourceFailure {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Partial<RenderFeatureSourceFailure>;
  if (
    typeof row.name !== 'string' ||
    typeof row.message !== 'string' ||
    typeof row.code !== 'string' ||
    row.code.length === 0 ||
    typeof row.expected !== 'string' ||
    typeof row.hint !== 'string' ||
    (row.stack !== undefined && typeof row.stack !== 'string')
  )
    return false;
  if (row.code !== 'render-feature-stage-failed') return true;
  const detail = row.detail as
    | Partial<import('../errors/render').RenderFeatureStageFailedDetail>
    | undefined;
  return (
    detail !== null &&
    typeof detail === 'object' &&
    typeof detail.featureIdentity === 'string' &&
    Number.isSafeInteger(detail.order) &&
    detail.stage === 'extract' &&
    ['next-frame', 'renderer-recover', 'registration'].includes(detail.recovery ?? '')
  );
}
