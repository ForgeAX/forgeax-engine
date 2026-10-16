// parse-texture.test.ts -- M3 t35: texture path parse-bridge unit test.
//
// R1 fixup: tests now import the real parseTextures from src/parse-texture.ts
// (instead of an inline stub), closing the AC-04 coverage gap.

import { describe, expect, it } from 'vitest';
import type { TexturePod } from '@forgeax/engine-types';
import { parseTextures } from '../src/parse-texture.js';
import type { FbxRawTextures } from '../src/parse-texture.js';

const MOCK_TEXTURE_RAW: FbxRawTextures = {
  textures: [
    { name: 'diffuse', filePath: 'textures/diffuse.png', sourceIndex: 0 },
    { name: 'normal', filePath: 'maps/normal.jpg', sourceIndex: 1 },
  ],
};

describe('parseTexture', () => {
  it('parses texture paths with forward-slash separators', () => {
    const pods: TexturePod[] = parseTextures(MOCK_TEXTURE_RAW);
    expect(pods.length).toBe(2);

    const diffuse = pods[0]!;
    expect(diffuse.name).toBe('diffuse');
    expect(diffuse.filePath).toBe('textures/diffuse.png');
    expect(diffuse.filePath).not.toContain('\\');
    expect(diffuse.sourceIndex).toBe(0);

    const normal = pods[1]!;
    expect(normal.name).toBe('normal');
    expect(normal.filePath).toBe('maps/normal.jpg');
    expect(normal.filePath).not.toContain('\\');
    expect(normal.sourceIndex).toBe(1);
  });

  it('returns empty array for empty textures', () => {
    const pods = parseTextures({ textures: [] });
    expect(pods.length).toBe(0);
  });

  it('returns empty array for missing textures', () => {
    const pods = parseTextures({});
    expect(pods.length).toBe(0);
  });

  it('texture with no embedded-media: present in output', () => {
    const raw: FbxRawTextures = {
      textures: [{ name: 'checker', filePath: 'tex/checker.tga', sourceIndex: 0 }],
    };
    const pods = parseTextures(raw);
    expect(pods.length).toBe(1);
    expect(pods[0]!.filePath).toBe('tex/checker.tga');
  });

  it('handles texture without name: falls back to filePath as name', () => {
    const raw: FbxRawTextures = {
      textures: [{ filePath: 'tex/unnamed.png', sourceIndex: 0 }],
    };
    const pods = parseTextures(raw);
    expect(pods.length).toBe(1);
    expect(pods[0]!.name).toBe('tex/unnamed.png');
    expect(pods[0]!.filePath).toBe('tex/unnamed.png');
  });
});