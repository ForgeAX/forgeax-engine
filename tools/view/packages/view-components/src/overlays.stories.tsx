import type { Meta, StoryObj } from '@storybook/react-vite';
import { Copy, MessageSquareText, Moon, Sun, Trash2 } from 'lucide-react';
import { Menu, type MenuItem } from './components';

const meta = {
  title: 'Overlays/Menu',
  component: Menu,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '菜单面板：标题、分隔、危险项与快捷键。选中项使用 aria-selected 与勾选图标。通过 MenuDropdown、FloatingMenu 或 ContextMenu 呈现。',
      },
    },
  },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj;

const menuItems: MenuItem[] = [
  { type: 'title', label: '资源操作' },
  { id: 'copy', label: '复制路径', icon: <Copy className="fx-icon" />, shortcut: 'Ctrl+C' },
  {
    id: 'reference',
    label: '在对话中引用',
    icon: <MessageSquareText className="fx-icon" />,
  },
  { type: 'separator' },
  { id: 'delete', label: '删除资源', icon: <Trash2 className="fx-icon" />, danger: true },
];

export const MenuVariants: Story = {
  name: '菜单项样式',
  render: () => <Menu items={menuItems} />,
};

export const SelectedItem: Story = {
  name: '选中高亮',
  render: () => (
    <Menu
      items={[
        {
          id: 'light',
          label: '浅色',
          icon: <Sun className="fx-icon" />,
          selected: true,
          onSelect: () => undefined,
        },
        {
          id: 'dark',
          label: '深色',
          icon: <Moon className="fx-icon" />,
          onSelect: () => undefined,
        },
      ]}
    />
  ),
};
