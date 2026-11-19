import type { MaterialBgAssemblyCacheEntry } from './frame-snapshot';

type ProbeEntries = Map<number | undefined, MaterialBgAssemblyCacheEntry>;
type ShaderEntries = Map<string, ProbeEntries>;

/** The existing material binding owner, indexed by its scalar identities. */
export class MaterialBgAssemblyCache {
  private sourceIdentity: string | undefined;
  private readonly materials = new Map<number, ShaderEntries>();

  get(
    sourceIdentity: string | undefined,
    materialHandle: number | undefined,
    shaderId: string | undefined,
    probeIndex?: number,
  ): MaterialBgAssemblyCacheEntry | undefined {
    if (
      sourceIdentity === undefined ||
      this.sourceIdentity !== sourceIdentity ||
      materialHandle === undefined
    )
      return undefined;
    return this.materials
      .get(materialHandle)
      ?.get(shaderId ?? '')
      ?.get(probeIndex);
  }

  set(
    sourceIdentity: string,
    materialHandle: number,
    shaderId: string | undefined,
    probeIndex: number | undefined,
    entry: MaterialBgAssemblyCacheEntry,
  ): void {
    if (this.sourceIdentity !== sourceIdentity) {
      this.clear();
      this.sourceIdentity = sourceIdentity;
    }
    const materials = this.materials;
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
    for (const shaders of this.materials.values())
      for (const probes of shaders.values()) yield* probes.values();
  }

  clear(): void {
    this.materials.clear();
    this.sourceIdentity = undefined;
  }
}
