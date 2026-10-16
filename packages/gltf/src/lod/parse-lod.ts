import { err, gltfErr, ok, type Result } from '../errors.js';

export interface GltfLodRelation {
  readonly rootNode: number;
  readonly lodNodeIds: readonly number[];
  readonly screenCoverages: readonly number[];
  /** All node-level MSFT_lod groups, retained for multi-root scenes. */
  readonly groups: readonly GltfLodGroup[];
}

export interface GltfLodGroup {
  readonly rootNode: number;
  readonly lodNodeIds: readonly number[];
  readonly screenCoverages: readonly number[];
}

interface RawNode {
  readonly mesh?: unknown;
  readonly extensions?: { readonly MSFT_lod?: { readonly ids?: unknown } };
  readonly extras?: { readonly MSFT_screencoverage?: unknown };
}

interface RawMesh {
  readonly primitives?: unknown;
}

interface RawGltf {
  readonly extensionsRequired?: readonly unknown[];
  readonly meshes?: readonly RawMesh[];
  readonly nodes?: readonly RawNode[];
  readonly extensions?: { readonly MSFT_screencoverage?: { readonly scales?: unknown } };
}

export function parseGltfLodExtension(
  json: unknown,
): Result<GltfLodRelation, ReturnType<typeof gltfErr<'gltf-lod-invalid'>>> {
  const doc = json as RawGltf;
  const nodes = doc.nodes ?? [];
  const rawCoverage = doc.extensions?.MSFT_screencoverage?.scales;
  const groups: GltfLodGroup[] = [];
  for (let rootNode = 0; rootNode < nodes.length; rootNode += 1) {
    if (nodes[rootNode]?.extensions?.MSFT_lod === undefined) continue;
    const idsRaw = nodes[rootNode]?.extensions?.MSFT_lod?.ids;
    if (!Array.isArray(idsRaw)) {
      return err(gltfErr('gltf-lod-invalid', { rootNode, ids: [], reason: 'not-integer' }));
    }
    const ids = idsRaw.filter((value): value is number => typeof value === 'number');
    if (
      ids.length !== idsRaw.length ||
      ids.some((id) => !Number.isInteger(id) || id < 0 || id >= nodes.length)
    ) {
      return err(gltfErr('gltf-lod-invalid', { rootNode, ids, reason: 'missing-node' }));
    }
    if (new Set(ids).size !== ids.length || ids.includes(rootNode)) {
      return err(gltfErr('gltf-lod-invalid', { rootNode, ids, reason: 'duplicate-node' }));
    }
    const hasMesh = (node: RawNode | undefined): boolean => {
      if (typeof node?.mesh !== 'number' || !Number.isInteger(node.mesh) || node.mesh < 0) {
        return false;
      }
      const mesh = doc.meshes?.[node.mesh];
      // An extension relation is publishable only when its target mesh has at
      // least one primitive. The parser normally receives the source mesh
      // table, so an empty table/primitive list is a source-contract failure;
      // treating it as a valid relation would let toAssetPack silently drop
      // the LOD level later.
      return mesh !== undefined && Array.isArray(mesh.primitives) && mesh.primitives.length > 0;
    };
    if (!hasMesh(nodes[rootNode]) || ids.some((id) => !hasMesh(nodes[id]))) {
      return err(gltfErr('gltf-lod-invalid', { rootNode, ids, reason: 'missing-node' }));
    }
    const nodeCoverage = nodes[rootNode]?.extras?.MSFT_screencoverage;
    const coverage = normalizeScreenCoverages(
      nodeCoverage === undefined ? rawCoverage : nodeCoverage,
      ids.length,
      nodeCoverage !== undefined,
    );
    if (coverage === 'invalid') {
      return err(gltfErr('gltf-lod-invalid', { rootNode, ids, reason: 'coverage' }));
    }
    groups.push({
      rootNode,
      lodNodeIds: ids,
      screenCoverages: coverage ?? [],
    });
  }
  const first = groups[0];
  if (first === undefined) {
    if (doc.extensionsRequired?.some((extension) => extension === 'MSFT_lod')) {
      return err(gltfErr('gltf-lod-invalid', { rootNode: 0, ids: [], reason: 'missing-node' }));
    }
    return ok({ rootNode: 0, lodNodeIds: [], screenCoverages: [], groups: [] });
  }
  return ok({
    rootNode: first.rootNode,
    lodNodeIds: first.lodNodeIds,
    screenCoverages: first.screenCoverages,
    groups,
  });
}

/**
 * Normalize the official node `extras.MSFT_screencoverage` form and the
 * historical ForgeaX document-extension adapter form. The official array
 * includes one terminal threshold for the discard range, while MeshAsset
 * stores only the thresholds that select lower geometry levels.
 */
function normalizeScreenCoverages(
  raw: unknown,
  lodCount: number,
  officialNodeForm: boolean,
): readonly number[] | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return 'invalid';
  if (
    raw.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1,
    )
  ) {
    return 'invalid';
  }
  const expectedLengths = officialNodeForm ? [lodCount + 1] : [lodCount, lodCount + 1];
  if (!expectedLengths.includes(raw.length)) return 'invalid';
  const values = raw.slice(0, lodCount) as number[];
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] as number) >= (values[index - 1] as number)) return 'invalid';
  }
  return values;
}
