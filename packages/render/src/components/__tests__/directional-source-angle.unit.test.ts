import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { collectCameraSnapshots } from '../../extract/cameras';
import { extractWorldEnvironment } from '../../extract/world-environment';
import { VIEW_UNIFORM_BYTES, VIEW_UNIFORM_SLOT_STRIDE, writeViewUbo } from '../../record/view-ubo';
import { createWorldInternalView, prepareExtractContext } from '../../render-system-extract';
import { Camera } from '../camera';
import { DirectionalLight } from '../directional-light';
import { sunSourceRadiusOf } from '../sun-source-radius';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('DirectionalLight.sourceAngle', () => {
  it('defaults to the sun apparent diameter, 0.5357 degrees', () => {
    expect(read('../directional-light.ts')).toMatch(
      /sourceAngle: \{ type: 'f32', default: 0\.5357 \}/,
    );
  });

  it('is validated as finite and >= 0 at the render boundary', () => {
    const helpers = read('../light-helpers.ts');
    expect(helpers).toMatch(/!Number\.isFinite\(sourceAngle\) \|\| sourceAngle < 0/);
    expect(helpers).toMatch(/'sourceAngle'/);
  });

  it('publishes the current ECS source angle in View lane 251', async () => {
    const world = new World();
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1 } },
      )
      .unwrap();
    const sun = world.spawn({ component: DirectionalLight, data: { sourceAngle: 2 } }).unwrap();
    world.update().unwrap();
    const [camera] = collectCameraSnapshots(world);
    if (camera === undefined) throw new Error('Expected a projected camera');

    const context = prepareExtractContext(world);
    const extract = () =>
      extractWorldEnvironment(world, context, createWorldInternalView(world), undefined).lights;
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const buffer = device
      .createBuffer({
        size: VIEW_UNIFORM_SLOT_STRIDE + VIEW_UNIFORM_BYTES,
        usage: 0x0040 | 0x0008,
      })
      .unwrap();
    const radii: number[] = [];
    const queue = {
      writeBuffer: (_target: Buffer, offset: number, payload: Float32Array) => {
        expect(offset).toBe(VIEW_UNIFORM_SLOT_STRIDE);
        radii.push(payload[251] as number);
        return device.queue.writeBuffer(buffer, offset, payload);
      },
    } as RhiQueue;
    try {
      for (const degrees of [2, 6]) {
        world.set(sun, DirectionalLight, { sourceAngle: degrees }).unwrap();
        const lights = extract();
        if (lights.directional === undefined) throw new Error('Expected the extracted sun');
        expect(lights.directional.sourceAngle).toBe(degrees);
        writeViewUbo(
          queue,
          buffer,
          camera,
          lights.directional,
          lights,
          [],
          VIEW_UNIFORM_SLOT_STRIDE,
        );
      }
      expect(radii).toEqual(
        [2, 6].map((degrees) => Math.fround(Math.sin((degrees * Math.PI) / 360))),
      );
    } finally {
      device.destroyBuffer(buffer).unwrap();
    }
  });

  it('writes sin(half angle) for the View lane and 0 for a point light', () => {
    expect(sunSourceRadiusOf(0)).toBe(0);
    expect(sunSourceRadiusOf(-1)).toBe(0);
    expect(sunSourceRadiusOf(Number.NaN)).toBe(0);
    expect(sunSourceRadiusOf(0.5357)).toBeCloseTo(Math.sin(0.5 * 0.5357 * (Math.PI / 180)), 12);
    expect(sunSourceRadiusOf(1000)).toBeLessThanOrEqual(1);
  });
});
