import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  terrainAxisEndpoint,
  terrainHeightBounds,
  terrainLod,
  terrainTranslationValid,
} from '@forgeax/engine-terrain';
import { deriveOwnedMaterialParameters, type MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  type ExtractedFrame,
  type RenderableSnapshot,
  sortDispatchByQueue,
} from '../render-system-extract.js';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { TerrainLayers } from './layers';
import { terrainShadowReceivers } from './shadow-family.js';
import {
  type TerrainProjectionFacts,
  type TerrainProjectionSectionFacts,
  type TerrainSourceCache,
  terrainDrawSection,
  terrainSourceError,
} from './source';

export function terrainSectionKey(source: RenderableSnapshot, index: number): string {
  return `${source.entityKey}:${index}`;
}

function sameFourParameters(value: unknown, a: number, b: number, c: number, d: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value[0] === a &&
    value[1] === b &&
    value[2] === c &&
    value[3] === d
  );
}

function sameValues(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/** A view-local draw roster derived from one retained entity, without synthetic ECS identities. */
export function projectTerrainView(
  frame: ExtractedFrame,
  accepted: ReadonlyMap<string, RenderableSnapshot>,
  materials: MaterialFrame,
  sourceScope: RenderResourceScope,
  sources: TerrainSourceCache,
  resolveMaterial: (world: RenderResourceScope, handle: number) => MaterialResource,
  layers?: TerrainLayers,
  hasSources = frame.renderables.some((source) => source.terrain !== undefined),
): { frame: ExtractedFrame; materials: MaterialFrame } {
  if (!hasSources) return { frame, materials };
  const camera = frame.cameras[0];
  if (camera === undefined) return { frame, materials };
  const renderables: RenderableSnapshot[] = [],
    dispatch: DispatchEntry[] = [];
  const dispatchByRenderable = new Map<number, DispatchEntry[]>();
  for (const entry of frame.dispatch) {
    const entries = dispatchByRenderable.get(entry.renderableIndex);
    if (entries === undefined) dispatchByRenderable.set(entry.renderableIndex, [entry]);
    else entries.push(entry);
  }
  const shadowFamilies = new Map(
    terrainShadowReceivers(frame.renderables).map(
      (root, index) => [root.entityKey, index + 1] as const,
    ),
  );
  for (const [oldIndex, source] of frame.renderables.entries()) {
    const terrain = source.terrain;
    if (terrain === undefined) {
      const index = renderables.length;
      renderables.push(source);
      for (const entry of dispatchByRenderable.get(oldIndex) ?? [])
        dispatch.push({ ...entry, renderableIndex: index });
      continue;
    }
    const world = sourceScope;
    if (world === undefined)
      terrainSourceError('terrain-query-unavailable', 'World', 'the Terrain resource scope');
    const content = sources.resolve(world, terrain.handle);
    const layerFrame = layers?.capture(world, content);
    const asset = content.asset,
      n = asset.subsectionVertices,
      width = (n - 1) * asset.spacing;
    const nx = (asset.columns - 1) / (n - 1),
      nz = (asset.rows - 1) / (n - 1),
      maxLod = content.grids.length - 1;
    if (!terrainTranslationValid(asset, source.transform.world) || terrain.forcedLod > maxLod)
      terrainSourceError(
        'terrain-pose-unsupported',
        'Transform/LOD',
        'finite supported placement and a resident Terrain LOD',
      );
    const shadowFamily = shadowFamilies.get(source.entityKey) ?? 0;
    const priorFacts = accepted.get(terrainSectionKey(source, 0))?.terrainSection?.projectionFacts;
    const matchesTerrainProjectionCamera = (priorFacts: TerrainProjectionFacts) => {
      return (
        priorFacts.camera[0] === (camera.position?.[0] ?? 0) &&
        priorFacts.camera[1] === (camera.position?.[1] ?? 0) &&
        priorFacts.camera[2] === (camera.position?.[2] ?? 0) &&
        priorFacts.camera[3] === camera.near &&
        priorFacts.camera[4] === camera.fov &&
        priorFacts.camera[5] === camera.projection &&
        priorFacts.camera[6] === camera.orthoTop &&
        priorFacts.camera[7] === camera.orthoBottom
      );
    };
    const matchesTerrainProjectionHeader = () => {
      const headerMatches =
        priorFacts !== undefined &&
        priorFacts.world === world &&
        priorFacts.source === content &&
        priorFacts.sourceVersion === content.version &&
        priorFacts.handle === terrain.handle &&
        priorFacts.lod0Diameter === terrain.lod0Diameter &&
        priorFacts.forcedLod === terrain.forcedLod &&
        priorFacts.layer === terrain.layer &&
        priorFacts.shadowFamily === shadowFamily &&
        priorFacts.authorVisible === source.authorVisible &&
        priorFacts.shadowCaster === source.shadowCaster &&
        priorFacts.shadowReceiver === source.shadowReceiver &&
        sameValues(priorFacts.transform, source.transform.world) &&
        matchesTerrainProjectionCamera(priorFacts);
      return headerMatches;
    };
    const headerMatches = matchesTerrainProjectionHeader();
    let projectionMatches = headerMatches;
    let precheckedMaterials: MaterialResource[] | undefined;
    if (headerMatches && priorFacts !== undefined) {
      const validateRetainedTerrainMaterials = (priorFacts: TerrainProjectionFacts) => {
        for (let index = 0; index < content.sectionCount; index++) {
          const fact = priorFacts.sections[index];
          const section = terrainDrawSection(content, index).data;
          const prior = accepted.get(terrainSectionKey(source, index));
          const proof = prior?.terrainSection?.materialReuse;
          if (typeof section.material !== 'number') {
            projectionMatches = false;
            continue;
          }
          const resource = resolveMaterial(world, section.material);
          if (fact?.materialSource !== resource) {
            if (precheckedMaterials === undefined) precheckedMaterials = [];
            precheckedMaterials[index] = resource;
          }
          const base = resource.snapshot;
          const snapshot = proof?.projectedSnapshot;
          const priorMaterial = prior?.material;
          const checkRetainedTerrainMaterialProof = () => {
            if (
              fact === undefined ||
              proof === undefined ||
              snapshot === undefined ||
              priorMaterial === undefined ||
              !resource.ownsValues(base) ||
              fact.materialSource !== resource ||
              fact.materialSnapshot !== base ||
              fact.layerFrame !== layerFrame ||
              proof.world !== world ||
              proof.source !== resource ||
              proof.sourceSnapshot !== base ||
              proof.layerFrame !== layerFrame ||
              snapshot !== priorMaterial.snapshot ||
              !priorMaterial.ownsValues(snapshot) ||
              proof.acceptedMaterial.resource !== priorMaterial ||
              proof.acceptedMaterial.snapshot !== snapshot ||
              (layerFrame !== undefined && layers?.isBound(snapshot, layerFrame) !== true)
            ) {
              projectionMatches = false;
            }
          };
          checkRetainedTerrainMaterialProof();
        }
      };
      validateRetainedTerrainMaterials(priorFacts);
    }
    const retainedProjectionFacts =
      projectionMatches && priorFacts !== undefined ? priorFacts : undefined;
    const retainedSections = retainedProjectionFacts?.sections;
    const resolveTerrainSectionLods = () => {
      const lods =
        retainedSections === undefined
          ? Array.from({ length: content.sectionCount }, (_, index) => {
              const section = terrainDrawSection(content, index).data;
              if (terrain.forcedLod >= 0) return Math.fround(Math.min(maxLod, terrain.forcedLod));
              const x = section.x + width / 2 + (source.transform.world[12] ?? 0),
                y = (section.minHeight + section.maxHeight) / 2 + (source.transform.world[13] ?? 0),
                z = section.z + width / 2 + (source.transform.world[14] ?? 0);
              const distance = Math.max(
                camera.near,
                Math.hypot(
                  x - (camera.position[0] ?? 0),
                  y - (camera.position[1] ?? 0),
                  z - (camera.position[2] ?? 0),
                ),
              );
              const diameter =
                camera.projection === 'orthographic'
                  ? width / Math.abs(camera.orthoTop - camera.orthoBottom)
                  : width / (distance * Math.tan(camera.fov / 2));
              return Math.fround(terrainLod(diameter, terrain.lod0Diameter, maxLod));
            })
          : undefined;
      return lods;
    };
    const lods = resolveTerrainSectionLods();
    const projectedLod = (index: number): number =>
      retainedSections?.[index]?.lod ?? lods?.[index] ?? 0;
    const projectionSections: TerrainProjectionSectionFacts[] | undefined =
      retainedProjectionFacts !== undefined ? undefined : [];
    const cameraFacts =
      retainedProjectionFacts?.camera ??
      (Object.freeze([
        camera.position?.[0] ?? 0,
        camera.position?.[1] ?? 0,
        camera.position?.[2] ?? 0,
        camera.near,
        camera.fov,
        camera.projection,
        camera.orthoTop,
        camera.orthoBottom,
      ]) as unknown as TerrainProjectionFacts['camera']);
    const projectionFacts: TerrainProjectionFacts = retainedProjectionFacts ?? {
      world,
      source: content,
      sourceVersion: content.version,
      handle: terrain.handle,
      lod0Diameter: terrain.lod0Diameter,
      forcedLod: terrain.forcedLod,
      layer: terrain.layer,
      transform: Object.freeze(Array.from(source.transform.world)),
      camera: cameraFacts,
      shadowFamily,
      authorVisible: source.authorVisible,
      shadowCaster: source.shadowCaster,
      shadowReceiver: source.shadowReceiver,
      sections: projectionSections ?? [],
    };
    let projectionFactsComplete = true;
    const projectTerrainSections = () => {
      for (let index = 0; index < content.sectionCount; index++) {
        const section = terrainDrawSection(content, index).data;
        const retained = retainedSections?.[index];
        const lod = retained?.lod ?? projectedLod(index),
          grid = retained?.grid ?? Math.floor(lod),
          x = index % nx,
          z = Math.floor(index / nx);
        const resolveTerrainNeighbors = () => {
          const neighbors = retained?.neighbors ?? [
            x > 0 ? projectedLod(index - 1) : lod,
            x < nx - 1 ? projectedLod(index + 1) : lod,
            z > 0 ? projectedLod(index - nx) : lod,
            z < nz - 1 ? projectedLod(index + nx) : lod,
          ];
          return neighbors;
        };
        const neighbors = resolveTerrainNeighbors();
        if (typeof section.material !== 'number')
          terrainSourceError(
            'terrain-query-unavailable',
            'material',
            'an admitted Material reference',
          );
        const resource =
          retained?.materialSource ??
          precheckedMaterials?.[index] ??
          (headerMatches ? priorFacts?.sections[index]?.materialSource : undefined) ??
          resolveMaterial(world, section.material);
        const resolveTerrainSectionMaterial = () => {
          const base = retained?.materialSnapshot ?? resource.snapshot;
          if (
            base.textureHandles?.get('terrainHeightTexture') !== section.heightTexture ||
            base.textureHandles?.get('terrainWeightTexture') !== section.weightTexture
          )
            terrainSourceError(
              'terrain-query-unavailable',
              'material terrain bindings',
              'the admitted height/control closure',
            );
          const prior = accepted.get(terrainSectionKey(source, index));
          const priorProof = prior?.terrainSection?.materialReuse;
          const priorMaterial = prior?.material;
          let reusable = retained !== undefined;
          if (!reusable) {
            const matchesTerrainSectionMaterial = () => {
              const capturePriorTerrainMaterialFacts = () => {
                const priorSnapshot = priorProof?.projectedSnapshot;
                const priorParameters = priorSnapshot?.paramSnapshot;
                const layerFrameMatches =
                  layerFrame === undefined
                    ? priorProof?.layerFrame === undefined
                    : priorProof?.layerFrame === layerFrame &&
                      priorSnapshot !== undefined &&
                      layers?.isBound(priorSnapshot, layerFrame) === true;
                const parametersMatch =
                  sameFourParameters(
                    priorParameters?.terrainSection,
                    section.x,
                    section.z,
                    width,
                    n,
                  ) &&
                  sameFourParameters(priorParameters?.terrainLod, grid, lod, nx, nz) &&
                  sameFourParameters(
                    priorParameters?.terrainNeighbors,
                    neighbors[0] ?? lod,
                    neighbors[1] ?? lod,
                    neighbors[2] ?? lod,
                    neighbors[3] ?? lod,
                  ) &&
                  priorParameters?.terrainShadowFamily === shadowFamily;
                return { priorSnapshot, layerFrameMatches, parametersMatch };
              };
              const { priorSnapshot, layerFrameMatches, parametersMatch } =
                capturePriorTerrainMaterialFacts();
              reusable =
                resource.ownsValues(base) &&
                priorProof?.world === world &&
                prior?.terrainSection?.source === content &&
                priorProof?.source === resource &&
                priorProof.sourceSnapshot === base &&
                priorMaterial !== undefined &&
                priorMaterial.snapshot === priorSnapshot &&
                priorSnapshot !== undefined &&
                priorMaterial.ownsValues(priorSnapshot) &&
                priorProof.acceptedMaterial.resource === priorMaterial &&
                priorProof.acceptedMaterial.snapshot === priorSnapshot &&
                layerFrameMatches &&
                parametersMatch;
              return reusable;
            };
            reusable = matchesTerrainSectionMaterial();
          }
          const [minHeight, maxHeight] =
            retained === undefined
              ? terrainHeightBounds(section.minHeight, section.maxHeight)
              : [retained.localAabb[1] ?? 0, retained.localAabb[4] ?? 0];
          let material: MaterialResource;
          if (reusable && priorMaterial !== undefined) material = priorMaterial;
          else {
            const parameters = {
              ...base.paramSnapshot,
              terrainSection: [section.x, section.z, width, n],
              terrainLod: [grid, lod, nx, nz],
              terrainNeighbors: [...neighbors],
              terrainShadowFamily: shadowFamily,
            };
            material =
              deriveOwnedMaterialParameters(resource, base, parameters) ??
              resource.withParameters(parameters);
            if (layerFrame !== undefined) layers?.bind(material.snapshot, layerFrame);
          }
          return {
            base,
            material,
            reusable,
            priorProof,
            prior,
            minHeight,
            maxHeight,
          };
        };
        const { base, material, reusable, priorProof, prior, minHeight, maxHeight } =
          resolveTerrainSectionMaterial();
        if (reusable && priorProof !== undefined)
          materials = materials.withAccepted(priorProof.acceptedMaterial);
        else materials = materials.with(material);
        const acceptedMaterial = materials.get(material);
        const materialProofComplete =
          resource.ownsValues(base) &&
          material.ownsValues(material.snapshot) &&
          acceptedMaterial?.resource === material &&
          acceptedMaterial.snapshot === material.snapshot;
        if (!materialProofComplete) projectionFactsComplete = false;
        const terrainSectionChanged = () => {
          const changed =
            retained === undefined &&
            (prior?.terrainSection === undefined ||
              terrainDrawSection(prior.terrainSection.source, index).heights !==
                terrainDrawSection(content, index).heights ||
              prior.terrainSection.source.asset.spacing !== asset.spacing ||
              prior.terrainSection.source.grids[grid] !== content.grids[grid] ||
              prior.terrainSection?.lod !== lod ||
              neighbors.some((v, i) => v !== prior.terrainSection?.neighbors[i]));
          return changed;
        };
        const changed = terrainSectionChanged();
        const temporal = source.temporal;
        const localAabb = new Float32Array(
          retained?.localAabb ?? [
            section.x,
            minHeight,
            section.z,
            terrainAxisEndpoint(section.x, width),
            maxHeight,
            terrainAxisEndpoint(section.z, width),
          ],
        );
        const dispatchStart = dispatch.length;
        if (retained === undefined)
          projectionSections?.push({
            lod,
            grid,
            neighbors: Object.freeze([...neighbors]),
            localAabb: Object.freeze(Array.from(localAabb)),
            materialSource: resource,
            materialSnapshot: base,
            layerFrame,
            dispatch: [],
          });
        const createTerrainSectionDraw = () => {
          const draw: RenderableSnapshot = {
            ...source,
            assetHandle: Number(content.grids[grid]),
            material,
            materials: [material],
            materialBindingSources: ['mesh-default'],
            localAabb,
            terrainSection:
              retained !== undefined && prior?.terrainSection !== undefined
                ? prior.terrainSection
                : {
                    source: content,
                    index,
                    lod,
                    neighbors,
                    ...(materialProofComplete ? { projectionFacts } : {}),
                    ...(materialProofComplete
                      ? {
                          materialReuse: {
                            world,
                            source: resource,
                            sourceSnapshot: base,
                            projectedSnapshot: material.snapshot,
                            layerFrame,
                            acceptedMaterial,
                          },
                        }
                      : {}),
                  },
            ...(changed
              ? {
                  temporal: {
                    previousSource: temporal?.previousSource ?? 'current-seed',
                    motionValid: false,
                    reactive: true,
                    reactiveReasons: ['geometry-revision'],
                    previousTransform: temporal?.previousTransform ?? source.transform,
                    previousInstances: undefined,
                  },
                }
              : {}),
          };
          return draw;
        };
        const draw = createTerrainSectionDraw();
        const renderableIndex = renderables.length;
        renderables.push(draw);
        const appendTerrainSectionDispatch = () => {
          if (source.authorVisible === false) return;
          if (retained !== undefined) {
            for (const entry of retained.dispatch) dispatch.push({ ...entry, renderableIndex });
          } else
            appendMaterialDispatchEntries(
              dispatch,
              base.passes.filter(
                (pass) =>
                  source.shadowCaster !== false ||
                  ((pass.renderState?.tags as Record<string, string> | undefined)?.LightMode !==
                    'ShadowCaster' &&
                    pass.name !== 'shadow-caster'),
              ),
              source.entityKey as EntityHandle,
              material.snapshot.materialHandle ?? 0,
              renderableIndex,
              terrain.layer,
              0,
              material.snapshot.materialProgramKeys,
            );
          if (retained === undefined) {
            const facts = projectionSections?.[index];
            if (facts !== undefined && projectionSections !== undefined)
              projectionSections[index] = {
                ...facts,
                dispatch: Object.freeze(
                  dispatch
                    .slice(dispatchStart)
                    .map((entry) => Object.freeze({ ...entry, renderableIndex: 0 })),
                ),
              };
          }
        };
        appendTerrainSectionDispatch();
      }
    };
    projectTerrainSections();
    const sealTerrainProjectionFacts = () => {
      if (!projectionMatches) {
        for (const section of projectionSections ?? []) Object.freeze(section);
        if (projectionSections !== undefined) Object.freeze(projectionSections);
        Object.freeze(projectionFacts);
      }
      if (!projectionFactsComplete) {
        for (
          let index = renderables.length - content.sectionCount;
          index < renderables.length;
          index++
        ) {
          const row = renderables[index];
          if (row?.terrainSection?.projectionFacts === projectionFacts) {
            const { projectionFacts: _facts, ...terrainSection } = row.terrainSection;
            renderables[index] = { ...row, terrainSection };
          }
        }
      }
    };
    sealTerrainProjectionFacts();
  }
  return { frame: { ...frame, renderables, dispatch: sortDispatchByQueue(dispatch) }, materials };
}
