import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';

const assetRoot = resolve(import.meta.dirname, '../assets/ui');

async function readPack(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(assetRoot, name), 'utf8')) as Record<string, unknown>;
}

describe('game-default UI asset manifest', () => {
  it('keeps one derived identity per self-contained UI pack', async () => {
    const hud = await readPack('hud.pack.json');
    const settings = await readPack('settings.pack.json');
    expect(hud.schemaVersion).toBe('3.0.0');
    expect(settings.schemaVersion).toBe('3.0.0');
    const hudId = PackageId.parse(hud.packageId as string);
    const settingsId = PackageId.parse(settings.packageId as string);
    if (!hudId.ok) throw hudId.error;
    if (!settingsId.ok) throw settingsId.error;
    const hudAsset = (hud.assets as Record<string, { kind: string }>)["ui/hud"];
    const settingsAsset = (settings.assets as Record<string, { kind: string }>)["ui/settings"];
    const hudGuid = AssetGuid.format(AssetGuid.derive(hudId.value, 'ui/hud'));
    const settingsGuid = AssetGuid.format(AssetGuid.derive(settingsId.value, 'ui/settings'));
    expect(hudAsset?.kind).toBe('ui');
    expect(settingsAsset?.kind).toBe('ui');
    expect(hudGuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(settingsGuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(hudGuid).not.toBe(settingsGuid);
  });

  it('stores the final HTML and CSS payload without an importer or DDC', async () => {
    const hud = await readPack('hud.pack.json');
    const settings = await readPack('settings.pack.json');
    for (const pack of [hud, settings]) {
      const asset = Object.values(pack.assets as Record<string, { payload: { html: string; css: string } }>)[0];
      expect(asset?.payload.html).toContain('data-ui');
      expect(asset?.payload.css).toContain(':host');
    }
    const settingsHtml = (settings.assets as Record<string, { payload: { html: string } }>)['ui/settings']?.payload.html;
    const hudHtml = (hud.assets as Record<string, { payload: { html: string } }>)['ui/hud']?.payload.html;
    expect(hudHtml).toContain('data-ui-slot="mission"');
    expect(hudHtml).toContain('data-ui-slot="health"');
    expect(hudHtml).toContain('data-ui-slot="target-status"');
    expect(hudHtml).toContain('data-ui-slot="charge"');
    expect(hudHtml).toContain('data-ui-slot="charge-meter"');
    expect(hudHtml).toContain('data-ui-slot="combo"');
    expect(hudHtml).toContain('data-ui-slot="asset-lab-status"');
    expect(hudHtml).toContain('<details class="asset-lab">');
    expect(hudHtml).toContain('data-ui-action="target-profile"');
    expect(hudHtml).toContain('data-ui-action="jpeg-texture"');
    expect(hudHtml).toContain('data-ui-action="video-texture"');
    expect(hudHtml).toContain('data-ui-action="sprite-atlas"');
    expect(hudHtml).toContain('data-ui-action="font-source"');
    expect(hudHtml).toContain('data-ui-action="fbx-companion"');
    expect(settingsHtml).toContain('data-ui-setting="clear-color"');
    expect(settingsHtml).toContain('value="purple"');
  });
});
