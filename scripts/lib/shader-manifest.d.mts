import type { PathOrFileDescriptor } from 'node:fs';

export function readShaderManifestText(path: PathOrFileDescriptor): string;
export function decodeShaderManifestText(bytes: Uint8Array): string;
export function openShaderManifestPublication(path: PathOrFileDescriptor): {
  readonly url: string;
  dispose(): void;
};
