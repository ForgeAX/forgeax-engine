// Positive fixture (w27 case b): the M3 decoder strip landed. The runtime
// carries NO static import from @forgeax/engine-image (the decoder moved to
// the build-time imageImporter); the texture loader reads only an imported
// `.bin`. The Path (a) gate must PASS (exit 0): a.2-anti holds (no runtime
// engine-image edge) and a.2-pos holds (imageImporter holds parseImage,
// fixture file packages/image/src/image-importer.ts).

export async function loadTextureAsset(bytes: Uint8Array): Promise<unknown> {
  // The runtime no longer decodes; it builds a TextureAsset POD from the
  // build-time-imported RGBA `.bin` bytes.
  return { kind: 'texture', data: bytes };
}
