import { describe, expect, it } from 'vitest';
import { buildConvoy, convoyPath, CONVOY_NORMALS } from '../convoy-model.ts';
import scenePack from '../../scene.pack.ts';

async function build(pack: {
  readonly build: (reader: never) => unknown;
}): Promise<Record<string, unknown>> {
  const result = await pack.build(undefined as never);
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) {
    throw new Error(`ScriptablePack build failed: ${JSON.stringify(result)}`);
  }
  return (result as unknown as { readonly value: Record<string, unknown> }).value;
}

describe('player support', () => {
  it('sits the capsule on the model in robot and truck poses', { timeout: 30000 }, async () => {
    const scene = (await build(scenePack))['scene/showcase'] as {
      readonly entities: Record<string, { readonly components: Record<string, Record<string, unknown>> }>;
    };
    const player = Object.values(scene.entities)
      .map((entity) => entity.components)
      .find((entry) => entry.Name?.value === 'Player');
    // The capsule's lowest point sits on the model's lowest point in robot and truck poses.
    const convoy = buildConvoy(512);
    const supportHeight = Number(player?.Collider?.radius) + Number(player?.Collider?.halfHeight);
    for (const u of [0, 1]) {
      const pose = convoy.assembly.sample(convoyPath(convoy.assembly), u).unwrap();
      const mesh = convoy.assembly.toMesh(pose, { normals: CONVOY_NORMALS }).unwrap().mesh;
      const positions = mesh.attributes.position as Float32Array;
      let lowest = Infinity;
      for (let i = 1; i < positions.length; i += 3) lowest = Math.min(lowest, positions[i]!);
      expect(supportHeight).toBeGreaterThanOrEqual(-lowest - 0.00001);
      expect(supportHeight + lowest).toBeLessThan(0.005);
    }
  });
});
