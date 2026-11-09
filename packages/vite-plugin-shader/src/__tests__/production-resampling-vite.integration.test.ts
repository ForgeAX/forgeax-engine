import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeDocumentText } from '@forgeax/engine-codec';
import {
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { build } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';
import { forgeaxShader } from '../index.js';
import { publishShaderManifest } from '../manifest-publication.js';

interface PublishedArtifact {
  readonly hash?: string;
  readonly sourceDigest?: string;
  readonly compilerProfile?: unknown;
  readonly reflectionIndex?: number;
  readonly entryPointsIndex?: number;
  readonly entryPoints?: readonly { readonly name: string; readonly stage: string }[];
  readonly defines?: Readonly<Record<string, boolean>>;
  readonly definesKey?: string;
  readonly programContract?: unknown;
}

interface PublishedMaterial extends PublishedArtifact {
  readonly identifier: string;
  readonly variants: readonly PublishedArtifact[];
}

interface PublishedReflection {
  readonly schemaVersion: string;
  readonly boundGlobals: readonly {
    readonly group: number;
    readonly binding: number;
    readonly addressSpace: string;
    readonly resourceKind: string;
    readonly name?: string;
  }[];
}

interface PublishedManifest {
  readonly entries: readonly (PublishedArtifact & { readonly identifier?: string })[];
  readonly materialShaders: readonly PublishedMaterial[];
  readonly reflections?: readonly PublishedReflection[];
  readonly entryPoints?: readonly (readonly { readonly name: string; readonly stage: string }[])[];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('emits and admits production resampling entries through Vite buildStart and generateBundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-resampling-vite-'));
  const previousFetch = globalThis.fetch;
  try {
    await writeFile(join(root, 'entry.js'), 'export {}\n');
    vi.stubEnv('FORGEAX_ENGINE_SHADER_SOURCE_BUILD', '1');
    vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', undefined);

    const output = await build({
      configFile: false,
      logLevel: 'silent',
      root,
      plugins: [forgeaxShader()],
      build: {
        write: false,
        reportCompressedSize: false,
        rollupOptions: { input: join(root, 'entry.js') },
      },
    });
    if (!Array.isArray(output) && !('output' in output)) {
      throw new Error('Vite returned a watcher instead of a completed build output');
    }
    const bundles = Array.isArray(output) ? output : [output];
    const manifestAsset = bundles
      .flatMap((bundle) => bundle.output)
      .find((item) => item.type === 'asset' && item.fileName === 'shaders/manifest.json');
    if (manifestAsset?.type !== 'asset') {
      throw new Error('Vite generateBundle did not emit shaders/manifest.json');
    }
    // The build emits a zstd frame; the registry decodes it from the wire bytes.
    const wireBytes =
      typeof manifestAsset.source === 'string'
        ? new TextEncoder().encode(manifestAsset.source)
        : manifestAsset.source;
    const decoded = await decodeDocumentText(wireBytes);
    if (!decoded.ok) throw new Error('emitted manifest did not decode');
    const publication = JSON.parse(decoded.value) as PublishedManifest;

    globalThis.fetch = async () =>
      new Response(new Uint8Array(wireBytes), { headers: { 'content-type': 'application/json' } });
    const registry = new ShaderRegistry({
      manifestUrl: 'https://production-resampling.invalid/shaders/manifest.json',
    });
    const admitted = await registry.loadManifest();
    expect(admitted.ok, admitted.ok ? '' : JSON.stringify(admitted.error)).toBe(true);

    const entries = [...registry.entries()];
    const materialRows = [...registry.materialShaderManifestEntries()];
    const failures: string[] = [];
    const note = (condition: boolean, detail: string): void => {
      if (!condition) failures.push(detail);
    };
    const checkRawArtifact = (row: PublishedArtifact | undefined, label: string): void => {
      note(row !== undefined, `${label}: publication row is missing`);
      if (row === undefined) return;
      note(/^[a-f0-9]{8}$/.test(row.hash ?? ''), `${label}: compiled hash is missing`);
      note(
        /^[a-f0-9]{64}$/.test(row.sourceDigest ?? ''),
        `${label}: exact source digest is missing`,
      );
      note(row.compilerProfile !== undefined, `${label}: compiler profile is missing`);
      const reflectionIndex = row.reflectionIndex;
      note(
        Number.isSafeInteger(reflectionIndex) &&
          reflectionIndex !== undefined &&
          reflectionIndex >= 0 &&
          reflectionIndex < (publication.reflections?.length ?? 0),
        `${label}: raw reflectionIndex is missing or out of range`,
      );
      const entryPointsIndex = row.entryPointsIndex;
      note(
        Number.isSafeInteger(entryPointsIndex) &&
          entryPointsIndex !== undefined &&
          entryPointsIndex >= 0 &&
          entryPointsIndex < (publication.entryPoints?.length ?? 0),
        `${label}: raw entryPointsIndex is missing or out of range`,
      );
    };
    const checkResolvedArtifact = (
      raw: PublishedArtifact | undefined,
      resolved:
        | {
            readonly hash?: string;
            readonly sourceDigest?: string;
            readonly compilerProfile?: unknown;
            readonly reflection?: unknown;
            readonly entryPoints?: unknown;
            readonly programContract?: unknown;
            readonly defines?: Readonly<Record<string, boolean>>;
          }
        | undefined,
      label: string,
    ): void => {
      checkRawArtifact(raw, label);
      note(resolved !== undefined, `${label}: ShaderRegistry did not resolve the row`);
      if (raw === undefined || resolved === undefined) return;
      note(resolved.hash === raw.hash, `${label}: admitted hash does not match the raw row`);
      note(
        resolved.sourceDigest === raw.sourceDigest,
        `${label}: admitted source digest does not match the raw row`,
      );
      note(
        JSON.stringify(resolved.compilerProfile) === JSON.stringify(raw.compilerProfile),
        `${label}: admitted compiler profile does not match the raw row`,
      );
      if (raw.reflectionIndex !== undefined) {
        note(
          JSON.stringify(resolved.reflection) ===
            JSON.stringify(publication.reflections?.[raw.reflectionIndex]),
          `${label}: reflectionIndex does not resolve to this compiled artifact's reflection`,
        );
      }
      if (raw.entryPointsIndex !== undefined) {
        note(
          JSON.stringify(resolved.entryPoints) ===
            JSON.stringify(publication.entryPoints?.[raw.entryPointsIndex]),
          `${label}: entryPointsIndex does not resolve to this compiled artifact's reads`,
        );
      }
      if (raw.programContract !== undefined) {
        note(
          JSON.stringify(resolved.programContract) === JSON.stringify(raw.programContract),
          `${label}: admitted program contract does not match the raw row`,
        );
      }
    };

    const compute = entries.filter(
      (entry) => entry.identifier === LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
    );
    const fragment = entries.filter(
      (entry) => entry.identifier === LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
    );
    note(compute.length === 1, 'compute resampling material entry is missing or duplicated');
    note(
      ['light_texture_resample', 'light_texture_reduce'].every((name) =>
        compute[0]?.entryPoints?.some((entry) => entry.name === name && entry.stage === 'compute'),
      ),
      'compute resampling entrypoints/stages are incomplete',
    );
    note(fragment.length === 1, 'fragment resampling material entry is missing or duplicated');
    note(
      [
        ['light_texture_fullscreen', 'vertex'],
        ['light_texture_resample_fragment', 'fragment'],
      ].every(([name, stage]) =>
        fragment[0]?.entryPoints?.some((entry) => entry.name === name && entry.stage === stage),
      ),
      'fragment resampling entrypoints/stages are incomplete',
    );
    const rawCompute = publication.materialShaders.find(
      (entry) => entry.identifier === LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
    );
    const rawFragment = publication.materialShaders.find(
      (entry) => entry.identifier === LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
    );
    checkResolvedArtifact(
      rawCompute,
      materialRows.find((entry) => entry.identifier === LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER),
      'compute resampling primary',
    );
    checkResolvedArtifact(
      rawFragment,
      materialRows.find((entry) => entry.identifier === LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER),
      'fragment resampling primary',
    );
    checkResolvedArtifact(
      publication.entries.find(
        (entry) => entry.identifier === LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
      ),
      compute[0],
      'compute resampling direct entry',
    );
    checkResolvedArtifact(
      publication.entries.find(
        (entry) => entry.identifier === LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
      ),
      fragment[0],
      'fragment resampling direct entry',
    );
    note(
      JSON.stringify(compute[0]?.programContract?.colorTargets) === '[]',
      'compute resampling must publish an empty target list',
    );
    note(
      JSON.stringify(fragment[0]?.programContract?.colorTargets) ===
        JSON.stringify([
          { location: 0, format: 'rgba32float', numericType: 'float' },
          { location: 1, format: 'rgba8unorm', numericType: 'float' },
        ]),
      'fragment resampling must publish both f32 and normalized output targets',
    );

    const rawStandard = publication.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    const admittedStandard = materialRows.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    checkResolvedArtifact(rawStandard, admittedStandard, 'Standard PBR primary material');
    const rawDirectStandard = publication.entries.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    const admittedDirectStandard = entries.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    checkResolvedArtifact(rawDirectStandard, admittedDirectStandard, 'Standard PBR direct entry');
    if (rawStandard !== undefined && admittedStandard !== undefined) {
      const primaryMatches = rawStandard.variants.filter(
        (variant) =>
          variant.hash === rawStandard.hash && variant.sourceDigest === rawStandard.sourceDigest,
      );
      note(primaryMatches.length > 0, 'primary Standard row has no matching compiled variant');
      for (const variant of primaryMatches) {
        note(
          variant.reflectionIndex === rawStandard.reflectionIndex &&
            JSON.stringify(variant.compilerProfile) === JSON.stringify(rawStandard.compilerProfile),
          'primary Standard row facts do not match its selected compiled variant',
        );
      }
      if (rawDirectStandard !== undefined && admittedDirectStandard !== undefined) {
        const selectedVariants = rawStandard.variants.filter(
          (variant) =>
            variant.hash === rawDirectStandard.hash &&
            variant.sourceDigest === rawDirectStandard.sourceDigest,
        );
        note(
          selectedVariants.length === 1,
          'direct Standard entry does not identify exactly one compiled variant',
        );
        for (const variant of selectedVariants) {
          note(
            ['STORAGE_BUFFER_AVAILABLE', 'CLUSTER_FORWARD_AVAILABLE'].every(
              (key) => admittedDirectStandard.defines?.[key] === variant.defines?.[key],
            ),
            'direct Standard defines do not select the variant named by its artifact hash',
          );
          note(
            JSON.stringify(admittedDirectStandard.reflection) ===
              JSON.stringify(publication.reflections?.[variant.reflectionIndex ?? -1]),
            'direct Standard reflection does not match its selected compiled variant',
          );
        }
      }

      const storageVariant = rawStandard.variants.find(
        (variant) =>
          variant.defines?.STORAGE_BUFFER_AVAILABLE === true &&
          variant.defines.CLUSTER_FORWARD_AVAILABLE === true,
      );
      const textureVariant = rawStandard.variants.find(
        (variant) =>
          variant.defines?.STORAGE_BUFFER_AVAILABLE === false &&
          variant.defines.CLUSTER_FORWARD_AVAILABLE === true,
      );
      checkRawArtifact(storageVariant, 'storage-backed Standard variant');
      checkRawArtifact(textureVariant, 'storage-free Standard variant');
      for (const [rawVariant, label] of [
        [storageVariant, 'storage-backed Standard variant'],
        [textureVariant, 'storage-free Standard variant'],
      ] as const) {
        const decoded = admittedStandard.variants.find(
          (variant) => variant.definesKey === rawVariant?.definesKey,
        );
        checkResolvedArtifact(rawVariant, decoded, label);
        if (rawVariant !== undefined) {
          note(
            JSON.stringify(decoded?.defines) === JSON.stringify(rawVariant.defines),
            `${label}: defines were associated with another compiled variant`,
          );
        }
      }
      const storageIndex = storageVariant?.reflectionIndex;
      const textureIndex = textureVariant?.reflectionIndex;
      const storageReflection =
        storageIndex === undefined ? undefined : publication.reflections?.[storageIndex];
      const textureReflection =
        textureIndex === undefined ? undefined : publication.reflections?.[textureIndex];
      note(
        storageReflection?.boundGlobals.some(
          (global) =>
            global.group === 2 &&
            global.binding === 3 &&
            global.addressSpace === 'storage' &&
            global.resourceKind === 'storage-buffer',
        ) === true,
        'storage-backed Standard reflection does not describe the storage light table',
      );
      note(
        textureReflection?.boundGlobals.some(
          (global) =>
            global.group === 2 && global.binding === 3 && global.resourceKind === 'texture',
        ) === true,
        'storage-free Standard reflection does not describe the integer texture light table',
      );
      note(
        storageVariant?.reflectionIndex !== textureVariant?.reflectionIndex,
        'storage and storage-free Standard variants share one reflection identity',
      );
    }
    expect(failures, failures.join('\n')).toEqual([]);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);

it('keeps generic registry admission usable for custom manifests without engine resampling entries', async () => {
  const previousFetch = globalThis.fetch;
  try {
    const wireText = JSON.stringify(
      publishShaderManifest([{ hash: 'custom-entry', wgsl: 'fn custom() {}', bindings: '[]' }], []),
    );
    globalThis.fetch = async () => new Response(wireText);
    const registry = new ShaderRegistry({
      manifestUrl: 'https://custom-shader.invalid/shaders/manifest.json',
    });
    const admitted = await registry.loadManifest();
    expect(admitted.ok, admitted.ok ? '' : JSON.stringify(admitted.error)).toBe(true);
    expect([...registry.entries()].map(({ hash }) => hash)).toEqual(['custom-entry']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
