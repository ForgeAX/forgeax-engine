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
          'Menu items support titles, separators, destructive actions and shortcuts. Selection actions use aria-selected; radio and checkbox choices use their native menu roles with aria-checked. Present through MenuDropdown, FloatingMenu or ContextMenu.',
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

export const CheckedItems: Story = {
  render: () => <Menu items={[
    { id: 'material', label: 'Material', selection: 'radio', checked: true },
    { id: 'wireframe', label: 'Wireframe', selection: 'radio', checked: false },
    { type: 'separator' },
    { id: 'bounds', label: 'Bounds', selection: 'checkbox', checked: true },
    { id: 'collision', label: 'Collision', selection: 'checkbox', checked: false, disabled: true },
  ]} />,
};
