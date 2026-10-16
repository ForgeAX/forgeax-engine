import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Checkbox, CheckboxGroup, Radio, RadioGroup } from './components';
import { TokenValue } from './storybook/Specimens';

const meta = {
  title: 'Controls/Choices',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Checkbox、Radio 及对应 Group 共用 `--fx-component-choice-size` 与 `--fx-color-choice-indicator`：Checkbox 为圆角方框与勾选，Radio 为 14px 圆形描边与 8px 实心圆点。支持 legend、副文案、水平/垂直排列、disabled 与 checkbox 半选（indeterminate）。',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const CheckboxSingle: Story = {
  name: 'Checkbox',
  render: () => (
    <div style={{ display: 'grid', gap: 16, width: 'min(100%, 360px)' }}>
      <Checkbox label="包含骨骼与动作" defaultChecked />
      <Checkbox label="导出时压缩纹理" description="减小包体，预览画质略降。" />
      <Checkbox label="不可用示例" disabled />
      <Checkbox label="半选状态" indeterminate defaultChecked />
    </div>
  ),
};

function CheckboxGroupDemo() {
  const [formats, setFormats] = useState(['gltf']);
  return (
    <CheckboxGroup
      legend="导出格式"
      value={formats}
      onChange={setFormats}
      layout="vertical"
      options={[
        { value: 'gltf', label: 'glTF 2.0', description: '运行时与 Web 预览。' },
        { value: 'fbx', label: 'FBX', description: 'DCC 回导。' },
        { value: 'usd', label: 'USD', disabled: true },
      ]}
    />
  );
}

export const CheckboxGroupStory: Story = {
  name: 'CheckboxGroup',
  render: () => <CheckboxGroupDemo />,
};

export const RadioSingle: Story = {
  name: 'Radio',
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <Radio name="preview-radio" value="a" label="标准质量" defaultChecked />
      <Radio name="preview-radio" value="b" label="快速草稿" description="低分辨率占位。" />
    </div>
  ),
};

function RadioGroupDemo() {
  const [quality, setQuality] = useState('standard');
  return (
    <RadioGroup
      name="quality"
      legend="生成质量"
      layout="vertical"
      value={quality}
      onChange={setQuality}
      options={[
        { value: 'standard', label: '标准质量', description: '默认平衡速度与细节。' },
        { value: 'draft', label: '快速草稿' },
        { value: 'high', label: '高精度', description: '耗时更长。', disabled: true },
      ]}
    />
  );
}

export const RadioGroupStory: Story = {
  name: 'RadioGroup',
  render: () => <RadioGroupDemo />,
};

export const Tokens: Story = {
  name: 'Choice tokens',
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      <TokenValue token="--fx-component-choice-size" />
      <TokenValue token="--fx-component-choice-dot-size" />
      <TokenValue token="--fx-color-choice-indicator" />
    </div>
  ),
};
