import { Box } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { AssetReferenceField, type AssetReferenceLabels } from './AssetReferenceField';
import {
  Checkbox,
  CollapsibleSection,
  PropertyRow,
  Select,
  Switch,
  TextInput,
} from './components';
import { inspectorColorHex, inspectorFormGroupsFromInspection } from './inspector-form-model';

export type InspectorFormFieldKind =
  | 'vector3'
  | 'vector4'
  | 'angle3'
  | 'number'
  | 'bool'
  | 'switch'
  | 'text'
  | 'enum'
  | 'color'
  | 'asset';

export type InspectorFormField = {
  key: string;
  label: string;
  kind: InspectorFormFieldKind;
  value: unknown;
  options?: readonly string[];
};

export type InspectorFormGroup = {
  key: string;
  name: string;
  category?: 'all' | 'type' | 'capability';
  fields: readonly InspectorFormField[];
  groups?: readonly InspectorFormGroup[];
};
export type InspectorAssetActionResolver = (value: unknown) => { onOpen?: () => void; onBrowse?: () => void } | undefined;

const READ_ONLY = { readOnly: true, tabIndex: -1 as const };

function ColorField({ value }: { value: unknown }) {
  const [mode, setMode] = useState<'hex' | 'rgba' | 'hsla' | 'linear'>('hex');
  const hex = inspectorColorHex(value);
  const match = /^#([0-9A-F]{6})([0-9A-F]{2})?$/i.exec(hex);
  const bytes = match ? [0, 2, 4].map(index => parseInt(match[1]!.slice(index, index + 2), 16)) : null;
  const alpha = match?.[2] ? parseInt(match[2], 16) / 255 : 1;
  const raw = Array.isArray(value) ? value : value && typeof value === 'object'
    ? ['r', 'g', 'b', 'a'].map((key, index) => (value as Record<string, unknown>)[key] ?? (value as Record<string, unknown>)[['x', 'y', 'z', 'w'][index]!]) : null;
  const numeric = raw && raw.slice(0, 3).every(channel => typeof channel === 'number' && Number.isFinite(channel));
  let display = hex || String(value);
  if (bytes && mode === 'rgba') display = `rgba(${bytes.join(', ')}, ${Number(alpha.toFixed(3))})`;
  if (bytes && mode === 'hsla') {
    const [r, g, b] = bytes.map(byte => byte / 255);
    const max = Math.max(r!, g!, b!);
    const min = Math.min(r!, g!, b!);
    const delta = max - min;
    const lightness = (max + min) / 2;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    const hue = delta === 0 ? 0 : max === r ? ((g! - b!) / delta) % 6 : max === g ? (b! - r!) / delta + 2 : (r! - g!) / delta + 4;
    display = `hsla(${Math.round((hue * 60 + 360) % 360)}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%, ${Number(alpha.toFixed(3))})`;
  }
  if (numeric && mode === 'linear') display = `rgba(${[...raw!.slice(0, 3), raw![3] ?? 1].map(channel => Number((channel as number).toFixed(3))).join(', ')})`;
  return <span className="fx-inspector-form__color" title={hex || undefined}>
    <span className="fx-inspector-form__swatch" aria-hidden style={{ backgroundColor: hex || undefined }} />
    <span className="fx-inspector-form__color-value"><span className="fx-inspector-form__color-hex" title={display}>{display}</span>
      <Select className="fx-inspector-form__color-mode" aria-label="Color display mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="hex">sRGB HEX</option><option value="rgba">RGBA</option><option value="hsla">HSLA</option>
        {numeric ? <option value="linear">Linear RGBA</option> : null}
      </Select>
    </span>
  </span>;
}

function formatDegrees(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return `${(Object.is(rounded, -0) ? 0 : rounded).toFixed(1)}°`;
}

function VectorField({
  axes,
  vector,
  degrees = false,
}: {
  axes: readonly ('x' | 'y' | 'z' | 'w')[];
  vector: Record<'x' | 'y' | 'z' | 'w', number>;
  degrees?: boolean;
}) {
  return (
    <span className={`fx-inspector-form__vec${axes.length > 3 ? ' fx-inspector-form__vec--4' : ''}${degrees ? ' fx-inspector-form__vec--angle' : ''}`}>
      {axes.map((axis) => (
        <span className={`fx-inspector-form__vcell fx-inspector-form__vcell--${axis}`} key={axis}>
          <span className="fx-inspector-form__numfield">
            <TextInput
              className="fx-inspector-form__input fx-inspector-form__input--number"
              type={degrees ? 'text' : 'number'}
              value={degrees ? formatDegrees(vector[axis]) : vector[axis]}
              aria-label={degrees ? `${axis.toUpperCase()} (°)` : axis.toUpperCase()}
              {...READ_ONLY}
            />
          </span>
        </span>
      ))}
    </span>
  );
}

export function InspectorFieldControl({ field, assetLabels, assetActions }: { field: InspectorFormField; assetLabels?: Partial<AssetReferenceLabels>; assetActions?: InspectorAssetActionResolver }) {
  if (field.kind === 'angle3' && typeof field.value === 'object' && field.value !== null) {
    const vector = field.value as Record<'x' | 'y' | 'z', number>;
    return <VectorField axes={['x', 'y', 'z']} vector={{ ...vector, w: 0 }} degrees />;
  }
  if (field.kind === 'vector3' && typeof field.value === 'object' && field.value !== null) {
    const vector = field.value as Record<'x' | 'y' | 'z', number>;
    return <VectorField axes={['x', 'y', 'z']} vector={{ ...vector, w: 0 }} />;
  }
  if (field.kind === 'vector4' && typeof field.value === 'object' && field.value !== null) {
    const vector = field.value as Record<'x' | 'y' | 'z' | 'w', number>;
    return <VectorField axes={['x', 'y', 'z', 'w']} vector={vector} />;
  }
  if (field.kind === 'bool') {
    return (
      <Checkbox
        className="fx-inspector-form__checkbox"
        checked={field.value === true}
        disabled
        hideLabel
        label={field.label}
      />
    );
  }
  if (field.kind === 'switch') {
    return <Switch checked={field.value === true} disabled hideLabel label={field.label} />;
  }
  if (field.kind === 'enum') {
    return (
      <span className="fx-inspector-form__select">
        <Select className="fx-inspector-form__input" value={String(field.value)} disabled>
          {(field.options ?? [String(field.value)]).map((option) => (
            <option value={option} key={option}>{option}</option>
          ))}
        </Select>
      </span>
    );
  }
  if (field.kind === 'color') {
    return <ColorField value={field.value} />;
  }
  if (field.kind === 'asset') {
    return <AssetReferenceField value={field.value} {...(assetLabels ? { labels: assetLabels } : {})} {...assetActions?.(field.value)} />;
  }
  return (
    <span className={field.kind === 'number' ? 'fx-inspector-form__numfield fx-inspector-form__numfield--solo' : undefined}>
      <TextInput
        className={`fx-inspector-form__input ${field.kind === 'number' ? 'fx-inspector-form__input--number' : 'fx-inspector-form__input--text'}`}
        type={field.kind === 'number' ? 'number' : 'text'}
        value={String(field.value)}
        {...READ_ONLY}
      />
    </span>
  );
}

function FormGroup({
  group,
  nested = false,
  assetActions,
}: {
  group: InspectorFormGroup;
  nested?: boolean;
  assetActions?: InspectorAssetActionResolver;
}) {
  const [open, setOpen] = useState(true);
  const category = group.category === 'all' ? 'all' : group.category === 'capability' ? 'cap' : 'type';
  return (
    <div className={`fx-inspector-form__group fx-inspector-form__group--${category}${nested ? ' is-nested' : ''}`}>
      <CollapsibleSection
        open={open}
        onOpenChange={setOpen}
        title={(
          <span className="fx-inspector-form__title">
            <span className="fx-inspector-form__icon"><Box size={13} strokeWidth={1.7} /></span>
            <span>{group.name}</span>
          </span>
        )}
      >
        <div className="fx-inspector-form__fields">
          {group.fields.map((field) => (
            <div className={`fx-inspector-form__row${field.kind === 'angle3' ? ' fx-inspector-form__row--angle' : ''}`} key={field.key} data-testid={`inspector-form-field-${group.key}-${field.key}`}>
              <PropertyRow className={`fx-inspector-form__property${field.kind === 'angle3' ? ' fx-inspector-form__property--angle' : ''}`} label={<span title={field.key}>{field.label}</span>}>
                <InspectorFieldControl field={field} {...(assetActions ? { assetActions } : {})} />
              </PropertyRow>
            </div>
          ))}
          {(group.groups ?? []).map((child) => (
            <FormGroup group={child} key={child.key} nested {...(assetActions ? { assetActions } : {})} />
          ))}
        </div>
      </CollapsibleSection>
    </div>
  );
}

export function InspectorForm({
  groups,
  inspection,
  identityTitle,
  className,
  empty,
  assetActions,
}: {
  groups?: readonly InspectorFormGroup[];
  inspection?: unknown;
  identityTitle?: string;
  className?: string;
  empty?: ReactNode;
  assetActions?: InspectorAssetActionResolver;
}) {
  const resolved = groups ?? inspectorFormGroupsFromInspection(
    inspection,
    identityTitle === undefined ? {} : { identityTitle },
  ) as InspectorFormGroup[];
  if (resolved.length === 0) return empty ?? null;
  return (
    <div className={['fx-inspector-form', className].filter(Boolean).join(' ')} data-view-readonly="true">
      {resolved.map((group) => (
        <FormGroup group={group} key={group.key} {...(assetActions ? { assetActions } : {})} />
      ))}
    </div>
  );
}
