import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaseMeta, ChatLine, PendingAsk, PendingGate, StepNode } from '../shared/ipc.js';
import {
  STAGE,
  directionText,
  refuteEdges,
  stageLayout,
  trackLayout,
  weaveChat,
  type StageBox,
  type StageEdge,
  type StageLayout,
} from './track.js';
import { CaseCard } from './CaseCard.js';
import { StepSheet } from './StepSheet.js';
import { Icon } from './Icon.js';

/**
 * 工作区的舞台：**一整幅可缩放拖拽的画布**（ui.md §3）。
 *
 * 卡片与连线在同一层里共用世界坐标——分两层各自缩放的话线与卡必然错位。
 * 位置全部由 `stage.ts` 算好，这里一行都不量：量高度意味着先渲染再定位，
 * 而那正是"已读的卡会跑"的入口（`spike:stage` 兜着这条）。
 *
 * 卡面只留五样（序号 · 类型 · 状态 · 假设句 · 结论），证据与工具调用进右侧详情浮层——
 * 舞台是拿来扫视与介入的，逐字读的那一档在浮层里。
 */

/** 低于这个缩放，卡片退成"色标 + 大号序号 + 状态"的图例（正文这时本来也读不出来）。 */
const LOD_FAR = 0.46;
const K_MIN = 0.22;
const K_MAX = 1.8;
/**
 * 右边那两层各占多宽。**这里是唯一的出处**：`styles.css` 那三条（`.todolayer` 的宽与右距、
 * `.stepsheet` 的宽、浮层开着时待办让位到哪儿）都从这几个数变成的 CSS 变量里读。
 *
 * 🔴 各写一份的必然结果是慢慢对不上，而且**不会有任何报错**：几何这侧少扣二十几个像素，
 * 表现只是"适应"与"跟随最新"把卡片停在待办层底下一点点——正好是这两个动作要防的事。
 */
const PANEL = { todoW: 372, todoRight: 14, sheetW: 452, gap: 28 } as const;

/** 视口右边被盖住多宽。待办层空着时它高度为 0，什么都没挡，所以按"这会儿在不在"算。 */
function occluded(hasTodos: boolean, sheetOpen: boolean) {
  const sheet = sheetOpen ? PANEL.sheetW : 0;
  if (!hasTodos) return sheet;
  return sheet + (sheetOpen ? PANEL.gap : PANEL.todoRight) + PANEL.todoW;
}

type ViewBox = { x: number; y: number; k: number };

/**
 * 每个调查各记一份视角。
 *
 * 🔴 **住在模块里，不在组件里。** 切换调查的入口在历史调查页（ui.md §8.3），
 * 而那一屏把整个工作区卸载掉——记在 `useRef` 里的话，人绕这一圈回来时它已经蒸发了，
 * 表现是"每次切回去都被拉回最新那一步"，而看着像跟随逻辑的问题。
 * 一个调查三个数，攒一天也没多少。
 */
const VIEWS = new Map<string, ViewBox>();

export function Stage({
  meta,
  steps,
  chat,
  liveLanes,
  pending,
  gates,
  todos,
  onExcerpt,
  onStopLane,
  onRename,
}: {
  meta: CaseMeta;
  steps: StepNode[];
  chat: ChatLine[];
  liveLanes: string[];
  /**
   * 挂着的①档与②档，**只用来在图上标出"是哪一步在等你"**。
   * 卡片本身在 `todos` 里、钉在视口上；不标的话人得自己在图上找是哪一步停住了。
   */
  pending: PendingAsk[];
  gates: PendingGate[];
  /** ①档与②档的卡片：**钉在视口右上，不随画布跑**（见 `.todolayer` 那段注释）。 */
  todos: React.ReactNode;
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
  onStopLane: (lane: string) => void;
  onRename: (title: string) => Promise<boolean>;
}) {
  const track = useMemo(() => trackLayout(steps), [steps]);
  const items = useMemo(() => weaveChat(track.rows, chat), [track.rows, chat]);
  const layout = useMemo(
    () => stageLayout(items, track.lanes, { title: meta.title, question: meta.question }),
    [items, track.lanes, meta.title, meta.question],
  );
  const edges = useMemo(
    () => [...layout.edges, ...refuteEdges(layout, track.edges)],
    [layout, track.edges],
  );

  /**
   * 哪几步正等着人。②档直接对得上（`PendingGate.id` 就是 `CallNode.id`），
   * ①档靠 `callId` 认——认不到就不标，**不猜**：标到一个猜出来的位置上比不标更糟。
   */
  const waiting = useMemo(() => {
    const callIds = new Set([...gates.map((g) => g.id), ...pending.map((p) => p.callId).filter(Boolean)]);
    const out = new Set<string>();
    for (const s of steps) if (s.calls.some((c) => callIds.has(c.id))) out.add(s.id);
    return out;
  }, [steps, pending, gates]);

  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewBox>({ x: 40, y: 20, k: 1 });
  const [follow, setFollow] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);

  /**
   * 可视区 ≠ 视口：右边那两层（待办、展开着的详情浮层）各盖着一块。
   * 按视口居中的话，最新那几步会静静躺在待办卡背后，而"适应"与"跟随最新"
   * 恰恰是拿来保证"我要看的东西在屏幕上"的两个动作。
   *
   * **两层都要按"这会儿真的在不在"扣**：待办层空着时它高度为 0、什么都没挡，
   * 照旧扣掉 358px 的话，整幅图会长期偏左一截，而多数时候它正是空的。
   * `sheetOpen` 由调用方给：`setPicked` 要到下一帧才落地，这一帧读 `picked` 拿到的是旧值。
   */
  const freeSize = useCallback(
    (sheetOpen = !!picked) => {
      const r = box.current?.getBoundingClientRect();
      const w = (r?.width ?? 1200) - occluded(!!(pending.length || gates.length), sheetOpen);
      // ⚠️ 这个下限**不是"至少有这么宽"，是防除零**：夹出来的宽度是一块不存在的空间，
      // 按它居中等于把卡片摆到浮层底下。窗口的 `minWidth`（`main/index.ts`）保证够不着这儿
      return { w: Math.max(160, w), h: r?.height ?? 700 };
    },
    [picked, pending.length, gates.length],
  );

  /**
   * 把某一张卡摆到可视区中间。
   *
   * **主干那一列要连它左边那条旁白槽一起居中**：读的单位是"一列 + 挨着它的那几句话"，
   * 只按卡片自己居中的话，旁白正好卡在视口左沿被裁掉半个字（实测如此）。
   * 别的列左边没有旁白，照旧按卡片自己居中。
   */
  const centerOn = useCallback(
    (id: string | null, minK?: number) => {
      const n = id ? layout.byId.get(id) : null;
      if (!n) return;
      const leftPad = n.kind === 'step' && n.row.col === 0 ? STAGE.sayW + STAGE.sayGap : 0;
      setView((v) => {
        const k = minK ? Math.max(v.k, minK) : v.k;
        const { w, h } = freeSize();
        return { k, x: w / 2 - (n.x - leftPad / 2 + n.w / 2) * k, y: h * 0.44 - (n.y + n.h / 2) * k };
      });
    },
    [layout, freeSize],
  );

  const fit = useCallback(() => {
    const b = layout.bounds;
    const { w, h } = freeSize();
    const m = 48;
    const k = Math.max(K_MIN, Math.min(1.1, (w - m * 2) / b.w, (h - m * 2) / b.h));
    setView({ k, x: (w - b.w * k) / 2 - b.x1 * k, y: (h - b.h * k) / 2 - b.y1 * k });
  }, [layout.bounds, freeSize]);

  /**
   * 切进 / 切出一个调查时收发那份视角。共用一份的话，切回来时停在的是**别的调查**
   * 上一次拖到的地方——而两次调查的图形状完全不同，那个坐标多半落在一片空白上。
   */
  const shownCase = useRef<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  // 离开工作区那一屏时也要存：换调查走的是历史调查页，那一路上这个组件是被卸载掉的
  useEffect(() => () => {
    if (shownCase.current) VIEWS.set(shownCase.current, viewRef.current);
  }, []);
  useEffect(() => {
    if (shownCase.current === meta.id) return;
    if (shownCase.current) VIEWS.set(shownCase.current, view);
    shownCase.current = meta.id;
    // 浮层跟着一起关：`picked` 是上一个调查里的 step id，新调查的 layout 里查不到它，
    // 于是浮层不渲染、而 `picked` 仍是真——`.sheeting` 与那 466px 的扣减会一直挂着
    setPicked(null);
    const saved = VIEWS.get(meta.id);
    if (saved) setView(saved);
    // 头一回打开停在最新那一步上，不是停在整幅图的缩略——一屏读不出字的缩略图
    // 说不出"这一轮查到哪了"，而那正是这一屏要回答的问题
    else centerOn(layout.lastId, 0.92);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  /**
   * 跟随最新：**只在同一个调查里真的多出一张卡时动**。每帧都居中的话，人一拖开就被拽回去。
   *
   * 🔴 **记的是「哪个调查的哪一张」**。只记 id 的话，切调查那一轮它也会认成"多出了一张"——
   * 而上面那个 effect 刚刚把保存的视角恢复回来，这一次 `centerOn` 紧跟着把它盖掉，
   * "每个调查各记一份视角"于是在默认开着跟随时等于没有。
   */
  const lastSeen = useRef<{ caseId: string; id: string | null } | null>(null);
  useEffect(() => {
    const seen = lastSeen.current;
    lastSeen.current = { caseId: meta.id, id: layout.lastId };
    // 换了调查、或头一回见：位置由上面那个 effect 定，这儿只记不动
    if (!seen || seen.caseId !== meta.id || seen.id === layout.lastId) return;
    if (follow) centerOn(layout.lastId, 0.8);
  }, [meta.id, layout.lastId, follow, centerOn]);

  // ── 手势 ────────────────────────────────────────────────────────────────
  /**
   * 以 (px,py) 为定点按倍数缩放。
   *
   * 🔴 **倍数要在 setState 的回调里乘**，不能在外面按当前的 `view.k` 先算好一个目标值：
   * React 批处理同一轮里的多次 setState，而闭包里的 `view.k` 是这一帧的旧值——
   * 连点五下「−」时五次算出的目标一模一样，最终只缩了一档（实测如此）。
   */
  const zoomBy = (px: number, py: number, factor: number) => {
    setView((v) => {
      const k = Math.min(K_MAX, Math.max(K_MIN, v.k * factor));
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // React 的 onWheel 是被动监听，`preventDefault` 在里面不生效（整页会跟着滚）
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        // 触控板一次捏合会连发几十个 wheel，同样必须在回调里乘——理由同 `zoomBy`
        setView((v) => {
          const k = Math.min(K_MAX, Math.max(K_MIN, v.k * (1 - e.deltaY * 0.0022)));
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
        });
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.s-card,.s-say,.s-hud,.todolayer,.stepsheet')) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  // Esc 关浮层。J/K 是待办那一对，不在这儿抢
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && picked) setPicked(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked]);

  /** 点开一张卡时它可能正落在浮层底下：**只在真被盖住时才挪画布**，每点一张都居中会晕。 */
  const ensureVisible = (id: string) => {
    const n = layout.byId.get(id);
    if (!n) return;
    const { w, h } = freeSize(true);
    setView((v) => {
      const l = n.x * v.k + v.x;
      const rr = (n.x + n.w) * v.k + v.x;
      const t = n.y * v.k + v.y;
      const b = (n.y + n.h) * v.k + v.y;
      let dx = 0;
      let dy = 0;
      if (rr > w - 16) dx = w - 16 - rr;
      else if (l < 16) dx = 16 - l;
      if (b > h - 16) dy = h - 16 - b;
      else if (t < 16) dy = 16 - t;
      return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
    });
  };

  const pick = (id: string) => {
    setPicked(id);
    ensureVisible(id);
  };

  const stepIds = useMemo(() => layout.boxes.filter((b) => b.kind === 'step').map((b) => b.id), [layout.boxes]);
  /**
   * 🔴 **凡是"浮层开着"的判断都认它，不认 `picked`。** `picked` 可以指向一个舞台上
   * 根本不存在的 id（换了调查、或跳去一个不在本次调查里的推翻者），那时浮层不渲染，
   * 而 `.sheeting` 与可视区那 466px 的扣减会继续挂着——屏幕上留下一块谁也不占的空白。
   */
  const pickedBox = picked ? layout.byId.get(picked) : undefined;
  const far = view.k < LOD_FAR;

  return (
    <div
      className={`stage${pickedBox ? ' sheeting' : ''}`}
      ref={box}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('.s-card,.s-say')) fit();
      }}
      style={
        {
          '--todo-w': `${PANEL.todoW}px`,
          '--todo-right': `${PANEL.todoRight}px`,
          '--sheet-w': `${PANEL.sheetW}px`,
          '--panel-gap': `${PANEL.gap}px`,
          '--dot': `${26 * view.k}px`,
          '--dotx': `${view.x % (26 * view.k)}px`,
          '--doty': `${view.y % (26 * view.k)}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="world"
        data-lod={far ? 'far' : 'near'}
        style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }}
      >
        <Wires edges={edges} layout={layout} />
        {layout.laneHeads.map((l) => (
          <div key={l.id} className={`lanehead ${l.kind}`} style={{ left: l.x, top: l.y }}>
            <span className="tag">{l.label}</span>
            {l.note && <span className="note">{l.note}</span>}
          </div>
        ))}
        {layout.marks.map((m) => (
          <div key={m.id} className="smark" style={{ left: m.x, top: m.y }}>
            第 {m.sessionIndex} 次会话
          </div>
        ))}
        {layout.boxes.map((b) =>
          b.kind === 'case' ? (
            <CaseCard key={b.id} box={b} meta={meta} onRename={onRename} onOpen={() => pick(b.id)} />
          ) : b.kind === 'say' ? (
            <SayNode key={b.id} box={b} />
          ) : (
            <StepNodeCard
              key={b.id}
              box={b}
              picked={picked === b.id}
              waiting={waiting.has(b.id)}
              live={!!b.row.step.lane && liveLanes.includes(b.row.step.lane)}
              onPick={() => pick(b.id)}
              onStopLane={onStopLane}
            />
          ),
        )}
      </div>

      {/**
       * ①档与②档钉在视口上，**不落在画布里**：①档「永远置顶」在滚动条的世界里是 top，
       * 在画布的世界里没有 top——一张能被人拖出屏幕的卡不叫置顶。
       * 浮层拉开时它整条让到浮层左边，仍然常驻。
       */}
      <div className="todolayer">{todos}</div>

      <div className="s-hud">
        <div className="zoomer">
          <button title="缩小" onClick={() => zoomBy(freeSize().w / 2, freeSize().h / 2, 1 / 1.2)}>
            −
          </button>
          <span className="k">{Math.round(view.k * 100)}%</span>
          <button title="放大" onClick={() => zoomBy(freeSize().w / 2, freeSize().h / 2, 1.2)}>
            +
          </button>
          <button className="txt" onClick={fit} title="整幅图缩到一屏（双击画布空处同样）">
            适应
          </button>
          <button
            className={`txt ${follow ? 'on' : ''}`}
            onClick={() => setFollow(!follow)}
            title={follow ? '新的一步钻出来时自动跟过去' : '不跟随：新步骤照旧钻出来，画布不动'}
          >
            跟随最新
          </button>
        </div>
        <Minimap layout={layout} view={view} size={freeSize()} waiting={waiting} onGo={(x, y) => setView((v) => {
          const { w, h } = freeSize();
          return { ...v, x: w / 2 - x * v.k, y: h / 2 - y * v.k };
        })} />
      </div>

      {pickedBox && (
        <StepSheet
          box={pickedBox}
          meta={meta}
          liveLanes={liveLanes}
          onClose={() => setPicked(null)}
          onExcerpt={onExcerpt}
          onStopLane={onStopLane}
          onGo={(id) => {
            // 跳不过去的一律不动。设成一个查不到的 id 的话，浮层当场消失、
            // 而人只是想看看推翻它的那一步长什么样
            if (!layout.byId.has(id)) return;
            setPicked(id);
            centerOn(id, 0.85);
          }}
          step={(dir) => {
            const at = stepIds.indexOf(picked ?? '');
            const next = stepIds[at + dir];
            if (next) {
              setPicked(next);
              centerOn(next, 0.85);
            }
          }}
          canStep={(dir) => {
            const at = stepIds.indexOf(picked ?? '');
            return at >= 0 && !!stepIds[at + dir];
          }}
        />
      )}
    </div>
  );
}

/**
 * 连线。三种形各说一件事，**曲线被「推翻」独占**——结构线一律走直角，
 * 所以那条曲线一出现就不用读字也知道发生了什么（ui.md §3）。
 */
function Wires({ edges, layout }: { edges: StageEdge[]; layout: StageLayout }) {
  /** 推翻那条曲线整条走在**所有卡片左边**的空槽里。走在旁白那一栏里的话，
      它会从那几句话的字缝里穿过去——而旁白没有底色，挡都挡不住。 */
  const gutter = layout.bounds.x1 - 26;
  const paths = edges.flatMap((e) => {
    const a = layout.byId.get(e.fromId);
    const b = layout.byId.get(e.toId);
    if (!a || !b) return [];
    return [{ id: e.id, kind: e.kind, d: wirePath(e.kind, a, b, gutter) }];
  });
  return (
    <svg
      className="wires"
      width={layout.bounds.x2 + 240}
      height={layout.bounds.y2 + 240}
      aria-hidden
    >
      <defs>
        <marker id="wire-tip" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L6 3 L0 6 z" />
        </marker>
        <marker id="wire-tip-bad" className="bad" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L6 3 L0 6 z" />
        </marker>
      </defs>
      {paths.map((p) => (
        <path
          key={p.id}
          className={`w-${p.kind}`}
          d={p.d}
          markerEnd={p.kind === 'flow' ? undefined : `url(#wire-tip${p.kind === 'refute' ? '-bad' : ''})`}
        />
      ))}
    </svg>
  );
}

function wirePath(kind: StageEdge['kind'], a: StageBox, b: StageBox, gutter: number) {
  if (kind === 'flow') {
    // 同一列：一条竖线。跨列的 flow 不该出现（列内才有 flow），万一出现也画得出来
    const x1 = a.x + 22;
    const y1 = a.y + a.h;
    const x2 = b.x + 22;
    const y2 = b.y;
    if (Math.abs(x2 - x1) < 2) return `M${x1},${y1} L${x2},${y2}`;
    const my = y1 + (y2 - y1) / 2;
    return `M${x1},${y1} V${my} H${x2} V${y2}`;
  }
  if (kind === 'open') {
    // 开一条新线：父的右沿拐到子的左沿
    const x1 = a.x + a.w;
    const y1 = a.y + 22;
    const x2 = b.x - 5;
    const y2 = b.y + 22;
    const mx = x1 + (x2 - x1) / 2;
    return `M${x1},${y1} H${mx} V${y2} H${x2}`;
  }
  // 推翻：整条走在最左边那条空槽里，两头贴着卡片左沿，不压任何一个字
  const x1 = a.x;
  const y1 = a.y + 22;
  const x2 = b.x - 5;
  const y2 = b.y + 22;
  return `M${x1},${y1} C${gutter},${y1} ${gutter},${y2} ${x2},${y2}`;
}

/** 旁白：agent 的判断 / 人的补充。不做成卡——它是旁白，不是节点。 */
function SayNode({ box }: { box: Extract<StageBox, { kind: 'say' }> }) {
  return (
    <div
      className={`s-say ${box.line.role}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <span className="who">{sayLabel(box.line.role)}</span>
      <p style={{ WebkitLineClamp: box.textLines } as React.CSSProperties}>{box.line.text}</p>
    </div>
  );
}

/** 「补充」而不是「你」：人在这儿说的话语义是**异步入队的补充**（ui.md §8.2），不是聊天。 */
function sayLabel(role: ChatLine['role']) {
  return ({ assistant: 'agent', user: '补充', system: '系统' } as const)[role];
}

/**
 * 舞台上的一步。**卡面只留五样**：序号 · 类型 · 状态 · 假设句 · 结论。
 * 证据条数与调用次数都不在上面——要看那些就是要逐字读，而逐字读在浮层里。
 */
function StepNodeCard({
  box,
  picked,
  waiting,
  live,
  onPick,
  onStopLane,
}: {
  box: Extract<StageBox, { kind: 'step' }>;
  picked: boolean;
  /** 这一步正卡在①档回填或②档闸门上。**暖色是「需要人动手」的全局专属**（ui.md §4）。 */
  waiting: boolean;
  live: boolean;
  onPick: () => void;
  onStopLane: (lane: string) => void;
}) {
  const { row } = box;
  const step = row.step;
  return (
    <article
      className={`s-card step ${step.status} ${step.kind}${picked ? ' picked' : ''}${waiting ? ' waiting' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onClick={onPick}
    >
      <div className="c-head">
        <span className="ord">{row.label}</span>
        <span className={`kind ${step.kind}`}>{kindLabel(step.kind)}</span>
        {/* 推翻者不在这条轨道上时曲线画不出来，这句话照旧——
            少一道划线就是把一个已经作废的结论显示成仍然成立的 */}
        {row.refutedBy !== null && (
          <span className="refbadge">← {row.refutedBy ? `被 ${row.refutedBy} 推翻` : '已被推翻'}</span>
        )}
        {waiting && <span className="waitbadge">等你处理</span>}
        {/* 停一条支线只停它自己（overview §3.4），所以按钮长在那一行上：
            状态栏那枚「支线 N」说不出要停的是哪一条 */}
        {live && step.lane && (
          <button
            className="stoplane"
            title="只停这一条支线，主线与别的支线照旧"
            onClick={(e) => {
              e.stopPropagation();
              onStopLane(step.lane!);
            }}
          >
            <Icon name="stop" size={9} />停
          </button>
        )}
        <span className={`state ${step.status}`}>
          {step.status === 'open' && <span className="pulse" />}
          {statusLabel(step.status)}
        </span>
      </div>
      <p className="c-dir" style={{ WebkitLineClamp: box.dirLines } as React.CSSProperties}>
        {directionText(step)}
      </p>
      {step.verdict && (
        <p className="c-vd" style={{ WebkitLineClamp: box.vdLines } as React.CSSProperties}>
          {step.verdict}
        </p>
      )}
    </article>
  );
}

/** 导览图：画布一大，"我在整幅图的哪儿"就得有人回答。 */
function Minimap({
  layout,
  view,
  size,
  waiting,
  onGo,
}: {
  layout: StageLayout;
  view: ViewBox;
  size: { w: number; h: number };
  waiting: Set<string>;
  onGo: (x: number, y: number) => void;
}) {
  const W = 186;
  const H = 124;
  const pad = 8;
  const b = layout.bounds;
  const s = Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const l = clamp(pad + (-view.x / view.k - b.x1) * s, 0, W);
  const t = clamp(pad + (-view.y / view.k - b.y1) * s, 0, H);
  const r = clamp(l + (size.w / view.k) * s, 0, W);
  const bo = clamp(t + (size.h / view.k) * s, 0, H);
  return (
    <div
      className="minimap"
      style={{ width: W, height: H }}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onGo(b.x1 + (e.clientX - rect.left - pad) / s, b.y1 + (e.clientY - rect.top - pad) / s);
      }}
    >
      {layout.boxes
        .filter((n) => n.kind !== 'say')
        .map((n) => (
          <i
            key={n.id}
            className={waiting.has(n.id) ? 'wait' : n.kind === 'step' ? n.row.step.status : 'case'}
            style={{
              left: pad + (n.x - b.x1) * s,
              top: pad + (n.y - b.y1) * s,
              width: Math.max(3, n.w * s),
              height: Math.max(2, n.h * s),
            }}
          />
        ))}
      <div className="vp" style={{ left: l, top: t, width: Math.max(0, r - l), height: Math.max(0, bo - t) }} />
    </div>
  );
}

/** 只管 step 的状态。会话那几档由底部状态栏自己说——那儿要分"这一轮"与"这次调查"。 */
export function statusLabel(s: StepNode['status']) {
  return (
    {
      open: '进行中',
      confirmed: '已证实',
      refuted: '已推翻',
      inconclusive: '未查清',
      superseded: '被推翻',
      converged: '已收口',
    } as const
  )[s];
}

export function kindLabel(k: StepNode['kind']) {
  return ({ normal: '排查', unclassified: '未归类', impact: '影响面', leftover: '遗留问题' } as const)[k];
}
