import type {
  RenderPipeline,
  Result,
  RhiDevice,
  RhiError,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { expectTypeOf, test } from 'vitest';
import type {
  blitMipmapsSync,
  encodeMipmapLevel,
  generateMipmaps,
  getOrCreateMipmapPipeline,
  MipmapShaderModuleFactory,
  prepareMipmaps,
} from '../mipmap-generator';

test('mipmap entrypoints preserve RHI devices, resource brands and failures', () => {
  expectTypeOf<Parameters<typeof prepareMipmaps>[0]>().toEqualTypeOf<RhiDevice>();
  expectTypeOf<Parameters<typeof prepareMipmaps>[1]>().toEqualTypeOf<Texture>();
  expectTypeOf<Parameters<typeof blitMipmapsSync>[1]>().toEqualTypeOf<Texture>();
  expectTypeOf<Parameters<typeof generateMipmaps>[1]>().toEqualTypeOf<Texture>();
  expectTypeOf<Parameters<typeof encodeMipmapLevel>[2]>().toEqualTypeOf<TextureView>();
  expectTypeOf<ReturnType<MipmapShaderModuleFactory>>().toEqualTypeOf<
    Promise<Result<ShaderModule, RhiError>>
  >();
  expectTypeOf<ReturnType<typeof getOrCreateMipmapPipeline>>().toEqualTypeOf<
    Promise<Result<RenderPipeline, RhiError>>
  >();
  expectTypeOf<ReturnType<typeof generateMipmaps>>().toEqualTypeOf<
    Promise<Result<void, RhiError>>
  >();
});
