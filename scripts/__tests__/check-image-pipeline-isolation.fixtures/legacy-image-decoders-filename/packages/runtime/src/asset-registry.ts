// Stub asset-registry.ts with NO @forgeax/engine-image import so the fixture
// isolates the legacy-filename failure (image-decoders.d.ts regrowth). Under
// the post-strip gate (w27) a runtime engine-image import would itself trip
// a.2-anti, blurring the assertion target.

export function consumePath(): void {}
