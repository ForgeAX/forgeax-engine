import { describe, expect, it } from 'vitest';
import { resolveFbxTexturePath } from '../resolve-texture-path.js';

const candidates = (relativePath: string) => [{ relativePath }];

describe('resolveFbxTexturePath', () => {
  it('resolves a Windows absolute hint by its longest unique suffix', () => {
    const result = resolveFbxTexturePath(
      'Mesh/Male_Adult_17_facial.fbx',
      {
        declaredRelativePath: String.raw`D:\temp\Humans\without_opacity_version\m022\textures\m022_body_color.tga`,
      },
      candidates('../Textures/m022_body_color.tga'),
    );

    expect(result).toEqual({
      ok: true,
      relativePath: '../Textures/m022_body_color.tga',
      readUri: '../Textures/m022_body_color.tga',
      strategy: 'suffix',
    });
  });

  it('fails closed when the best basename match is ambiguous', () => {
    const result = resolveFbxTexturePath(
      'Mesh/model.fbx',
      { declaredFilename: String.raw`D:\different\body.tga` },
      [{ relativePath: '../Textures/body.tga' }, { relativePath: '../Other/body.tga' }],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('fbx-external-texture-ambiguous');
  });

  it('keeps a unique candidate path and converts it to a source-relative read URI', () => {
    const result = resolveFbxTexturePath(
      'assets/character/Mesh/model.fbx',
      { declaredRelativePath: '../Textures/body.tga' },
      candidates('../Textures/body.tga'),
    );

    expect(result).toEqual({
      ok: true,
      relativePath: '../Textures/body.tga',
      readUri: '../Textures/body.tga',
      strategy: 'exact',
    });
  });
});
