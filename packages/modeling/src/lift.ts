import { err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { mergeFlags } from './crease';
import { type ModelingError, modelingError } from './errors';
import { type CornerChannelName, EDGE_SHARP, type EditMesh } from './mesh';
import { type Attribution, markRole, type OpDiagnostic, type RoleCounts } from './ops';

/** Runtime attribute key -> corner channel lifted from it. */
const LIFT_CHANNELS: readonly (readonly [keyof MeshAsset['attributes'], CornerChannelName])[] = [
  ['uv', 'uv0'],
  ['uv1', 'uv1'],
  ['uv2', 'uv2'],
  ['uv3', 'uv3'],
  ['uv4', 'uv4'],
  ['uv5', 'uv5'],
  ['uv6', 'uv6'],
  ['uv7', 'uv7'],
  ['color', 'color'],
];

function sameValues(data: Float32Array, dim: number, a: number, b: number): boolean {
  for (let k = 0; k < dim; k++) {
    if (!Object.is(data[a * dim + k], data[b * dim + k])) return false;
  }
  return true;
}

/**
 * Lift a triangle-list `MeshAsset` into the session. Positions weld by exact f32
 * value; UV and color splits become corner values; an edge whose two faces carry
 * different normals at either end becomes a sharp edge, so export reproduces the
 * source hard edges. Material slots merge by name. Triangles that would break the
 * manifold rule (a third face on an edge, or orientation opposite to a neighbor)
 * are detached onto their own vertices, and triangles that collapse after welding
 * are skipped; both are reported.
 */
export function lift(
  mesh: EditMesh,
  source: MeshAsset,
  attribution: Attribution,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const position = source.attributes.position;
  if (!(position instanceof Float32Array) || position.length % 3 !== 0) {
    return err(
      modelingError(
        'model-precondition',
        'the mesh carries float32 xyz positions',
        { storage: position?.constructor.name ?? 'none' },
        'lift the unquantized mesh produced by the importer or geometry builder',
      ),
    );
  }
  for (const c of position) {
    if (!Number.isFinite(c)) {
      return err(modelingError('model-precondition', 'every position is finite', {}));
    }
  }
  const triangles = source.submeshes.filter((s) => s.topology === 'triangle-list');
  if (triangles.length === 0) {
    return err(
      modelingError('model-precondition', 'the mesh has a triangle-list submesh', {
        topologies: source.submeshes.map((s) => s.topology),
      }),
    );
  }
  const skippedSubmeshes = source.submeshes.length - triangles.length;
  const vertexCount = position.length / 3;
  const indexLength = source.indices?.length ?? vertexCount;
  for (const submesh of triangles) {
    if (submesh.indexOffset < 0 || submesh.indexOffset + submesh.indexCount > indexLength) {
      return err(
        modelingError('model-precondition', 'every submesh range lies inside the index buffer', {
          indexOffset: submesh.indexOffset,
          indexCount: submesh.indexCount,
          indices: indexLength,
        }),
      );
    }
    for (let i = submesh.indexOffset; i < submesh.indexOffset + submesh.indexCount; i++) {
      const r = source.indices === undefined ? i : (source.indices[i] as number);
      if (!Number.isInteger(r) || r < 0 || r >= vertexCount) {
        return err(
          modelingError('model-precondition', 'every index addresses a vertex', {
            at: i,
            index: r,
            vertices: vertexCount,
          }),
        );
      }
    }
  }
  const channels: { name: CornerChannelName; data: Float32Array; dim: number }[] = [];
  const ignored: string[] = [];
  for (const [key, name] of LIFT_CHANNELS) {
    const data = source.attributes[key];
    if (data === undefined) continue;
    if (!(data instanceof Float32Array)) {
      ignored.push(key);
      continue;
    }
    const dim = name === 'color' ? 4 : 2;
    if (data.length !== vertexCount * dim) {
      return err(
        modelingError('model-precondition', 'every lifted attribute has one value per vertex', {
          attribute: key,
          length: data.length,
          expected: vertexCount * dim,
        }),
      );
    }
    channels.push({ name, data, dim });
  }
  const normal =
    source.attributes.normal instanceof Float32Array ? source.attributes.normal : undefined;
  if (normal !== undefined && normal.length !== vertexCount * 3) {
    return err(
      modelingError('model-precondition', 'every lifted attribute has one value per vertex', {
        attribute: 'normal',
        length: normal.length,
        expected: vertexCount * 3,
      }),
    );
  }
  const index = (i: number) => (source.indices === undefined ? i : (source.indices[i] as number));
  // Weld by exact value, then replay the manifold acceptance on welded ids so each
  // vertex can be split into one copy per corner fan (bowties) before insertion.
  const weldIds = new Map<string, number>();
  const weldPosition: [number, number, number][] = [];
  const weld = (r: number): number => {
    const x = (position[r * 3] as number) + 0;
    const y = (position[r * 3 + 1] as number) + 0;
    const z = (position[r * 3 + 2] as number) + 0;
    const key = `${x},${y},${z}`;
    let id = weldIds.get(key);
    if (id === undefined) {
      id = weldPosition.length;
      weldIds.set(key, id);
      weldPosition.push([x, y, z]);
    }
    return id;
  };
  type Plan = { render: number[]; ids: number[]; material: number; accepted: boolean };
  const plans: Plan[] = [];
  const directed = new Map<string, [number, number]>();
  let detached = 0;
  let collapsed = 0;
  for (const submesh of triangles) {
    const slot = source.materialSlots[submesh.materialSlot]?.slotName ?? 'Default';
    const material = mesh.nameIndex(mesh.materialNames, slot);
    for (let i = submesh.indexOffset; i + 2 < submesh.indexOffset + submesh.indexCount; i += 3) {
      const render = [index(i), index(i + 1), index(i + 2)];
      const ids = render.map(weld);
      if (new Set(ids).size < 3) {
        collapsed++;
        continue;
      }
      const keys = ids.map((a, k) => `${a},${ids[(k + 1) % 3]}`);
      const accepted = keys.every((key) => !directed.has(key));
      if (accepted) for (const [k, key] of keys.entries()) directed.set(key, [plans.length, k]);
      else detached++;
      plans.push({ render, ids, material, accepted });
    }
  }
  const fan = new Map<string, string>();
  const root = (c: string): string => {
    let r = c;
    while (fan.get(r) !== undefined && fan.get(r) !== r) r = fan.get(r) as string;
    fan.set(c, r);
    return r;
  };
  for (const [t, plan] of plans.entries()) {
    if (!plan.accepted) continue;
    for (let k = 0; k < 3; k++) {
      const v = plan.ids[k] as number;
      const w = plan.ids[(k + 1) % 3] as number;
      const across = directed.get(`${w},${v}`);
      if (across === undefined) continue;
      const a = root(`${t}:${k}`);
      const b = root(`${across[0]}:${(across[1] + 1) % 3}`);
      if (a !== b) fan.set(a, b);
    }
  }
  const vertexOfFan = new Map<string, number>();
  const firstFan = new Map<number, string>();
  let splitVertices = 0;
  const cornerVertex = (t: number, k: number, id: number): number => {
    const r = root(`${t}:${k}`);
    let v = vertexOfFan.get(r);
    if (v === undefined) {
      v = mesh.addVertex(...(weldPosition[id] as [number, number, number]));
      vertexOfFan.set(r, v);
      if (firstFan.has(id)) splitVertices++;
      else firstFan.set(id, r);
    }
    return v;
  };
  const renderOf = new Map<number, number>();
  const faces: number[] = [];
  for (const [t, plan] of plans.entries()) {
    const loop = plan.accepted
      ? plan.ids.map((id, k) => cornerVertex(t, k, id))
      : plan.ids.map((id) => mesh.addVertex(...(weldPosition[id] as [number, number, number])));
    const added = mesh.addFace(loop, plan.material);
    if (!added.ok) return added;
    const f = added.value;
    if (attribution.tag >= 0) mesh.addTag(f, attribution.tag);
    for (const [k, h] of mesh.faceHalves(f).entries()) {
      const r = plan.render[k] as number;
      renderOf.set(h, r);
      for (const channel of channels) {
        mesh.setCorner(
          channel.name,
          h,
          channel.data.subarray(r * channel.dim, (r + 1) * channel.dim),
        );
      }
    }
    faces.push(f);
  }
  if (faces.length === 0) {
    return err(
      modelingError('model-op-no-effect', 'the mesh has a non-degenerate triangle', {
        collapsed,
      }),
    );
  }
  let sharp = 0;
  if (normal !== undefined) {
    for (const f of faces) {
      for (const h of mesh.faceHalves(f)) {
        const twin = h ^ 1;
        if (h > twin && renderOf.has(twin)) continue;
        if (!renderOf.has(twin)) continue;
        const pairs: [number, number][] = [
          [h, mesh.hNext[twin] as number],
          [mesh.hNext[h] as number, twin],
        ];
        const differs = pairs.some(
          ([a, b]) => !sameValues(normal, 3, renderOf.get(a) as number, renderOf.get(b) as number),
        );
        if (differs) {
          mesh.eFlags[h >> 1] = mergeFlags(mesh.eFlags[h >> 1] as number, EDGE_SHARP);
          sharp++;
        }
      }
    }
  }
  if (splitVertices > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${splitVertices} vertex copies separate corner fans that met only at a vertex (non-manifold bowties)`,
      detail: { splitVertices },
    });
  }
  if (detached > 0 || collapsed > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${detached} non-manifold or inconsistently oriented triangle(s) were detached onto their own vertices; ${collapsed} triangle(s) collapsed by welding were skipped`,
      detail: { detached, collapsed },
    });
  }
  if (skippedSubmeshes > 0 || ignored.length > 0) {
    diagnostics.push({
      severity: 'info',
      message: 'non-triangle submeshes and non-float32 attributes were not lifted',
      detail: { skippedSubmeshes, ignoredAttributes: ignored },
    });
  }
  const counts: RoleCounts = {};
  markRole(mesh, faces, attribution.label, 'face', counts);
  return ok({ ...counts, sharpEdges: sharp, vertices: weldPosition.length });
}
