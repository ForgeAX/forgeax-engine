import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../index.js';
import {
  EXACT_F32_MAX,
  F32_BOUNDARY_SOURCE,
  LEGACY_F32_PUBLICATION,
} from './wgsl-f32-boundary.fixture.js';

it('publishes direct and selected-entry IEEE maximum literals accepted by actual Dawn', async () => {
  const programs = [{ name: 'legacy-facade-control', code: LEGACY_F32_PUBLICATION }];
  for (const computeEntry of [undefined, 'positive', 'negative']) {
    const result = (
      await compileShader(F32_BOUNDARY_SOURCE, {
        id: 'f32-boundary',
        ...(computeEntry === undefined ? {} : { computeEntry }),
      })
    ).unwrap();
    expect(result.wgsl).toContain(EXACT_F32_MAX);
    programs.push({ name: computeEntry ?? 'direct', code: result.wgsl });
  }
  expect(programs[0]?.code).toContain('3.4028235e38f');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw Error('Actual adapter required');
  const info = adapter.info;
  console.error(
    '[f32-boundary] before-device',
    JSON.stringify({
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    }),
  );
  const device = await adapter.requestDevice(),
    errors: string[] = [],
    observed = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const out = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
  if (out) mkdirSync(out, { recursive: true });
  try {
    for (const program of programs) {
      if (Buffer.byteLength(program.code) > 65536)
        throw Error('Tiny shader module attachment exceeded 64 KiB');
      if (out) writeFileSync(`${out}/${program.name}.wgsl`, program.code);
      device.pushErrorScope('validation');
      console.error('[f32-boundary] module-start', program.name);
      const module = device.createShaderModule({
        label: `f32-boundary.${program.name}`,
        code: program.code,
      });
      const messages = Array.from((await module.getCompilationInfo()).messages, (m) => ({
        type: m.type,
        message: m.message,
      }));
      const validation = await device.popErrorScope();
      console.error('[f32-boundary] module-return', program.name, JSON.stringify(messages));
      observed.push({ name: program.name, messages, validation: validation?.message ?? null });
      if (out) writeFileSync(`${out}/modules.json`, JSON.stringify(observed, null, 2));
      if (program.name === 'legacy-facade-control') {
        expect(
          messages.some((m) => m.type === 'error' && m.message.includes('cannot be represented')),
        ).toBe(true);
        expect(validation).not.toBeNull();
      } else {
        expect(messages.filter((m) => m.type === 'error')).toEqual([]);
        expect(validation).toBeNull();
      }
    }
    expect(observed).toHaveLength(4);
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
  }
}, 30_000);
