import { defineResource } from '@forgeax/engine-ecs';

export const TerrainWalkerResource = defineResource<{ entity: import('@forgeax/engine-ecs').EntityHandle; speed: number; updates: number }>("TerrainWalker");

export const TerrainSubjectsResource = defineResource<Awaited<ReturnType<typeof import('./scene').buildTerrainWorld>>>('TerrainSubjects');
export const TerrainReloadPolicyResource = defineResource<ReturnType<typeof import('./reload-policy').terrainReloadPolicy>>('TerrainReloadPolicy');
export const TerrainGameplayGateResource = defineResource<ReturnType<typeof import('./reload-policy').terrainReloadPolicy>['gate']>('TerrainGameplayGate');
export const TerrainQueryResource = defineResource<Parameters<typeof import('./reload-policy').terrainReloadPolicy>[3]>('TerrainQuery');
export const TerrainWriterFailuresResource = defineResource<unknown[]>('TerrainWriterFailures');
