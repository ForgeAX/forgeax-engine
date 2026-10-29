import { AssetGuid } from '@forgeax/engine-pack/guid';
import { z } from 'zod';

export const GuidString = z
  .string()
  .refine(
    (value) => value === value.toLowerCase() && AssetGuid.parse(value).ok,
    'expected a canonical UUID string',
  );

/**
 * A read-only asset library: an Engine facade `@forgeax/engine/<package-directory>`
 * or a bare npm package name whose manifest declares `forgeax.library.assetRoot`.
 */
export const AssetLibrarySpecifier = z
  .string()
  .regex(
    /^(?:@forgeax\/engine\/[a-z0-9][a-z0-9-]*|(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$/,
    'expected @forgeax/engine/<package-directory> or a bare npm package name',
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
    assetRoots: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (path) =>
              !path.includes('\\') &&
              !path.includes(':') &&
              !path.includes('\0') &&
              path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
            'expected a project-relative asset directory with forward slashes',
          ),
      )
      .default(['assets']),
    assetLibraries: z
      .array(AssetLibrarySpecifier)
      .refine((items) => new Set(items).size === items.length, 'expected unique asset libraries')
      .default([]),
  })
  .strict();

export type GameProject = z.infer<typeof GameProjectSchema>;
export type GameProjectRoots = z.infer<typeof GameProjectRootsSchema>;
