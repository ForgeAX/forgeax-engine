import { evaluateVfxOracle, type VfxOracleInput } from '../evidence/oracle.js';
import { canonicalPresentation, createCanonicalPreviewRecipe } from '../kit/canonical.js';
import {
  loadResourceSubject,
  type ResourcePreviewArgs,
  type ResourcePreviewInput,
  subjectFailure,
} from './subject.js';

export interface VfxSubjectInspection {
  readonly subjectDigest: string;
  readonly programFingerprint: string;
  readonly emitterDigest: string;
  readonly sampleDigest: string;
  readonly boundsDigest: string;
  readonly computeDigest: string;
  readonly indirectDigest: string;
  readonly contactSheetDigest?: string;
  readonly authoredBounds: readonly [number, number, number, number, number, number];
}

type InspectionResult =
  | { readonly ok: true; readonly value: VfxSubjectInspection }
  | ReturnType<typeof subjectFailure>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteVector(value: unknown, length: number): number[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  )
    return undefined;
  return value;
}

function authoredBounds(
  emitters: readonly Record<string, unknown>[],
): readonly [number, number, number, number, number, number] | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const emitter of emitters) {
    const bounds = emitter.bounds;
    if (!isRecord(bounds) || typeof bounds.kind !== 'string') return undefined;
    if (bounds.kind === 'sphere') {
      const center = finiteVector(bounds.center, 3);
      const radius = bounds.radius;
      if (
        center === undefined ||
        typeof radius !== 'number' ||
        !Number.isFinite(radius) ||
        radius < 0
      )
        return undefined;
      const [x, y, z] = center;
      if (x === undefined || y === undefined || z === undefined) return undefined;
      minX = Math.min(minX, x - radius);
      minY = Math.min(minY, y - radius);
      minZ = Math.min(minZ, z - radius);
      maxX = Math.max(maxX, x + radius);
      maxY = Math.max(maxY, y + radius);
      maxZ = Math.max(maxZ, z + radius);
      continue;
    }
    if (bounds.kind === 'aabb') {
      const min = finiteVector(bounds.min, 3);
      const max = finiteVector(bounds.max, 3);
      if (
        min === undefined ||
        max === undefined ||
        min.some((entry, index) => entry > (max[index] ?? entry))
      )
        return undefined;
      const [loX, loY, loZ] = min;
      const [hiX, hiY, hiZ] = max;
      if (
        loX === undefined ||
        loY === undefined ||
        loZ === undefined ||
        hiX === undefined ||
        hiY === undefined ||
        hiZ === undefined
      )
        return undefined;
      minX = Math.min(minX, loX);
      minY = Math.min(minY, loY);
      minZ = Math.min(minZ, loZ);
      maxX = Math.max(maxX, hiX);
      maxY = Math.max(maxY, hiY);
      maxZ = Math.max(maxZ, hiZ);
      continue;
    }
    return undefined;
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return undefined;
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

function jsonDigest(value: unknown): string | undefined {
  const encoded = JSON.stringify(value);
  return typeof encoded === 'string' && encoded.length > 0 ? encoded : undefined;
}

export function inspectVfxSubject(input: {
  readonly guid: string;
  readonly asset: unknown;
  readonly digest?: string;
  readonly ownerFacts?: Readonly<Record<string, string | number | boolean>>;
}): InspectionResult {
  if (!isRecord(input.asset) || input.asset.kind !== 'particle-effect') {
    return subjectFailure(
      'resource-preview-kind-mismatch',
      'a ParticleEffectAsset with kind particle-effect',
      {
        phase: 'subject',
        guid: input.guid,
        actualKind:
          isRecord(input.asset) && typeof input.asset.kind === 'string'
            ? input.asset.kind
            : 'unknown',
      },
    );
  }
  if (input.asset.schemaVersion !== 3) {
    return subjectFailure('resource-preview-subject-invalid', 'a schema-v3 ParticleEffectAsset', {
      phase: 'subject',
      guid: input.guid,
      field: 'schemaVersion',
    });
  }
  const program = input.asset.program;
  const programFingerprint = requiredString(input.asset.programFingerprint);
  if (!isRecord(program) || program.format !== 'forgeax-vfx-program-4') {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'a cooked forgeax-vfx-program-4 payload',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'program',
      },
    );
  }
  if (
    programFingerprint === undefined ||
    requiredString(program.fingerprint) !== programFingerprint
  ) {
    return subjectFailure('resource-preview-subject-invalid', 'non-empty authored VFX bounds', {
      phase: 'subject',
      guid: input.guid,
      field: 'programFingerprint',
    });
  }
  const rawEmitters = Array.isArray(program.emitters) ? program.emitters : [];
  const emitters = rawEmitters.filter(isRecord);
  const definitions = Array.isArray(input.asset.emitters)
    ? input.asset.emitters.filter(isRecord)
    : [];
  if (
    emitters.length === 0 ||
    emitters.length !== rawEmitters.length ||
    definitions.length !== emitters.length
  ) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'the ParticleEffectAsset to publish matching cooked emitter definitions',
      { phase: 'subject', guid: input.guid, field: 'emitters' },
    );
  }
  for (const [index, emitter] of emitters.entries()) {
    const id = requiredString(emitter.id);
    const module = requiredString(emitter.module);
    const capacity = emitter.capacity;
    const backend = emitter.backend;
    const renderers = emitter.renderers;
    if (
      id === undefined ||
      module === undefined ||
      typeof capacity !== 'number' ||
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      !isRecord(backend) ||
      backend.required !== 'gpu' ||
      !isRecord(emitter.schedule) ||
      !Array.isArray(renderers) ||
      !isRecord(definitions[index]) ||
      definitions[index].id !== id ||
      definitions[index].capacity !== capacity
    ) {
      return subjectFailure(
        'resource-preview-subject-invalid',
        'each cooked emitter to match its ParticleEffectAsset definition',
        { phase: 'subject', guid: input.guid, field: `emitters[${index}]` },
      );
    }
  }
  const bounds = authoredBounds(emitters);
  if (bounds === undefined) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'finite authored VFX emitter bounds',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'program.emitters[].bounds',
      },
    );
  }
  const emitterDigest = jsonDigest(
    emitters.map(({ id, module, capacity }) => ({ id, module, capacity })),
  );
  const sampleDigest = jsonDigest(emitters.map(({ id, schedule }) => ({ id, schedule })));
  const boundsDigest = jsonDigest(
    emitters.map(({ id, bounds: emitterBounds }) => ({ id, bounds: emitterBounds })),
  );
  const indirectDigest = jsonDigest(
    emitters.map(({ id, renderers }) => ({
      id,
      renderers: (renderers as readonly unknown[]).filter(isRecord).map((renderer) => ({
        kind: renderer.kind,
        enabled: renderer.enabled ?? true,
      })),
    })),
  );
  if (
    emitterDigest === undefined ||
    sampleDigest === undefined ||
    boundsDigest === undefined ||
    indirectDigest === undefined
  ) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'the cooked VFX program to publish stable emitter, schedule, bounds, and renderer facts',
      { phase: 'subject', guid: input.guid, field: 'program.emitters' },
    );
  }
  const ownerFacts = isRecord(input.asset.ownerFacts) ? input.asset.ownerFacts : input.ownerFacts;
  const subjectDigest =
    requiredString(input.asset.digest) ??
    requiredString(input.digest) ??
    requiredString(ownerFacts?.subjectDigest) ??
    programFingerprint;
  const contactSheetDigest = requiredString(ownerFacts?.contactSheetDigest);
  return {
    ok: true,
    value: {
      subjectDigest,
      programFingerprint,
      emitterDigest,
      sampleDigest,
      boundsDigest,
      computeDigest: programFingerprint,
      indirectDigest,
      ...(contactSheetDigest === undefined ? {} : { contactSheetDigest }),
      authoredBounds: bounds,
    },
  };
}

export async function executeVfxPreview(args: ResourcePreviewArgs, input: ResourcePreviewInput) {
  const loaded = await loadResourceSubject(args.guid, input, 'vfx');
  if (!loaded.ok) return loaded;
  const inspected = inspectVfxSubject(loaded.value);
  if (!inspected.ok) return inspected;
  const renderer = input.renderer;
  const runtime = input.renderer?.vfx;
  if (
    renderer?.rendererReady !== true ||
    renderer.worldReady !== true ||
    runtime === undefined ||
    renderer.observation === undefined
  ) {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'shared World, Renderer, and VFX compute runtime',
      {
        phase: 'renderer',
        runId: input.runId,
      },
    );
  }
  const observation = renderer.observation;
  const observedString = (field: string): string =>
    typeof observation[field] === 'string' ? (observation[field] as string) : '';
  const authoredBounds = observation.authoredBounds;
  const seed = observation.seed;
  const fixedDelta = observation.fixedDelta;
  const timelineFrames = observation.timelineFrames;
  if (
    !Array.isArray(authoredBounds) ||
    authoredBounds.length !== 6 ||
    authoredBounds.some((value) => typeof value !== 'number' || !Number.isFinite(value)) ||
    typeof seed !== 'number' ||
    typeof fixedDelta !== 'number' ||
    typeof timelineFrames !== 'number' ||
    !Number.isInteger(timelineFrames) ||
    timelineFrames <= 0 ||
    !Number.isFinite(seed) ||
    !Number.isFinite(fixedDelta) ||
    fixedDelta <= 0
  ) {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the VFX render observation to include authored bounds and timeline facts',
      { phase: 'renderer-observation', runId: input.runId },
    );
  }
  const observed: VfxOracleInput['observed'] = {
    ...inspected.value,
    subjectDigest: observedString('subjectDigest'),
    programFingerprint: observedString('programFingerprint'),
    emitterDigest: observedString('emitterDigest'),
    sampleDigest: observedString('sampleDigest'),
    boundsDigest: observedString('boundsDigest'),
    computeDigest: observedString('computeDigest'),
    indirectDigest: observedString('indirectDigest'),
    ...(observedString('contactSheetDigest') === ''
      ? {}
      : { contactSheetDigest: observedString('contactSheetDigest') }),
    authoredBounds: authoredBounds as unknown as readonly [
      number,
      number,
      number,
      number,
      number,
      number,
    ],
    seed,
    fixedDelta,
    timelineFrames,
    rendererHealthy: renderer.rendererReady && renderer.worldReady,
    dispatches: runtime.dispatches,
    indirectDraws: runtime.indirectDraws,
    subjectOutputs: runtime.subjectOutputs,
    nonBlackPixels: renderer.nonBlackPixels,
  };
  const oracle = evaluateVfxOracle({ requested: inspected.value, observed });
  if (oracle.status !== 'passed') {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the VFX compute and indirect observation to match the loaded owner facts',
      { phase: 'oracle', runId: input.runId, ...oracle.detail },
    );
  }
  return {
    ok: true as const,
    value: {
      subject: { kind: 'vfx' as const, guid: args.guid, digest: inspected.value.subjectDigest },
      presentation: canonicalPresentation('vfx'),
      recipe: createCanonicalPreviewRecipe('vfx'),
      authoredBounds: inspected.value.authoredBounds,
      timeline: {
        seed,
        fixedDelta,
        frames: timelineFrames,
      },
      oracle,
      artifacts: input.artifacts ?? [],
    },
    artifacts: input.artifacts ?? [],
  };
}
