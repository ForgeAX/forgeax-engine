import { describe, expect, it } from 'vitest';
import { defaultToolDescriptors } from '../catalog.js';
import { createDefaultContributions } from '../contributions.js';

describe('domain preview catalog', () => {
  it('discovers four explicit domain descriptors and no generic preview alias', () => {
    const ids = createDefaultContributions().map((contribution) => contribution.descriptor.id);
    expect(ids).toEqual([
      'project.migrate',
      'project.build',
      'asset.plugin.create',
      'project.root.set',
      'asset.plugin.inspect',
      'asset.list',
      'asset.inspect',
      'asset.resolve',
      'asset.verify',
      'asset.source.create',
      'asset.source.clone',
      'asset.source.import',
      'asset.source.instance.create',
      'asset.source.values.apply',
      'asset.source.rebuild',
      'asset.source.cold-cook',
      'asset.material.preview',
      'asset.mesh.preview',
      'asset.vfx.preview',
      'asset.texture.preview',
    ]);
    expect(ids).not.toContain('asset.preview');
    expect(ids).not.toContain('preview.run');
    expect(ids).not.toContain('preview.analyze');
  });

  it('keeps domain descriptors bound to one host realm and GUID-only inputs', () => {
    const domains = defaultToolDescriptors.filter((descriptor) =>
      descriptor.id.endsWith('.preview'),
    );
    expect(domains.map((descriptor) => descriptor.id)).toEqual([
      'asset.material.preview',
      'asset.mesh.preview',
      'asset.vfx.preview',
      'asset.texture.preview',
    ]);
    for (const descriptor of domains) {
      expect(descriptor.realm).toBe('host');
      expect(descriptor.evidence).toEqual(
        expect.arrayContaining(['rhi-tape', 'png', 'profile-capture']),
      );
      expect(descriptor.evidence).toHaveLength(3);
      expect(descriptor.argsSchema.describe).toContain('"required":["guid"]');
      expect(descriptor.argsSchema.describe).not.toContain('"binding"');
    }
  });
});
