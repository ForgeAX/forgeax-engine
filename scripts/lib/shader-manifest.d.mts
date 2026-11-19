import type { PathOrFileDescriptor } from 'node:fs';

export function readShaderManifestText(path: PathOrFileDescriptor): string;
export function decodeShaderManifestText(bytes: Uint8Array): string;
