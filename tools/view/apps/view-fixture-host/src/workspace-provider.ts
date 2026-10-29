import type {
  EngineWorkspaceAsset,
  EngineWorkspacePreview,
  EngineWorkspaceProvider,
  EngineWorkspaceTarget,
} from '@forgeax/engine/app';
import { EngineWorkspaceError } from '@forgeax/engine/app';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { PackAuthoringDraft, type PackDraftDocument } from '@forgeax/engine-pack/source';
import { ASSETS, FIXTURE_SESSION_ID, SCENE_TARGET_ID, INSPECTIONS, PROJECT, PROJECT_ROOT, SCENE_NODES } from './scenarios/default.ts';

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
  const drafts = new Map<string, { document: PackDraftDocument; draft: PackAuthoringDraft<number> }>();
  let nextDraftId = 0;
  const target: EngineWorkspaceTarget = {
    targetId: SCENE_TARGET_ID, sessionId: FIXTURE_SESSION_ID, worldId: 'fixture-world',
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
    closeProject() {
      for (const entry of drafts.values()) entry.draft.close();
      drafts.clear();
    },
    async authorPack({ request, signal }) {
      abort(signal);
      if (request.action === 'open') {
        const sourcePath = request.sourcePath ?? '';
        const source = ASSETS.find(asset => asset.sourcePath === sourcePath || asset.sourcePath === `${PROJECT_ROOT}/${sourcePath}`);
        if (!source || !sourcePath.endsWith('.pack.ts')) unavailable('Pack authoring');
        const existing = drafts.get(sourcePath);
        if (existing) return existing.draft.snapshot();
        const document: PackDraftDocument = {
          sourcePath, revision: 'fixture-1', packageId: `fixture:${source.sourceKey}`,
          format: 'pack.ts', generationIdentity: sourcePath,
          fields: [
            { name: 'quality', type: 'enum', default: 'High', values: ['Low', 'Medium', 'High'], path: ['parameters', 'quality'] },
            { name: 'density', type: 'f32', default: 0.75, minimum: 0, maximum: 1, path: ['parameters', 'density'] },
            { name: 'tint', type: 'color', default: [0.24, 0.68, 0.57, 1], path: ['parameters', 'tint'], apply: { asset: source.sourceKey ?? '', path: ['tint'] } },
            { name: 'enabled', type: 'bool', default: true, path: ['parameters', 'enabled'], apply: { asset: source.sourceKey ?? '', path: ['enabled'] } },
            { name: 'intensity', type: 'f32', default: 1.25, minimum: 0, maximum: 4, path: ['parameters', 'intensity'], apply: { asset: source.sourceKey ?? '', path: ['intensity'] } },
            ...(source.sourceKey === 'scene/showcase' ? [
              { name: 'groundColor', type: 'color' as const, default: [0.36, 0.52, 0.28, 1], path: ['parameters', 'groundColor'], apply: { asset: 'material/ground', path: ['color'] } },
              { name: 'groundRoughness', type: 'f32' as const, default: 0.65, minimum: 0, maximum: 1, path: ['parameters', 'groundRoughness'], apply: { asset: 'material/ground', path: ['roughness'] } },
              { name: 'groundScale', type: 'f32' as const, default: 1, minimum: 0.1, maximum: 8, path: ['parameters', 'groundScale'], apply: { asset: 'mesh/ground', path: ['scale'] } },
              { name: 'groundVisible', type: 'bool' as const, default: true, path: ['parameters', 'groundVisible'], apply: { asset: 'mesh/ground', path: ['visible'] } },
              { name: 'playerColor', type: 'color' as const, default: [0.78, 0.34, 0.2, 1], path: ['parameters', 'playerColor'], apply: { asset: 'material/player', path: ['color'] } },
              { name: 'playerMetallic', type: 'f32' as const, default: 0.2, minimum: 0, maximum: 1, path: ['parameters', 'playerMetallic'], apply: { asset: 'material/player', path: ['metallic'] } },
            ] : []),
          ],
        };
        const draft = new PackAuthoringDraft(`fixture-draft-${++nextDraftId}`, document, {
          generate: async () => nextDraftId,
          adopt: async () => true,
          preview: async () => {},
          save: async (current, changes) => {
            const updated = { ...current, revision: `fixture-${++nextDraftId}`, fields: current.fields.map(field => changes.has(field.name) ? { ...field, default: changes.get(field.name)! } : field) };
            const entry = drafts.get(sourcePath);
            if (entry) entry.document = updated;
            return updated;
          },
        });
        drafts.set(sourcePath, { document, draft });
        return draft.snapshot();
      }
      const entry = [...drafts.values()].find(({ draft }) => draft.id === request.draftId);
      if (!entry) unavailable('Pack draft');
      switch (request.action) {
        case 'get': return entry.draft.snapshot();
        case 'edit': return (await entry.draft.edit(request.field ?? '', request.value)).unwrap();
        case 'generate': return entry.draft.generate();
        case 'save': return entry.draft.save();
        case 'undo': return entry.draft.undo();
        case 'redo': return entry.draft.redo();
        case 'discard': return entry.draft.discard();
        case 'refresh': return entry.draft.refresh(entry.document);
        case 'close': {
          if (entry.draft.snapshot().unsaved && !request.discard) throw new Error('Save or discard changes before closing the fixture draft');
          if (request.discard) await entry.draft.discard();
          entry.draft.close();
          drafts.delete(entry.document.sourcePath);
          return { closed: entry.draft.id };
        }
      }
    },
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
