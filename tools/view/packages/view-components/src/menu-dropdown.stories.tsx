import type { Meta, StoryObj } from '@storybook/react-vite';
import { Eye, Grid2x2, Languages, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button, IconButton, MenuDropdown } from './components';

function MenuDropdownStoryFrame({ children }: { children: ReactNode }) {
  return <div className="fx-menu-dropdown-story-frame">{children}</div>;
}

const meta = {
  title: 'Overlays/MenuDropdown',
  component: MenuDropdown,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '锚定在触发器上的下拉菜单，复用 Menu 面板与选中高亮（勾选 + aria-selected）。用于主题、语言等可扩展的单选列表；点击外部或 Esc 关闭，选中后自动收起。',
      },
    },
  },
  argTypes: {
    label: { control: 'text' },
    align: { control: 'select', options: ['start', 'end'] },
    items: { control: false },
    trigger: { control: false },
  },
} satisfies Meta<typeof MenuDropdown>;

export default meta;
type Story = StoryObj;

export const ThemePicker: Story = {
  name: '主题切换（选中态）',
  render: () => {
    const [theme, setTheme] = useState<'light' | 'dark'>('light');
    return (
      <MenuDropdownStoryFrame>
      <MenuDropdown
        label="界面主题"
        align="end"
        items={[
          {
            id: 'light',
            label: '浅色',
            icon: <Sun className="fx-icon" />,
            selected: theme === 'light',
            onSelect: () => setTheme('light'),
          },
          {
            id: 'dark',
            label: '深色',
            icon: <Moon className="fx-icon" />,
            selected: theme === 'dark',
            onSelect: () => setTheme('dark'),
          },
        ]}
        trigger={(
          <IconButton
            variant="quiet"
            size="compact"
            label="界面主题"
            icon={theme === 'light' ? <Sun className="fx-icon" /> : <Moon className="fx-icon" />}
          />
        )}
      />
      </MenuDropdownStoryFrame>
    );
  },
};

export const LocalePicker: Story = {
  name: '语言切换（紧凑触发器）',
  render: () => {
    const [locale, setLocale] = useState<'en' | 'zh'>('zh');
    return (
      <MenuDropdownStoryFrame>
      <MenuDropdown
        label="界面语言"
        align="end"
        items={[
          {
            id: 'zh',
            label: '简体中文',
            icon: <Languages className="fx-icon" />,
            selected: locale === 'zh',
            onSelect: () => setLocale('zh'),
          },
          {
            id: 'en',
            label: 'English',
            icon: <Languages className="fx-icon" />,
            selected: locale === 'en',
            onSelect: () => setLocale('en'),
          },
        ]}
        trigger={(
          <IconButton
            variant="quiet"
            size="compact"
            label="界面语言"
            icon={(
              <span
                style={{
                  minWidth: 16,
                  fontSize: 'var(--fx-type-caption-font-size)',
                  letterSpacing: '0.04em',
                }}
              >
                {locale === 'zh' ? '中' : 'EN'}
              </span>
            )}
          />
        )}
      />
      </MenuDropdownStoryFrame>
    );
  },
};

export const AlignStart: Story = {
  name: '左对齐展开',
  render: () => (
    <div style={{ padding: 'var(--fx-ref-space-16)' }}>
    <MenuDropdown
      label="视图选项"
      align="start"
      items={[
        {
          id: 'a',
          label: '透视',
          icon: <Eye className="fx-icon" />,
          selected: true,
          onSelect: () => undefined,
        },
        {
          id: 'b',
          label: '正交',
          icon: <Grid2x2 className="fx-icon" />,
          onSelect: () => undefined,
        },
      ]}
      trigger={(
        <Button variant="quiet" size="compact" leadingIcon={<Languages className="fx-icon" />}>
          视图
        </Button>
      )}
    />
    </div>
  ),
};
