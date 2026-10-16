import type { StorybookConfig } from '@storybook/react-vite';

/** Vite 8 on Windows keys importers as `./F:/abs/src/foo.stories.tsx`; the index uses `./src/foo.stories.tsx`. */
const WINDOWS_ABS_STORY_KEY =
  /"\.\/[A-Za-z]:\/[^"]+?\/(src\/[^"]+\.stories\.(?:tsx|ts|jsx|js))"/g;

const config: StorybookConfig = {
  stories: [
    {
      directory: '../src',
      files: '**/*.stories.@(ts|tsx)',
    },
  ],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  docs: {
    autodocs: 'tag',
  },
  async viteFinal(viteConfig) {
    viteConfig.plugins = [
      ...(viteConfig.plugins ?? []),
      {
        name: 'forgeax-fix-storybook-windows-importers',
        enforce: 'post',
        transform(code: string, id: string) {
          if (!id.replace(/\\/g, '/').includes('storybook-stories')) return null;
          const next = code.replace(WINDOWS_ABS_STORY_KEY, '"./$1"');
          return next === code ? null : next;
        },
      },
    ];
    return viteConfig;
  },
};

export default config;
