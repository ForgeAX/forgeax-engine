import {
  ShaderSource,
  shaderSourceForDescriptor,
  snapshotPipelineDescriptor,
} from '@forgeax/engine-types';
import type { PipelineLibraryLimits, PipelineLibraryManifest } from './pipeline-library';
import { checkPipelineLibraryAllocation } from './pipeline-library-limits';

const ownedLibraries = new WeakSet<object>();

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

/** Detach received WGSL bodies into the existing realm's immutable fragments.
 * The portable manifest remains v1: serialization borrows complete code, while
 * App options and recovery closures retain these source owners inside a realm. */
export function ownPipelineLibrary(
  manifest: PipelineLibraryManifest,
  policy?: PipelineLibraryLimits,
): PipelineLibraryManifest {
  checkPipelineLibraryAllocation(manifest, 'input', policy);
  if (ownedLibraries.has(manifest)) return manifest;
  const metadata: Record<string, unknown> = {};
  for (const key of Object.keys(manifest)) {
    const property = Object.getOwnPropertyDescriptor(manifest, key);
    if (property === undefined || !('value' in property))
      throw new Error('Pipeline library requires plain data');
    if (key !== 'shaders') metadata[key] = property.value;
  }
  const snapshot = snapshotPipelineDescriptor(metadata) as Omit<PipelineLibraryManifest, 'shaders'>;
  freezeTree(snapshot);
  const fragments = new Map<string, string>();
  const sources = new Map<string, ShaderSource>();
  const owned = Object.freeze({
    ...snapshot,
    shaders: Object.freeze(
      manifest.shaders.map((descriptor) => {
        const admitted = shaderSourceForDescriptor(descriptor);
        const source = admitted ?? ShaderSource.fromText(descriptor.code, fragments);
        const owner = sources.get(source.identity) ?? source;
        sources.set(owner.identity, owner);
        return owner.descriptor(descriptor.label);
      }),
    ),
  });
  ownedLibraries.add(owned);
  return owned;
}
