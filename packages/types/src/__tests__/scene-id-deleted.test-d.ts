// scene-id-deleted.test-d - negative assertion for SceneInstanceId brand
// deletion (AC-22). Activated in M3 once the old ecs container files are
// deleted in the same commit.
//
// TS compile-time negative assertion: the `@ts-expect-error` directive below
// verifies that importing SceneInstanceId from @forgeax/engine-types produces
// a TS error (TS2305: Module has no exported member). If SceneInstanceId still
// exists, the `@ts-expect-error` is unused and tsc emits TS2578, failing the
// test at typecheck time.

