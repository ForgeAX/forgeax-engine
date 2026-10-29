import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ColorPicker } from './ColorPicker';

const meta = {
  title: 'Forms/Color Picker',
  component: ColorPicker,
  args: { label: 'Body color', value: [1, 0.913, 0.832, 1], onChange: () => {} },
} satisfies Meta<typeof ColorPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

function PickerExample({ initial = [1, 0.913, 0.832, 1], locale = 'en' }: { initial?: readonly number[]; locale?: 'en' | 'zh' }) {
  const [value, setValue] = useState<readonly number[]>(initial);
  return <div style={{ padding: 24 }}><ColorPicker label={locale === 'zh' ? '主体颜色' : 'Body color'} locale={locale} value={value} onChange={setValue} /></div>;
}

export const Default: Story = {
  render: () => <PickerExample />,
  parameters: { docs: { description: { story: 'The shortcut bar can be shown or hidden. Its menu switches between recent colors and saved color themes; themes can be created, edited, and filled with the current color. Closing the dialog suppresses the trigger tooltip until focus or the pointer leaves the swatch.' } } },
};

export const Transparency: Story = {
  render: () => <PickerExample initial={[0.418, 0.413, 1, 0.35]} />,
  parameters: { docs: { description: { story: 'Alpha controls and translucent color swatches display over a checkerboard background.' } } },
};

export const Chinese: Story = {
  render: () => <PickerExample locale="zh" />,
  parameters: { docs: { description: { story: 'The picker receives its locale from the host without depending on a workspace translation service.' } } },
};
