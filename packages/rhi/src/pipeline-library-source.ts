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

/** Snapshot recipes while retaining received immutable WGSL strings unchanged.
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
  const sources = new Map<string, ShaderSource>();
  const owned = Object.freeze({
    ...snapshot,
    shaders: Object.freeze(
      manifest.shaders.map((descriptor) => {
        const admitted = shaderSourceForDescriptor(descriptor);
        if (admitted !== undefined) return admitted.descriptor(descriptor.label);
        const text = descriptor.code;
        const owner = sources.get(text) ?? new ShaderSource([text]);
        sources.set(text, owner);
        return owner.descriptor(descriptor.label);
      }),
    ),
  });
  ownedLibraries.add(owned);
  return owned;
}
