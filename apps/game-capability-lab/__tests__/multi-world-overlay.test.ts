import type { App, DrawSource } from '@forgeax/engine-app';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Context } from '@forgeax/engine-plugin';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { installMultiWorldOverlay } from '../assets/plugins/multi-world-overlay';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();


describe('game-default multi-world overlay', () => {
  it('owns secondary assets independently and retires them without touching the primary World', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const primaryMesh = assets.create(BUILTIN_CUBE).unwrap();
    let drawSource: DrawSource | undefined;
    const app = {
      world,
      setDrawSource(next: DrawSource | undefined) { drawSource = next; },
    } as App;
    const overlay = installMultiWorldOverlay(new Context(), app);
    const owner = overlay.world.assets!;
    expect(owner).not.toBe(assets);
    expect(drawSource?.()).toEqual({ worlds: [world, overlay.world], cameraOwner: 0, resourceOwner: 0 });

    const beacons = [...overlay.world.query({ read: [MeshFilter, MeshRenderer] }).unwrap()];
    expect(beacons).toHaveLength(2);
    const mesh = beacons[0]!.get(MeshFilter).assetHandle;
    const material = beacons[0]!.get(MeshRenderer).materials[0]!;
    expect(owner.validate(mesh).ok).toBe(true);
    expect(owner.validate(material).ok).toBe(true);
    expect(assets.validate(mesh).ok).toBe(false);
    expect(overlay.world.spawn({ component: MeshFilter, data: { assetHandle: primaryMesh } }).ok).toBe(false);

    overlay.setEnabled(false);
    expect(drawSource).toBeUndefined();
    expect(owner.validate(mesh).ok).toBe(true);
    overlay.setEnabled(true);
    expect(drawSource?.()?.worlds).toEqual([world, overlay.world]);
    overlay.dispose();
    overlay.dispose();
    expect(drawSource).toBeUndefined();
    expect([...overlay.world.query({ read: [MeshFilter] }).unwrap()]).toHaveLength(0);
    expect(owner.validate(mesh).ok).toBe(false);
    expect(owner.validate(material).ok).toBe(false);
    expect(assets.validate(primaryMesh).ok).toBe(true);
    assets.release(primaryMesh).unwrap();
    assets.dispose();
  });
});
