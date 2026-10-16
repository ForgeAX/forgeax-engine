import { describe, expect, it } from 'vitest';
import { parseVfxStageDeclarations } from '../code-source.js';
import { parseParticleEffectSourceV3 } from '../code-source-v3.js';

const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'sparks',
      capacity: 1024,
      backend: { required: 'gpu' as const },
      space: 'world',
      schedule: { rate: 32, bursts: [{ time: 0, count: 16 }], loopDuration: 2 },
      bounds: { kind: 'aabb', min: [-10, -10, -10], max: [10, 10, 10] },
      program: { module: 'sparks.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: 'material-guid' }],
    },
  ],
};

describe('ParticleCodeEffectSource v3', () => {
  it('accepts typed bounded channels and same-effect visual events', () => {
    const result = parseParticleEffectSourceV3({
      ...source,
      emitters: [
        {
          ...source.emitters[0],
          channels: [{ id: 'impact', capacity: 2, overflow: 'drop-newest' }],
          events: [
            {
              id: 'impact-event',
              channel: 'impact',
              subEmitter: 'sparks',
              fanOut: 1,
              recursionDepth: 1,
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts the code-first source without an operator stack', () => {
    const result = parseParticleEffectSourceV3(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.emitters[0]?.program.module).toBe('sparks.vfx.wgsl');
    }
  });

  it('keeps stage declarations in authored WGSL rather than the source manifest', () => {
    const stage = parseVfxStageDeclarations(
      '// #vfx stage turbulence entry=vfx_turbulence domain=particle resources=particles:read-write dependsOn=update iterationBudget=4',
    );
    expect(stage.ok).toBe(true);
  });

  it('rejects v1 with an executable recook hint', () => {
    const result = parseParticleEffectSourceV3({ schemaVersion: 1, emitters: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-source-version-unsupported');
      expect(result.error.hint).toContain('Program v3');
      expect(result.error.hint).toContain('cold-cook');
    }
  });

  it('requires one explicit GPU backend policy and rejects derived fields', () => {
    const backend = structuredClone(source) as unknown as {
      emitters: Array<Record<string, unknown>>;
    };
    const emitter = backend.emitters[0];
    expect(emitter).toBeDefined();
    if (emitter === undefined) return;
    emitter.backend = { required: 'cpu' };
    expect(parseParticleEffectSourceV3(backend).ok).toBe(false);
    const derived = structuredClone(source) as typeof source & { backendPlan: string };
    derived.backendPlan = 'gpu';
    expect(parseParticleEffectSourceV3(derived).ok).toBe(false);
  });

  it.each([
    ['bounds', { bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1, dynamic: true } }],
    ['schedule', { schedule: { rate: 1, legacyRate: 2 } }],
    ['burst', { schedule: { rate: 1, bursts: [{ time: 0, count: 1, once: true }] } }],
    ['program', { program: { module: 'sparks.vfx.wgsl', fallback: 'cpu' } }],
    ['parameters', { parameters: { speed: 1 } }],
    ['custom data', { customData: { value: 1 } }],
  ])('rejects unknown nested %s fields', (_name, override) => {
    const emitter = { ...source.emitters[0], ...override };
    expect(parseParticleEffectSourceV3({ ...source, emitters: [emitter] }).ok).toBe(false);
  });

  it('keeps Data Interface requirements out of the source-side roster', () => {
    const emitter = {
      ...source.emitters[0],
      dataInterfaces: [{ token: 'vfx:camera' }],
    };
    expect(parseParticleEffectSourceV3({ ...source, emitters: [emitter] }).ok).toBe(false);
  });

  it('accepts an explicit mesh submesh and rejects ambiguous indices', () => {
    const mesh = structuredClone(source) as unknown as {
      schemaVersion: number;
      emitters: Array<Record<string, unknown>>;
    };
    const emitter = mesh.emitters[0];
    expect(emitter).toBeDefined();
    if (emitter === undefined) return;
    const renderers: Array<Record<string, unknown>> = [
      { kind: 'mesh', material: 'material-guid', mesh: 'mesh-guid', submesh: 2 },
    ];
    emitter.renderers = renderers;
    expect(parseParticleEffectSourceV3(mesh).ok).toBe(true);
    const renderer = renderers[0];
    expect(renderer).toBeDefined();
    if (renderer === undefined) return;
    renderer.submesh = -1;
    expect(parseParticleEffectSourceV3(mesh).ok).toBe(false);
  });
});
