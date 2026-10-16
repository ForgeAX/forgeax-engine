import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import {
  frameRequest,
  type PreparedFeatureMode,
  preparedFeature,
  preparedManifest,
  preparedWorld,
} from './render-feature-prepared-graphics.fixture';

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
}

function rootErrorCode(value: unknown): string {
  let error = value as { code: string; detail?: unknown };
  while (error.detail !== undefined && typeof error.detail === 'object' && error.detail !== null) {
    const cause = (error.detail as { cause?: unknown }).cause;
    if (
      cause === undefined ||
      typeof cause !== 'object' ||
      cause === null ||
      typeof (cause as { code?: unknown }).code !== 'string'
    ) {
      break;
    }
    error = cause as { code: string; detail?: unknown };
  }
  return error.code;
}

async function runCase(mode: PreparedFeatureMode) {
  const host = await constructRendererHost(
    canvas(),
    { rhi, features: [preparedFeature(`synthetic.${mode}`, mode)] },
    { shaderManifestUrl: preparedManifest },
  );
  expect(host.ok).toBe(true);
  if (!host.ok) return { frame: host, errors: [] as string[] };
  const errors: string[] = [];
  host.value.renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(rootErrorCode(event.error));
  });
  const world = preparedWorld();
  const attached = host.value.renderer.attach(world);
  expect(attached.ok).toBe(true);
  if (!attached.ok) return { frame: attached, errors };
  expect(world.update().ok).toBe(true);
  const first = host.value.renderer.draw(frameRequest(attached.value));
  if (first.ok) await first.value.completed;
  if (mode === 'recovery') {
    expect(world.update().ok).toBe(true);
    expect(host.value.renderer.draw(frameRequest(attached.value)).ok).toBe(true);
  }
  host.value.renderer.dispose();
  return { frame: first, errors: errors.filter((code) => code.startsWith('render-feature-')) };
}

describe('prepared graphics state-machine regression', () => {
  it('isolates accepted, empty, mismatch, and next-frame recovery cases', async () => {
    const accepted = await runCase('accepted');
    const empty = await runCase('empty');
    const mismatch = await runCase('mismatch');
    const recovery = await runCase('recovery');

    expect(accepted.frame.ok).toBe(true);
    expect(accepted.errors).not.toContain('render-feature-prepared-state-mismatch');
    expect(empty.frame.ok).toBe(true);
    expect(empty.errors).toEqual([]);
    expect(mismatch.frame.ok).toBe(true);
    expect(mismatch.errors).toContain('render-feature-stage-failed');
    expect(recovery.frame.ok).toBe(true);
    expect(recovery.errors).toContain('render-feature-stage-failed');
  });

  it('keeps a healthy feature producing a frame when a sibling fails preparation state', async () => {
    const host = await constructRendererHost(
      canvas(),
      {
        rhi,
        features: [
          preparedFeature('synthetic.healthy', 'accepted'),
          preparedFeature('synthetic.failing', 'mismatch'),
        ],
      },
      { shaderManifestUrl: preparedManifest },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    const errors: string[] = [];
    host.value.renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(rootErrorCode(event.error));
    });
    const world = preparedWorld();
    const attached = host.value.renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    expect(host.value.renderer.draw(frameRequest(attached.value)).ok).toBe(true);
    expect(errors).toContain('render-feature-stage-failed');
    host.value.renderer.dispose();
  });
});
