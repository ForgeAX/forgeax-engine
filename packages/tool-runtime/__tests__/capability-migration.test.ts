import { describe, expect, it } from 'vitest';
import {
  createCapabilityToken,
  createMigrationRecipe,
  probeMigrationTarget,
  validateMigrationPayload,
} from '../src/migration.js';
import type { MigrationCapabilityProbe } from '../src/migration.js';

const source: MigrationCapabilityProbe = {
  realm: 'host',
  catalogDigest: 'sha256:catalog-source',
  rhiBackend: 'webgpu',
  evidence: ['rhi-tape', 'png', 'profile-capture'],
  carrier: false,
  service: false,
};

const target: MigrationCapabilityProbe = {
  realm: 'host',
  catalogDigest: 'sha256:catalog-target',
  rhiBackend: 'webgpu',
  evidence: ['rhi-tape', 'png', 'profile-capture'],
  carrier: false,
  service: true,
};

describe('capability migration contract', () => {
  it('requires a versioned token and re-probes target capability', () => {
    const token = createCapabilityToken('project.preview', source, '1.0.0', target);
    expect(token).toMatchObject({
      kind: 'forgeax-tool-capability',
      version: '1.0.0',
      operation: 'project.preview',
      source,
    });
    expect(probeMigrationTarget(token, target)).toEqual({ ok: true, value: target });
    expect(
      probeMigrationTarget(token, { ...target, catalogDigest: 'sha256:stale' }),
    ).toMatchObject({ ok: false, error: { code: 'tool-capability-unavailable' } });
  });

  it('only carries a serializable recipe, snapshot, and artifact references', () => {
    const recipe = createMigrationRecipe({
      operation: 'project.preview',
      args: { scene: 'triangle', frames: 3 },
      snapshot: { revision: 2, digest: 'sha256:snapshot' },
      artifacts: [{ kind: 'rhi-tape', digest: 'sha256:tape' }],
    });
    expect(recipe).toMatchObject({ operation: 'project.preview', snapshot: { revision: 2 } });
    expect(validateMigrationPayload(recipe)).toEqual({ ok: true });
    expect(validateMigrationPayload({ nested: { world: { entityCount: 1 } } })).toMatchObject({
      ok: false,
      error: { code: 'tool-migration-live-state' },
    });
    expect(validateMigrationPayload({ ui: { selection: ['camera'] } })).toMatchObject({
      ok: false,
      error: { code: 'tool-migration-live-state' },
    });
  });
});
