import { useEffect, useState } from 'react';
import type { AppInfo, IntakeOptions } from '../shared/ipc.js';
import { LIMIT_BOUNDS, type UiSettings } from '../shared/settings.js';
import { LogoMark } from './LogoMark.js';

const REPO = 'https://github.com/xieziyu/inquestry';
const ISSUES = `${REPO}/issues/new`;
const AUTHOR = 'https://github.com/xieziyu';

/** backend 报出来的「不指定模型」那一档的 value。 */
const DEFAULT_ROW = 'default';

/**
 * 设置屏（ui.md §8.5）。三节：新建调查的默认值 / 超时与限流 / 关于。
 *
 * **改动即时落库**，没有保存按钮：这一页每一项都是下一次才生效的预设，
 * 攒一批再保存只会多一个"我改了没有"的状态。
 *
 * 🔴 **落库回来的那一份才是真的。** 限流值在 main 那侧夹逼（`normalizeSettings`），
 * 填了个越界的数字时屏幕上留着人填的、实际生效的是夹过的——所以这里认回执，
 * 不认自己手上那份乐观值。
 */
export function Settings() {
  const [s, setS] = useState<UiSettings | null>(null);
  const [opts, setOpts] = useState<IntakeOptions | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.inquestry.getSettings().then(setS);
    void window.inquestry.intakeOptions().then(setOpts);
    void window.inquestry.appInfo().then(setInfo);
  }, []);

  const save = (next: UiSettings) => {
    // 先乐观画上，让点击有即时反馈；回执到了再以它为准（越界值会被夹回来）
    setS(next);
    void window.inquestry.putSettings(next).then(setS);
  };

  if (!s) return <div className="page settings" />;

  const patchIntake = (p: Partial<UiSettings['intake']>) => save({ ...s, intake: { ...s.intake, ...p } });
  const patchLimits = (p: Partial<UiSettings['limits']>) => save({ ...s, limits: { ...s.limits, ...p } });

  const hasDefaultRow = !!opts?.models.some((m) => m.value === DEFAULT_ROW);
  const model = opts?.models.find((m) => m.value === (s.intake.agent.model ?? DEFAULT_ROW));
  const efforts = model?.efforts ?? [];

  return (
    <div className="page settings">
      <header className="pagehead">
        <h1>设置</h1>
        <span className="sub">改动即时保存到本地</span>
      </header>
      <div className="pagebody">
        <div className="pad">
          <section className="set-sec">
            <h2>默认偏好</h2>
            <div className="set-body">
              {/* 说清是**哪一个** backend 没接入：只印那条 note（"未接入"）的话，
                  它挨着 Backend 这个标题，读起来像是当前这个没接上 */}
              <Row
                label="Backend"
                hint={opts?.backends
                  .filter((b) => !b.enabled)
                  .map((b) => `${b.label} ${b.note ?? '不可用'}`)
                  .join(' · ')}
              >
                <div className="seg">
                  {opts?.backends.map((b) => (
                    <button
                      key={b.value}
                      className={s.intake.agent.backend === b.value ? 'on' : ''}
                      disabled={!b.enabled}
                      onClick={() =>
                        patchIntake({ agent: { backend: b.value, model: null, effort: null } })
                      }
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </Row>

              <Row
                label="模型"
                hint={
                  opts && !opts.modelsProbed
                    ? '没能从 backend 问到模型列表（可能是还没登录），这几项是内置兜底'
                    : '列表是探测出来的，探测不到才退回内置表'
                }
              >
                <div className="seg wrap">
                  {!hasDefaultRow && (
                    <button
                      className={s.intake.agent.model === null ? 'on' : ''}
                      onClick={() =>
                        patchIntake({ agent: { ...s.intake.agent, model: null, effort: null } })
                      }
                    >
                      默认
                    </button>
                  )}
                  {opts?.models.map((m) => {
                    const value = m.value === DEFAULT_ROW ? null : m.value;
                    return (
                      <button
                        key={m.value}
                        className={s.intake.agent.model === value ? 'on' : ''}
                        title={m.description}
                        onClick={() =>
                          patchIntake({ agent: { ...s.intake.agent, model: value, effort: null } })
                        }
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              </Row>

              {/* 模型不支持 effort 就整项不出现，而不是给个拧了不生效的假开关（D19） */}
              {efforts.length > 0 && (
                <Row label="思考强度" hint="再点一下取消，交给 backend 自己定">
                  <div className="seg">
                    {efforts.map((e) => (
                      <button
                        key={e}
                        className={s.intake.agent.effort === e ? 'on' : ''}
                        onClick={() =>
                          patchIntake({
                            agent: {
                              ...s.intake.agent,
                              effort: s.intake.agent.effort === e ? null : e,
                            },
                          })
                        }
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </Row>
              )}

              <Row label="权限模式初值" hint="随时可切；接管档每次调用都要你放行，且不会自动过去">
                <div className="seg">
                  <button
                    className={s.intake.takeover ? '' : 'on'}
                    onClick={() => patchIntake({ takeover: false })}
                  >
                    自动模式
                  </button>
                  <button
                    className={s.intake.takeover ? 'on' : ''}
                    onClick={() => patchIntake({ takeover: true })}
                  >
                    全程接管
                  </button>
                </div>
              </Row>

              <Row
                label="最近工作区"
                hint={
                  opts?.recentRoots.length
                    ? `${opts.recentRoots.length} 条，首页那张表单上的快捷入口`
                    : '还没有用过任何工作区'
                }
              >
                <span className="ro mono">
                  {opts?.recentRoots[0]?.split('/').slice(-1)[0] ?? '—'}
                </span>
              </Row>
            </div>
          </section>

          <section className="set-sec">
            <h2>超时与限流</h2>
            <div className="set-body">
              <Row
                label="闸门自动放行"
                hint='②档倒计时归零按预设放行，节点标记"自动放行"。接管模式下这一项不生效'
              >
                <Num
                  value={Math.round(s.limits.gateTimeoutMs / 60_000)}
                  min={Math.ceil(LIMIT_BOUNDS.gateTimeoutMs.min / 60_000)}
                  max={Math.floor(LIMIT_BOUNDS.gateTimeoutMs.max / 60_000)}
                  unit="分钟"
                  onCommit={(v) => patchLimits({ gateTimeoutMs: v * 60_000 })}
                />
              </Row>
              <Row
                label="同时在跑的调查"
                hint="超上限时降级最久没动的那个。当前这个、正在跑的、挂着待办的都不会被降"
              >
                <Num
                  value={s.limits.maxLiveCases}
                  min={LIMIT_BOUNDS.maxLiveCases.min}
                  max={LIMIT_BOUNDS.maxLiveCases.max}
                  unit="个"
                  onCommit={(v) => patchLimits({ maxLiveCases: v })}
                />
              </Row>
              <Row
                label="载入内存的调查"
                hint="只是投影缓存，降级不影响库里的数据。它不会小于上面那个数"
              >
                <Num
                  value={s.limits.maxLoadedCases}
                  min={LIMIT_BOUNDS.maxLoadedCases.min}
                  max={LIMIT_BOUNDS.maxLoadedCases.max}
                  unit="个"
                  onCommit={(v) => patchLimits({ maxLoadedCases: v })}
                />
              </Row>
            </div>
          </section>

          <section className="set-sec">
            <h2>关于</h2>
            <div className="set-body">
              <div className="about">
                <LogoMark size={34} />
                <div className="vmeta">
                  <div className="v">
                    Inquestry <b>{info?.version ?? '—'}</b>
                  </div>
                  <div className="sub mono">
                    {info
                      ? [
                          `Electron ${info.electron}`,
                          `SQLite ${info.sqlite}`,
                          // 探不到就不印这一段，别编一个"未知版本"
                          info.claudeVersion ? `claude ${info.claudeVersion}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : '…'}
                  </div>
                </div>
                <span className="lic mono">GPL-3.0</span>
              </div>

              <Row
                label="claude 可执行文件"
                hint={info?.claudePath ?? '没找到。装上 Claude Code 并在终端登录一次。'}
              >
                <span className={`ro ${info && !info.claudePath ? 'bad' : ''}`}>
                  {info?.claudePath ? '已就绪' : '未找到'}
                </span>
              </Row>

              <Row label="数据库" hint={info?.dbPath}>
                <span className="ro mono">{info ? mb(info.dbBytes) : '—'}</span>
                <button onClick={() => void window.inquestry.revealDb()}>在访达中显示</button>
              </Row>

              <div className="links">
                <Link href={REPO}>源码仓库</Link>
                <i />
                <Link href={ISSUES}>反馈问题</Link>
                <i />
                <Link href={AUTHOR}>作者 @xieziyu</Link>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="srow">
      <div className="lab">
        <div className="n">{label}</div>
        {hint && <div className="h">{hint}</div>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  );
}

/**
 * 数字输入。**编辑中不落库，失焦或回车才落**：每敲一个键就存的话，
 * 想把 12 改成 3 会先经过一个 1 —— 那一下是合法值，会被当场应用（限流当场降级掉一批调查）。
 *
 * 本地态是字符串而不是数字：清空输入框重打是最常见的改法，而空串 `Number('')` 是 0。
 */
function Num({
  value,
  min,
  max,
  unit,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // 落库回来的值可能被夹过（也可能被别处改了），以它为准重画
  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const n = Number(text.trim());
    // 空的 / 不是数字就退回当前值，别把 0 当成人的意思
    if (!Number.isFinite(n) || !text.trim()) return setText(String(value));
    onCommit(n);
  };

  return (
    <>
      <input
        className="num"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setText(String(value));
        }}
      />
      <span className="unit" title={`${min} – ${max}`}>
        {unit}
      </span>
    </>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        // 渲染进程里直接跳转会把整个 app 换成那个网页，而且回不来
        e.preventDefault();
        void window.inquestry.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function mb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
