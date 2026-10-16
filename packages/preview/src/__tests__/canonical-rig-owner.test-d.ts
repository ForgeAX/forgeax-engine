/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PreviewPresentation as PublicPreviewPresentation } from '../index.js';
import type { CanonicalPreviewRecipe, canonicalPresentation } from '../kit/canonical.js';
import type { PreviewPresentation as PresentationOwner } from '../kit/presentation.js';

type LitAssetGeometry = Extract<PresentationOwner, { readonly kind: 'lit-asset' }>['geometry'];
type PublicLitAssetGeometry = Extract<
  PublicPreviewPresentation,
  { readonly kind: 'lit-asset' }
>['geometry'];
type TextureGeometry = Extract<PresentationOwner, { readonly kind: 'texture-unlit' }>['geometry'];
type CanonicalRig = CanonicalPreviewRecipe['rig'];
type PublicCanonicalRig = import('../index.js').CanonicalPreviewRecipe['rig'];
type CanonicalPresentation = ReturnType<typeof canonicalPresentation>;
type CanonicalLitGeometry = Extract<
  CanonicalPresentation,
  { readonly kind: 'lit-asset' }
>['geometry'];
type CanonicalTextureGeometry = Extract<
  CanonicalPresentation,
  { readonly kind: 'texture-unlit' }
>['geometry'];

const canonicalSource = readFileSync(new URL('../kit/canonical.ts', import.meta.url), 'utf8');
const normalizedCanonicalSource = canonicalSource.replace(/\s+/g, ' ');

describe('canonical preview rig owner', () => {
  it('keeps the lit rig derived from the presentation owner', () => {
    expectTypeOf<LitAssetGeometry>().toEqualTypeOf<'handle-sphere' | 'asset-mesh'>();
    expectTypeOf<PublicLitAssetGeometry>().toEqualTypeOf<LitAssetGeometry>();
    expectTypeOf<CanonicalRig>().toEqualTypeOf<LitAssetGeometry | 'asset-quad'>();
    expectTypeOf<LitAssetGeometry | 'asset-quad'>().toEqualTypeOf<CanonicalRig>();
    expectTypeOf<PublicCanonicalRig>().toEqualTypeOf<CanonicalRig>();
    expectTypeOf<CanonicalLitGeometry>().toEqualTypeOf<LitAssetGeometry>();

    const acceptsCanonicalRig = (rig: CanonicalRig): CanonicalRig => rig;
    acceptsCanonicalRig('handle-sphere');
    acceptsCanonicalRig('asset-mesh');
    acceptsCanonicalRig('asset-quad');
    // @ts-expect-error Texture presentation geometry is not a canonical recipe rig.
    acceptsCanonicalRig('aspect-quad');
  });

  it('preserves the texture presentation projection and owner declaration', () => {
    expectTypeOf<TextureGeometry>().toEqualTypeOf<'aspect-quad'>();
    expectTypeOf<CanonicalTextureGeometry>().toEqualTypeOf<TextureGeometry>();
    expect(normalizedCanonicalSource).toContain(
      "readonly rig: Extract<PreviewPresentation, { readonly kind: 'lit-asset' }>['geometry'] | 'asset-quad';",
    );
    expect(normalizedCanonicalSource).not.toContain(
      "readonly rig: 'handle-sphere' | 'asset-mesh' | 'asset-quad';",
    );
    expect(normalizedCanonicalSource).toContain("geometry: 'aspect-quad';");
    expect(normalizedCanonicalSource).not.toContain(' as ');
  });
});
