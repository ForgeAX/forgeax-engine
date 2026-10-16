import { evaluateTextureOracle, type TextureOracleInput } from '../evidence/oracle.js';
import { canonicalPresentation, createCanonicalPreviewRecipe } from '../kit/canonical.js';
import {
  loadResourceSubject,
  type ResourcePreviewArgs,
  type ResourcePreviewInput,
  subjectFailure,
} from './subject.js';

export interface TextureSubjectInspection {
  readonly subjectDigest: string;
  readonly boundDigest: string;
  readonly dimensions: readonly [number, number];
  readonly format: string;
  readonly colorSpace: string;
  readonly mipCount: number;
  readonly uvDigest: string;
  readonly filter: string;
  readonly bindingDigest: string;
  readonly payloadClass: TextureOracleInput['observed']['payloadClass'];
}

type InspectionResult =
  | { readonly ok: true; readonly value: TextureSubjectInspection }
  | ReturnType<typeof subjectFailure>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredString(asset: Record<string, unknown>, field: string): string | undefined {
  const value = asset[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredNumber(asset: Record<string, unknown>, field: string): number | undefined {
  const value = asset[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function authoredMipCount(
  asset: Record<string, unknown>,
  shapeDimensions: readonly (number | undefined)[] | undefined,
): number | undefined {
  const mips = isRecord(asset.mips) ? asset.mips : undefined;
  if (mips?.kind === 'packed') {
    const levels = requiredNumber(mips, 'levelCount');
    return levels !== undefined && Number.isInteger(levels) && levels > 0 ? levels : undefined;
  }
  if (mips?.kind !== 'generate') return mips?.kind === 'none' ? 1 : undefined;
  const [width, height] = shapeDimensions ?? [undefined, undefined];
  if (width === undefined || height === undefined) return undefined;
  const shape = isRecord(asset.shape) ? asset.shape : undefined;
  const extent = shape !== undefined && isRecord(shape.extent) ? shape.extent : undefined;
  const depth =
    shape?.viewDimension === '3d' && extent !== undefined
      ? (requiredNumber(extent, 'depth') ?? 1)
      : 1;
  let largest = Math.max(width, height, depth);
  let levels = 1;
  while (largest > 1) {
    largest = Math.max(1, Math.floor(largest / 2));
    levels += 1;
  }
  return levels;
}

function isTexturePayloadClass(value: unknown): value is TextureSubjectInspection['payloadClass'] {
  return (
    value === 'black' || value === 'transparent' || value === 'single-channel' || value === 'color'
  );
}

function classifyPayload(
  data: unknown,
  format: string | undefined,
): TextureSubjectInspection['payloadClass'] | undefined {
  const bytes =
    data instanceof Uint8Array || data instanceof Uint8ClampedArray
      ? [...data]
      : Array.isArray(data) && data.every((value) => typeof value === 'number')
        ? data
        : undefined;
  if (bytes === undefined || bytes.length === 0) return undefined;
  const normalizedFormat = format?.toLowerCase() ?? '';
  const singleChannel = normalizedFormat.startsWith('r') && !normalizedFormat.startsWith('rg');
  if (bytes.every((value) => value === 0)) return 'black';
  if (singleChannel) return 'single-channel';
  // RG carries two color/data channels and has no alpha lane.  Only the
  // explicitly four-channel formats below permit a transparent classification;
  // compressed and packed formats remain an opaque color observation here.
  if (normalizedFormat.startsWith('rgba') || normalizedFormat.startsWith('bgra')) {
    const alpha = bytes.filter((_, index) => (index + 1) % 4 === 0);
    if (alpha.length > 0 && alpha.every((value) => value === 0)) return 'transparent';
  }
  return 'color';
}

type Observation = Readonly<Record<string, string | number | boolean | readonly number[]>>;

function observationString(observation: Observation, field: string): string | undefined {
  const value = observation[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function observationDimensions(observation: Observation): readonly [number, number] | undefined {
  const value = observation.dimensions;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((entry) => typeof entry !== 'number' || !Number.isInteger(entry) || entry <= 0)
  )
    return undefined;
  return [value[0] as number, value[1] as number];
}

function observationPayloadClass(
  observation: Observation,
): TextureSubjectInspection['payloadClass'] | undefined {
  const value = observation.payloadClass;
  return isTexturePayloadClass(value) ? value : undefined;
}

export function inspectTextureSubject(input: {
  readonly guid: string;
  readonly asset: unknown;
  readonly digest?: string;
  readonly ownerFacts?: Readonly<Record<string, string | number | boolean>>;
}): InspectionResult {
  if (!isRecord(input.asset) || input.asset.kind !== 'texture') {
    return subjectFailure('resource-preview-kind-mismatch', 'a TextureAsset with kind texture', {
      phase: 'subject',
      guid: input.guid,
      actualKind:
        isRecord(input.asset) && typeof input.asset.kind === 'string'
          ? input.asset.kind
          : 'unknown',
    });
  }
  const asset = input.asset;
  const inlineOwner = asset.ownerFacts;
  const ownerFacts = isRecord(inlineOwner) ? inlineOwner : input.ownerFacts;
  const readString = (field: string): string | undefined =>
    requiredString(asset, field) ?? requiredString(ownerFacts ?? {}, field);
  const subjectDigest = readString('digest') ?? input.digest ?? readString('subjectDigest');
  const boundDigest = readString('boundDigest');
  const uvDigest = readString('uvDigest');
  const bindingDigest = readString('bindingDigest');
  const format = readString('format');
  const colorSpace = readString('colorSpace');
  const filter = readString('filter');
  const shape = isRecord(asset.shape) ? asset.shape : undefined;
  const extent = shape !== undefined && isRecord(shape.extent) ? shape.extent : undefined;
  const shapeDimensions =
    extent !== undefined
      ? [requiredNumber(extent, 'width'), requiredNumber(extent, 'height')]
      : undefined;
  const dimensionsValue = asset.dimensions;
  const dimensions = Array.isArray(dimensionsValue)
    ? dimensionsValue
    : shapeDimensions?.[0] !== undefined && shapeDimensions[1] !== undefined
      ? shapeDimensions
      : [requiredNumber(asset, 'width'), requiredNumber(asset, 'height')];
  const authoredMips = isRecord(asset.mips) ? asset.mips : undefined;
  const packedLevelCount =
    authoredMips?.kind === 'packed' ? requiredNumber(authoredMips, 'levelCount') : undefined;
  if (
    authoredMips?.kind === 'packed' &&
    (packedLevelCount === undefined || !Number.isInteger(packedLevelCount) || packedLevelCount <= 0)
  ) {
    return subjectFailure('resource-preview-subject-invalid', 'TextureAsset packed mip metadata', {
      phase: 'subject',
      guid: input.guid,
      field: 'mips.levelCount',
    });
  }
  const mipCount =
    authoredMipCount(asset, shapeDimensions) ??
    requiredNumber(asset, 'mipCount') ??
    requiredNumber(asset, 'mipLevelCount') ??
    requiredNumber(ownerFacts ?? {}, 'mipCount') ??
    requiredNumber(ownerFacts ?? {}, 'mipLevelCount') ??
    1;
  const payloadClass =
    readString('payloadClass') ?? classifyPayload(asset.data, format) ?? undefined;
  if (
    subjectDigest === undefined ||
    boundDigest === undefined ||
    uvDigest === undefined ||
    bindingDigest === undefined ||
    format === undefined ||
    colorSpace === undefined ||
    filter === undefined ||
    dimensions.length !== 2 ||
    dimensions.some(
      (value) => typeof value !== 'number' || !Number.isInteger(value) || value <= 0,
    ) ||
    !Number.isInteger(mipCount) ||
    mipCount <= 0 ||
    !isTexturePayloadClass(payloadClass)
  ) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'TextureAsset dimensions and owner binding facts',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'digest/dimensions/format/colorSpace/mipCount/uv/filter/binding',
      },
    );
  }
  const [width = 0, height = 0] = dimensions;
  return {
    ok: true,
    value: {
      subjectDigest,
      boundDigest,
      dimensions: [width, height],
      format,
      colorSpace,
      mipCount,
      uvDigest,
      filter,
      bindingDigest,
      payloadClass,
    },
  };
}

export async function executeTexturePreview(
  args: ResourcePreviewArgs,
  input: ResourcePreviewInput,
) {
  const loaded = await loadResourceSubject(args.guid, input, 'texture');
  if (!loaded.ok) return loaded;
  const inspected = inspectTextureSubject(loaded.value);
  if (!inspected.ok) return inspected;
  const renderer = input.renderer;
  const drawCalls = renderer?.texture?.drawCalls ?? renderer?.drawCalls ?? 0;
  if (
    renderer?.rendererReady !== true ||
    renderer.worldReady !== true ||
    drawCalls <= 0 ||
    renderer.observation === undefined
  ) {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'shared World and Renderer texture stage to produce an observed output',
      {
        phase: 'renderer',
        runId: input.runId,
      },
    );
  }
  const observation = renderer.observation;
  const observedPayloadClass = observationPayloadClass(observation);
  if (observedPayloadClass === undefined) {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the rendered texture observation to classify the actual payload',
      { phase: 'renderer-observation', runId: input.runId },
    );
  }
  if (observation.rendererTextureResident !== true) {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the Renderer to report a resident texture binding for the preview draw',
      { phase: 'renderer-texture-binding', runId: input.runId },
    );
  }
  const observed: TextureOracleInput['observed'] = {
    subjectDigest: observationString(observation, 'subjectDigest') ?? '',
    boundDigest: observationString(observation, 'boundDigest') ?? '',
    dimensions: observationDimensions(observation) ?? [0, 0],
    format: observationString(observation, 'format') ?? '',
    colorSpace: observationString(observation, 'colorSpace') ?? '',
    mipCount: typeof observation.mipCount === 'number' ? observation.mipCount : 0,
    uvDigest: observationString(observation, 'uvDigest') ?? '',
    filter: observationString(observation, 'filter') ?? '',
    bindingDigest: observationString(observation, 'bindingDigest') ?? '',
    rendererHealthy: renderer.rendererReady && renderer.worldReady,
    drawCalls,
    nonBlackPixels: renderer.nonBlackPixels,
    payloadClass: observedPayloadClass,
  };
  const oracle = evaluateTextureOracle({ requested: inspected.value, observed });
  if (oracle.status !== 'passed') {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the rendered texture binding observation to match the loaded owner facts',
      { phase: 'oracle', runId: input.runId, ...oracle.detail },
    );
  }
  return {
    ok: true as const,
    value: {
      subject: { kind: 'texture' as const, guid: args.guid, digest: inspected.value.subjectDigest },
      presentation: canonicalPresentation('texture'),
      recipe: createCanonicalPreviewRecipe('texture'),
      quad: { projection: 'orthographic', aspect: 'preserving', stage: 'unlit-checker' },
      binding: { filter: inspected.value.filter, digest: inspected.value.bindingDigest },
      oracle,
      artifacts: input.artifacts ?? [],
    },
    artifacts: input.artifacts ?? [],
  };
}
