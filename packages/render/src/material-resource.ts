import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import type { MaterialPass } from '@forgeax/engine-types';
import type { MaterialSnapshot } from './render-system-extract';

const resources = new WeakMap<MaterialSnapshot, MaterialResource>();

/** One renderer's accepted shared material. Entity bindings retain this identity. */
export class MaterialResource {
  private current: MaterialSnapshot;

  static from(snapshot: MaterialSnapshot): MaterialResource {
    return resources.get(snapshot) ?? new MaterialResource(snapshot);
  }

  constructor(snapshot: MaterialSnapshot) {
    this.current = snapshot;
    resources.set(snapshot, this);
  }

  get snapshot(): MaterialSnapshot {
    return this.current;
  }

  /** Called by material preparation at the renderer's adoption boundary. */
  adopt(snapshot: MaterialSnapshot): void {
    this.current = snapshot;
    resources.set(snapshot, this);
  }
}

export function materialResource(snapshot: MaterialSnapshot): MaterialResource | undefined {
  return resources.get(snapshot);
}

export function runtimeMaterialShaderIdForMaterial(
  passes: readonly MaterialPass[],
  programs: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const pass =
    passes.find(
      (pass) =>
        !/shadow|depth/i.test(
          String(
            (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
          ),
        ),
    ) ?? passes[0];
  if (pass === undefined) return undefined;
  return programs === undefined
    ? runtimeMaterialShaderId(pass.program.module, pass.name)
    : programs[pass.name];
}

/** Sprite geometry follows the immutable author program, independent of cooked IDs. */
export function materialUsesSpriteGeometry(material: Pick<MaterialSnapshot, 'passes'>): boolean {
  const shader = runtimeMaterialShaderIdForMaterial(material.passes, undefined);
  return shader === 'forgeax::sprite' || shader === 'forgeax::sprite-lit';
}
