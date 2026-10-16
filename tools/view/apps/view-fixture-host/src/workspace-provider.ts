import type {
  EngineWorkspaceAsset,
  EngineWorkspacePreview,
  EngineWorkspaceProvider,
  EngineWorkspaceTarget,
} from '@forgeax/engine/app';
import { EngineWorkspaceError } from '@forgeax/engine/app';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { ASSETS, EDITOR_TARGET_ID, INSPECTIONS, PROJECT, PROJECT_ROOT, SCENE_NODES } from './scenarios/default.ts';

const MESH_FACTS: Record<string, { vertexCount: number; triangleCount: number }> = {
  'geometry/box': { vertexCount: 24, triangleCount: 12 },
  'geometry/plane': { vertexCount: 4, triangleCount: 2 },
  'geometry/sphere': { vertexCount: 561, triangleCount: 1024 },
  'geometry/torus': { vertexCount: 578, triangleCount: 1152 },
};

function abort(signal?: AbortSignal) { signal?.throwIfAborted(); }
type ProjectInput = { root: string; signal?: AbortSignal };
type AssetInput = { guid: string; signal?: AbortSignal };
type PreviewInput = { asset: EngineWorkspaceAsset; signal?: AbortSignal };
type EntityInput = { entityId: string };
type HighlightInput = { entityId?: string };

function unavailable(operation: string): never {
  throw new EngineWorkspaceError(
    'engine-workspace-capability-unavailable',
    `${operation} requires a rendered Engine target`,
    'Use a real Engine workspace for rendering operations.',
  );
}

/** Dev-only Engine provider; the actual workspace lifecycle and Host protocol stay production-owned. */
export function createFixtureWorkspaceProvider(): EngineWorkspaceProvider {
  const target: EngineWorkspaceTarget = {
    targetId: EDITOR_TARGET_ID, sessionId: 'fixture-session', worldId: 'fixture-world',
    generation: 1, headed: true, width: 1280, height: 720,
  };
  const handle = Object.freeze({ projectId: PROJECT.id });
  const entityNumber = { world: 1, ground: 2, player: 3, sun: 4 } as const;
  return {
    openProject({ root, signal }: ProjectInput) {
      abort(signal);
      if (root !== PROJECT_ROOT) throw new EngineWorkspaceError(
        'engine-workspace-project-mismatch', PROJECT_ROOT, 'Open the fixture project root.',
      );
      return { project: PROJECT, target, handle };
    },
    closeProject() {},
    listAssets({ signal }: { signal?: AbortSignal }) {
      abort(signal);
      return ASSETS;
    },
    inspectAsset({ guid, signal }: AssetInput) {
      abort(signal);
      const asset = ASSETS.find(item => item.guid === guid);
      if (!asset) throw new EngineWorkspaceError('engine-workspace-asset-not-found', 'A fixture asset');
      return {
        guid, asset, source: { path: asset.sourcePath },
        meta: asset.kind === 'mesh'
          ? { sourceKey: asset.sourceKey, topology: 'triangles', ...MESH_FACTS[asset.sourceKey ?? ''] }
          : { sourceKey: asset.sourceKey },
      };
    },
    openPreview({ asset, signal }: PreviewInput): EngineWorkspacePreview {
      abort(signal);
      if (asset.kind !== 'scene' && asset.kind !== 'mesh') unavailable(`Preview for ${asset.kind}`);
      const fixtureAsset = ASSETS.find(item => item.guid === asset.guid);
      if (!fixtureAsset) throw new EngineWorkspaceError('engine-workspace-asset-not-found', 'A fixture asset');
      if (asset.kind === 'mesh') {
        return {
          target: { ...target, targetId: `fixture-mesh-${asset.guid}`, worldId: `fixture-mesh-${asset.guid}` },
          asset: fixtureAsset,
          getCamera() { return { version: 0, camera: null }; },
          close() {},
        };
      }
      return {
        target,
        asset: fixtureAsset,
        getCamera() { return unavailable('Camera inspection'); },
        tools: {
          tree() { return { targetId: target.targetId, worldId: target.worldId, revision: 1, sampledAt: Date.now(), nodes: SCENE_NODES.map(node => ({ ...node, entity: node.entity as EntityHandle })), nextOffset: null }; },
          inspect({ entityId }: EntityInput) {
            const inspection = INSPECTIONS[entityId as keyof typeof INSPECTIONS];
            if (!inspection) throw new EngineWorkspaceError('engine-workspace-entity-not-found', 'A fixture scene entity');
            return {
              ...inspection, entity: entityNumber[entityId as keyof typeof entityNumber] as EntityHandle,
              targetId: target.targetId, worldId: target.worldId, sampledAt: Date.now(),
              components: inspection.components.map(component => ({
                ...component, schema: {}, meta: {}, writable: false,
              })),
            };
          },
          focus({ entityId }: EntityInput) {
            if (!(entityId in INSPECTIONS)) throw new EngineWorkspaceError('engine-workspace-entity-not-found', 'A fixture scene entity');
            return { entityId, targetId: target.targetId };
          },
          highlight({ entityId }: HighlightInput) {
            if (entityId && !(entityId in INSPECTIONS)) throw new EngineWorkspaceError('engine-workspace-entity-not-found', 'A fixture scene entity');
            return { entityId: entityId ?? null, targetId: target.targetId };
          },
        } as NonNullable<EngineWorkspacePreview['tools']>,
        close() {},
      };
    },
  };
}
