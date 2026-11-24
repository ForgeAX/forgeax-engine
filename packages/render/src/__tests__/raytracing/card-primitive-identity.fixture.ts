import { fileURLToPath } from 'node:url';
import { buildMeshCardLayout, type MeshCardProjection } from '@forgeax/engine-geometry';
import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { assert, expect, vi } from 'vitest';
import { encodePng } from '../../../../image/src/png-encoder';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookRayMaterial,
} from '../../../../shader-compiler/src/index';
import { Materials } from '../../materials';
import { referenceSurfaceMaterialSnapshot } from '../../raytracing/material-bindings';
import {
  CARD_PLANES,
  prepareSurfaceCapture,
  type SurfaceCapture,
  type SurfaceCaptureSource,
} from '../../raytracing/surface-cards';
import { readBuffer } from './path-tracer.fixture';
import { half } from './sdf-cards.fixture';

const empty = 0xffffffff;
const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const view: MeshCardProjection = {
  origin: [-1, 1, 1],
  u: [1, 0, 0],
  v: [0, -1, 0],
  n: [0, 0, 1],
  width: 2,
  height: 2,
  depth: 2,
};
type Compile = Parameters<typeof prepareSurfaceCapture>[1];
export type IdentityEvidence = (name: string, bytes: Uint8Array) => Promise<void>;

/** CPU preparation through the maintained authoring/cook route; never rewrites final WGSL. */
export async function prepareCardIdentityFixture() {
  const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const inputs = await collectMaterialSources([directory], [directory]);
  const sources = buildMaterialSourceCatalog(inputs).unwrap();
  const asset = Materials.standard({
    baseColor: [0, 1, 0, 1],
    roughness: 0.6,
    renderState: { cullMode: 'none' },
  });
  const cooked = (
    await cookRayMaterial({
      material: 'identity',
      table: { identity: asset },
      sources,
      context: 'card-capture',
    })
  ).unwrap();
  const source = async (
    positions: number[],
    indices: Uint32Array,
    sections: readonly [number, number][],
    instanceId = 0,
    material = cooked,
  ): Promise<SurfaceCaptureSource> => ({
    instance: { instanceId, geometryId: 0, mask: 255, transform, positions, indices },
    layout: (
      await buildMeshCardLayout(positions, indices, {
        triangleSidedness: new Uint8Array(indices.length / 3).fill(1),
      })
    ).unwrap(),
    captureKey: JSON.stringify(['authored-card-identity', instanceId, positions, indices.length]),
    sections: sections.map(([indexOffset, indexCount], index) => ({
      indexOffset,
      indexCount,
      material: {
        id: index,
        program: { source: material.program.wgsl, paramSchema: material.program.paramSchema },
        snapshot: referenceSurfaceMaterialSnapshot({
          asset: material.asset,
          program: material.program,
        }),
      },
    })),
  });
  // The visible primitive is the last in the Mesh and starts above the u16 range.
  // Capture must preserve the original identity across material sections.
  const highIndices = new Uint32Array(65537 * 3);
  for (let triangle = 0; triangle < 65536; triangle++) highIndices.set([0, 1, 2], triangle * 3);
  highIndices.set([3, 4, 5], 65536 * 3);
  const high = await source(
    [10, -0.75, 0, 11, -0.75, 0, 10, 0.75, 0, -0.75, -0.75, 0, 0.75, -0.75, 0, -0.75, 0.75, 0],
    highIndices,
    [
      [0, 32768 * 3],
      [32768 * 3, 32769 * 3],
    ],
  );
  const overlap = async (front: number) =>
    source(
      [
        -0.75,
        -0.75,
        0,
        0.75,
        -0.75,
        0,
        -0.75,
        0.75,
        0,
        -0.75,
        -0.75,
        front,
        0.75,
        -0.75,
        front,
        -0.75,
        0.75,
        front,
      ],
      new Uint32Array([0, 1, 2, 3, 4, 5]),
      [
        [0, 3],
        [3, 3],
      ],
    );
  let changes = 0;
  const mutantInputs = {
    ...inputs,
    engine: inputs.engine.map((input) => {
      if (!input.path.replaceAll('\\', '/').endsWith('/ray-material.wgsl')) return input;
      const old = 'v.tangent,tri.ids.z);';
      assert(input.source.includes(old));
      changes++;
      return { ...input, source: input.source.replace(old, 'v.tangent,tri.ids.z&65535u);') };
    }),
  };
  assert(changes === 1);
  const truncated = (
    await cookRayMaterial({
      material: 'identity',
      table: { identity: asset },
      sources: buildMaterialSourceCatalog(mutantInputs).unwrap(),
      context: 'card-capture',
    })
  ).unwrap();
  const maskedAsset = Materials.standard({
    baseColor: [0, 1, 0, 0],
    roughness: 0.6,
    alphaCutoff: 0.5,
    renderState: { cullMode: 'none' },
  });
  const masked = (
    await cookRayMaterial({
      material: 'masked',
      table: { masked: maskedAsset },
      sources,
      context: 'card-capture',
    })
  ).unwrap();
  const unsupportedSource = `#define_import_path game::identity_unsupported
#import forgeax_material::surface_v1::{SurfaceInput,SurfaceData}
fn evaluate_surface(input:SurfaceInput)->SurfaceData{return SurfaceData(vec3f(.2,.3,.4),vec3f(0),0.,.6,vec3f(0),1.,1.,0.,0.);}`;
  const customSources = buildMaterialSourceCatalog({
    ...inputs,
    project: [
      ...inputs.project,
      { source: unsupportedSource, path: 'identity-unsupported.wgsl', virtual: true },
    ],
  }).unwrap();
  const customAsset = Materials.standard({
    surfaceModule: 'game::identity_unsupported',
    parameters: [],
    values: {},
    renderState: { cullMode: 'none' },
  });
  const unsupported = (
    await cookRayMaterial({
      material: 'unsupported',
      table: { unsupported: customAsset },
      sources: customSources,
      context: 'card-capture',
    })
  ).unwrap();
  return {
    sources,
    asset,
    cooked,
    source,
    high,
    tie: await overlap(0),
    occluded: await overlap(0.25),
    truncated,
    masked,
    unsupported,
  };
}

async function readPlane(
  device: RhiDevice,
  texture: Texture,
  width: number,
  height: number,
  pixelBytes: number,
) {
  const stride = Math.ceil((width * pixelBytes) / 256) * 256;
  const buffer = device.createBuffer({ size: stride * height, usage: 12 }).unwrap();
  try {
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, { width, height });
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const padded = await readBuffer(device, buffer, stride * height),
      bytes = new Uint8Array(width * height * pixelBytes);
    for (let y = 0; y < height; y++)
      bytes.set(
        padded.subarray(y * stride, y * stride + width * pixelBytes),
        y * width * pixelBytes,
      );
    return bytes;
  } finally {
    device.destroyBuffer(buffer).unwrap();
  }
}

async function snapshot(
  device: RhiDevice,
  capture: SurfaceCapture,
  name: string,
  save: IdentityEvidence,
) {
  const planes = [];
  for (const plane of CARD_PLANES) {
    const bytes = await readPlane(
      device,
      capture.textures[plane],
      capture.width,
      capture.height,
      8,
    );
    await save(`${name}-${plane}`, bytes);
    planes.push(bytes);
  }
  const depth = await readPlane(device, capture.textures.depth, capture.width, capture.height, 4);
  const ids = await readPlane(
    device,
    capture.primitiveIndex.texture,
    capture.width,
    capture.height,
    4,
  );
  await save(`${name}-depth`, depth);
  await save(`${name}-primitive`, ids);
  await save(`${name}-work`, new TextEncoder().encode(JSON.stringify(capture.materialWork)));
  await save(
    `${name}-extent`,
    new TextEncoder().encode(
      JSON.stringify({
        width: capture.width,
        height: capture.height,
        resolution: capture.resolution,
      }),
    ),
  );
  const color = new Uint8Array(capture.width * capture.height * 4),
    identity = new Uint8Array(color.length),
    words = new DataView(ids.buffer);
  const albedo = planes[0];
  assert(albedo);
  for (let pixel = 0; pixel < color.length / 4; pixel++) {
    for (let lane = 0; lane < 3; lane++)
      color[pixel * 4 + lane] = Math.round(
        Math.min(1, Math.max(0, half(albedo, pixel * 8 + lane * 2))) * 255,
      );
    color[pixel * 4 + 3] = 255;
    const id = words.getUint32(pixel * 4, true);
    if (id !== empty) {
      const mixed = Math.imul(id ^ (id >>> 16), 0x45d9f3b) >>> 0;
      identity[pixel * 4] = (mixed & 255) ^ 47;
      identity[pixel * 4 + 1] = ((mixed >>> 8) & 255) ^ 113;
      identity[pixel * 4 + 2] = ((mixed >>> 16) & 255) ^ 191;
    }
    identity[pixel * 4 + 3] = 255;
  }
  await save(`${name}-albedo.png`, encodePng(capture.width, capture.height, color));
  await save(
    `${name}-primitive-categorical.png`,
    encodePng(capture.width, capture.height, identity),
  );
  return { planes, depth, ids };
}

/** Both phases share one submission; an intervening copy witnesses the original depth winner. */
async function recordPair(
  device: RhiDevice,
  capture: SurfaceCapture,
  save: IdentityEvidence,
  name: string,
  range?: { first: number; count: number },
) {
  capture.rasterWork(range, range !== undefined).unwrap();
  const encoder = device.createCommandEncoder({}).unwrap();
  const material = encoder.beginRenderPass({
    colorAttachments: CARD_PLANES.map((plane) => ({
      view: capture.views[plane],
      loadOp: range === undefined ? ('clear' as const) : ('load' as const),
      storeOp: 'store' as const,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    })),
    depthStencilAttachment: {
      view: capture.views.depth,
      depthLoadOp: range === undefined ? 'clear' : 'load',
      depthStoreOp: 'store',
      depthClearValue: 1,
    },
  });
  if (range !== undefined) capture.clearTiles(material, range).unwrap();
  capture.recordPass(material, range).unwrap();
  material.end();
  const witnesses: {
    name: string;
    pixelBytes: number;
    stride: number;
    buffer: import('@forgeax/engine-rhi').Buffer;
  }[] = [];
  try {
    for (const name of ['depth', ...CARD_PLANES] as const) {
      const pixelBytes = name === 'depth' ? 4 : 8;
      const stride = Math.ceil((capture.width * pixelBytes) / 256) * 256;
      const buffer = device.createBuffer({ size: stride * capture.height, usage: 12 }).unwrap();
      witnesses.push({ name, pixelBytes, stride, buffer });
      encoder.copyTextureToBuffer(
        { texture: capture.textures[name] },
        { buffer, bytesPerRow: stride },
        { width: capture.width, height: capture.height },
      );
    }
    const identity = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: capture.primitiveIndex.view,
          loadOp: range === undefined ? 'clear' : 'load',
          storeOp: 'store',
          clearValue: { r: empty, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: capture.views.depth,
        depthLoadOp: range === undefined ? 'clear' : 'load',
        depthStoreOp: 'store',
        depthClearValue: 1,
      },
    });
    if (range !== undefined) capture.clearTiles(identity, range, 'identity').unwrap();
    capture.recordPass(identity, range, 'identity').unwrap();
    identity.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const before = new Map<string, Uint8Array>();
    for (const witness of witnesses) {
      const padded = await readBuffer(device, witness.buffer, witness.stride * capture.height);
      const bytes = new Uint8Array(capture.width * capture.height * witness.pixelBytes);
      for (let y = 0; y < capture.height; y++)
        bytes.set(
          padded.subarray(
            y * witness.stride,
            y * witness.stride + capture.width * witness.pixelBytes,
          ),
          y * capture.width * witness.pixelBytes,
        );
      await save(`${name}-material-${witness.name}`, bytes);
      before.set(witness.name, bytes);
    }
    const observed = await snapshot(device, capture, name, save);
    expect(observed.depth).toEqual(before.get('depth'));
    for (const [index, plane] of CARD_PLANES.entries())
      expect(observed.planes[index]).toEqual(before.get(plane));
    return observed;
  } finally {
    for (const witness of witnesses) device.destroyBuffer(witness.buffer).unwrap();
  }
}

/** An independent authored horizontal-triangle oracle; no capture bytes or BVH ids feed it. */
function expectedPrimitive(source: SurfaceCaptureSource, x: number, y: number) {
  const positions = source.instance.positions,
    indices = source.instance.indices;
  let primitive = empty,
    depth = 1;
  for (let index = 0; index < indices.length; index += 3) {
    const a = (indices[index] ?? NaN) * 3,
      b = (indices[index + 1] ?? NaN) * 3,
      c = (indices[index + 2] ?? NaN) * 3;
    const ax = positions[a] ?? NaN,
      ay = positions[a + 1] ?? NaN,
      bx = positions[b] ?? NaN,
      by = positions[b + 1] ?? NaN,
      cx = positions[c] ?? NaN,
      cy = positions[c + 1] ?? NaN;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const u = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / area;
    const v = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area;
    const t = (1 - (positions[a + 2] ?? NaN)) / 2;
    // This preregistered interior pixel avoids raster edge ownership entirely.
    if (u > 0 && v > 0 && u + v < 1 && t >= 0 && t < depth) {
      primitive = index / 3;
      depth = t;
    }
  }
  return { primitive, depth };
}

export async function verifyCardIdentity(
  device: RhiDevice,
  compile: Compile,
  fixture: Awaited<ReturnType<typeof prepareCardIdentityFixture>>,
  save: IdentityEvidence,
) {
  const records = [];
  for (const [name, source] of [
    ['high', fixture.high],
    ['tie', fixture.tie],
    ['occluded', fixture.occluded],
  ] as const) {
    const capture = (
      await prepareSurfaceCapture(device, compile, [source], {
        kind: 'view',
        resolution: 8,
        projection: view,
      })
    ).unwrap();
    try {
      const observed = await recordPair(device, capture, save, name);
      const expected = expectedPrimitive(source, -0.375, -0.375),
        offset = (5 * 8 + 2) * 4;
      const actual = new DataView(observed.ids.buffer).getUint32(offset, true);
      const actualDepth = new DataView(observed.depth.buffer).getFloat32(offset, true);
      records.push({
        name,
        expected,
        actual,
        actualDepth,
        width: capture.width,
        height: capture.height,
      });
      await save(`${name}-observed`, new TextEncoder().encode(JSON.stringify(records.at(-1))));
      expect(actual).toBe(expected.primitive);
      expect(actualDepth).toBe(expected.depth);
      const albedo = observed.planes[0];
      assert(albedo);
      expect(half(albedo, offset * 2 + 2)).toBe(1);
    } finally {
      capture.dispose();
    }
  }
  return records;
}

export async function verifyIdentityNegativeControls(
  device: RhiDevice,
  compile: Compile,
  fixture: Awaited<ReturnType<typeof prepareCardIdentityFixture>>,
  save: IdentityEvidence,
) {
  const truncated = {
    ...fixture.high,
    sections: fixture.high.sections.map((section) => ({
      ...section,
      material: {
        ...section.material,
        program: {
          source: fixture.truncated.program.wgsl,
          paramSchema: fixture.truncated.program.paramSchema,
        },
      },
    })),
  };
  const high = (
    await prepareSurfaceCapture(device, compile, [truncated], {
      kind: 'view',
      resolution: 8,
      projection: view,
    })
  ).unwrap();
  try {
    const result = await recordPair(device, high, save, 'negative-truncated-u16');
    expect(new DataView(result.ids.buffer).getUint32((5 * 8 + 2) * 4, true)).toBe(0);
    expect(expectedPrimitive(fixture.high, -0.375, -0.375).primitive).toBe(65536);
  } finally {
    high.dispose();
  }
  const create = device.createRenderPipeline.bind(device);
  const spy = vi.spyOn(device, 'createRenderPipeline').mockImplementation((desc) => {
    if (desc.fragment?.entryPoint !== 'fs_card_identity') return create(desc);
    const depth = desc.depthStencil;
    assert(depth);
    return create({ ...desc, depthStencil: { ...depth, depthCompare: 'less-equal' } });
  });
  let tie: SurfaceCapture;
  try {
    tie = (
      await prepareSurfaceCapture(device, compile, [fixture.tie], {
        kind: 'view',
        resolution: 8,
        projection: view,
      })
    ).unwrap();
  } finally {
    spy.mockRestore();
  }
  try {
    const result = await recordPair(device, tie, save, 'negative-last-tie-wins');
    expect(new DataView(result.ids.buffer).getUint32((5 * 8 + 2) * 4, true)).toBe(1);
    expect(expectedPrimitive(fixture.tie, -0.375, -0.375).primitive).toBe(0);
  } finally {
    tie.dispose();
  }
}

export async function verifyIdentityMaterialCoverage(
  device: RhiDevice,
  compile: Compile,
  fixture: Awaited<ReturnType<typeof prepareCardIdentityFixture>>,
  save: IdentityEvidence,
) {
  const positions = [-0.75, -0.75, 0, 0.75, -0.75, 0, -0.75, 0.75, 0],
    indices = new Uint32Array([0, 1, 2]);
  for (const [name, material, kind] of [
    ['masked-view', fixture.masked, 'view'],
    ['masked-proxy', fixture.masked, 'cards'],
    ['unsupported', fixture.unsupported, 'view'],
  ] as const) {
    const source = await fixture.source(positions, indices, [[0, 3]], 0, material);
    await save(
      `${name}-input`,
      new TextEncoder().encode(
        JSON.stringify({ kind, snapshot: source.sections[0]?.material.snapshot.paramSnapshot }),
      ),
    );
    const capture = (
      await prepareSurfaceCapture(
        device,
        compile,
        [source],
        kind === 'view' ? { kind, resolution: 8, projection: view } : { kind, resolution: 8 },
      )
    ).unwrap();
    try {
      const result = await recordPair(device, capture, save, name);
      for (const id of new Uint32Array(result.ids.buffer)) expect(id).toBe(empty);
      const written = new Float32Array(result.depth.buffer).filter((value) => value < 1).length;
      if (name === 'masked-view') expect(written).toBe(0);
      else {
        expect(written).toBeGreaterThan(0);
        const validity = result.planes[3];
        assert(validity);
        for (let pixel = 0; pixel < result.depth.length / 4; pixel++) {
          if (new DataView(result.depth.buffer).getFloat32(pixel * 4, true) === 1) continue;
          // A proxy retains alpha-hole material/depth, but never its contact ID.
          expect(half(validity, pixel * 8 + 6)).toBe(name === 'masked-proxy' ? 1 : 2);
        }
      }
    } finally {
      capture.dispose();
    }
  }
}

function tileBytes(bytes: Uint8Array, capture: SurfaceCapture, tile: number, pixelBytes: number) {
  const columns = capture.width / capture.resolution,
    x = (tile % columns) * capture.resolution,
    y = Math.floor(tile / columns) * capture.resolution;
  const result = new Uint8Array(capture.resolution * capture.resolution * pixelBytes);
  for (let row = 0; row < capture.resolution; row++)
    result.set(
      bytes.subarray(
        ((y + row) * capture.width + x) * pixelBytes,
        ((y + row) * capture.width + x + capture.resolution) * pixelBytes,
      ),
      row * capture.resolution * pixelBytes,
    );
  return result;
}

export async function verifyIdentityEdits(
  device: RhiDevice,
  compile: Compile,
  fixture: Awaited<ReturnType<typeof prepareCardIdentityFixture>>,
  save: IdentityEvidence,
) {
  const positions = [-0.75, -0.75, 0, 0.75, -0.75, 0, -0.75, 0.75, 0],
    indices = new Uint32Array([0, 1, 2]);
  const a = await fixture.source(positions, indices, [[0, 3]], 10),
    b = await fixture.source(positions, indices, [[0, 3]], 20);
  const capture = (
    await prepareSurfaceCapture(device, compile, [a, b], { kind: 'cards', resolution: 8 })
  ).unwrap();
  try {
    const initial = await recordPair(device, capture, save, 'edit-initial');
    const other = capture.entry(20),
      first = capture.entry(10);
    assert(first && other);
    expect(other.firstTile).toBe(a.layout.cards.length);
    const snapshotA = a.sections[0]?.material.snapshot;
    assert(snapshotA);
    capture
      .adoptMaterial(snapshotA, {
        ...snapshotA,
        paramSnapshot: { ...snapshotA.paramSnapshot, baseColor: [1, 0, 0, 1] },
      })
      .unwrap();
    capture.retransform(10, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.125, 0, 0, 1]).unwrap();
    const range = { first: first.firstTile, count: a.layout.cards.length };
    capture.prepareTiles(range);
    const encoder = device.createCommandEncoder({}).unwrap();
    capture.record(encoder, range).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const edited = await snapshot(device, capture, 'edit-current', save);
    for (let tile = other.firstTile; tile < other.firstTile + b.layout.cards.length; tile++) {
      for (let plane = 0; plane < 4; plane++) {
        const after = edited.planes[plane],
          before = initial.planes[plane];
        assert(after && before);
        expect(tileBytes(after, capture, tile, 8)).toEqual(tileBytes(before, capture, tile, 8));
      }
      expect(tileBytes(edited.depth, capture, tile, 4)).toEqual(
        tileBytes(initial.depth, capture, tile, 4),
      );
      expect(tileBytes(edited.ids, capture, tile, 4)).toEqual(
        tileBytes(initial.ids, capture, tile, 4),
      );
    }
    expect(edited.planes[0]).not.toEqual(initial.planes[0]);
    const albedo = edited.planes[0];
    assert(albedo);
    let changedCoverage = 0;
    for (let tile = range.first; tile < range.first + range.count; tile++) {
      const ids = new DataView(tileBytes(edited.ids, capture, tile, 4).buffer);
      const colors = tileBytes(albedo, capture, tile, 8);
      for (let pixel = 0; pixel < ids.byteLength / 4; pixel++) {
        if (ids.getUint32(pixel * 4, true) === empty) continue;
        changedCoverage++;
        expect(half(colors, pixel * 8)).toBe(1);
        expect(half(colors, pixel * 8 + 2)).toBe(0);
      }
    }
    expect(changedCoverage).toBeGreaterThan(0);
    let coverage = 0;
    for (let offset = 0; offset < edited.ids.length; offset += 4)
      if (new DataView(edited.ids.buffer).getUint32(offset, true) !== empty) coverage++;
    expect(coverage).toBeGreaterThan(0);
    // Execute the actual partial record wrapper with one controlled bad loadOp.
    // The unmodified wrapper's raw result above is the positive control.
    const bad = device.createCommandEncoder({}).unwrap(),
      begin = bad.beginRenderPass.bind(bad);
    const spy = vi.spyOn(bad, 'beginRenderPass').mockImplementation((desc) => {
      if (desc.label !== 'cards.capture-identity') return begin(desc);
      const depth = desc.depthStencilAttachment;
      assert(depth);
      return begin({
        ...desc,
        depthStencilAttachment: { ...depth, depthLoadOp: 'clear', depthClearValue: 1 },
      });
    });
    try {
      capture.record(bad, range).unwrap();
    } finally {
      spy.mockRestore();
    }
    device.queue.submit([bad.finish().unwrap()]).unwrap();
    const invalid = await snapshot(device, capture, 'negative-whole-depth-clear', save);
    let changed = 0;
    for (let tile = other.firstTile; tile < other.firstTile + b.layout.cards.length; tile++) {
      const before = tileBytes(edited.depth, capture, tile, 4),
        after = tileBytes(invalid.depth, capture, tile, 4);
      for (let byte = 0; byte < before.length; byte++) if (before[byte] !== after[byte]) changed++;
    }
    expect(changed).toBeGreaterThan(0);
    return {
      tiles: capture.allocatedTiles,
      range,
      otherFirst: other.firstTile,
      coverage,
      changedCoverage,
      negativeChangedBytes: changed,
    };
  } finally {
    capture.dispose();
  }
}
