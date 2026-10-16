import { decodeImageBytes } from '@forgeax/engine/assets-runtime';
import { MeshRenderer } from '@forgeax/engine/render';
import type { TextureAsset } from '@forgeax/engine/types';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

async function encode(type: 'image/png' | 'image/jpeg'): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(64, 64);
  const context = canvas.getContext('2d');
  if (context === null) return new Uint8Array();
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      context.fillStyle = (x + y) % 2 === 0 ? '#e0302a' : '#2a5ae0';
      context.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  const blob = await canvas.convertToBlob({ type });
  return new Uint8Array(await blob.arrayBuffer());
}

function code(error: unknown): string {
  return String((error as { code?: unknown }).code);
}

export default defineFeature({
  title: 'Runtime PNG/JPEG decode',
  catalog: 'Runtime PNG/JPEG decode',
  kind: 'visual',
  summary:
    'PNG and JPEG bytes produced at runtime (OffscreenCanvas.convertToBlob) decode through decodeImageBytes into a TextureAsset POD, which a Standard material samples as baseColorTexture.',
  expect:
    'ON: the left quad shows a red/blue checkerboard from PNG bytes, the right one from JPEG bytes. OFF: both quads turn plain white. Checks: decoded extents are 64x64, garbage bytes are image-decode-failed, image/webp is image-format-unsupported.',
  async setup({ world }) {
    spawnStage(world);
    const checks: FeatureCheck[] = [];
    const white = standard(world, {
      baseColor: [1, 1, 1, 1],
      roughness: 1,
      metallic: 0,
      renderState: { cullMode: 'none' },
    });
    const quads: { entity: ReturnType<typeof spawnMesh>; textured: ReturnType<typeof standard> }[] =
      [];
    for (const [index, mime] of (['image/png', 'image/jpeg'] as const).entries()) {
      const decoded = await decodeImageBytes(await encode(mime), mime);
      checks.push({
        name: `${mime} decodes`,
        ok: decoded.ok,
        ...(decoded.ok ? {} : { detail: code(decoded.error) }),
      });
      if (!decoded.ok) continue;
      const extent = decoded.value.shape.extent;
      checks.push({
        name: `${mime} extent 64x64`,
        ok: extent.width === 64 && extent.height === 64,
        detail: `${extent.width}x${extent.height}`,
      });
      const texture = world.allocSharedRef('TextureAsset', decoded.value as TextureAsset);
      const textured = standard(world, {
        baseColor: [1, 1, 1, 1],
        baseColorTexture: texture as never,
        roughness: 1,
        metallic: 0,
        renderState: { cullMode: 'none' },
      });
      const entity = spawnMesh(world, MESH.quad, textured, {
        pos: [index === 0 ? -1.1 : 1.1, 1, 0],
        scale: [2, 2, 2],
      });
      quads.push({ entity, textured });
    }
    const garbage = await decodeImageBytes(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      'image/png',
    );
    checks.push({
      name: 'garbage PNG bytes are image-decode-failed',
      ok: !garbage.ok && code(garbage.error) === 'image-decode-failed',
      ...(garbage.ok ? {} : { detail: code(garbage.error) }),
    });
    const webp = await decodeImageBytes(new Uint8Array(4), 'image/webp' as 'image/png');
    checks.push({
      name: 'image/webp is image-format-unsupported',
      ok: !webp.ok && code(webp.error) === 'image-format-unsupported',
      ...(webp.ok ? {} : { detail: code(webp.error) }),
    });
    return {
      toggle(on) {
        for (const { entity, textured } of quads) {
          world.set(entity, MeshRenderer, { materials: [on ? textured : white] } as never);
        }
      },
      checks: () => checks,
    };
  },
});
