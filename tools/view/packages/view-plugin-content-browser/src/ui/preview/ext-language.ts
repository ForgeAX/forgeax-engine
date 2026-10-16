export interface LanguageResolution {
  readonly lang: string;
  readonly label: string;
}

const EXT_LANGUAGE: Readonly<Record<string, LanguageResolution>> = {
  ts: { lang: 'typescript', label: 'TypeScript' },
  mts: { lang: 'typescript', label: 'TypeScript' },
  cts: { lang: 'typescript', label: 'TypeScript' },
  tsx: { lang: 'tsx', label: 'TSX' },
  js: { lang: 'javascript', label: 'JavaScript' },
  mjs: { lang: 'javascript', label: 'JavaScript' },
  cjs: { lang: 'javascript', label: 'JavaScript' },
  jsx: { lang: 'jsx', label: 'JSX' },
  json: { lang: 'json', label: 'JSON' },
  jsonc: { lang: 'jsonc', label: 'JSONC' },
  json5: { lang: 'json5', label: 'JSON5' },
  css: { lang: 'css', label: 'CSS' },
  scss: { lang: 'scss', label: 'SCSS' },
  html: { lang: 'html', label: 'HTML' },
  htm: { lang: 'html', label: 'HTML' },
  md: { lang: 'markdown', label: 'Markdown' },
  markdown: { lang: 'markdown', label: 'Markdown' },
  py: { lang: 'python', label: 'Python' },
  rs: { lang: 'rust', label: 'Rust' },
  wgsl: { lang: 'wgsl', label: 'WGSL' },
  glsl: { lang: 'glsl', label: 'GLSL' },
  vert: { lang: 'glsl', label: 'GLSL' },
  frag: { lang: 'glsl', label: 'GLSL' },
  sh: { lang: 'shellscript', label: 'Shell' },
  bash: { lang: 'shellscript', label: 'Shell' },
  zsh: { lang: 'shellscript', label: 'Shell' },
  yaml: { lang: 'yaml', label: 'YAML' },
  yml: { lang: 'yaml', label: 'YAML' },
  toml: { lang: 'toml', label: 'TOML' },
  xml: { lang: 'xml', label: 'XML' },
};

export function resolveLanguage(ext: string): LanguageResolution | undefined {
  const key = ext.replace(/^\./, '').toLowerCase();
  return EXT_LANGUAGE[key];
}
