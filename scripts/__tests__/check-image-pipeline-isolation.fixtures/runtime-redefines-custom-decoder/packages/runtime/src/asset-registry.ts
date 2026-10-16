// Stub asset-registry.ts with NO @forgeax/engine-image import so the fixture
// isolates the class-Decoder failure (custom-decoder.ts adds a new
// implementation symbol). Under the post-strip gate (w27) a runtime
// engine-image import would itself trip a.2-anti, blurring the assertion.

export function consumePath(): void {}
