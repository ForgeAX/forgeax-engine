import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { RangeInput, Switch } from './components';
import { SpecSection, TokenValue } from './storybook/Specimens';

const meta = {
  title: 'Controls/Switch',
  component: Switch,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '开关用于即时生效的二值设置。轨道与滑块使用 `--fx-color-surface-selected` 与 `--fx-color-selection-indicator`，不使用品牌色。',
      },
    },
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

function SwitchRowDemo() {
  const [detailPanel, setDetailPanel] = useState(true);
  return (
    <Switch
      layout="row"
      label="详情面板"
      checked={detailPanel}
      onCheckedChange={setDetailPanel}
      style={{ width: 280 }}
    />
  );
}

export const Inline: Story = {
  name: '内联开关',
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
      <Switch aria-label="自动保存" defaultChecked />
      <Switch aria-label="显示网格" />
      <Switch aria-label="不可用" disabled defaultChecked />
    </div>
  ),
};

export const SettingsRow: Story = {
  name: '设置行布局',
  parameters: {
    docs: {
      description: {
        story: '`layout="row"` 用于菜单或浮层内的标签 + 开关行，悬停时使用表面 hover。',
      },
    },
  },
  render: () => <SwitchRowDemo />,
};

function RangeDemo() {
  const [size, setSize] = useState(88);
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: 280 }}>
      <span>缩略图大小</span>
      <RangeInput
        min={48}
        max={200}
        step={4}
        value={size}
        onChange={(event) => setSize(Number(event.target.value))}
      />
    </label>
  );
}

export const Range: Story = {
  name: '范围滑块',
  render: () => (
    <SpecSection title="Range" description="原生 range 通过 `accent-color: selection-indicator` 保持中性强调。">
      <RangeDemo />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <TokenValue token="--fx-component-range-width" />
        <TokenValue token="--fx-color-selection-indicator" />
      </div>
    </SpecSection>
  ),
};
