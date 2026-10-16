// Stub asset-registry.ts with NO @forgeax/engine-image import so the fixture
// isolates the forbidden-symbol failure (foo.ts re-implements decodeImage).
// Under the post-strip gate (w27) a runtime engine-image import would itself
// trip a.2-anti, blurring the assertion target, so this stub stays clean.

export function consumePath(): void {}
