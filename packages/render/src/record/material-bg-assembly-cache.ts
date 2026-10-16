import type { MaterialBgAssemblyCacheEntry } from './frame-snapshot';

type ProbeEntries = Map<number | undefined, MaterialBgAssemblyCacheEntry>;
type ShaderEntries = Map<string, ProbeEntries>;

/** The existing material binding owner, indexed by its scalar identities. */
export class MaterialBgAssemblyCache {
  private readonly worlds = new Map<string, Map<number, ShaderEntries>>();

  get(
    worldIdentity: string | undefined,
    materialHandle: number | undefined,
    shaderId: string | undefined,
    probeIndex?: number,
  ): MaterialBgAssemblyCacheEntry | undefined {
    if (worldIdentity === undefined || materialHandle === undefined) return undefined;
    return this.worlds
      .get(worldIdentity)
      ?.get(materialHandle)
      ?.get(shaderId ?? '')
      ?.get(probeIndex);
  }

  set(
    worldIdentity: string,
    materialHandle: number,
    shaderId: string | undefined,
    probeIndex: number | undefined,
    entry: MaterialBgAssemblyCacheEntry,
  ): void {
    let materials = this.worlds.get(worldIdentity);
    if (materials === undefined) {
      materials = new Map();
      this.worlds.set(worldIdentity, materials);
    }
    let shaders = materials.get(materialHandle);
    if (shaders === undefined) {
      shaders = new Map();
      materials.set(materialHandle, shaders);
    }
    const shader = shaderId ?? '';
    let probes = shaders.get(shader);
    if (probes === undefined) {
      probes = new Map();
      shaders.set(shader, probes);
    }
    probes.set(probeIndex, entry);
  }

  *values(): IterableIterator<MaterialBgAssemblyCacheEntry> {
    for (const materials of this.worlds.values())
      for (const shaders of materials.values())
        for (const probes of shaders.values()) yield* probes.values();
  }

  clear(): void {
    this.worlds.clear();
  }
}
