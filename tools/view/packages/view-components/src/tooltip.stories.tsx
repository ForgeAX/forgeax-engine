import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, IconButton, Tooltip } from './components';

const meta = {
  title: 'Overlays/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '标准深色 Tooltip（compact 标题 + caption 说明）。portaled 时与视口保持 12px 边距，避免贴边；顶栏场景用 placement=bottom。',
      },
    },
  },
  argTypes: {
    content: { control: 'text' },
    placement: { control: 'select', options: ['top', 'bottom'] },
    portaled: { control: 'boolean' },
    children: { control: false },
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj;

export const Playground: Story = {
  render: () => (
    <Tooltip content="导出当前角色资源" placement="top" portaled={false}>
      <Button>悬停或聚焦</Button>
    </Tooltip>
  ),
};

export const RichContent: Story = {
  name: '标题 + 说明',
  render: () => (
    <Tooltip
      placement="bottom"
      portaled
      title="未连接 ForgeaX Host"
      description="未连接 Host，界面使用本地占位数据，部分功能不可用。"
    >
      <IconButton
        variant="quiet"
        size="compact"
        label="Host 连接状态"
        icon={(
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 'var(--fx-radius-pill)',
              background: 'var(--fx-color-status-warning-fg)',
            }}
          />
        )}
      />
    </Tooltip>
  ),
};

export const PortaledBelowToolbar: Story = {
  name: '顶部工具栏（portaled + bottom）',
  parameters: {
    docs: {
      description: {
        story:
          '模拟 Viewer header：父级 overflow:hidden 时，portaled 将 Tooltip 挂到 body，placement=bottom 向下展开。',
      },
    },
  },
  render: () => (
    <div
      style={{
        overflow: 'hidden',
        borderBottom: 'var(--fx-border-width) solid var(--fx-color-border-subtle)',
        background: 'var(--fx-color-surface-sidebar)',
        padding: '4px 12px',
      }}
    >
      <Tooltip placement="bottom" portaled content="未连接 ForgeaX Host">
        <Button variant="quiet" size="compact">
          状态
        </Button>
      </Tooltip>
    </div>
  ),
};
