import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { expect, it } from 'vitest';
import { createCustomProjectileMesh, resetCustomProjectileMesh, toggleCustomProjectileMesh } from '../assets/plugins/custom-projectile-mesh';

it('changes only mesh UV data through the asset owner and preserves detached reads', async () => {
  const assets = new AssetRegistry();
  const projectile = await createCustomProjectileMesh(assets);
  const before = assets.read(projectile.meshHandle).unwrap();
  toggleCustomProjectileMesh(projectile);
  const changed = assets.read(projectile.meshHandle).unwrap();
  expect(changed.attributes?.uv).toEqual(projectile.alternateUV);
  expect(changed.attributes?.position).toEqual(before.attributes?.position);
  expect(changed.indices).toEqual(before.indices);
  expect(changed.aabb).toEqual(before.aabb);
  const vertices = changed.vertices as Float32Array;
  for (let vertex = 0; vertex < projectile.alternateUV.length / 2; vertex++) {
    expect(vertices[vertex * 12 + 6]).toBe(projectile.alternateUV[vertex * 2]);
    expect(vertices[vertex * 12 + 7]).toBe(projectile.alternateUV[vertex * 2 + 1]);
  }
  expect(before.attributes?.uv).toEqual(projectile.baseUV);
  resetCustomProjectileMesh(projectile);
  expect(assets.read(projectile.meshHandle).unwrap().attributes?.uv).toEqual(projectile.baseUV);
  expect(changed.attributes?.uv).toEqual(projectile.alternateUV);
  projectile.dispose();
  expect(assets.validate(projectile.meshHandle).ok).toBe(false);
  assets.dispose();
});
