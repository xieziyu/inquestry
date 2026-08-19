import { useEffect, useState } from 'react';
import type { AppInfo, EnvStatus, IntakeOptions } from '../shared/ipc.js';
import type { UpdateStatus } from '../shared/update.js';
import { LIMIT_BOUNDS, type UiSettings } from '../shared/settings.js';
import { PROJECT_LINKS } from '../shared/links.js';
import { LogoMark } from './LogoMark.js';
import { Picker, type PickerItem } from './Picker.js';

const REPO = PROJECT_LINKS.repo;
const ISSUES = `${REPO}/issues/new`;
const AUTHOR = PROJECT_LINKS.author;

/** backend 报出来的「不指定模型」那一档的 value。 */
const DEFAULT_ROW = 'default';

/** 「不指定」那一档的 value：`null` 不能当选项的值。与 `Intake.tsx` 同一套。 */
const NONE = '';

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
  const [env, setEnv] = useState<EnvStatus | null>(null);

  useEffect(() => {
    void window.inquestry.getSettings().then(setS);
    void window.inquestry.intakeOptions().then(setOpts);
    void window.inquestry.appInfo().then(setInfo);
    void window.inquestry.envCheck().then(setEnv);
  }, []);

  const save = (next: UiSettings) => {
    // 先乐观画上，让点击有即时反馈；回执到了再以它为准（越界值会被夹回来）
    setS(next);
    void window.inquestry.putSettings(next).then(setS);
  };

  if (!s) return <div className="page settings" />;

  const patchIntake = (p: Partial<UiSettings['intake']>) => save({ ...s, intake: { ...s.intake, ...p } });
  const patchLimits = (p: Partial<UiSettings['limits']>) => save({ ...s, limits: { ...s.limits, ...p } });

  const model = opts?.models.find((m) => m.value === (s.intake.agent.model ?? DEFAULT_ROW));
  const efforts = model?.efforts ?? [];
  // backend 报得出「默认」那一档时就用它那行——它说得出默认到底落到哪个模型
  const defaultRow = opts?.models.find((m) => m.value === DEFAULT_ROW);
  /**
   * 这儿挑的模型这会儿可能探测不到了（那时探到、这时退回内置表）。
   * 说出来比默默换掉强：默默换掉的话，人以为在用 opus，报告里记的是另一个。
   */
  const modelMissing = s.intake.agent.model !== null && !!opts && !model;

  const models: PickerItem[] = [
    { value: NONE, label: defaultRow?.label ?? '默认模型', note: defaultRow?.resolvedModel },
    ...(opts?.models ?? [])
      .filter((m) => m.value !== DEFAULT_ROW)
      .map((m) => ({ value: m.value, label: m.label, note: m.resolvedModel, title: m.description })),
    // 探测不到的那个也要显示成选中的，否则按钮上会跳回默认那一档
    ...(modelMissing ? [{ value: s.intake.agent.model!, label: s.intake.agent.model! }] : []),
  ];

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
              <Row label="Backend">
                <div className="seg">
                  {opts?.backends.map((b) => (
                    <button
                      key={b.value}
                      className={s.intake.agent.backend === b.value ? 'on' : ''}
                      disabled={!b.enabled}
                      // 压暗那一档得说得出为什么，否则读起来像是坏了
                      title={b.enabled ? undefined : (b.note ?? '不可用')}
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
                err={modelMissing ? '这会儿探测不到，仍会原样交给 backend；真下线了的话调查起不来' : undefined}
              >
                <Picker
                  label="模型"
                  value={s.intake.agent.model ?? NONE}
                  items={models}
                  bad={modelMissing}
                  onPick={(v) =>
                    patchIntake({ agent: { ...s.intake.agent, model: v || null, effort: null } })
                  }
                />
              </Row>

              {/* 模型不支持 effort 就整项不出现，而不是给个拧了不生效的假开关（D19） */}
              {efforts.length > 0 && (
                <Row label="思考强度">
                  <Picker
                    label="思考强度"
                    value={s.intake.agent.effort ?? NONE}
                    items={[
                      { value: NONE, label: '默认' },
                      ...efforts.map((e) => ({ value: e, label: e })),
                    ]}
                    onPick={(v) => patchIntake({ agent: { ...s.intake.agent, effort: v || null } })}
                  />
                </Row>
              )}

              <Row label="权限模式初值">
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
            </div>
          </section>

          <section className="set-sec">
            <h2>超时与限流</h2>
            <div className="set-body">
              <Row label="闸门自动放行">
                <Num
                  value={Math.round(s.limits.gateTimeoutMs / 60_000)}
                  min={Math.ceil(LIMIT_BOUNDS.gateTimeoutMs.min / 60_000)}
                  max={Math.floor(LIMIT_BOUNDS.gateTimeoutMs.max / 60_000)}
                  unit="分钟"
                  onCommit={(v) => patchLimits({ gateTimeoutMs: v * 60_000 })}
                />
              </Row>
              <Row label="同时在跑的调查">
                <Num
                  value={s.limits.maxLiveCases}
                  min={LIMIT_BOUNDS.maxLiveCases.min}
                  max={LIMIT_BOUNDS.maxLiveCases.max}
                  unit="个"
                  onCommit={(v) => patchLimits({ maxLiveCases: v })}
                />
              </Row>
              <Row label="载入内存的调查">
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
                <span className="lic mono">GPL-3.0-or-later</span>
              </div>

              <UpdateRow />

              {/* CLI 是 app 自带的（版本印在上面那行小字里），所以这儿只答登录这一件事。
                  探不出来时既不说已登录也不说没登录 */}
              <Row label="Claude 登录">
                {env?.loggedIn ? (
                  <span className="ro mono">{env.email ?? '已登录'}</span>
                ) : env?.loggedIn === false ? (
                  <span className="ro bad">未登录，终端里跑一次 claude auth login</span>
                ) : (
                  <span className="ro">…</span>
                )}
              </Row>

              {/* 值就是路径本身，不是说明——所以它占控件那一列，不做成第二行小字 */}

              <Row label="数据库" wide>
                {info && <Path value={info.dbPath} />}
                <span className="ro mono sz">{info ? mb(info.dbBytes) : '—'}</span>
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

/**
 * 一条设置。**没有说明小字**：这一页每一项的标签自己说得清，
 * 挂在下面的那句话只是把同一件事再讲一遍，还把行高撑成两倍。
 *
 * `err` 是**状态**不是说明——它只在那一项这会儿真出了问题时才有（比如挑的模型探测不到）。
 */
function Row({
  label,
  err,
  wide,
  children,
}: {
  label: string;
  err?: string;
  /** 控件那一列要占满剩下的宽（路径那种要靠省略号收尾的）。 */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`srow${wide ? ' wide' : ''}${err ? ' errored' : ''}`}>
      <div className="lab">{label}</div>
      <div className="ctl">{children}</div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

/**
 * 更新状态一行。更新本身是后台下载、退出时静默安装的，所以这里不是升级的必经之路——
 * 只让用户看得见进度、并能提前重启。dev（unsupported）整行不渲染。
 */
function UpdateRow() {
  const [st, setSt] = useState<UpdateStatus>({ phase: 'idle' });

  useEffect(() => {
    void window.inquestry.updateStatus().then(setSt).catch(() => undefined);
    return window.inquestry.onUpdateStatus(setSt);
  }, []);

  if (st.phase === 'unsupported') return null;

  const busy = st.phase === 'checking' || st.phase === 'downloading';
  return (
    <Row label="更新">
      <span className={`ro${st.phase === 'error' ? ' bad' : ''}`}>{updateText(st)}</span>
      {st.phase === 'ready' ? (
        <button onClick={() => void window.inquestry.updateInstall()}>立即重启</button>
      ) : (
        <button disabled={busy} onClick={() => void window.inquestry.updateCheck()}>
          检查更新
        </button>
      )}
    </Row>
  );
}

function updateText(s: UpdateStatus): string {
  switch (s.phase) {
    case 'checking':
      return '正在检查…';
    case 'current':
      return '已是最新';
    case 'downloading':
      // update-available 之后、第一个进度事件之前 version 才会是空
      return s.version ? `正在下载 ${s.version} · ${s.percent}%` : '正在下载新版本…';
    case 'ready':
      return `${s.version} 已下好，重启后生效`;
    case 'error':
      return `检查失败：${s.message}`;
    default:
      return '尚未检查';
  }
}

/** 路径。**从头上截**：靠后那几级才认得出是哪一个，开头的 `/Users/<自己>` 条条都一样。 */
function Path({ value }: { value: string }) {
  return (
    <span className="ro mono path" title={value}>
      <bdi>{value}</bdi>
    </span>
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
