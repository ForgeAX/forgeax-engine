import { Disabled, Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { GlobalTransform, MorphWeights, Transform } from '@forgeax/engine-scene';
import {
  assertSceneRosterObservation,
  captureSceneSourceGuard,
  type SceneRosterObservation,
  type SceneSourceGuard,
} from '@forgeax/engine-scene/internal';
import { Skin } from '@forgeax/engine-skinning';
import { Terrain } from '@forgeax/engine-terrain';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  CapsuleShadow,
  Lines,
  MeshRenderer,
  Points,
  SpriteInstances,
  SpriteRegionOverride,
} from '../components';
import { GlyphText } from '../components/glyph-text';
import { Tilemap } from '../components/tilemap';
import { renderMaterialContextKey } from '../extract/material-context';
import { resolveVisibility } from '../extract/visibility';
import type {
  DispatchEntry,
  MaterialSnapshotContexts,
  PreparedExtractContext,
  RenderableSnapshot,
} from '../render-system-extract';
import { extractInactiveMeshMember } from '../render-system-extract-tail';
import { renderSourceComponents } from './render-source';

export type MeshSourcePreparationReason =
  | 'stale-input'
  | 'duplicate-member'
  | 'missing-member'
  | 'enabled-member'
  | 'missing-transform'
  | 'source-rejected'
  | 'roster-mismatch'
  | 'unsupported-component'
  | 'author-disabled-outside-roster';

export class MeshSourcePreparationError extends Error {
  readonly code = 'mesh-source-preparation-invalid' as const;

  constructor(
    readonly detail: {
      readonly reason: MeshSourcePreparationReason;
      readonly entity: EntityHandle;
    },
  ) {
    super(`Mesh source preparation rejected: ${detail.reason}`);
    this.name = 'MeshSourcePreparationError';
  }
}

export interface PreparedMeshSource {
  readonly world: World;
  readonly renderables: readonly RenderableSnapshot[];
  /** Source order; the existing admission owner performs pass ordering. */
  readonly dispatch: readonly DispatchEntry[];
  readonly hiddenEntities: ReadonlySet<EntityHandle>;
  /** Owned candidate data, never an admission capability or the ordinary cache. */
  readonly materialSnapshots: MaterialSnapshotContexts;
  /** Source/content qualification only, never a native readiness receipt. */
  readonly isCurrent: () => boolean;
}

export interface MeshSourcePreparation {
  readonly members: readonly EntityHandle[];
  readonly authorDisabled: ReadonlySet<EntityHandle>;
  /** Guards the fixed roster, prepared poses, content and compiler inputs. */
  readonly isCurrent: () => boolean;
  /** Required for actual staged admission; fixed before the first source read. */
  readonly roster?: SceneRosterObservation;
}

export function meshSourceComponents(world: World) {
  // GlobalTransform is a domain output, not authored input. Extraction owns its initial pose guard.
  return [...renderSourceComponents(world), Transform];
}

function reject(reason: MeshSourcePreparationReason, entity: EntityHandle) {
  return err(new MeshSourcePreparationError({ reason, entity }));
}

function validateMember(
  world: World,
  entity: EntityHandle,
): MeshSourcePreparationReason | undefined {
  if (world[worldRead].getFieldValue(entity, Entity, 'self') !== entity) return 'missing-member';
  if (!world.hasComponent(entity, Disabled)) return 'enabled-member';
  const skin = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  if (
    [
      skin,
      MorphWeights,
      CapsuleShadow,
      Lines,
      Points,
      SpriteInstances,
      SpriteRegionOverride,
      Terrain,
      GlyphText,
      Tilemap,
    ].some((component) => world.hasComponent(entity, component))
  )
    return 'unsupported-component';
  if (
    world.hasComponent(entity, MeshRenderer) &&
    (!world.hasComponent(entity, Transform) || !world.hasComponent(entity, GlobalTransform))
  )
    return 'missing-transform';
  return undefined;
}

function sameRosterInput(
  world: World,
  roster: SceneRosterObservation | undefined,
  input: MeshSourcePreparation,
): boolean {
  return (
    roster === undefined ||
    (roster.world === world && !roster.active && roster.members.length === input.members.length)
  );
}
function sameRosterMember(
  roster: SceneRosterObservation | undefined,
  input: MeshSourcePreparation,
  entity: EntityHandle,
  index: number,
): boolean {
  return (
    roster === undefined ||
    (roster.members[index] === entity &&
      roster.isAuthorDisabled(entity) === input.authorDisabled.has(entity))
  );
}
function appendMeshMember(
  world: World,
  context: PreparedExtractContext,
  entity: EntityHandle,
  renderables: RenderableSnapshot[],
  dispatch: DispatchEntry[],
  hidden: Set<EntityHandle>,
): void {
  const member = extractInactiveMeshMember(world, context, entity);
  if (member.renderables.length !== 1)
    throw new MeshSourcePreparationError({ reason: 'source-rejected', entity });
  const offset = renderables.length;
  renderables.push(member.renderables[0] as RenderableSnapshot);
  for (const entry of member.dispatch)
    dispatch.push({ ...entry, renderableIndex: entry.renderableIndex + offset });
  if (member.hidden) hidden.add(entity);
}

interface CapturedMeshMembers {
  readonly renderables: RenderableSnapshot[];
  readonly dispatch: DispatchEntry[];
  readonly hiddenEntities: Set<EntityHandle>;
}
function* captureMeshMembers(
  world: World,
  candidateContext: PreparedExtractContext,
  input: MeshSourcePreparation,
  roster: SceneRosterObservation | undefined,
  isCurrent: () => boolean,
): Generator<void, Result<CapturedMeshMembers, Error>> {
  const renderables: RenderableSnapshot[] = [],
    dispatch: DispatchEntry[] = [];
  const seen = new Set<EntityHandle>(),
    hiddenEntities = new Set<EntityHandle>();
  for (const entity of input.members) {
    if (!isCurrent()) return reject('stale-input', entity);
    if (!sameRosterMember(roster, input, entity, seen.size))
      return reject('roster-mismatch', entity);
    if (seen.has(entity)) return reject('duplicate-member', entity);
    seen.add(entity);
    const invalid = validateMember(world, entity);
    if (invalid !== undefined) return reject(invalid, entity);
    if (!input.authorDisabled.has(entity) && world.hasComponent(entity, MeshRenderer)) {
      appendMeshMember(world, candidateContext, entity, renderables, dispatch, hiddenEntities);
    }
    if (!isCurrent()) return reject('stale-input', entity);
    yield;
  }
  for (const entity of input.authorDisabled) {
    if (!isCurrent()) return reject('stale-input', entity);
    if (!seen.has(entity)) return reject('author-disabled-outside-roster', entity);
    yield;
  }
  if (roster !== undefined && seen.size !== roster.members.length)
    return reject('roster-mismatch', input.members[0] ?? (0 as EntityHandle));
  return ok({ renderables, dispatch, hiddenEntities });
}

/**
 * Read the eligible Scene roster without making it query-visible. Each resume
 * consumes one member, owns its extracted values, and rechecks the caller's
 * source/content guard. The caller retains asset holds and stages these rows
 * privately until its complete roster/seal is accepted by the existing owner.
 */
export function* prepareMeshSourceSteps(
  world: World,
  context: PreparedExtractContext,
  input: MeshSourcePreparation,
): Generator<void, Result<PreparedMeshSource, Error>> {
  // Candidate material adoption must never mutate the ordinary source cache.
  // Shared instance projections reuse their backing at r+2; use the existing
  // uncached extraction path, which owns a copy, for these cross-frame values.
  let valid = true;
  let poses: SceneSourceGuard | undefined;
  const roster = input.roster;
  const checkSource = input.isCurrent;
  const materialContext = context.materialContext;
  const contextKey =
    materialContext === undefined ? undefined : renderMaterialContextKey(materialContext);
  const isCurrent = () => {
    valid =
      valid &&
      world.execution.health === 'healthy' &&
      checkSource.call(input) &&
      context.materialContext === materialContext &&
      (materialContext === undefined || renderMaterialContextKey(materialContext) === contextKey) &&
      (roster === undefined || roster.isCurrent()) &&
      (poses === undefined || poses.isCurrent()) &&
      world.execution.health === 'healthy';
    return valid;
  };
  try {
    if (roster !== undefined) {
      assertSceneRosterObservation(roster, meshSourceComponents(world));
      poses = captureSceneSourceGuard(world, roster.members, [GlobalTransform]).unwrap();
    }
    if (!isCurrent()) return reject('stale-input', input.members[0] ?? (0 as EntityHandle));
    if (!sameRosterInput(world, roster, input))
      return reject('roster-mismatch', input.members[0] ?? (0 as EntityHandle));
    const candidateContext: PreparedExtractContext = {
      ...context,
      materialSnapshotContexts: new Map(),
      instanceCollections: undefined,
      visibility: resolveVisibility(world),
    };
    const captured = yield* captureMeshMembers(world, candidateContext, input, roster, isCurrent);
    if (!captured.ok) return captured;
    if (!isCurrent()) return reject('stale-input', input.members[0] ?? (0 as EntityHandle));
    const { renderables, dispatch, hiddenEntities } = captured.value;
    return ok(
      Object.freeze({
        world,
        renderables: Object.freeze(renderables),
        dispatch: Object.freeze(dispatch),
        hiddenEntities,
        materialSnapshots: candidateContext.materialSnapshotContexts,
        isCurrent,
      }),
    );
  } catch (error) {
    if (error instanceof Error) return err(error);
    throw error;
  }
}
