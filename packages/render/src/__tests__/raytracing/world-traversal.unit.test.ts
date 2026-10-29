import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAY_QUERY_WGSL_ENABLE, type RhiDevice, validateRayQueryShader } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { GLOBAL_SDF_COMPOSE_WGSL } from '../../raytracing/global-sdf';
import {
  createIrradianceFieldKernel,
  irradianceFieldKernelWgsl,
} from '../../raytracing/irradiance-field';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import {
  createWorldAcceleration,
  tlasTransform,
  triangleFaceNormals,
} from '../../raytracing/world-acceleration';
import {
  WORLD_CARD_RADIANCE_WGSL,
  WORLD_TRAVERSAL_ROSTER,
  type WorldTraversal,
  worldTraversalWgsl,
} from '../../raytracing/world-traversal';

const TRAVERSALS: readonly WorldTraversal[] = ['global-sdf', 'ray-query'];
const LIMITS = {
  maxBlasGeometryCount: 4,
  maxBlasPrimitiveCount: 4096,
  maxTlasInstanceCount: 64,
  maxAccelerationStructuresPerShaderStage: 1,
};

async function device(rayQuery = false): Promise<RhiDevice> {
  const adapter = new RhiNullAdapter(rayQuery ? { rayQuery: LIMITS } : {});
  return (await adapter.requestDevice()).unwrap();
}

/**
 * The parity kernel the native Ray Query test runs: one module per traversal, same body.
 * `settings` keeps the production layout (x = Card count, y = resolution, z = residency
 * pending) plus w = max steps; `parity` is x = projection margin, y = min step factor.
 */
function parityKernel(traversal: WorldTraversal): string {
  return `${worldTraversalWgsl(traversal)}
@group(0) @binding(5) var<storage,read> cards: array<Card>;
@group(0) @binding(6) var<storage,read> cardLit: array<vec4f>;
@group(0) @binding(7) var<storage,read> rays: array<Ray>;
struct Traced { hit: Hit, radiance: vec4f }
@group(0) @binding(8) var<storage,read_write> traced: array<Traced>;
@group(0) @binding(9) var<uniform> parity: vec4f;
@group(0) @binding(10) var<uniform> settings: vec4u;
@group(0) @binding(11) var albedo: texture_2d<f32>;
@group(0) @binding(12) var normal: texture_2d<f32>;
@group(0) @binding(13) var emission: texture_2d<f32>;
@group(0) @binding(14) var f0: texture_2d<f32>;
@group(0) @binding(15) var cardDepth: texture_depth_2d;
${WORLD_CARD_RADIANCE_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x>=arrayLength(&rays)){return;}
 let hit=traceWorld(rays[gid.x],settings.w,parity.y);
 traced[gid.x]=Traced(hit,worldCardRadiance(hit,parity.x,false));
}
`;
}

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../rhi-wgpu-native/src/__tests__/fixtures/world-traversal',
);
const GENERATED: Readonly<Record<string, string>> = {
  'global-sdf.wgsl': parityKernel('global-sdf'),
  'ray-query.wgsl': parityKernel('ray-query'),
  'compose.wgsl': GLOBAL_SDF_COMPOSE_WGSL,
  'card-surface.ray-query.wgsl': irradianceFieldKernelWgsl('ray-query').cardSurface,
  'trace-probes.ray-query.wgsl': irradianceFieldKernelWgsl('ray-query').traceProbes,
  'trace-reflections.ray-query.wgsl': irradianceFieldKernelWgsl('ray-query').traceReflections,
  'screen-probe-world.ray-query.wgsl': screenProbeWorldWgsl('ray-query'),
};

const declared = (source: string) =>
  new Map(
    [
      ...source.matchAll(/@group\(0\) @binding\((\d+)\) var(?:<([^>]+)>)? (\w+)\s*:\s*([^;]+);/g),
    ].map((m) => [Number(m[1]), m[4]?.trim() === 'acceleration_structure' ? 'tlas' : (m[2] ?? '')]),
  );

describe('world traversal seam', () => {
  it('declares the same slots each roster names, and only Ray Query enables the extension', () => {
    for (const traversal of TRAVERSALS) {
      const source = worldTraversalWgsl(traversal);
      const slots = declared(source);
      expect(slots.size, traversal).toBe(WORLD_TRAVERSAL_ROSTER[traversal].length);
      for (const [binding, kind] of WORLD_TRAVERSAL_ROSTER[traversal]) {
        const space = slots.get(binding);
        expect(space, `${traversal}:${binding}`).toBeDefined();
        expect(
          kind === 'tlas'
            ? space === 'tlas'
            : kind === 'uniform'
              ? space === 'uniform'
              : space === 'storage,read',
          `${traversal}:${binding}`,
        ).toBe(true);
      }
      expect(source.includes(RAY_QUERY_WGSL_ENABLE), traversal).toBe(traversal === 'ray-query');
      if (traversal === 'ray-query')
        expect(source.trimStart().startsWith(RAY_QUERY_WGSL_ENABLE)).toBe(true);
      for (const seam of ['fn traceWorld(ray: Ray', 'fn worldHitCandidates(hit: Hit)'])
        expect(source, traversal).toContain(seam);
    }
  });

  it('keeps the native parity fixtures generated from the seam', () => {
    for (const [name, source] of Object.entries(GENERATED)) {
      const path = resolve(FIXTURES, name);
      if (process.env.FORGEAX_UPDATE_WORLD_TRAVERSAL_FIXTURES === '1') {
        mkdirSync(FIXTURES, { recursive: true });
        writeFileSync(path, source);
      }
      expect(
        existsSync(path),
        `${path}; rerun with FORGEAX_UPDATE_WORLD_TRAVERSAL_FIXTURES=1`,
      ).toBe(true);
      expect(readFileSync(path, 'utf8'), name).toBe(source);
    }
  });

  it('refuses the Ray Query lane as data on a device without caps.rayQuery', async () => {
    const d = await device();
    expect(d.caps.rayQuery.supported).toBe(false);
    const gate = validateRayQueryShader(d.caps.rayQuery, worldTraversalWgsl('ray-query'));
    expect(gate.ok ? undefined : gate.error.code).toBe('feature-not-enabled');
    expect(validateRayQueryShader(d.caps.rayQuery, worldTraversalWgsl('global-sdf')).ok).toBe(true);
    const acceleration = createWorldAcceleration(d, {
      maxInstances: 4,
      maxTriangles: 64,
      maxBlasBuildsPerFrame: 1,
    });
    expect(acceleration.ok ? undefined : acceleration.error.code).toBe('feature-not-enabled');
    const module = createShaderModuleImmediate(d, { code: '' }).unwrap();
    const kernel = createIrradianceFieldKernel(d, 'traceProbes', module, 'ray-query');
    expect(kernel.ok ? undefined : kernel.error.code).toBe('feature-not-enabled');
    expect(createIrradianceFieldKernel(d, 'traceProbes', module, 'global-sdf').ok).toBe(true);
  });
});

describe('world acceleration', () => {
  const box = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
  const translated = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 2, 3, 1];

  it('retains exact opposite-winding surface coverage without promoting ordinary backs or nearby planes', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect([...triangleFaceNormals(positions, [0, 1, 2, 2, 1, 0])]).toEqual([
      0, 0, 1, 1, 0, 0, -1, 1,
    ]);
    // Separate author vertices at identical coordinates still cover the same plane.
    const duplicateVertices = new Float32Array([...positions, ...positions]);
    expect([...triangleFaceNormals(duplicateVertices, [0, 1, 2, 5, 4, 3])]).toEqual([
      0, 0, 1, 1, 0, 0, -1, 1,
    ]);
    expect([...triangleFaceNormals(positions, [0, 1, 2, 0, 1, 2])]).toEqual([
      0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expect([...triangleFaceNormals(positions, [0, 1, 2])]).toEqual([0, 0, 1, 0]);
    // Any nonzero separation retains distinct one-sided surfaces; no epsilon welding.
    for (let i = 3; i < 6; i++) duplicateVertices[i * 3 + 2] = 1e-6;
    const separated = triangleFaceNormals(duplicateVertices, [0, 1, 2, 5, 4, 3]);
    expect([separated[3], separated[7]]).toEqual([0, 0]);
    expect([...triangleFaceNormals(positions, [0, 0, 0])]).toEqual([0, 0, 0, 0]);
  });

  it('derives per-triangle normals and the 3x4 row-major instance transform', () => {
    expect([...triangleFaceNormals(box.positions, box.indices)]).toEqual([0, 0, 1, 0, 0, 0, 1, 0]);
    expect(tlasTransform(translated(5))).toEqual([1, 0, 0, 5, 0, 1, 0, 2, 0, 0, 1, 3]);
  });

  it('builds each geometry once within the per-frame budget and rebuilds the TLAS on change', async () => {
    const d = await device(true);
    const world = createWorldAcceleration(d, {
      maxInstances: 8,
      maxTriangles: 16,
      maxBlasBuildsPerFrame: 1,
    }).unwrap();
    const geometries = [
      { geometryId: 0, ...box },
      { geometryId: 1, positions: box.positions, indices: box.indices },
    ];
    const first = { instanceId: 7, geometryId: 0, mask: 1, transform: translated(0) };
    const instances = [first, { instanceId: 9, geometryId: 1, mask: 1, transform: translated(2) }];
    for (const [k, instance] of instances.entries()) {
      const geometry = geometries[k];
      if (geometry === undefined) throw new Error('missing geometry');
      world.set(instance, geometry).unwrap();
    }
    const update = () => world.update(d.createCommandEncoder().unwrap()).unwrap();
    // One BLAS = 48 B positions + 24 B uint32 indices (+ 32 B face normals uploaded);
    // one TLAS instance = 64 B of GPU build input; one table row = 16 B uploaded.
    expect(update()).toEqual({
      pending: 1,
      blasBuilt: 1,
      tlasBuilt: 1,
      bytesBuilt: 72 + 64,
      rowsWritten: 2,
      bytesUploaded: 72 + 32 + 32,
    });
    expect(update()).toEqual({
      pending: 0,
      blasBuilt: 1,
      tlasBuilt: 1,
      bytesBuilt: 72 + 128,
      rowsWritten: 2,
      bytesUploaded: 72 + 32 + 32,
    });
    expect(update()).toEqual({
      pending: 0,
      blasBuilt: 0,
      tlasBuilt: 0,
      bytesBuilt: 0,
      rowsWritten: 0,
      bytesUploaded: 0,
    });
    // A move patches one record and one row; the GPU rebuild still consumes both records.
    world.move(7, translated(1)).unwrap();
    expect(update()).toEqual({
      pending: 0,
      blasBuilt: 0,
      tlasBuilt: 1,
      bytesBuilt: 128,
      rowsWritten: 1,
      bytesUploaded: 16,
    });
    const layout = d
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 4, accelerationStructure: {} }],
      })
      .unwrap();
    expect(
      d.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { kind: 'accelerationStructure', value: world.tlas } }],
      }).ok,
    ).toBe(true);
    const large = {
      geometryId: 2,
      positions: box.positions,
      indices: new Uint16Array(39).map((_, k) => [0, 1, 2][k % 3] ?? 0),
    };
    const exhausted = world.set(
      { instanceId: 11, geometryId: 2, mask: 1, transform: translated(4) },
      large,
    );
    expect(exhausted.ok ? undefined : exhausted.error.code).toBe('ray-reference-limit');
    expect([world.instances, world.geometries]).toEqual([2, 2]);
    let tooMany: ReturnType<typeof world.set> | undefined;
    for (let k = 0; k < 9 && tooMany?.ok !== false; k++)
      tooMany = world.set({ ...first, instanceId: 100 + k }, { geometryId: 0, ...box });
    expect(tooMany?.ok ? undefined : tooMany?.error.code).toBe('ray-reference-limit');
    expect(world.instances).toBe(8);
    world.dispose();
  });
});
