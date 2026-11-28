import { describe, expect, it, vi } from 'vitest';
import { stagePublicationShaders } from '../shader-publication.js';

const emptyManifest = async () => JSON.stringify({ entries: [] });

describe('renderer shader manifest startup', () => {
  it('reads the default shader manifest when the URL is omitted', async () => {
    const readShaderManifest = vi.fn(emptyManifest);
    const publication = stagePublicationShaders({ readShaderManifest });
    await expect(publication.ready).resolves.toBe(publication.catalog);
    expect(readShaderManifest).toHaveBeenCalledExactlyOnceWith('/shaders/manifest.json');
  });

  it('uses the explicit bundler shader manifest URL', async () => {
    const readShaderManifest = vi.fn(emptyManifest);
    const shaderManifestUrl = '/game/shaders/manifest.json';
    const publication = stagePublicationShaders({ readShaderManifest, shaderManifestUrl });
    await expect(publication.ready).resolves.toBe(publication.catalog);
    expect(readShaderManifest).toHaveBeenCalledExactlyOnceWith(shaderManifestUrl);
  });

  it('skips the manifest read when the bundler explicitly disables it', async () => {
    const readShaderManifest = vi.fn(emptyManifest);
    const publication = stagePublicationShaders({
      readShaderManifest,
      shaderManifestUrl: undefined,
    });
    await expect(publication.ready).resolves.toBe(publication.catalog);
    expect(readShaderManifest).not.toHaveBeenCalled();
  });
});
