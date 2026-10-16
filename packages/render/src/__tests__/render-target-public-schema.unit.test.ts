import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Render from '../index';

const schema = JSON.parse(
  readFileSync(new URL('./render-target-public-schema.json', import.meta.url), 'utf8'),
) as {
  readonly $id: string;
  readonly title: string;
  readonly schemaVersion?: never;
  readonly additionalProperties: boolean;
  readonly properties: {
    readonly schemaVersion: { readonly const: string };
    readonly runtimeExports: { readonly items: { readonly enum: readonly string[] } };
    readonly typeExports: { readonly items: { readonly enum: readonly string[] } };
    readonly operations: {
      readonly items: {
        readonly properties: { readonly name: { readonly enum: readonly string[] } };
      };
    };
    readonly errorCodes: { readonly items: { readonly enum: readonly string[] } };
    readonly stableTargetIds: { readonly const: readonly string[] };
  } & Record<string, unknown>;
};

const manifest = JSON.parse(
  readFileSync(
    new URL(
      '../../../../apps/learn-render/6.pbr/4.render-target-reflection/src/feature-manifest.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  readonly stableTargetIds: readonly string[];
  readonly evidenceCommands: readonly string[];
  readonly operations: readonly string[];
};

describe('public render-target schema and stable consumer manifest', () => {
  it('describes the public surface without a runtime registry', () => {
    expect(schema.properties.schemaVersion.const).toBe('render-target-public/1');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual([
      'schemaVersion',
      'runtimeExports',
      'typeExports',
      'operations',
      'errorCodes',
      'stableTargetIds',
    ]);
    for (const name of schema.properties.runtimeExports.items.enum)
      expect(name in Render).toBe(true);
    expect(schema.properties.typeExports.items.enum).toContain('ReflectionProbeInspection');
    expect(schema.properties.typeExports.items.enum).toContain(
      'ReflectionProbeSelectionInspection',
    );
    expect(schema.properties.typeExports.items.enum).toContain('RenderIntentInvalidDetail');
    expect(schema.properties.operations.items.properties.name.enum).toEqual([
      'Renderer.createRenderTarget',
      'Renderer.resizeRenderTarget',
      'Renderer.createRenderTargetTextureSource',
      'Renderer.requestTargetReadback',
      'Renderer.requestFramebufferSnapshot',
      'Renderer.observe',
      'Renderer.inspect',
      'Renderer.recover',
      'Renderer.destroyRenderTarget',
    ]);
    expect(schema.properties.errorCodes.items.enum).toEqual([
      'render-target-descriptor-invalid',
      'render-target-capability-missing',
      'render-target-layer-invalid',
      'render-target-state-invalid',
      'render-target-operation-failed',
      'framebuffer-snapshot-failed',
      'reflection-probe-budget-exceeded',
      'render-intent-invalid',
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/device|queue|encoder|handle|registry/i);
  });

  it('keeps the five stable target IDs and evidence commands aligned', () => {
    // The reflection consumer does not snapshot a framebuffer; the snapshot journey
    // is gated by framebuffer-snapshot.{dawn,browser}.test.ts in @forgeax/engine-runtime.
    expect(manifest.operations).toEqual(
      schema.properties.operations.items.properties.name.enum.filter(
        (name) => name !== 'Renderer.requestFramebufferSnapshot',
      ),
    );
    expect(manifest.stableTargetIds).toEqual(schema.properties.stableTargetIds.const);
    expect(manifest.evidenceCommands).toEqual([
      'node scripts/smoke-cube-camera-browser.mjs',
      'node scripts/smoke-cube-camera-dawn.mjs',
      'node scripts/smoke-reflection-probe-browser.mjs',
      'node scripts/smoke-reflection-probe-dawn.mjs',
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/device|queue|encoder|handle|registry/i);
  });
});
