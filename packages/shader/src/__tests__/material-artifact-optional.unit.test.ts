import { describe, expect, it, vi } from 'vitest';
import { ShaderRegistry } from '../ShaderRegistry.js';

describe('optional registered material artifact lookup', () => {
  it('returns absent without taking the strict diagnostic lookup path', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const strict = vi.spyOn(registry, 'findMaterialArtifact').mockImplementation(() => {
      throw Error('optional lookup must not create a diagnostic');
    });
    try {
      expect(registry.materialArtifact('runtime::uncompiled')).toBeUndefined();
      expect(strict).not.toHaveBeenCalled();
    } finally {
      strict.mockRestore();
    }
    const failure = registry.findMaterialArtifact('runtime::uncompiled');
    expect(failure.ok).toBe(false);
    if (failure.ok) throw Error('strict lookup must report the absent shader');
    expect(failure.error).toMatchObject({
      code: 'material-shader-not-found',
      detail: { identifier: 'runtime::uncompiled', registeredShaderIds: [] },
    });
  });

  it('observes later admission and returns the exact immutable admitted entry', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    expect(registry.materialArtifact('runtime::late')).toBeUndefined();
    registry.installMaterialArtifact('runtime::late', {
      source: 'fn admitted() {}',
      paramSchema: [{ name: 'color', type: 'vec4', default: [1, 0, 0, 1] }],
    });
    const artifact = registry.materialArtifact('runtime::late');
    expect(artifact).toBe(registry.findMaterialArtifact('runtime::late').unwrap());
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(artifact?.paramSchema[0]?.name).toBe('color');
    const receiver = new ShaderRegistry({ manifestUrl: undefined });
    receiver.installMaterialArtifactsFrom(registry);
    expect(receiver.materialArtifact('runtime::late')).toBe(
      receiver.findMaterialArtifact('runtime::late').unwrap(),
    );
    expect(receiver.materialArtifact('runtime::late')?.source).toBe(artifact?.source);
  });
});
