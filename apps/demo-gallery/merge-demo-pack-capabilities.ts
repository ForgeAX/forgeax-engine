import { existsSync } from 'node:fs';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { gltfImporter } from '@forgeax/engine-gltf';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { Importer } from '@forgeax/engine-types';
import type { DemoPluginProfile } from './demo-plugin-profile.js';

function mergeByKey<T extends { readonly key: string }>(items: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of items) merged.set(item.key, item);
  return [...merged.values()];
}

const DEFAULT_IMPORTERS: readonly Importer[] = [
  audioImporter,
  imageImporter,
  gltfImporter,
  fbxImporter,
  fontImporter,
];

function captureWantsParticleCooker(cookers: readonly unknown[]): boolean {
  return cookers.some(
    (cooker) =>
      typeof cooker === 'object' &&
      cooker !== null &&
      ((cooker as { name?: string }).name === 'particle-code-native' ||
        (cooker as { key?: string }).key === 'particle-effect'),
  );
}

/** Real pack capabilities for the shared gallery host (never jiti capture stubs). */
export function mergeDemoPackCapabilities(
  profiles: Iterable<DemoPluginProfile>,
): { importers: Importer[]; cookers: NativeCooker[] } {
  const roots = new Set<string>();
  const cookers: NativeCooker[] = [];

  for (const profile of profiles) {
    const pack = profile.pack;
    if (pack === undefined) continue;
    for (const root of pack.roots) {
      if (existsSync(root)) roots.add(root);
    }
    if (captureWantsParticleCooker(pack.cookers)) {
      const demoRoots = pack.roots.filter((root) => existsSync(root));
      if (demoRoots.length > 0) {
        cookers.push(createParticleCodeNativeCookerFromRoots(demoRoots));
      }
    }
  }

  cookers.unshift(createMaterialPackCooker([...roots]));

  return {
    importers: [...DEFAULT_IMPORTERS],
    cookers: mergeByKey(cookers),
  };
}
