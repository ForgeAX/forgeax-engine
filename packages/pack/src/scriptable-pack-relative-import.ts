import { dirname, extname, resolve } from 'node:path';

export const SCRIPTABLE_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
] as const;

/** Keep execution and source inventory on the same first-existing-file search. */
export function relativeScriptableImportCandidates(
  importer: string,
  specifier: string,
): readonly string[] {
  if (!specifier.startsWith('.')) return [];
  const raw = resolve(
    dirname(importer),
    specifier.endsWith('?raw') ? specifier.slice(0, -4) : specifier,
  );
  const extension = extname(raw);
  const stem = raw.slice(0, raw.length - extension.length);
  const substitutions =
    extension === '.js'
      ? [`${stem}.ts`, `${stem}.tsx`]
      : extension === '.mjs'
        ? [`${stem}.mts`]
        : extension === '.cjs'
          ? [`${stem}.cts`]
          : [];
  if (
    extension === '.json' ||
    SCRIPTABLE_SOURCE_EXTENSIONS.includes(
      extension as (typeof SCRIPTABLE_SOURCE_EXTENSIONS)[number],
    )
  ) {
    return [...substitutions, raw];
  }
  return [
    raw,
    ...SCRIPTABLE_SOURCE_EXTENSIONS.map((suffix) => `${raw}${suffix}`),
    ...SCRIPTABLE_SOURCE_EXTENSIONS.map((suffix) => resolve(raw, `index${suffix}`)),
  ];
}
