import { expect, it, vi } from 'vitest';
import type { MeshDistanceField } from '../distance-field';
import { distanceFieldTexel } from '../distance-field-bricks';
import * as triangleQueries from '../triangle-query';
import { buildVisibilityDistanceField } from '../visibility-distance-field';

it('preserves full-vote artifacts while avoiding votes that cannot change the sign', async () => {
  const original = triangleQueries.createTriangleQuery;
  let calls = 0;
  const spy = vi.spyOn(triangleQueries, 'createTriangleQuery').mockImplementation((triangles) => {
    const query = original(triangles);
    return {
      ...query,
      trace: (...args: Parameters<typeof query.trace>) => {
        calls++;
        return query.trace(...args);
      },
    };
  });
  try {
    const rows = [];
    for (const flags of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      calls = 0;
      const field = (
        await buildVisibilityDistanceField(
          [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
          [0, 1, 2, 0, 2, 3],
          {
            voxelSize: 0.25,
            triangleSidedness: flags,
          },
        )
      ).unwrap();
      const artifact = await legacyDenseArtifact(field);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(artifact))),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
      rows.push({ flags, calls, digest });
    }
    // Version-3 bytes captured before early termination: one-sided, both mixed
    // assignments and all-two-sided. Includes both positive and negative votes.
    expect(rows.map((row) => row.digest)).toEqual([
      '7ef6e8d1203b89a85fb0a3de38070e5463097d972a837ad87963c0f467ae31cb',
      '3f09e909ff446a4d921527bec44600e7db8de900377b348c9eda15c870c838ff',
      '39908fb16aac6dd347cd162227cd014d891db29749b668a06fd8138f521f9b8c',
      'b18c2a3cc0899a3cb9cfeb4208e9bc03cfa1b51d94e49e932d5533fa43a362ba',
    ]);
    const fullVoteCalls = [47432, 99372, 99372];
    for (const [i, baseline] of fullVoteCalls.entries())
      expect(rows[i]?.calls).toBeLessThan(baseline * 0.9);
    expect(rows[3]?.calls).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it('does not cast sign rays when the bounded nearest query found no nearby geometry', async () => {
  const original = triangleQueries.createTriangleQuery;
  const band = Math.fround(Math.sqrt(3));
  let farQueries = 0;
  const spy = vi.spyOn(triangleQueries, 'createTriangleQuery').mockImplementation((triangles) => {
    const query = original(triangles);
    return {
      ...query,
      trace: (...args: Parameters<typeof query.trace>) => {
        const [, origin, direction] = args;
        const center = origin.map((v, i) => v + 1e-4 * band * (direction[i] ?? 0)) as [
          number,
          number,
          number,
        ];
        const nearest = query.nearestSquared(center);
        if (nearest !== null && nearest > band * band * 1.00000001) farQueries++;
        return query.trace(...args);
      },
    };
  });
  try {
    const field = (
      await buildVisibilityDistanceField(
        [-4, -1, 0, -3, -1, 0, -4, 1, 0, 3, -1, 0, 4, -1, 0, 4, 1, 0],
        [0, 1, 2, 3, 4, 5],
        { voxelSize: 0.25, triangleSidedness: [0, 0] },
      )
    ).unwrap();
    const artifact = await legacyDenseArtifact(field);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(artifact))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    expect(digest).toBe('abd5ce7f97e2705bdeb438f31cd73b06708631a60f885026e82d91ae0cc99bdb');
    expect(farQueries).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

// Reconstruct the frozen v3 oracle only in this regression. Its old digests stay
// unchanged across storage versions, proving every logical sample and metadata.
async function legacyDenseArtifact(field: MeshDistanceField): Promise<Uint8Array> {
  const { values: _, bricks: __, ...metadata } = field;
  const header = new TextEncoder().encode(JSON.stringify({ version: 3, ...metadata }));
  const [nx, ny, nz] = field.dimensions;
  const bytes = new Uint8Array(4 + header.length + nx * ny * nz * 4 + 64),
    view = new DataView(bytes.buffer);
  view.setUint32(0, header.length, true);
  bytes.set(header, 4);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        view.setFloat32(
          4 + header.length + ((z * ny + y) * nx + x) * 4,
          distanceFieldTexel(field, x, y, z),
          true,
        );
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(0, -64))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  bytes.set(new TextEncoder().encode(hash), bytes.length - 64);
  return bytes;
}
