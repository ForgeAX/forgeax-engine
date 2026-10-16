import { Camera, DirectionalLight, MeshFilter, orthographic } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

function prepareRenderSchemas(frame: {
  readonly mesh: { readonly assetHandle: number };
  readonly light: { readonly direction: Float32Array; readonly intensity: number };
  readonly camera: { readonly projection: number; readonly near: number; readonly far: number };
}) {
  return {
    meshAssetHandle: frame.mesh.assetHandle,
    lightDirection: frame.light.direction,
    cameraProjection: frame.camera.projection,
    cameraNear: frame.camera.near,
    cameraFar: frame.camera.far,
  };
}

describe('runtime render schema consumer', () => {
  it('reads canonical render fields without adapters or casts', () => {
    const row = {
      mesh: { assetHandle: 3 },
      light: { direction: new Float32Array([0, -1, 0]), intensity: 2 },
      camera: orthographic({ left: -1, right: 1, bottom: -1, top: 1, near: 0.1, far: 10 }),
    };
    const prepared = prepareRenderSchemas(row);
    expect(prepared.meshAssetHandle).toBe(3);
    expect(prepared.cameraProjection).toBe(1);
    expect(Camera.fields.projection.default).toBe(0);
    expect(DirectionalLight.fields.direction.type).toBe('array<f32, 3>');
    expect(MeshFilter.fields.assetHandle.type).toBe('shared<MeshAsset>');
  });
});
