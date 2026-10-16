// Static specifiers let Vite code-split grammars used by source previews.

type HighlighterCore = {
  loadLanguage: (lang: unknown) => Promise<unknown>;
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
};
type LanguageInput = unknown;

export type HighlightAppearance = 'light' | 'dark';

export const HIGHLIGHT_THEMES = {
  light: 'github-light-default',
  dark: 'github-dark-default',
} as const;

type LangModule = { readonly default: LanguageInput };

const LANG_LOADERS: Readonly<Record<string, () => Promise<LangModule>>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  json5: () => import('shiki/langs/json5.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  wgsl: () => import('shiki/langs/wgsl.mjs'),
  glsl: () => import('shiki/langs/glsl.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
};

let corePromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const inFlightLangs = new Map<string, Promise<boolean>>();

async function getCore(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const [coreMod, engineMod, darkTheme, lightTheme] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-dark-default.mjs'),
        import('shiki/themes/github-light-default.mjs'),
      ]);
      const core = await coreMod.createHighlighterCore({
        themes: [darkTheme.default, lightTheme.default],
        langs: [],
        engine: engineMod.createJavaScriptRegexEngine({ forgiving: true }),
      });
      return core as unknown as HighlighterCore;
    })();
  }
  return corePromise as Promise<HighlighterCore>;
}

async function ensureLanguage(core: HighlighterCore, lang: string): Promise<boolean> {
  if (loadedLangs.has(lang)) return true;
  const loader = LANG_LOADERS[lang];
  if (!loader) return false;
  let pending = inFlightLangs.get(lang);
  if (!pending) {
    pending = (async () => {
      const mod = await loader();
      await core.loadLanguage(mod.default);
      loadedLangs.add(lang);
      return true;
    })();
    inFlightLangs.set(lang, pending);
  }
  return pending;
}

export async function highlightToHtml(
  code: string,
  lang: string,
  appearance: HighlightAppearance = 'dark',
): Promise<string | null> {
  const core = await getCore();
  const ready = await ensureLanguage(core, lang);
  if (!ready) return null;
  return core.codeToHtml(code, { lang, theme: HIGHLIGHT_THEMES[appearance] });
}
