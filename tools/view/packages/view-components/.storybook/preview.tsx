import type { Decorator, Preview } from '@storybook/react-vite';
import { useGlobals } from 'storybook/preview-api';
import type { ThemeName } from '@forgeax/view-components';
import { ThemeProvider } from '@forgeax/view-components/theme';
import '@forgeax/view-components/styles.css';
import { StorybookPrefsBar } from './StorybookPrefsBar';

const withForgeaxTheme: Decorator = (Story) => {
  const [globals, updateGlobals] = useGlobals();
  const theme: ThemeName = globals.theme === 'dark' ? 'dark' : 'light';

  return (
    <ThemeProvider
      theme={theme}
      applyToDocument
      style={{
        minHeight: '100vh',
        padding: 24,
        background: 'var(--fx-color-surface-canvas)',
      }}
    >
      <StorybookPrefsBar
        theme={theme}
        onThemeChange={(name) => updateGlobals({ theme: name })}
      />
      <Story />
    </ThemeProvider>
  );
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'ForgeaX interface theme',
      defaultValue: 'light',
    },
  },
  decorators: [withForgeaxTheme],
  parameters: {
    backgrounds: { disable: true },
    controls: { expanded: true },
    layout: 'fullscreen',
    options: {
      storySort: {
        order: [
          'Foundations',
          ['Overview', 'Colors', 'Typography', 'Spacing', 'Shape'],
          'Themes',
          'Controls',
          ['Button', 'Icon', 'Forms', 'Choices', 'Switch'],
          'Workspace Patterns',
          'Feedback',
          ['States', 'Error Notice', 'Preview Stats'],
          'Overlays',
          ['Menu', 'MenuDropdown', 'FloatingMenu', 'Tooltip', 'Dialog and Context'],
          'Workflows',
          'Accessibility',
        ],
      },
    },
  },
  tags: ['autodocs'],
};

export default preview;
