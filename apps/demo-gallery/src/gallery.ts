interface DemoManifestEntry {
  route: string;
  name: string;
  title: string;
  category: string;
  url: string;
  kind?: string;
}

interface DemoManifest {
  count: number;
  categories: string[];
  demos: DemoManifestEntry[];
}

interface CategoryMeta {
  label: string;
  hint: string;
  accent: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  bevy: {
    label: 'Bevy Examples',
    hint: 'Bevy-style feature reproductions',
    accent: '#7aa2ff',
  },
  hello: {
    label: 'Hello',
    hint: 'Engine capability smoke demos',
    accent: '#9ece6a',
  },
  'hello-multi-uv': {
    label: 'Hello Multi-UV',
    hint: 'Multi-UV material path',
    accent: '#73daca',
  },
  'learn-render': {
    label: 'Learn Render',
    hint: 'LearnOpenGL-style rendering lessons',
    accent: '#ff9e64',
  },
  templates: {
    label: 'Game Templates',
    hint: 'Preview-hosted template games',
    accent: '#bb9af7',
  },
  preview: {
    label: 'Preview Host',
    hint: 'Asset-resident Cordis gameplay host',
    accent: '#c0caf5',
  },
  collectathon: {
    label: 'Collectathon',
    hint: 'Collectathon sample apps',
    accent: '#e0af68',
  },
  perf: {
    label: 'Perf',
    hint: 'Performance probes',
    accent: '#f7768e',
  },
  parity: {
    label: 'Parity',
    hint: 'Cross-backend parity checks',
    accent: '#2ac3de',
  },
  tetris: {
    label: 'Tetris',
    hint: 'Tetris sample',
    accent: '#ff007c',
  },
  shadertoy: {
    label: 'Shadertoy',
    hint: 'Shader playground ports',
    accent: '#fca7ea',
  },
  'remote-demo': {
    label: 'Remote Demo',
    hint: 'Remote loading samples',
    accent: '#a9b1d6',
  },
  'rhi-debug-viewer': {
    label: 'RHI Debug',
    hint: 'RHI capture inspection',
    accent: '#565f89',
  },
  'multiplayer-snake': {
    label: 'Multiplayer Snake',
    hint: 'Networking sample',
    accent: '#41a6b5',
  },
};

const COLLAPSED_STORAGE_KEY = 'forgeax-demo-gallery-collapsed';

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`demo gallery element missing: ${selector}`);
  return element;
}

const nav = requiredElement<HTMLElement>('#nav');
const searchInput = requiredElement<HTMLInputElement>('#search');
const demoCount = requiredElement<HTMLElement>('#demo-count');
const demoTitle = requiredElement<HTMLElement>('#demo-title');
const demoMeta = requiredElement<HTMLElement>('#demo-meta');
const previewWrap = requiredElement<HTMLElement>('#preview-wrap');
const previewA = requiredElement<HTMLIFrameElement>('#preview-a');
const previewB = requiredElement<HTMLIFrameElement>('#preview-b');
const previewLoading = requiredElement<HTMLElement>('#preview-loading');
const previewLoadingLabel = requiredElement<HTMLElement>('.preview-loading-label');
const placeholder = requiredElement<HTMLElement>('#placeholder');
const openTab = requiredElement<HTMLAnchorElement>('#open-tab');

type PreviewSlot = 'a' | 'b';

const previewFrames: Record<PreviewSlot, HTMLIFrameElement> = {
  a: previewA,
  b: previewB,
};

let visibleSlot: PreviewSlot | null = null;
let previewLoadGeneration = 0;

/** Bevy 2D examples commonly use a 1200x640 orthographic frustum. */
const BEVY_2D_ASPECT = 1200 / 640;
const DEFAULT_ASPECT = 16 / 9;

function resolvePreviewAspect(route: string): number {
  if (route.includes('/2d') || route.includes('2d-')) return BEVY_2D_ASPECT;
  return DEFAULT_ASPECT;
}

function categoryMeta(category: string): CategoryMeta {
  return (
    CATEGORY_META[category] ?? {
      label: category,
      hint: 'Engine demo apps',
      accent: '#8b949e',
    }
  );
}

let manifest: DemoManifest | null = null;
let activeRoute = '';
const collapsedCategories = loadCollapsedCategories();

if (import.meta.hot) {
  // Gallery shell and demo iframes share one Vite dev server. Demo pack/catalog
  // work may broadcast `full-reload` to every HMR client; keep sidebar state.
  import.meta.hot.on('vite:beforeFullReload', () => false);
}

function loadCollapsedCategories(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

function saveCollapsedCategories(): void {
  localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsedCategories]));
}

function isCategoryCollapsed(category: string, filter: string): boolean {
  if (filter.trim()) return false;
  return collapsedCategories.has(category);
}

function routeFromHash(): string {
  return location.hash.replace(/^#\/?/, '');
}

function setHash(route: string): void {
  const next = route ? `#/${route}` : '';
  if (location.hash !== next) location.hash = next;
}

function scrollActiveDemoIntoView(behavior: ScrollBehavior): void {
  const run = (): void => {
    const active = nav.querySelector<HTMLElement>('.demo-link[aria-current="page"]');
    if (!active) return;

    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const targetTop =
      nav.scrollTop + (activeRect.top - navRect.top) - nav.clientHeight / 2 + activeRect.height / 2;

    nav.scrollTo({
      top: Math.max(0, targetTop),
      behavior,
    });
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });
}

function markNavSelection(route: string): void {
  for (const button of nav.querySelectorAll<HTMLButtonElement>('.demo-link')) {
    if (button.dataset.route === route) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  }
}

function syncNavSelection(entry: DemoManifestEntry): void {
  const expandedCategory = collapsedCategories.delete(entry.category);
  saveCollapsedCategories();
  if (expandedCategory) {
    renderNav(searchInput.value);
    return;
  }

  markNavSelection(entry.route);
}

function otherSlot(slot: PreviewSlot): PreviewSlot {
  return slot === 'a' ? 'b' : 'a';
}

function setVisibleSlot(slot: PreviewSlot): void {
  for (const key of ['a', 'b'] as const) {
    previewFrames[key].classList.toggle('is-idle', key !== slot);
  }
  visibleSlot = slot;
}

function beginPreviewLoad(entry: DemoManifestEntry): void {
  const generation = ++previewLoadGeneration;
  const targetSlot = visibleSlot === null ? 'a' : otherSlot(visibleSlot);
  const targetFrame = previewFrames[targetSlot];

  previewLoadingLabel.textContent = `Loading ${entry.title}…`;
  previewLoading.hidden = false;

  const finish = (): void => {
    if (generation !== previewLoadGeneration) return;
    setVisibleSlot(targetSlot);
    previewLoading.hidden = true;
  };

  const onLoad = (): void => {
    targetFrame.removeEventListener('load', onLoad);
    finish();
  };

  targetFrame.addEventListener('load', onLoad);
  if (targetFrame.src === entry.url || targetFrame.src === new URL(entry.url, location.href).href) {
    finish();
    return;
  }
  targetFrame.src = entry.url;
}

function selectDemo(entry: DemoManifestEntry, options: { scroll?: ScrollBehavior } = {}): void {
  if (entry.route === activeRoute && visibleSlot !== null && previewLoading.hidden) {
    if (options.scroll !== undefined) scrollActiveDemoIntoView(options.scroll);
    return;
  }

  activeRoute = entry.route;
  demoTitle.textContent = entry.title;
  demoMeta.textContent = `${entry.name} · ${entry.category}`;
  previewWrap.style.setProperty('--preview-aspect', String(resolvePreviewAspect(entry.route)));
  previewWrap.hidden = false;
  placeholder.hidden = true;
  openTab.href = entry.url;
  openTab.hidden = false;
  setHash(entry.route);

  syncNavSelection(entry);

  if (options.scroll !== undefined) scrollActiveDemoIntoView(options.scroll);

  beginPreviewLoad(entry);
}

function renderNav(filter: string): void {
  if (!manifest) return;

  const needle = filter.trim().toLowerCase();
  const grouped = new Map<string, DemoManifestEntry[]>();

  for (const demo of manifest.demos) {
    const haystack = `${demo.title} ${demo.name} ${demo.route} ${demo.category}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    const bucket = grouped.get(demo.category) ?? [];
    bucket.push(demo);
    grouped.set(demo.category, bucket);
  }

  nav.replaceChildren();
  const categories = [...grouped.keys()].sort((a, b) => a.localeCompare(b));

  for (const category of categories) {
    const demos = grouped.get(category) ?? [];
    const meta = categoryMeta(category);
    const collapsed = isCategoryCollapsed(category, filter);

    const section = document.createElement('section');
    section.className = 'category';
    section.dataset.category = category;
    section.style.setProperty('--category-accent', meta.accent);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'category-toggle';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.innerHTML = `
      <span class="category-chevron" aria-hidden="true"></span>
      <span class="category-heading">
        <span class="category-label">${meta.label}</span>
        <span class="category-hint">${meta.hint}</span>
      </span>
      <span class="category-count">${demos.length}</span>
    `;
    toggle.addEventListener('click', () => {
      if (collapsedCategories.has(category)) collapsedCategories.delete(category);
      else collapsedCategories.add(category);
      saveCollapsedCategories();
      renderNav(searchInput.value);
    });
    section.appendChild(toggle);

    const list = document.createElement('div');
    list.className = 'category-list';
    list.hidden = collapsed;

    for (const demo of demos) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'demo-link';
      button.dataset.route = demo.route;
      button.innerHTML = `${demo.title}<small>${demo.route}</small>`;
      button.addEventListener('click', () => selectDemo(demo));
      if (demo.route === activeRoute) button.setAttribute('aria-current', 'page');
      list.appendChild(button);
    }

    section.appendChild(list);
    nav.appendChild(section);
  }
}

async function boot(): Promise<void> {
  const response = await fetch('/demo-manifest.json');
  manifest = (await response.json()) as DemoManifest;
  demoCount.textContent = `${manifest.count} demos · single dev server`;

  const initialRoute = routeFromHash();
  const initial = manifest.demos.find((demo) => demo.route === initialRoute);
  if (initial) {
    activeRoute = initial.route;
    collapsedCategories.delete(initial.category);
    saveCollapsedCategories();
  }

  renderNav('');
  searchInput.addEventListener('input', () => renderNav(searchInput.value));

  if (initial) selectDemo(initial, { scroll: 'smooth' });
}

window.addEventListener('hashchange', () => {
  if (!manifest) return;
  const route = routeFromHash();
  if (route === activeRoute) return;
  const entry = manifest.demos.find((demo) => demo.route === route);
  if (entry) selectDemo(entry, { scroll: 'smooth' });
});

boot().catch((error) => {
  demoTitle.textContent = 'Failed to load demo manifest';
  demoMeta.textContent = error instanceof Error ? error.message : String(error);
});
