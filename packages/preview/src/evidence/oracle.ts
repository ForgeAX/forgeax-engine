export type PreviewOracleStatus = PreviewOracle['status'];

export type PreviewOracle =
  | {
      readonly status: 'passed';
      readonly subjectBound: true;
      readonly drawCalls: number;
      readonly dispatches: number;
      readonly rendererHealthy: true;
      readonly detail: Record<string, string | number | boolean>;
    }
  | {
      readonly status: 'failed';
      readonly subjectBound: false;
      readonly drawCalls: number;
      readonly dispatches: number;
      readonly rendererHealthy: boolean;
      readonly detail: Record<string, string | number | boolean>;
    };

export function passedPreviewOracle(input: {
  readonly drawCalls: number;
  readonly dispatches?: number;
  readonly detail: Record<string, string | number | boolean>;
}): PreviewOracle {
  return {
    status: 'passed',
    subjectBound: true,
    drawCalls: input.drawCalls,
    dispatches: input.dispatches ?? 0,
    rendererHealthy: true,
    detail: { ...input.detail },
  };
}

export function failedPreviewOracle(input: {
  readonly drawCalls?: number;
  readonly dispatches?: number;
  readonly rendererHealthy?: boolean;
  readonly detail: Record<string, string | number | boolean>;
}): PreviewOracle {
  return {
    status: 'failed',
    subjectBound: false,
    drawCalls: input.drawCalls ?? 0,
    dispatches: input.dispatches ?? 0,
    rendererHealthy: input.rendererHealthy ?? false,
    detail: { ...input.detail },
  };
}

export interface MaterialOracleInput {
  readonly requested: {
    readonly subjectDigest: string;
    readonly program: string;
    readonly pass: string;
    readonly bindingsDigest: string;
    readonly closureDigest: string;
  };
  readonly observed: MaterialOracleInput['requested'] & {
    readonly rendererHealthy: boolean;
    readonly drawCalls: number;
    readonly nonBlackPixels: number;
  };
}

export interface MeshOracleInput {
  readonly requested: {
    readonly subjectDigest: string;
    readonly vertexDigest: string;
    readonly indexDigest: string;
    readonly submeshDigest: string;
    readonly aabbDigest: string;
    readonly aabb?: readonly [number, number, number, number, number, number];
    readonly submeshCount?: number;
    readonly materialSlotCount?: number;
  };
  readonly observed: MeshOracleInput['requested'] & {
    readonly rendererHealthy: boolean;
    readonly drawCalls: number;
    readonly nonBlackPixels: number;
  };
}

function oracleDetail(
  kind: 'material' | 'mesh',
  requested: Record<string, unknown>,
  observed: Record<string, unknown>,
  mismatch: string | undefined,
): Record<string, string | number | boolean> {
  return {
    kind,
    mismatch: mismatch ?? 'none',
    requestedSubjectDigest:
      typeof requested.subjectDigest === 'string' ? requested.subjectDigest : 'unknown',
    observedSubjectDigest:
      typeof observed.subjectDigest === 'string' ? observed.subjectDigest : 'unknown',
    requestedOwnerDigest: JSON.stringify(requested),
    observedOwnerDigest: JSON.stringify(observed),
  };
}

function firstMismatch(
  requested: Record<string, unknown>,
  observed: Record<string, unknown>,
): string | undefined {
  for (const key of Object.keys(requested)) {
    const requestedValue = requested[key];
    const observedValue = observed[key];
    if (
      Array.isArray(requestedValue) ||
      Array.isArray(observedValue) ||
      typeof requestedValue === 'object' ||
      typeof observedValue === 'object'
    ) {
      if (JSON.stringify(requestedValue) !== JSON.stringify(observedValue)) return key;
    } else if (requestedValue !== observedValue) {
      return key;
    }
  }
  return undefined;
}

export function evaluateMaterialOracle(input: MaterialOracleInput): PreviewOracle {
  const requested = input.requested as unknown as Record<string, string>;
  const observed = input.observed as unknown as Record<string, string>;
  const mismatch = firstMismatch(requested, observed);
  const healthy = input.observed.rendererHealthy && input.observed.drawCalls > 0;
  const detail = oracleDetail('material', requested, observed, mismatch);
  if (mismatch !== undefined || !healthy) {
    return failedPreviewOracle({
      drawCalls: input.observed.drawCalls,
      rendererHealthy: input.observed.rendererHealthy,
      detail: { ...detail, rendererHealthy: input.observed.rendererHealthy },
    });
  }
  return passedPreviewOracle({
    drawCalls: input.observed.drawCalls,
    detail: { ...detail, rendererHealthy: true },
  });
}

export function evaluateMeshOracle(input: MeshOracleInput): PreviewOracle {
  const requested = input.requested as unknown as Record<string, string>;
  const observed = input.observed as unknown as Record<string, string>;
  const mismatch = firstMismatch(requested, observed);
  const healthy = input.observed.rendererHealthy && input.observed.drawCalls > 0;
  const detail = oracleDetail('mesh', requested, observed, mismatch);
  if (mismatch !== undefined || !healthy) {
    return failedPreviewOracle({
      drawCalls: input.observed.drawCalls,
      rendererHealthy: input.observed.rendererHealthy,
      detail: { ...detail, rendererHealthy: input.observed.rendererHealthy },
    });
  }
  return passedPreviewOracle({
    drawCalls: input.observed.drawCalls,
    detail: { ...detail, rendererHealthy: true },
  });
}

export interface VfxOracleInput {
  readonly requested: {
    readonly subjectDigest: string;
    readonly programFingerprint: string;
    readonly emitterDigest: string;
    readonly sampleDigest: string;
    readonly boundsDigest: string;
    readonly computeDigest: string;
    readonly indirectDigest: string;
    readonly contactSheetDigest?: string;
    readonly authoredBounds?: readonly [number, number, number, number, number, number];
    readonly seed?: number;
    readonly fixedDelta?: number;
    readonly timelineFrames?: number;
  };
  readonly observed: VfxOracleInput['requested'] & {
    readonly rendererHealthy: boolean;
    readonly dispatches: number;
    readonly indirectDraws: number;
    readonly subjectOutputs: number;
    readonly nonBlackPixels: number;
  };
}

export interface TextureOracleInput {
  readonly requested: {
    readonly subjectDigest: string;
    readonly boundDigest: string;
    readonly dimensions: readonly [number, number];
    readonly format: string;
    readonly colorSpace: string;
    readonly mipCount: number;
    readonly uvDigest: string;
    readonly filter: string;
    readonly bindingDigest: string;
  };
  readonly observed: TextureOracleInput['requested'] & {
    readonly rendererHealthy: boolean;
    readonly drawCalls: number;
    readonly nonBlackPixels: number;
    readonly payloadClass: 'black' | 'transparent' | 'single-channel' | 'color';
  };
}

function identityRecord(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      Array.isArray(value) ? JSON.stringify(value) : String(value),
    ]),
  );
}

function evaluateIdentityOracle(
  kind: 'vfx' | 'texture',
  requestedInput: Record<string, unknown>,
  observedInput: Record<string, unknown>,
  healthy: boolean,
  drawCalls: number,
  dispatches: number,
  detailOverrides: Record<string, string | number | boolean>,
): PreviewOracle {
  const requested = identityRecord(requestedInput);
  const observed = identityRecord(observedInput);
  const mismatch = firstMismatch(requested, observed);
  const detail = {
    kind,
    mismatch: mismatch ?? 'none',
    requestedSubjectDigest: requested.subjectDigest ?? 'unknown',
    observedSubjectDigest: observed.subjectDigest ?? 'unknown',
    requestedOwnerDigest: JSON.stringify(requested),
    observedOwnerDigest: JSON.stringify(observed),
    ...detailOverrides,
  };
  if (mismatch !== undefined || !healthy) {
    return failedPreviewOracle({ drawCalls, dispatches, rendererHealthy: healthy, detail });
  }
  return passedPreviewOracle({ drawCalls, dispatches, detail });
}

export function evaluateVfxOracle(input: VfxOracleInput): PreviewOracle {
  const observed = input.observed;
  const healthy =
    observed.rendererHealthy &&
    observed.dispatches > 0 &&
    observed.indirectDraws > 0 &&
    observed.subjectOutputs > 0;
  return evaluateIdentityOracle(
    'vfx',
    input.requested,
    input.observed,
    healthy,
    observed.indirectDraws,
    observed.dispatches,
    {
      rendererHealthy: observed.rendererHealthy,
      indirectDraws: observed.indirectDraws,
      subjectOutputs: observed.subjectOutputs,
      nonBlackPixels: observed.nonBlackPixels,
    },
  );
}

export function evaluateTextureOracle(input: TextureOracleInput): PreviewOracle {
  const observed = input.observed;
  return evaluateIdentityOracle(
    'texture',
    input.requested,
    input.observed,
    observed.rendererHealthy && observed.drawCalls > 0,
    observed.drawCalls,
    0,
    {
      rendererHealthy: observed.rendererHealthy,
      payloadClass: observed.payloadClass,
      nonBlackPixels: observed.nonBlackPixels,
    },
  );
}
