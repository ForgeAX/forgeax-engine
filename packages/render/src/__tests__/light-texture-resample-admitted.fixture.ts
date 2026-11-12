import {
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import {
  isShaderCompilerProfile,
  isShaderProgramContract,
  isShaderReflection,
  type ManifestEntry,
} from '@forgeax/engine-types';

export interface AdmittedLightTextureResamplePrograms {
  readonly compute: ManifestEntry;
  readonly fragment: ManifestEntry;
  readonly publication: {
    readonly schemaVersion: string;
    readonly source: 'vite-emitted' | 'engine-built';
    readonly url?: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly entryCount: number;
    readonly computeHash: string;
    readonly fragmentHash: string;
    readonly computeSourceDigest: string;
    readonly fragmentSourceDigest: string;
    readonly computeReflectionSha256: string;
    readonly fragmentReflectionSha256: string;
    readonly computeCompilerProfile: ManifestEntry['compilerProfile'];
    readonly fragmentCompilerProfile: ManifestEntry['compilerProfile'];
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stable = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  stable.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', stable.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireEntry(entries: readonly ManifestEntry[], identifier: string): ManifestEntry {
  const matches = entries.filter((entry) => entry.identifier === identifier);
  if (matches.length !== 1) {
    throw new Error(
      `expected one admitted resampling entry ${identifier}, found ${matches.length}`,
    );
  }
  const entry = matches[0];
  if (
    entry === undefined ||
    entry.hash === undefined ||
    entry.sourceDigest === undefined ||
    !isShaderCompilerProfile(entry.compilerProfile) ||
    !isShaderProgramContract(entry.programContract) ||
    !isShaderReflection(entry.reflection)
  ) {
    throw new Error(`admitted resampling entry is missing current artifact facts: ${identifier}`);
  }
  return entry;
}

function requireSourceDigest(entry: ManifestEntry): string {
  if (typeof entry.sourceDigest !== 'string') {
    throw new Error(`admitted resampling entry is missing sourceDigest: ${entry.identifier}`);
  }
  return entry.sourceDigest;
}

export async function admitSerializedLightTextureResamplePrograms(
  serialized: string,
  source: AdmittedLightTextureResamplePrograms['publication']['source'],
  url?: string,
  byteLength = new TextEncoder().encode(serialized).byteLength,
): Promise<AdmittedLightTextureResamplePrograms> {
  const bytes = new TextEncoder().encode(serialized);
  const parsed = JSON.parse(serialized) as { readonly schemaVersion?: unknown };
  if (typeof parsed.schemaVersion !== 'string') {
    throw new Error('current shader publication has no schema version');
  }
  const registry = new ShaderRegistry({
    manifestUrl: url ?? 'memory://current-engine-shader-publication',
    readText: async () => serialized,
  });
  const admitted = await registry.loadManifest();
  if (!admitted.ok) throw admitted.error;

  const entries = Array.from(registry.entries());
  const compute = requireEntry(entries, LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER);
  const fragment = requireEntry(entries, LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER);
  const computeStages = compute.entryPoints?.map(({ name, stage }) => `${stage}:${name}`) ?? [];
  const fragmentStages = fragment.entryPoints?.map(({ name, stage }) => `${stage}:${name}`) ?? [];
  if (
    !computeStages.includes('compute:light_texture_resample') ||
    !computeStages.includes('compute:light_texture_reduce')
  ) {
    throw new Error(
      `admitted resampling compute entries are incomplete: ${computeStages.join(',')}`,
    );
  }
  if (
    !fragmentStages.includes('vertex:light_texture_fullscreen') ||
    !fragmentStages.includes('fragment:light_texture_resample_fragment')
  ) {
    throw new Error(
      `admitted resampling fragment entries are incomplete: ${fragmentStages.join(',')}`,
    );
  }

  return Object.freeze({
    compute,
    fragment,
    publication: Object.freeze({
      schemaVersion: parsed.schemaVersion,
      source,
      ...(url === undefined ? {} : { url }),
      sha256: await sha256Hex(bytes),
      byteLength,
      entryCount: entries.length,
      computeHash: compute.hash,
      fragmentHash: fragment.hash,
      computeSourceDigest: requireSourceDigest(compute),
      fragmentSourceDigest: requireSourceDigest(fragment),
      computeReflectionSha256: await sha256Hex(
        new TextEncoder().encode(JSON.stringify(compute.reflection)),
      ),
      fragmentReflectionSha256: await sha256Hex(
        new TextEncoder().encode(JSON.stringify(fragment.reflection)),
      ),
      computeCompilerProfile: compute.compilerProfile,
      fragmentCompilerProfile: fragment.compilerProfile,
    }),
  });
}

/** Admit the manifest emitted by the current Vite app build, byte-for-byte. */
export async function loadEmittedLightTextureResamplePrograms(
  url = '/shaders/manifest.json',
): Promise<AdmittedLightTextureResamplePrograms> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`shader manifest fetch failed: ${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const serialized = new TextDecoder().decode(bytes);
  return admitSerializedLightTextureResamplePrograms(
    serialized,
    'vite-emitted',
    new URL(url, location.href).href,
    bytes.byteLength,
  );
}
