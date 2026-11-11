import { cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Engine-owned coverage for runtime packs (native program admitted at run time,
// UI button -> GameHost.port -> engine -> state reply). The template stays a
// slim starter; tests install this feature into a disposable project copy.
const ASSETS = resolve(import.meta.dirname, 'assets');
const VASE_PLUGIN_GUID = '2ad7eb74-815c-5129-b7b7-be05e171b788';

const edits = [
  {
    file: 'world/world.pack.ts',
    anchor:
      "          { $asset: 'c034cc6c-b31f-5b16-89d6-4db4d05939d8' }, // player/player.pack.ts plugin/player\n",
    insert: `          { $asset: '${VASE_PLUGIN_GUID}' }, // runtime-vase/vase.pack.ts plugin/vase\n`,
  },
  {
    file: 'ui/guide.ui.html',
    anchor: '  <small data-ui-slot="hint">',
    after: '</small>\n',
    insert:
      '  <button type="button" data-ui-part="vase-button">Reshape vase</button>\n' +
      '  <span data-ui-part="vase-status" role="status" aria-live="polite">Preparing vase...</span>\n',
  },
  {
    file: 'ui/guide.ui.css',
    anchor: '.crosshair { position:',
    insert:
      '.guide button { cursor: pointer; margin-top: 3px; padding: 5px 10px; border: 0; border-radius: 4px; background: #ffdf76; color: #142230; font: inherit; }\n' +
      '.guide button:disabled { opacity: 0.6; cursor: wait; }\n' +
      ':host(.locked) .guide button { display: none; }\n',
  },
  {
    file: 'ui/guide-controller.ts',
    anchor: "import { installPlayerHud } from './player-hud.ts';\n",
    insert: "import { installVaseButton } from './vase-button.ts';\n",
    position: 'after',
  },
  {
    file: 'ui/guide-controller.ts',
    anchor: '      releases.push(() => hud.dispose());\n',
    insert:
      '      const vase = installVaseButton(shadow, port);\n      releases.push(() => vase.dispose());\n',
    position: 'after',
  },
];

/** Add the runtime vase feature to a disposable copy of templates/game-3d. */
export async function installRuntimeVase(root) {
  const assets = resolve(root, 'assets');
  await cp(ASSETS, assets, { recursive: true });
  for (const { file, anchor, after, insert, position = 'before' } of edits) {
    const path = resolve(assets, file);
    const source = await readFile(path, 'utf8');
    const start = source.indexOf(anchor);
    if (start < 0 || source.indexOf(anchor, start + 1) >= 0)
      throw new Error(
        `runtime vase overlay: ${file} no longer has one anchor ${JSON.stringify(anchor)}`,
      );
    let at = start;
    if (after !== undefined) at = source.indexOf(after, start) + after.length;
    else if (position === 'after') at = start + anchor.length;
    await writeFile(path, source.slice(0, at) + insert + source.slice(at));
  }
}
