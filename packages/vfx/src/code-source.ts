import { err, ok, type Result } from '@forgeax/engine-types';

/** Engine-owned seed module used by newly-authored particle effects. */
export const PARTICLE_CODE_DEFAULT_MODULE_ID = 'forgeax_vfx::default' as const;

export type ParticleBoundsSource =
  | {
      readonly kind: 'aabb';
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    }
  | {
      readonly kind: 'sphere';
      readonly center: readonly [number, number, number];
      readonly radius: number;
    };

export type ParticleRendererOverflowPolicy = 'drop-newest' | 'drop-oldest';
export interface ParticleTextureSheetSource {
  readonly columns: number;
  readonly rows: number;
  readonly frameRate: number;
  readonly frameCount?: number;
}

export interface ParticleSoftParticleSource {
  readonly fadeDistance: number;
}

export type ParticleChannelOverflowPolicy = ParticleRendererOverflowPolicy;

export type ParticleStageDomain = 'particle';
export type ParticleStageResourceAccess = 'read' | 'write' | 'read-write';

export interface ParticleStageResourceSource {
  readonly name: string;
  readonly access: ParticleStageResourceAccess;
}

export interface ParticleStageSource {
  readonly id: string;
  readonly entry: string;
  readonly domain: ParticleStageDomain;
  readonly resources: readonly ParticleStageResourceSource[];
  readonly dependsOn: readonly string[];
  readonly iterationBudget: number;
}

export const PARTICLE_STAGE_RESOURCE_NAMES = Object.freeze([
  'particles',
  'runtime',
  'aliveIndices',
  'counters',
  'indirect',
  'scratch',
  'billboardInstances',
  'channelInputs',
  'events',
  'eventCounters',
] as const);

export interface ParticleChannelSource {
  readonly id: string;
  readonly payload?: 'impact';
  readonly capacity: number;
  readonly overflow: ParticleChannelOverflowPolicy;
}

export interface ParticleEventSource {
  readonly id: string;
  readonly channel: string;
  readonly subEmitter: string;
  readonly fanOut: number;
  readonly recursionDepth: number;
}

export interface ParticleEmitterSourceBase {
  readonly id: string;
  readonly capacity: number;
  readonly backend: { readonly required: 'gpu' };
  readonly space: 'local' | 'world';
  readonly bounds: ParticleBoundsSource;
  readonly schedule: {
    readonly rate: number;
    readonly bursts?: readonly { readonly time: number; readonly count: number }[];
    readonly loopDuration?: number;
  };
  readonly program: { readonly module: string };
  readonly channels?: readonly ParticleChannelSource[];
  readonly events?: readonly ParticleEventSource[];
  readonly simulationWhenCulled?: 'continue' | 'pause' | 'restart-on-visible';
}

export interface ParticleCodeSourceInvalidDetail {
  readonly path: string;
  readonly emitterId?: string;
  readonly stageId?: string;
  readonly resource?: string;
}

export interface ParticleCodeSourceError {
  readonly code:
    | 'vfx-source-invalid'
    | 'vfx-source-version-unsupported'
    | 'vfx-source-channel-invalid'
    | 'vfx-source-event-invalid'
    | 'vfx-source-stage-invalid'
    | 'vfx-source-renderer-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: ParticleCodeSourceInvalidDetail;
}

function stageInvalid(
  path: string,
  expected: string,
  stageId?: string,
  resource?: string,
): Result<never, ParticleCodeSourceError> {
  return err({
    code: 'vfx-source-stage-invalid',
    expected,
    hint: `repair stage ${path} and recook the stage declaration`,
    detail: {
      path,
      ...(stageId === undefined ? {} : { stageId }),
      ...(resource === undefined ? {} : { resource }),
    },
  });
}

const STAGE_FIELDS = ['entry', 'domain', 'resources', 'dependsOn', 'iterationBudget'] as const;
const STAGE_RESOURCE_NAMES = new Set<string>(PARTICLE_STAGE_RESOURCE_NAMES);

function parseStageResources(
  value: string,
  path: string,
  stageId: string,
): Result<readonly ParticleStageResourceSource[], ParticleCodeSourceError> {
  if (value.length === 0)
    return stageInvalid(path, 'at least one explicit stage resource', stageId);
  const resources: ParticleStageResourceSource[] = [];
  const names = new Set<string>();
  for (const item of value.split(',')) {
    const [name, access, extra] = item.split(':');
    if (
      name === undefined ||
      access === undefined ||
      extra !== undefined ||
      !STAGE_RESOURCE_NAMES.has(name) ||
      (access !== 'read' && access !== 'write' && access !== 'read-write') ||
      names.has(name)
    ) {
      return stageInvalid(
        path,
        'known resources with unique read, write, or read-write access',
        stageId,
        name,
      );
    }
    names.add(name);
    resources.push({ name, access });
  }
  return ok(Object.freeze(resources));
}

/** Parse compiler-owned stage metadata from authored WGSL comments. */
export function parseVfxStageDeclarations(
  source: string,
): Result<readonly ParticleStageSource[], ParticleCodeSourceError> {
  const stages: ParticleStageSource[] = [];
  const ids = new Set<string>();
  const pattern = /^\s*\/\/\s*#vfx\s+stage\s+([^\s]+)\s+(.+)$/gm;
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    const fieldsText = match[2];
    if (id === undefined || fieldsText === undefined || !/^[A-Za-z_]\w*$/.test(id) || ids.has(id)) {
      return stageInvalid(
        `stage.${id ?? 'unknown'}`,
        'a unique stage id and supported stage declaration',
        id,
      );
    }
    const fields: Record<string, string> = {};
    for (const token of fieldsText.trim().split(/\s+/)) {
      const separator = token.indexOf('=');
      const key = separator < 0 ? undefined : token.slice(0, separator);
      const value = separator < 0 ? undefined : token.slice(separator + 1);
      if (
        key === undefined ||
        value === undefined ||
        !STAGE_FIELDS.includes(key as (typeof STAGE_FIELDS)[number]) ||
        fields[key] !== undefined
      ) {
        return stageInvalid(
          `stage.${id}`,
          'a supported stage declaration with entry, domain, resources, dependsOn, and iterationBudget fields',
          id,
        );
      }
      fields[key] = value;
    }
    const entry = fields.entry;
    const domain = fields.domain;
    const resourcesValue = fields.resources;
    const dependsOnValue = fields.dependsOn;
    const budgetValue = fields.iterationBudget;
    if (
      entry === undefined ||
      !/^[A-Za-z_]\w*$/.test(entry) ||
      entry.startsWith('forgeax_vfx_') ||
      domain !== 'particle' ||
      resourcesValue === undefined ||
      dependsOnValue === undefined ||
      budgetValue === undefined
    ) {
      return stageInvalid(
        `stage.${id}`,
        'a particle-domain stage with an author entry and explicit fields',
        id,
      );
    }
    const resources = parseStageResources(resourcesValue, `stage.${id}.resources`, id);
    if (!resources.ok) return resources;
    const iterationBudget = Number(budgetValue);
    if (!Number.isInteger(iterationBudget) || iterationBudget < 1 || iterationBudget > 64) {
      return stageInvalid(
        `stage.${id}.iterationBudget`,
        'an integer iteration budget from 1 through 64',
        id,
      );
    }
    const dependsOn =
      dependsOnValue === 'none'
        ? []
        : dependsOnValue.split(',').filter((dependency) => dependency.length > 0);
    if (dependsOn.some((dependency) => !/^[A-Za-z_]\w*$/.test(dependency))) {
      return stageInvalid(`stage.${id}.dependsOn`, 'stage identifiers or none', id);
    }
    ids.add(id);
    stages.push({
      id,
      entry,
      domain: 'particle',
      resources: resources.value,
      dependsOn: Object.freeze(dependsOn),
      iterationBudget,
    });
  }
  return ok(Object.freeze(stages));
}
