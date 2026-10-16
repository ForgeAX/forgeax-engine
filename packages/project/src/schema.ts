import { AssetGuid } from '@forgeax/engine-pack/guid';
import { z } from 'zod';

export const GuidString = z
  .string()
  .refine(
    (value) => value === value.toLowerCase() && AssetGuid.parse(value).ok,
    'expected a canonical UUID string',
  );

export const PluginRealmSchema = z.enum(['host', 'engine', 'build', 'frontend']);
export const GameProjectRootsSchema = z
  .object({
    engine: GuidString.optional(),
    host: GuidString.optional(),
    frontend: GuidString.optional(),
    build: GuidString.optional(),
  })
  .strict();

export const GameProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    schemaVersion: z.literal('3.0.0'),
    roots: GameProjectRootsSchema,
  })
  .strict();

export type GameProject = z.infer<typeof GameProjectSchema>;
export type GameProjectRoots = z.infer<typeof GameProjectRootsSchema>;
