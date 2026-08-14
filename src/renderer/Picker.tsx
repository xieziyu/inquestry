import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type PickerItem = {
  value: string;
  label: string;
  /** 跟在标签右边的次要信息：上一级路径、模型 id、backend 的备注。 */
  note?: string;
  disabled?: boolean;
  title?: string;
};

/** 末尾那条兜底动作（隔一条线），比如「打开其他目录…」。 */
export type PickerAction = {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
};

/** 动作那一行在 `rows` 里的 value，不会与真值撞上。 */
const ACTION = ' action';

/**
 * 单选下拉。原生 `<select>` 在深色面板上由系统画，字体、圆角、内边距一概不跟这套色板走，
 * 一屏里混着两种控件很明显；下拉面板本身也放不下「标签 + 次要信息」两列。
 *
 * ⚠️ 自己画就得自己补键盘：原生 `<select>` 白送的上下键、Enter、Home/End 都在这儿，
 * 少了它们对纯键盘的人就是这一格根本用不了。
 */
export function Picker({
  value,
  items,
  onPick,
  placeholder,
  icon,
  action,
  need,
  bad,
  label,
  noteTruncate = 'tail',
}: {
  value: string;
  items: PickerItem[];
  onPick: (value: string) => void;
  /** `value` 不在 `items` 里时按钮上写什么。 */
  placeholder?: string;
  /** 按钮左边的图标。 */
  icon?: React.ReactNode;
  /**
   * 菜单末尾那条兜底动作。**`items` 为空时点按钮直接走它**——
   * 只剩这一条的菜单还要人先展开再点，白多一次点击。
   */
  action?: PickerAction;
  /** 还没选，按钮描主色的边。 */
  need?: boolean;
  /** 当前值有问题（比如挑的模型探测不到了）。 */
  bad?: boolean;
  label: string;
  /** 次要信息从哪头截。路径要留末几级，所以从头上截。 */
  noteTruncate?: 'head' | 'tail';
}) {
  const [open, setOpen] = useState(false);
  /** 键盘走到第几行。-1 表示还没用键盘走过。 */
  const [active, setActive] = useState(-1);
  /** 下面放不下，朝上开。 */
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const rows: PickerItem[] = action ? [...items, { value: ACTION, label: action.label }] : items;
  const current = items.find((i) => i.value === value);

  // 点到别处就收起来。用 pointerdown 而不是 click：click 要等抬手，
  // 期间菜单还盖在下面，落到菜单外那一下会先被底下的东西吃掉
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  /**
   * 量完再定朝哪开。**必须是 layout effect**：放在普通 effect 里的话，
   * 朝下那一版会先画出去一帧，看着就是菜单跳了一下。
   */
  useLayoutEffect(() => {
    if (!open) {
      setUp(false);
      return;
    }
    const btn = wrap.current?.firstElementChild?.getBoundingClientRect();
    const m = list.current?.getBoundingClientRect();
    if (!btn || !m) return;
    const below = window.innerHeight - btn.bottom;
    setUp(below < m.height + 12 && btn.top > below);
  }, [open, items.length]);

  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelectorAll('[role="menuitem"]')[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const choose = (row: PickerItem) => {
    setOpen(false);
    if (row.value === ACTION) action?.onSelect();
    else onPick(row.value);
  };

  const show = () => {
    if (items.length === 0 && action) {
      action.onSelect();
      return;
    }
    const i = rows.findIndex((r) => r.value === value);
    setActive(i >= 0 ? i : rows.findIndex((r) => !r.disabled));
    setOpen(true);
  };

  /** 上下键跳过禁用项；绕一圈都没有能落脚的就原地不动。 */
  const step = (dir: 1 | -1) => {
    setActive((a) => {
      let i = a < 0 ? (dir > 0 ? -1 : 0) : a;
      for (let n = 0; n < rows.length; n++) {
        i = (i + dir + rows.length) % rows.length;
        if (!rows[i]!.disabled) return i;
      }
      return a;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (!open) return;
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) show();
      else step(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (open && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const order = e.key === 'Home' ? rows : [...rows].reverse();
      const hit = order.find((r) => !r.disabled);
      if (hit) setActive(rows.indexOf(hit));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) show();
      else if (active >= 0 && !rows[active]!.disabled) choose(rows[active]!);
    }
  };

  return (
    <div className="picker" ref={wrap} onKeyDown={onKeyDown}>
      <button
        className={`pk${need ? ' need' : ''}${bad ? ' bad' : ''}${open ? ' open' : ''}`}
        title={current?.title ?? current?.label}
        aria-label={label}
        aria-haspopup={items.length > 0 ? 'menu' : undefined}
        aria-expanded={items.length > 0 ? open : undefined}
        onClick={() => (open ? setOpen(false) : show())}
      >
        {icon}
        <span className="t">{current?.label ?? placeholder ?? value}</span>
        {items.length > 0 && <span className="caret">▾</span>}
      </button>

      {open && (
        <div
          className={`picker-menu${noteTruncate === 'head' ? ' headcut' : ''}${up ? ' up' : ''}`}
          role="menu"
          ref={list}
        >
          {rows.map((r, i) => (
            <button
              key={r.value}
              role="menuitem"
              className={`${r.value === value ? 'on' : ''}${i === active ? ' at' : ''}${
                r.value === ACTION ? ' act' : ''
              }`}
              disabled={r.disabled}
              title={r.title}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              {r.value === ACTION && action?.icon}
              <span className="n">{r.label}</span>
              {r.note && (
                <span className="p">
                  <bdi>{r.note}</bdi>
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
