// apps/hello/asi-world/src/atlas-viewer.ts
// Debug entry: side-by-side PNG view of terrain_atlas + object_atlas
// (vite multi-input target — see vite.config.ts atlasViewer).
//
// Charter P5 (producer/consumer split): browser-only — pure DOM, no
// renderer / no engine imports. The page is the AI user's escape
// hatch when atlas authoring drift is suspected; one URL away from
// the main demo (plan-strategy §M3 atlas-viewer.html boundary).

interface AtlasEntry {
  readonly label: string;
  readonly src: string;
}

const ATLASES: readonly AtlasEntry[] = [
  { label: 'terrain_atlas', src: '/world/terrain_atlas.png' },
  { label: 'object_atlas', src: '/world/object_atlas.png' },
];

function renderAtlas(parent: HTMLElement, entry: AtlasEntry): void {
  const wrap = document.createElement('div');
  wrap.className = 'atlas';

  const lbl = document.createElement('label');
  lbl.textContent = entry.label;

  const sizeSpan = document.createElement('span');
  const img = new Image();
  img.src = entry.src;
  img.onload = (): void => {
    sizeSpan.textContent = `${img.naturalWidth} x ${img.naturalHeight} px`;
  };
  img.onerror = (): void => {
    sizeSpan.textContent = `failed: ${entry.src}`;
  };

  wrap.append(lbl, sizeSpan, img);
  parent.append(wrap);
}

const row = document.getElementById('row');
if (row === null) {
  throw new Error('[atlas-viewer] missing #row container in atlas-viewer.html');
}
for (const atlas of ATLASES) {
  renderAtlas(row, atlas);
}
