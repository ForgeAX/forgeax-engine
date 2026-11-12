import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { SHOW_PROGRAMS } from './programs.ts';
import { SHOW_DISC_KEY, showDiscMaterial } from './show.ts';
import { packGuid } from './subjects.ts';

/**
 * The Show project roots of one program: the engine plugin runs the program in the World,
 * the frontend plugin mounts the timeline UI (`ui`, the timeline UiAsset GUID). The
 * program's subject Packs are ordinary siblings; every output they list is referenced so
 * the Pack closure publishes it.
 */
export function showPack(options: {
  readonly packageId: string;
  readonly program: string;
  readonly ui: string;
  /** Specifier of the module exporting `showEngine` and `showTimeline`, relative to the Pack file. */
  readonly plugins: string;
  /** Build root module (default export: a plugin registering native cookers), relative to the Pack file. */
  readonly build?: string;
  /** Mirror the subject in the turntable disc through the camera's PlanarReflection (default true). */
  readonly mirror?: boolean;
  /** Build identity shown on the page (for example the source commits). */
  readonly label?: string;
}) {
  const program = SHOW_PROGRAMS[options.program];
  if (program === undefined) throw new Error(`unknown Show program ${options.program}`);
  const references = program.subjects.flatMap((subject) =>
    subject.packs.flatMap((pack) =>
      [...(pack.scenes ?? []), ...(pack.meshes ?? []), ...Object.values(pack.materials ?? {})].map((key) => ({
        $asset: packGuid(pack.packageId, key),
      })),
    ),
  );
  return definePack({
    schemaVersion: '2.0.0',
    plugins: true,
    packageId: definePackageId(options.packageId),
    build: () =>
      ok({
        [SHOW_DISC_KEY]: showDiscMaterial(),
        ...Object.fromEntries(Object.entries(program.looks ?? {}).map(([name, look]) => [`material/look-${name}`, look])),
        'plugin/engine': {
          kind: 'plugin',
          module: { specifier: options.plugins, export: 'showEngine' },
          config: {
            program: options.program,
            assets: references,
            ...(options.mirror === false ? {} : { disc: { $asset: packGuid(options.packageId, SHOW_DISC_KEY) } }),
            ...(options.label === undefined ? {} : { label: options.label }),
            looks: Object.fromEntries(
              Object.keys(program.looks ?? {}).map((name) => [name, { $asset: packGuid(options.packageId, `material/look-${name}`) }]),
            ),
          },
        },
        ...(options.build === undefined
          ? {}
          : { 'plugin/build': { kind: 'plugin', module: { specifier: options.build } } }),
        'plugin/frontend': {
          kind: 'plugin',
          module: { specifier: options.plugins, export: 'showTimeline' },
          config: { ui: { $asset: options.ui } },
        },
      }),
  });
}
