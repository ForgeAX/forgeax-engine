export interface RuntimeFormFields extends ReadonlyArray<RuntimeFormField> {
  readFields?: () => RuntimeFormField[];
}
export interface RuntimeFormField {
  name: string;
  value: unknown;
  set: (value: unknown) => void;
  choices?: readonly string[];
  choiceLabels?: Readonly<Record<string, string>>;
  read?: () => unknown;
  readonly?: boolean;
  label?: string;
  help?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  slider?: boolean;
  inputType?: 'color';
  defaultValue?: unknown;
}
/** Pending edits still observe their owner when a surrounding dimension is collapsed. */
export function runtimeFormVisible(section: HTMLElement) {
  for (let node: HTMLElement | null = section; node; node = node.parentElement)
    if (node.hidden || (node instanceof HTMLDetailsElement && !node.open)) return false;
  return true;
}
const arrayValue = (value: unknown) =>
  value === null ||
  Array.isArray(value) ||
  (ArrayBuffer.isView(value) && !(value instanceof DataView));
const retiredRuntimeObject = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'stale-entity';
const runtimeErrorText = (reason: unknown) => {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === 'object') {
    const error = reason as {
      code?: unknown;
      expected?: unknown;
      hint?: unknown;
      message?: unknown;
    };
    if (typeof error.message === 'string') return error.message;
    if (typeof error.code === 'string')
      return [error.code, error.expected, error.hint]
        .filter((v) => typeof v === 'string')
        .join(' · ');
  }
  return String(reason);
};
const displayValue = (value: unknown) =>
  value === null
    ? 'null'
    : arrayValue(value)
      ? JSON.stringify(Array.from(value as ArrayLike<unknown>))
      : value && typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

const controlShape = (field: RuntimeFormField) => [
  field.name,
  field.choices,
  field.choiceLabels,
  Boolean(field.readonly),
  field.label,
  field.help,
  field.min,
  field.max,
  field.step,
  field.slider,
  field.inputType,
  field.value === null
    ? 'null'
    : ArrayBuffer.isView(field.value)
      ? 'typed-array'
      : Array.isArray(field.value)
        ? 'array'
        : typeof field.value,
];
let refreshObservations: Map<RuntimeFormFields, RuntimeFormField[]> | undefined;

/** The cache lives only within this refresh, never across owner publications. */
export function readRuntimeFormFields(fields: RuntimeFormFields) {
  const known = refreshObservations?.get(fields);
  if (known) return known;
  const observation =
    fields.readFields?.() ??
    fields.map((field) => ({ ...field, value: field.read ? field.read() : field.value }));
  refreshObservations?.set(fields, observation);
  return observation;
}

export function refreshRuntimeForms(forms: readonly { refresh(): void }[]) {
  const previous = refreshObservations;
  refreshObservations = new Map();
  try {
    for (const form of forms) form.refresh();
  } finally {
    refreshObservations = previous;
  }
}

const fieldLabels: Readonly<Record<string, string>> = {
  count: '波数量',
  waveCount: '波数量',
  pontoonCount: '浮力探针数量（4–32，偶数）',
  contactProbeCount: '船体接触探针数量',
  tessellationFactor: '网格细分等级',
  waterInfoResolution: 'WaterInfo 分辨率（px）',
  localResolution: 'FFT 分辨率（px）',
  thrustAccelerationMps2: '前进加速度（m/s²）',
  reverseRatio: '倒车推力比例',
  boostMultiplier: 'Space 加速倍率',
  throttleResponseSeconds: '油门响应时间（s）',
  rudderResponseSeconds: '舵响应时间（s）',
  turnAccelerationRadps2: '转向角加速度（rad/s²）',
  rudderReferenceSpeedMps: '满舵效参考速度（m/s）',
  lateralResistancePerSecond: '横向阻力（1/s）',
  anchorsM: '浮力探针位置（m / JSON）',
  radiiM: '探针半径（m / JSON）',
  centersM: '接触探针位置（m / JSON）',
  enabled: '启用',
  useAsyncPath: '异步求解',
  applyDrag: '启用水阻力',
  enabledMask: '启用探针（JSON）',
  buoyancyCoefficientNPerM3: '浮力系数（N/m³）',
  maxBuoyantForceN: '浮力上限（N）',
  dampingNPerMps: '线性浮力阻尼（N·s/m）',
  fftResolution: 'FFT 分辨率（px）',
  domainLengthM: '模拟域宽度（m）',
  centerXZ: '模拟域中心（m / JSON）',
  entryWaveMultiplier: '落水波增益',
  surfaceTransportMultiplier: '航行输运波增益',
  waveDampingPerSecond: '波衰减（1/s）',
  slopeThreshold: '泡沫坡度阈值',
  emissionPerSecond: '泡沫发射（1/s）',
  decayPerSecond: '泡沫衰减（1/s）',
  baseHeightM: '基准水位（m）',
  maxWaveHeightM: '波高保守边界（m）',
  overlapPriority: '水体重叠优先级',
  widthPx: '宽度（px）',
  heightPx: '高度（px）',
  blurRadius: '模糊半径（px）',
  localTessellation: '局部细分',
  fov: '视场角（rad）',
  near: '近裁剪（m）',
  far: '远裁剪（m）',
  exposure: '曝光',
  roughness: '粗糙度',
  metallic: '金属度',
  wavelengthMinM: '最短波长（m）',
  wavelengthMaxM: '最长波长（m）',
  amplitudeMinM: '最小振幅（m）',
  amplitudeMaxM: '最大振幅（m）',
  windAngleDegrees: '风向（°）',
  directionAngularSpreadDegrees: '方向散布（°）',
  randomness: '波谱随机度（0–1）',
  horizontalSpeedMps: '炮弹水平初速（m/s）',
  upwardSpeedMps: '炮弹上抛初速（m/s）',
  radiusM: '炮弹半径（m）',
  massKg: '质量（kg）',
  muzzleOffsetM: '炮口位置（m / JSON）',
  linearDamping: '原生线性阻尼（1/s）',
  angularDamping: '原生角阻尼（1/s）',
  maximumIntervalSeconds: '最大完整原生源间隔（s）',
  timeScale: '时间倍率',
  seed: '随机种子',
  baked: '作者查询网格夹具（非 GPU Bake）',
};

type RuntimeFormControl = {
  field: RuntimeFormField;
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  editing: boolean;
  pending: string | undefined;
  status: HTMLElement;
  range: HTMLInputElement | undefined;
  retired: boolean;
};

function createRuntimeFieldInput(field: RuntimeFormField, readExpanded: () => boolean) {
  const input = field.choices
    ? document.createElement('select')
    : arrayValue(field.value) || (field.value && typeof field.value === 'object')
      ? document.createElement('textarea')
      : document.createElement('input');
  if (input instanceof HTMLSelectElement) {
    for (const value of field.choices ?? []) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = field.choiceLabels?.[value] ?? value;
      input.append(option);
    }
    input.value = String(field.value);
  }
  if (input instanceof HTMLInputElement) {
    input.type =
      field.inputType ??
      (typeof field.value === 'boolean'
        ? 'checkbox'
        : typeof field.value === 'number'
          ? 'number'
          : 'text');
    // Numeric values remain source-honest, including transformed defaults and
    // fractional native readbacks. Sliders alone use the suggested increment.
    input.step = 'any';
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (input.type === 'checkbox') input.checked = Boolean(field.value);
    else input.value = String(field.value);
  } else if (input instanceof HTMLTextAreaElement) {
    input.value = field.readonly && !readExpanded() ? '展开查看已接纳事实' : displayValue(field.value);
    input.rows = 2;
  }
  return input;
}

function readRuntimeFieldInput(input: RuntimeFormControl['input'], field: RuntimeFormField) {
  const value =
    input instanceof HTMLTextAreaElement
      ? JSON.parse(input.value)
      : input instanceof HTMLSelectElement
        ? typeof field.value === 'number'
          ? Number(input.value)
          : input.value
        : input.type === 'checkbox'
          ? input.checked
          : input.type === 'number'
            ? Number(input.value)
            : input.value;
  return value;
}

/** The owner supplies accepted values; the form adds no runtime state authority. */
export function runtimeForm(parent: HTMLElement, title: string, fields: RuntimeFormFields) {
  const section = document.createElement('details');
  const heading = document.createElement('summary');
  heading.textContent = title;
  section.append(heading);
  let globallyDisabled = false;
  const controls: RuntimeFormControl[] = [];
  const renderFields = (current: readonly RuntimeFormField[]) => {
    for (const field of current) {
      if (field.value === undefined) continue;
      const label = document.createElement(field.label ? 'div' : 'label');
      const key = field.name.split('.').at(-1) ?? field.name;
      const caption = document.createElement('label');
      if (field.label) {
        caption.textContent = field.label;
        label.append(caption);
      } else label.textContent = fieldLabels[key] ?? field.name;
      if (field.label) label.className = 'coast-field';
      label.title = field.name;
      const input = createRuntimeFieldInput(field, () => section.open);
      input.dataset.parameter = field.name;
      if (field.label) {
        input.id = `water-control-${crypto.randomUUID()}`;
        caption.htmlFor = input.id;
      }
      input.disabled = globallyDisabled || Boolean(field.readonly);
      const errorText = document.createElement('small');
      errorText.setAttribute('role', 'status');
      const control = {
        field,
        input,
        editing: false,
        pending: undefined as string | undefined,
        status: errorText,
        range: undefined as HTMLInputElement | undefined,
        retired: false,
      };
      const beginEdit = () => {
        control.editing = true;
        input.setCustomValidity('');
        errorText.textContent = '';
      };
      const range =
        field.slider && typeof field.value === 'number'
          ? document.createElement('input')
          : undefined;
      control.range = range;
      if (range) {
        range.type = 'range';
        range.min = String(field.min ?? 0);
        range.max = String(field.max ?? 1);
        range.step = String(field.step ?? (Number(range.max) - Number(range.min)) / 100);
        range.value = String(field.value);
        range.disabled = input.disabled;
        range.setAttribute('aria-label', field.label ?? field.name);
        range.addEventListener('input', () => {
          input.value = range.value;
          beginEdit();
          errorText.textContent = '松手后应用';
        });
        range.addEventListener('change', () => input.dispatchEvent(new Event('change')));
      }
      input.addEventListener('input', beginEdit);
      input.addEventListener('change', () => {
        control.editing = false;
        const field = control.field;
        if (control.retired || field.readonly || globallyDisabled) return;
        try {
          input.setCustomValidity('');
          const previous = field.read ? displayValue(field.read()) : undefined;
          const value = readRuntimeFieldInput(input, field);
          if (typeof value === 'number' && !Number.isFinite(value))
            throw new Error('Expected a finite number');
          if (input instanceof HTMLInputElement && !input.checkValidity())
            throw new Error(input.validationMessage);
          control.pending = undefined;
          // A setter may synchronously refresh its sibling forms. Preserve this edit
          // until the requested value has been compared with the accepted owner value.
          control.editing = true;
          try {
            field.set(value);
          } finally {
            control.editing = false;
          }
          input.setCustomValidity('');
          errorText.textContent = '';
          const reconcileAcceptedEdit = () => {
            if (field.read) {
              const accepted = field.read();
              if (
                displayValue(accepted) === previous &&
                displayValue(accepted) !== displayValue(value)
              ) {
                control.pending = previous;
                errorText.textContent = '等待运行时接纳';
                if (input instanceof HTMLInputElement && input.type === 'checkbox')
                  input.checked = Boolean(value);
                else input.value = displayValue(value);
              } else if (input instanceof HTMLInputElement && input.type === 'checkbox')
                input.checked = Boolean(accepted);
              else input.value = displayValue(accepted);
            }
          };
          reconcileAcceptedEdit();
          if (range) range.value = input.value;
        } catch (error) {
          control.pending = undefined;
          input.setCustomValidity(runtimeErrorText(error));
          errorText.textContent = runtimeErrorText(error);
          input.reportValidity();
          if (field.read) {
            try {
              control.field.read?.();
            } catch {
              control.retired = true;
              input.disabled = true;
              if (range) range.disabled = true;
            }
          }
          if (range) range.value = input.value;
        }
      });
      const decorateField = () => {
        if (field.label) {
          const valueRow = document.createElement('div');
          valueRow.className = 'coast-field-value';
          valueRow.append(input);
          if (field.unit) {
            const unit = document.createElement('span');
            unit.textContent = field.unit;
            valueRow.append(unit);
          }
          if (field.defaultValue !== undefined && !field.readonly) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'coast-field-reset';
            reset.textContent = '↺';
            reset.title = `恢复初始值 ${String(field.defaultValue)}${field.unit ?? ''}`;
            reset.setAttribute('aria-label', `重置${field.label}`);
            reset.addEventListener('click', () => {
              if (input.disabled) return;
              if (input instanceof HTMLInputElement && input.type === 'checkbox')
                input.checked = Boolean(field.defaultValue);
              else input.value = displayValue(field.defaultValue);
              input.dispatchEvent(new Event('change'));
            });
            valueRow.append(reset);
          }
          label.append(valueRow);
          if (range) label.append(range);
          if (field.help) {
            const help = document.createElement('span');
            help.className = 'coast-field-help';
            help.textContent = field.help;
            label.append(help);
          }
          label.append(errorText);
        } else label.append(input, errorText);
      };
      decorateField();
      section.append(label);
      controls.push(control);
    }
  };
  renderFields(fields);
  let fieldShape = JSON.stringify(fields.map(controlShape));
  parent.append(section);
  const form = {
    section,
    fields,
    title,
    get pending() {
      return controls.some((control) => control.pending !== undefined);
    },
    get rejection() {
      return (
        controls.find((control) => control.input.validity.customError)?.status.textContent ?? ''
      );
    },
    remove() {
      section.remove();
    },
    rejectPending(reason: unknown) {
      const message = runtimeErrorText(reason);
      for (const control of controls) {
        if (control.pending === undefined) continue;
        control.pending = undefined;
        control.status.textContent = message;
        control.input.setCustomValidity(message);
        try {
          const accepted = control.field.read?.();
          if (control.input instanceof HTMLInputElement && control.input.type === 'checkbox')
            control.input.checked = Boolean(accepted);
          else control.input.value = displayValue(accepted);
        } catch {
          control.retired = true;
          control.input.disabled = true;
          if (control.range) control.range.disabled = true;
        }
        if (control.range) control.range.value = control.input.value;
      }
    },
    refresh(read?: (name: string) => unknown) {
      if (
        !runtimeFormVisible(section) &&
        !controls.some((control) => control.pending !== undefined)
      )
        return;
      let observation: Map<string, unknown> | undefined;
      const reconcileFieldShape = () => {
        if (fields.readFields) {
          let current: RuntimeFormField[];
          try {
            current = readRuntimeFormFields(fields);
          } catch (error) {
            if (!retiredRuntimeObject(error)) throw error;
            form.remove();
            controls.length = 0;
            return;
          }
          observation = new Map(current.map((field) => [field.name, field.value]));
          const shape = JSON.stringify(current.map(controlShape));
          if (shape !== fieldShape && !section.contains(document.activeElement)) {
            section.replaceChildren(heading);
            controls.length = 0;
            renderFields(current);
            fieldShape = shape;
          }
          for (const control of controls) {
            const acceptedField = current.find((field) => field.name === control.field.name);
            if (acceptedField) {
              control.field = acceptedField;
              control.retired = false;
              control.input.disabled = globallyDisabled || Boolean(acceptedField.readonly);
              if (control.range) control.range.disabled = control.input.disabled;
            } else {
              control.retired = true;
              control.input.disabled = true;
              if (control.range) control.range.disabled = true;
              control.status.textContent = '运行时参数分支已替换';
            }
          }
        }
        return true;
      };
      if (reconcileFieldShape() === undefined) return;
      const refreshAcceptedControl = (control: RuntimeFormControl) => {
        const { field, input } = control;
        if (control.editing || input.validity.customError) return;
        if (observation && !observation.has(field.name)) return;
        if (field.readonly && !section.open) return;
        let value: unknown;
        try {
          value = observation
            ? observation.get(field.name)
            : field.read
              ? field.read()
              : read
                ? read(field.name)
                : field.value;
        } catch (error) {
          if (!retiredRuntimeObject(error)) throw error;
          input.disabled = true;
          control.retired = true;
          if (control.range) control.range.disabled = true;
          control.status.textContent = '运行时对象已卸载';
          return;
        }
        if (control.pending !== undefined) {
          if (displayValue(value) === control.pending) return;
          control.pending = undefined;
          control.status.textContent = '已接纳';
        }
        if (input instanceof HTMLInputElement && input.type === 'checkbox')
          input.checked = Boolean(value);
        else input.value = displayValue(value);
        const range = control.range;
        if (range) {
          range.value = String(value);
          range.disabled = input.disabled;
        }
      };
      for (const control of controls) refreshAcceptedControl(control);
    },
    setDisabled(disabled: boolean) {
      globallyDisabled = disabled;
      for (const control of controls) {
        control.input.disabled = disabled || Boolean(control.field.readonly) || control.retired;
        if (control.range) control.range.disabled = control.input.disabled;
      }
    },
  };
  const onSectionToggle = () => {
    if (section.open) form.refresh();
  };
  section.addEventListener('toggle', onSectionToggle);
  const onAncestorToggle = (event: Event) => {
    if (event.target instanceof HTMLDetailsElement && event.target.contains(section))
      form.refresh();
  };
  document.addEventListener('toggle', onAncestorToggle, true);
  const remove = form.remove;
  form.remove = () => {
    section.removeEventListener('toggle', onSectionToggle);
    document.removeEventListener('toggle', onAncestorToggle, true);
    remove();
  };
  return form;
}

export function runtimeObjectFields(
  read: () => Record<string, unknown>,
  write: (value: Record<string, unknown>) => void,
  choices: Readonly<Record<string, readonly string[]>> = {},
  readonlyPaths: readonly string[] = [],
): RuntimeFormFields {
  const fields: RuntimeFormField[] = [];
  const source = read();
  const valueAt = (path: readonly string[]) =>
    path.reduce<unknown>(
      (value, key) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
      read(),
    );
  const visit = (value: Record<string, unknown>, path: readonly string[]) => {
    for (const [key, child] of Object.entries(value)) {
      const next = [...path, key],
        name = next.join('.');
      const readonly =
        readonlyPaths.includes(name) ||
        /^(id|configurationVersion|schemaVersion|body|effect|entity|resetRevision|fingerprint|module|wgsl|reflection)$/.test(
          key,
        ) ||
        (key === 'kind' && !choices[name]) ||
        /(?:Guids?|Identity|Version|Entities|Fingerprint)$/.test(key) ||
        (name === 'parameters' && source.kind === 'material') ||
        /^(passes|cooked|geometry|visibleMesh|waterInfoMesh|spline|staticSwitches)/.test(name);
      if (readonly) {
        fields.push({
          name,
          value: child,
          readonly: true,
          read: () => valueAt(next),
          set: () => {},
        });
        continue;
      }
      if (child && typeof child === 'object' && !arrayValue(child)) {
        visit(child as Record<string, unknown>, next);
        continue;
      }
      const options = choices[name] ?? (key === 'anchorMode' ? ['0', '1'] : undefined);
      if (child === undefined) continue;
      fields.push({
        name,
        value: child,
        ...(options ? { choices: options } : {}),
        read: () => valueAt(next),
        set: (replacement) => {
          if (valueAt(next) === undefined)
            throw new Error('This parameter branch was replaced; refresh before editing');
          const draft = structuredClone(read());
          const owner = next
            .slice(0, -1)
            .reduce((item, part) => item[part] as Record<string, unknown>, draft);
          owner[key] = replacement;
          write(draft);
        },
      });
    }
  };
  visit(source, []);
  return Object.assign(fields, {
    readFields: () => [...runtimeObjectFields(read, write, choices, readonlyPaths)],
  });
}
