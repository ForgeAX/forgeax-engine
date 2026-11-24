import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookRayMaterial,
} from '../../../../shader-compiler/src/index';
import { Materials } from '../../materials';
import { packCardLookupProjections } from '../../raytracing/card-lookup';
import {
  CARD_PLANES,
  createSurfaceCapture,
  type SurfaceCapture,
  type SurfaceCardSource,
} from '../../raytracing/surface-cards';
import { decodeNormal, half } from './sdf-cards.fixture';

async function blackWallSource(mesh: MeshAsset, transform: readonly number[]) {
  if (!mesh.indices || !mesh.cardLayout)
    throw new Error('Authored wall needs indices and Card layout');
  const positions = mesh.attributes.position,
    normals = mesh.attributes.normal;
  if (!(positions instanceof Float32Array) || !(normals instanceof Float32Array))
    throw new Error('Authored wall needs canonical position and normal channels');
  const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const sources = buildMaterialSourceCatalog(
    await collectMaterialSources([directory], [directory]),
  ).unwrap();
  const asset = Materials.standard({ baseColor: [0, 0, 0, 1], roughness: 1, specular: 0 });
  const material = (
    await cookRayMaterial({
      material: 'handoff-wall',
      table: { 'handoff-wall': asset },
      sources,
      context: 'card-capture',
    })
  ).unwrap();
  return {
    instance: {
      instanceId: 1,
      geometryId: 1,
      mask: 255,
      transform,
      positions,
      indices: mesh.indices,
      normals,
    },
    layout: mesh.cardLayout,
    sections: [
      { indexOffset: 0, indexCount: mesh.indices.length, material: { id: 0, ...material } },
    ],
  } satisfies SurfaceCardSource;
}

async function readTexture(device: GPUDevice, texture: GPUTexture, bytesPerPixel: number) {
  const width = texture.width,
    height = texture.height;
  const rowBytes = width * bytesPerPixel,
    stride = Math.ceil(rowBytes / 256) * 256;
  const staging = device.createBuffer({ size: stride * height, usage: 1 | 8 });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture, ...(texture.format.startsWith('depth') ? { aspect: 'depth-only' as const } : {}) },
      { buffer: staging, bytesPerRow: stride },
      [width, height],
    );
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const padded = new Uint8Array(staging.getMappedRange()),
      bytes = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++)
      bytes.set(padded.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
    staging.unmap();
    return bytes;
  } finally {
    staging.destroy();
  }
}

async function recordIntoNativeTargets(
  device: RhiDevice,
  capture: SurfaceCapture,
  targets: readonly GPUTexture[],
) {
  const borrowed: Texture[] = [];
  try {
    for (const texture of targets) borrowed.push((await device.importTexture(texture)).unwrap());
    const views = borrowed.map((texture) => device.createTextureView(texture, {}).unwrap());
    const depth = views[4];
    assert.ok(depth);
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: views.slice(0, 4).map((view) => ({
        view,
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
      depthStencilAttachment: {
        view: depth,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    try {
      capture.recordPass(pass).unwrap();
    } finally {
      pass.end();
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.nativeDevice().unwrap().queue.onSubmittedWorkDone();
  } finally {
    for (const texture of borrowed) device.destroyTexture(texture).unwrap();
  }
}

function verifyWallFaces(
  projections: SurfaceCardSource['layout']['cards'],
  width: number,
  resolution: number,
  normal: Uint8Array,
  validity: Uint8Array,
  depthBytes: Uint8Array,
) {
  const depth = new DataView(depthBytes.buffer, depthBytes.byteOffset, depthBytes.byteLength);
  const witnessed = [];
  for (const [tile, card] of projections.entries()) {
    if (Math.abs(card.n[0]) < 0.99) continue;
    const x = (tile % (width / resolution)) * resolution + resolution / 2;
    const y = Math.floor(tile / (width / resolution)) * resolution + resolution / 2;
    const pixel = y * width + x;
    assert.equal(half(validity, pixel * 8 + 6), 1, 'actual Card capture must cover the wall');
    const geometric = decodeNormal(half(normal, pixel * 8 + 4), half(normal, pixel * 8 + 6));
    const sign = Math.sign(card.n[0]);
    assert.ok(
      Math.abs((geometric[0] ?? NaN) - sign) < 1e-5,
      'captured geometric normal must face the authored X wall',
    );
    const u = (resolution / 2 + 0.5) / resolution;
    const z = depth.getFloat32(pixel * 4, true);
    const px =
      card.origin[0] +
      card.u[0] * u * card.width +
      card.v[0] * u * card.height -
      card.n[0] * z * card.depth;
    // Independent authored plane: this fixture is a four-centimetre wall.
    assert.ok(
      Math.abs(px - sign * 0.02) < 1e-5,
      'captured depth must reconstruct the authored wall plane',
    );
    witnessed.push({ sign, depth: z, x: px, geometric });
  }
  assert.deepEqual([...new Set(witnessed.map((row) => row.sign))].sort(), [-1, 1]);
  return witnessed;
}

/** Production Card-v3 raster capture over the same wall geometry and instance identity. */
export async function captureHandoffWall(
  device: RhiDevice,
  mesh: MeshAsset,
  transform: readonly number[],
  ownedTextures: GPUTexture[],
) {
  const source = await blackWallSource(mesh, transform);
  const capture = (
    await createSurfaceCapture(device, webgpu.createShaderModule, [source], {
      kind: 'cards',
      resolution: 8,
    })
  ).unwrap();
  const native = device.nativeDevice().unwrap();
  try {
    const targets = [...CARD_PLANES.map(() => 'rgba16float' as const), 'depth32float' as const].map(
      (format) => {
        const texture = native.createTexture({
          size: [capture.width, capture.height],
          format,
          usage: 4 | 16 | 1,
        });
        ownedTextures.push(texture);
        return texture;
      },
    );
    await recordIntoNativeTargets(device, capture, targets);
    const raw: Uint8Array[] = [];
    for (const texture of targets)
      raw.push(await readTexture(native, texture, texture.format.startsWith('depth') ? 4 : 8));
    const directory = 'artifacts/screen-probe/dawn/handoff-card-capture';
    mkdirSync(directory, { recursive: true });
    for (const [index, bytes] of raw.entries()) writeFileSync(`${directory}/${index}.raw`, bytes);
    const entry = capture.entry(1);
    const normal = raw[1],
      validity = raw[3],
      depth = raw[4];
    assert.ok(entry && normal && validity && depth);
    const witnessed = verifyWallFaces(
      entry.projections,
      capture.width,
      capture.resolution,
      normal,
      validity,
      depth,
    );
    const packed = packCardLookupProjections(
      capture,
      [{ instanceId: 1, key: entry.geometryKey }],
      [source],
    );
    writeFileSync(`${directory}/projections.raw`, packed.bytes);
    writeFileSync(
      `${directory}/capture.json`,
      JSON.stringify(
        {
          instanceId: 1,
          width: capture.width,
          height: capture.height,
          resolution: capture.resolution,
          count: packed.count,
          witnessed,
        },
        null,
        2,
      ),
    );
    return {
      ...packed,
      resolution: capture.resolution,
      width: capture.width,
      height: capture.height,
      targets,
    };
  } finally {
    capture.dispose();
  }
}
