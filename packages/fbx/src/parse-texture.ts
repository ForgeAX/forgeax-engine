// parse-texture.ts — FBX JSON POD to TexturePod bridge (t30).

import type { TexturePod } from '@forgeax/engine-types';

export interface FbxRawTexture {
  readonly name?: string;
  readonly filePath: string;
  readonly sourceIndex: number;
}

export interface FbxRawTextures {
  readonly textures?: readonly FbxRawTexture[];
}

export function parseTextures(raw: FbxRawTextures): TexturePod[] {
  const textures = raw.textures ?? [];
  return textures.map((t) => ({
    name: t.name ?? t.filePath,
    filePath: t.filePath,
    sourceIndex: t.sourceIndex,
  }));
}
