import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Condition-neutral measurement of a delivered `mesh/prop`: it reads only the exported
// MeshAsset (never the modeling kernel), so both benchmark conditions are measured alike.

const AXES = { x: 0, y: 1, z: 2 };

function float32(source) {
  if (source instanceof Float32Array) return source;
  if (source instanceof ArrayBuffer) return new Float32Array(source);
  return undefined;
}

function trianglesOf(mesh) {
  const positions = float32(mesh.attributes?.position);
  if (positions === undefined) return { error: 'mesh has no float32 position attribute' };
  const vertexCount = positions.length / 3;
  const indices = mesh.indices ?? Uint32Array.from({ length: vertexCount }, (_, i) => i);
  const submeshes = mesh.submeshes ?? [
    { indexOffset: 0, indexCount: indices.length, topology: 'triangle-list' },
  ];
  const triangles = [];
  const nonTriangleSubmeshes = submeshes.filter((s) => s.topology !== 'triangle-list').length;
  for (const submesh of submeshes) {
    if (submesh.topology !== 'triangle-list') continue;
    const end = submesh.indexOffset + submesh.indexCount;
    for (let i = submesh.indexOffset; i + 2 < end; i += 3) {
      triangles.push([indices[i], indices[i + 1], indices[i + 2]]);
    }
  }
  return { positions, triangles, nonTriangleSubmeshes, submeshCount: submeshes.length };
}

function weld(positions) {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const keyToId = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const welded = [];
  for (let v = 0; v < remap.length; v++) {
    const key = `${bits[3 * v]},${bits[3 * v + 1]},${bits[3 * v + 2]}`;
    let id = keyToId.get(key);
    if (id === undefined) {
      id = welded.length;
      keyToId.set(key, id);
      welded.push([positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]]);
    }
    remap[v] = id;
  }
  return { remap, welded };
}

function find(parent, a) {
  let root = a;
  while (parent[root] !== root) root = parent[root];
  while (parent[a] !== root) {
    const next = parent[a];
    parent[a] = root;
    a = next;
  }
  return root;
}

/** Topology, size and volume facts of a triangle mesh after an exact float32 weld. */
export function measureMesh(mesh) {
  const source = trianglesOf(mesh);
  if (source.error !== undefined) return { error: source.error };
  const { remap, welded } = weld(source.positions);
  const tris = [];
  let degenerate = 0;
  let zeroArea = 0;
  for (const [a, b, c] of source.triangles) {
    const t = [remap[a], remap[b], remap[c]];
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) {
      degenerate++;
      continue;
    }
    const [p, q, r] = [welded[t[0]], welded[t[1]], welded[t[2]]];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    if (
      u[1] * v[2] - u[2] * v[1] === 0 &&
      u[2] * v[0] - u[0] * v[2] === 0 &&
      u[0] * v[1] - u[1] * v[0] === 0
    ) {
      zeroArea++;
    }
    tris.push(t);
  }
  const edges = new Map();
  tris.forEach((t, f) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k];
      const b = t[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let e = edges.get(key);
      if (e === undefined) {
        e = { forward: 0, backward: 0, faces: [] };
        edges.set(key, e);
      }
      if (a < b) e.forward++;
      else e.backward++;
      e.faces.push(f);
    }
  });
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let misorientedEdges = 0;
  const parent = tris.map((_, i) => i);
  for (const e of edges.values()) {
    const total = e.forward + e.backward;
    if (total === 1) boundaryEdges++;
    else if (total > 2) nonManifoldEdges++;
    else if (e.forward !== 1) misorientedEdges++;
    for (let i = 1; i < e.faces.length; i++) {
      const ra = find(parent, e.faces[0]);
      const rb = find(parent, e.faces[i]);
      if (ra !== rb) parent[rb] = ra;
    }
  }
  const byRoot = new Map();
  tris.forEach((t, f) => {
    const root = find(parent, f);
    let c = byRoot.get(root);
    if (c === undefined) {
      c = { faces: 0, verts: new Set(), edges: new Set(), volume: 0 };
      byRoot.set(root, c);
    }
    c.faces++;
    for (let k = 0; k < 3; k++) {
      c.verts.add(t[k]);
      const a = t[k];
      const b = t[(k + 1) % 3];
      c.edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
    const [p, q, r] = [welded[t[0]], welded[t[1]], welded[t[2]]];
    c.volume +=
      (p[0] * (q[1] * r[2] - q[2] * r[1]) -
        p[1] * (q[0] * r[2] - q[2] * r[0]) +
        p[2] * (q[0] * r[1] - q[1] * r[0])) /
      6;
  });
  const closed = boundaryEdges === 0 && tris.length > 0;
  const components = [...byRoot.values()]
    .map((c) => {
      const euler = c.verts.size - c.edges.size + c.faces;
      return {
        triangles: c.faces,
        euler,
        genus: closed ? (2 - euler) / 2 : null,
        volume: c.volume,
      };
    })
    .sort((a, b) => b.triangles - a.triangles);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const v of t) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], welded[v][k]);
        max[k] = Math.max(max[k], welded[v][k]);
      }
    }
  }
  const size = min.map((m, k) => (tris.length > 0 ? max[k] - m : 0));
  const volume = components.reduce((sum, c) => sum + c.volume, 0);
  const boxVolume = size[0] * size[1] * size[2];
  return {
    triangles: source.triangles.length,
    weldedVertices: welded.length,
    submeshes: source.submeshCount,
    nonTriangleSubmeshes: source.nonTriangleSubmeshes,
    degenerateTriangles: degenerate,
    zeroAreaTriangles: zeroArea,
    boundaryEdges,
    nonManifoldEdges,
    misorientedEdges,
    closed,
    manifold: nonManifoldEdges === 0,
    oriented: misorientedEdges === 0,
    components: components.length,
    componentDetail: components.slice(0, 16),
    genus: closed ? components.reduce((sum, c) => sum + c.genus, 0) : null,
    inwardComponents: components.filter((c) => !(c.volume > 0)).length,
    bounds: tris.length > 0 ? [...min, ...max] : null,
    size,
    volume,
    volumeRatio: boxVolume > 0 ? volume / boxVolume : null,
  };
}

/** Evaluates one brief's measurable checks against measured facts. */
export function evaluateChecks(facts, brief) {
  return brief.checks.map((check) => {
    let actual;
    let pass;
    switch (check.kind) {
      case 'size':
        actual = facts.size[AXES[check.axis]];
        pass = Math.abs(actual - check.value) <= check.tolerance;
        break;
      case 'components':
        actual = facts.components;
        pass = actual >= check.min && actual <= check.max;
        break;
      case 'genus':
        actual = facts.genus;
        pass = actual !== null && actual >= check.min;
        break;
      case 'volumeRatio':
        actual = facts.volumeRatio;
        pass = actual !== null && actual > 0 && actual <= check.max;
        break;
      case 'triangles':
        actual = facts.triangles;
        pass = actual <= check.max;
        break;
      default:
        throw new Error(`unknown check kind ${check.kind}`);
    }
    return { ...check, actual, pass };
  });
}

/** Builds a Pack's default export and measures its `mesh/prop` output. */
export async function measurePack(packPath, brief) {
  const started = performance.now();
  let definition;
  try {
    definition = (await import(`${pathToFileURL(resolve(packPath)).href}?m=${Date.now()}`)).default;
  } catch (error) {
    return { build: { ok: false, error: `import failed: ${error?.message ?? error}` } };
  }
  if (typeof definition?.build !== 'function') {
    return { build: { ok: false, error: 'default export is not a definePack(...) definition' } };
  }
  const values = Object.fromEntries((definition.parameters ?? []).map((p) => [p.name, p.default]));
  let result;
  try {
    result = await definition.build({
      packageId: definition.packageId,
      ...(definition.parameters === undefined ? {} : { values }),
      readByGuid: async () => ({ ok: false, error: 'readByGuid is unavailable in the benchmark' }),
    });
  } catch (error) {
    return { build: { ok: false, error: `build threw: ${error?.message ?? error}` } };
  }
  if (!result?.ok) {
    const e = result?.error;
    return {
      build: {
        ok: false,
        error:
          `build returned an error: ${e?.code ?? ''} ${e?.hint ?? e?.message ?? JSON.stringify(e)}`.trim(),
      },
    };
  }
  const outputs = Object.keys(result.value);
  const mesh = result.value['mesh/prop'];
  if (mesh?.kind !== 'mesh') {
    return { build: { ok: false, outputs, error: "no 'mesh/prop' MeshAsset output" } };
  }
  const facts = measureMesh(mesh);
  if (facts.error !== undefined) return { build: { ok: false, outputs, error: facts.error } };
  const checks = evaluateChecks(facts, brief);
  const closedValid =
    facts.closed &&
    facts.manifold &&
    facts.oriented &&
    facts.inwardComponents === 0 &&
    facts.nonTriangleSubmeshes === 0;
  return {
    build: { ok: true, outputs, ms: Math.round(performance.now() - started) },
    facts,
    checks,
    closedValid,
    checksPass: checks.every((c) => c.pass),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [packPath, briefPath] = process.argv.slice(2);
  if (packPath === undefined || briefPath === undefined) {
    console.error('usage: node measure.mjs <pack.ts> <brief.json>');
    process.exit(2);
  }
  const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
  console.log(JSON.stringify(await measurePack(packPath, brief), null, 2));
}
