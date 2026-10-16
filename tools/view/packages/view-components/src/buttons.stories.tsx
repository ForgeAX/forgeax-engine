import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download, Plus, Settings } from 'lucide-react';
import { Button, IconButton } from './components';

const meta = {
  title: 'Controls/Button',
  component: Button,
  parameters: {
    docs: {
      description: {
        component:
          '按钮使用动词描述结果。同一操作区只突出一个 primary；quiet 用于轻量入口，danger 只用于破坏性操作。',
      },
    },
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'quiet', 'danger'],
    },
    size: {
      control: 'select',
      options: ['compact', 'default', 'large'],
    },
    leadingIcon: { control: false },
    trailingIcon: { control: false },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  args: {
    children: '查看资源',
    variant: 'secondary',
    size: 'default',
  },
};

export const Hierarchy: Story = {
  name: '操作权重',
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Button variant="primary">生成角色</Button>
      <Button>查看资源</Button>
      <Button variant="quiet">更多选项</Button>
      <Button variant="danger">删除资源</Button>
      <Button disabled title="请先选择资源">暂不可用</Button>
      <Button loading>正在生成</Button>
      <Button variant="primary" loading>正在打开</Button>
    </div>
  ),
};

export const Sizes: Story = {
  name: '尺寸与图标按钮',
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <Button size="compact">28px · 紧凑</Button>
      <Button>32px · 常规</Button>
      <Button size="large">44px · 大型</Button>
      <IconButton label="添加资源" icon={<Plus className="fx-icon" />} />
      <IconButton label="导出" icon={<Download className="fx-icon" />} variant="quiet" />
      <IconButton label="设置" icon={<Settings className="fx-icon" />} size="compact" />
    </div>
  ),
};
