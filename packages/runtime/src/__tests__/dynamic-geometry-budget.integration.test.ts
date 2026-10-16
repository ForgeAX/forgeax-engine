import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../../render/src/__tests__/shader-manifest-fixture';
import { createRenderer } from '../createRenderer';

const MIB = 1024 * 1024;
const canvas = () =>
  ({ width: 64, height: 64, getContext: () => null }) as unknown as HTMLCanvasElement;

it.each([
  undefined,
  128 * MIB,
  512 * MIB,
])('assembles the requested dynamic mesh budget (%s bytes)', async (bytes) => {
  const result = await createRenderer(
    canvas(),
    {
      rhi,
      ...(bytes === undefined ? {} : { dynamicGeometryMeshBudgetBytes: bytes }),
    },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const renderer = result.unwrap();
  try {
    expect(renderer.inspect().dynamicGeometry).toMatchObject({
      maxMeshBytes: bytes ?? 64 * MIB,
    });
  } finally {
    renderer.dispose();
  }
});

it.each([
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  512 * MIB + 1,
])('rejects invalid assembled mesh budgets (%s)', async (bytes) => {
  const requestAdapter = vi.spyOn(rhi, 'requestAdapter');
  try {
    const result = await createRenderer(
      canvas(),
      { rhi, dynamicGeometryMeshBudgetBytes: bytes },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    if (result.ok) result.value.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain('maxMeshBytes must be a positive safe integer');
    expect(requestAdapter).not.toHaveBeenCalled();
  } finally {
    requestAdapter.mockRestore();
  }
});
