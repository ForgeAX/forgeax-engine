export interface WaterSettingsDimension {
  readonly title: string;
  readonly description?: string;
  readonly elements: readonly HTMLElement[];
  readonly open?: boolean;
}

/** Regroup existing source controls without replacing their bindings or accepted values. */
export function arrangeWaterSettings(input: {
  readonly panel: HTMLElement;
  readonly title: string;
  readonly description: string;
  readonly dimensions: readonly WaterSettingsDimension[];
  readonly hero?: HTMLElement | undefined;
}) {
  const { panel } = input;
  const previousChildren = [...panel.children];
  document.body.classList.add('water-experience');
  panel.classList.add('water-settings');
  const hero = input.hero ?? document.createElement('div');
  hero.classList.add('water-hero');
  const title = hero.querySelector('h1') ?? document.createElement('h1');
  title.textContent = input.title;
  const description = document.createElement('p');
  description.textContent = input.description;
  if (!title.parentElement) hero.append(title);
  hero.append(description);
  panel.prepend(hero);
  for (const dimension of input.dimensions) {
    const details = document.createElement('details');
    details.className = 'water-dimension';
    details.open = dimension.open ?? false;
    const summary = document.createElement('summary');
    summary.textContent = dimension.title;
    const body = document.createElement('div');
    body.className = 'dimension-body';
    if (dimension.description) {
      const help = document.createElement('p');
      help.className = 'dimension-help';
      help.textContent = dimension.description;
      body.append(help);
    }
    body.append(...dimension.elements);
    details.append(summary, body);
    panel.append(details);
  }
  for (const child of previousChildren)
    if (child !== hero && child.parentElement === panel) panel.append(child);
  const hint = document.createElement('div');
  hint.className = 'water-camera-hint';
  hint.textContent =
    '点击画面 · WASD / 方向键漫游 · 拖动环视 · E/Q 升降 · Shift 加速 · 滚轮调速 · Esc 退出';
  document.body.append(hint);
}

export function waterQualityControl(apply: (level: 0 | 1 | 2 | 3) => void, initial: 0 | 1 | 2 | 3) {
  const label = document.createElement('label');
  label.className = 'row';
  label.append('画质预设');
  const select = document.createElement('select');
  select.dataset.waterQuality = '';
  for (const [level, name] of ['流畅', '均衡', '精细', '极致'].entries())
    select.add(new Option(name, String(level)));
  select.value = String(initial);
  select.addEventListener('change', () => apply(Number(select.value) as 0 | 1 | 2 | 3));
  label.append(select);
  return label;
}
