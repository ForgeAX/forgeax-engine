import { Moon, Sun } from 'lucide-react';
import { IconButton, MenuDropdown, themeNames, type ThemeName } from '@forgeax/view-components';

export type StorybookPrefsBarProps = {
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
};

export function StorybookPrefsBar({ theme, onThemeChange }: StorybookPrefsBarProps) {
  return (
    <div className="fx-storybook-prefs">
      <MenuDropdown
        label="界面主题"
        align="end"
        items={themeNames.map((name) => ({
          id: name,
          label: name === 'light' ? '浅色' : '深色',
          icon: name === 'light' ? <Sun className="fx-icon" /> : <Moon className="fx-icon" />,
          selected: theme === name,
          onSelect: () => onThemeChange(name),
        }))}
        trigger={(
          <IconButton
            variant="quiet"
            size="compact"
            label="界面主题"
            icon={theme === 'light' ? <Sun className="fx-icon" /> : <Moon className="fx-icon" />}
          />
        )}
      />
    </div>
  );
}
