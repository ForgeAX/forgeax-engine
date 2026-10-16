import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import {
  Checkbox,
  Field,
  RadioGroup,
  SearchField,
  Select,
  TextArea,
  TextInput,
} from './components';
import { TokenValue } from './storybook/Specimens';

const meta = {
  title: 'Controls/Forms',
  component: TextInput,
  parameters: {
    docs: {
      description: {
        component:
          '表单标签位于控件上方，帮助或错误文字紧跟控件。输入保持矩形圆角，与胶囊按钮明确区分。复选/单选见 Controls/Choices。',
      },
    },
  },
} satisfies Meta<typeof TextInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TextFields: Story = {
  name: '输入、选择与帮助文字',
  render: () => (
    <div style={{ display: 'grid', gap: 16, width: 'min(100%, 520px)' }}>
      <Field label="角色名称" htmlFor="character-name" note="名称用于资源列表和导出文件。">
        <TextInput id="character-name" defaultValue="林地狐狸" />
      </Field>
      <Field label="造型风格" htmlFor="character-style">
        <Select id="character-style" defaultValue="low-poly">
          <option value="low-poly">低多边形</option>
          <option value="cartoon">卡通风格</option>
          <option value="realistic">写实风格</option>
        </Select>
      </Field>
      <Field label="角色描述" htmlFor="character-description" note="达到高度上限后在输入框内部滚动。">
        <TextArea id="character-description" placeholder="描述外形、风格与游戏用途…" />
      </Field>
      <Field label="错误示例" htmlFor="invalid-name" error="名称不能包含路径分隔符。">
        <TextInput id="invalid-name" defaultValue="fox/model" aria-invalid />
      </Field>
      <TokenValue token="--fx-component-field-height-default" />
    </div>
  ),
};

function ChoiceExample() {
  const [quality, setQuality] = useState('standard');
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Checkbox label="包含骨骼与动作" defaultChecked />
      <RadioGroup
        name="quality-inline"
        value={quality}
        onChange={setQuality}
        aria-label="生成质量"
        options={[
          { value: 'standard', label: '标准质量' },
          { value: 'draft', label: '快速草稿' },
        ]}
      />
    </div>
  );
}

export const Choices: Story = {
  name: '内联复选与单选',
  parameters: {
    docs: {
      description: {
        story: '完整 API 与分组示例见 Controls/Choices。',
      },
    },
  },
  render: () => <ChoiceExample />,
};

function SearchExample() {
  const [query, setQuery] = useState('狐狸');
  return (
    <SearchField
      style={{ width: 320 }}
      value={query}
      placeholder="搜索角色"
      onChange={(event) => setQuery(event.target.value)}
      onClear={() => setQuery('')}
    />
  );
}

export const SearchInput: Story = {
  name: '搜索输入',
  render: () => <SearchExample />,
};
