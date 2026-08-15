/**
 * 同时开着的多个排查（D28 / ui.md §8.3）。
 *
 * 切换排查**不中断任何一个**：main 这边持有全部运行时，renderer 只是换个投影看。
 * 这也是「等你处理」能跨 case 汇总的前提——待办是 main 里活着的 Promise，
 * 排查一旦被丢掉，它挂着的那些也就没了。
 *
 * 对运行时只认 `LiveCase` 这几件事，所以自检不必起真会话。
 */

import type { Db } from '../backend/db/database.js';
import { caseList, searchCases, type CaseRow } from '../backend/db/queries.js';
import type { CaseBrief, CaseHit, Snapshot } from '../shared/ipc.js';

export type LiveCase = {
  /** 待办数要能单独问：全局汇总每 60ms 就要把所有排查算一遍，走不起 buildSnapshot。 */
  readonly todoCount: number;
  readonly isBusy: boolean;
  readonly sessionStatus: Snapshot['sessionStatus'];
  close(): void;
};

/** 每个活跃会话背后是一个 spawn 出来的 CLI 进程，所以这一档限的是它，不是载入的排查数。 */
export const MAX_LIVE_CASES = 3;
/** 载入着的运行时总数。静止的不占进程，但占内存，也会把首页那份列表的条数上限顶掉。 */
export const MAX_LOADED_CASES = 12;

export class CaseRegistry<R extends LiveCase> {
  private live = new Map<string, R>();
  /** 最近交互过的在后面。 */
  private lru: string[] = [];
  private currentId: string | null = null;
  private maxLive: number;
  private maxLoaded: number;

  constructor(
    private opts: {
      db: Db;
      create: (caseId: string) => R | null;
      maxLive?: number;
      maxLoaded?: number;
    },
  ) {
    this.maxLive = opts.maxLive ?? MAX_LIVE_CASES;
    this.maxLoaded = opts.maxLoaded ?? MAX_LOADED_CASES;
  }

  /**
   * 设置屏改了上限。**调小之后要当场执行一次**：不执行的话，新的上限要等到下一次
   * 领域事件才生效——而"手上正开着 5 个、把上限改成 2"之后很可能什么都不发生，
   * 于是那个数字看起来是个没接线的假开关。
   */
  setLimits(limits: { maxLive: number; maxLoaded: number }) {
    this.maxLive = limits.maxLive;
    this.maxLoaded = limits.maxLoaded;
    this.enforceLimit();
  }

  get current(): R | null {
    return this.currentId ? (this.live.get(this.currentId) ?? null) : null;
  }

  /**
   * renderer 说的那次排查**仍是当前排查**时才给它 runner。
   *
   * 切排查那一瞬 main 这边当时就换了，而旧界面要等下一次快照（最多 60ms）才换屏——
   * 这中间它发出的调用带的还是旧 caseId。不核对的话，在排查 A 里写了一半的线索
   * 会被投进排查 B 的会话，而且 handler 还会回一个「送到了」把 A 的草稿清掉。
   * 对不上就不给，让 renderer 把草稿留住。
   */
  currentIf(caseId: string | null | undefined): R | null {
    if (caseId && this.currentId !== caseId) return null;
    return this.current;
  }

  get currentCaseId(): string | null {
    return this.currentId;
  }

  /** 新建的排查：运行时由调用方造好再交进来——建单信息只有那一侧有。 */
  adopt(caseId: string, runner: R): R {
    this.live.set(caseId, runner);
    this.select(caseId);
    return runner;
  }

  /** 切到某个排查；没载入过就按库里的建单信息重建一个。库里没有这个 id 时返回 false。 */
  switchTo(caseId: string): boolean {
    if (!this.live.has(caseId)) {
      const runner = this.opts.create(caseId);
      if (!runner) return false;
      this.live.set(caseId, runner);
    }
    this.select(caseId);
    return true;
  }

  /** 去新建排查面板。**当前排查的运行时不动**：建到一半改主意，回去它还在跑。 */
  toIntake() {
    this.currentId = null;
  }

  /**
   * 钉住哪些：当前这个、还跑着的、以及**挂着待办的**。
   *
   * 只钉这三种，不是「所有载入过的」——待办只活在运行时里，所以有待办的必须钉；
   * 但一个只是点开看过一眼的排查没有这个理由，全钉的话条数上限就等于不存在，
   * 排查列表会随着用过的排查无上限地长。
   */
  private pinnedIds(): string[] {
    return [...this.live.entries()]
      .filter(([id, r]) => id === this.currentId || r.sessionStatus === 'live' || r.todoCount > 0)
      .map(([id]) => id);
  }

  briefs(): CaseBrief[] {
    return caseList(this.opts.db, { pinned: this.pinnedIds() }).map((c) => this.brief(c));
  }

  /**
   * 检索的结果同样要**合上运行时那一半**（ui.md §8.3）。
   *
   * 库里那一半只知道标题与状态；「等你 N」「运行中」只活在运行时里。少合这一下，
   * 搜出来的那一行会把一个正卡在 `ask_operator` 上等人的排查显示成"已停止"——
   * 而跨 case 汇总要保的正是"别让那条支线静静挂死"。
   */
  search(term: string): CaseHit[] {
    return searchCases(this.opts.db, term).map((c) => ({
      ...this.brief(c),
      hits: c.hits,
      snippet: c.snippet,
      where: c.where,
    }));
  }

  /**
   * 把库里查出来的一行合上运行时那一半。历史排查页用它——那一页不走 `briefs()`
   * （它固定 20 条 + 钉住的），但**必须共用这一下合并**，否则那一页的
   * 「等你 N / 运行中」会与首页那份各说各的。
   */
  briefOf(c: CaseRow): CaseBrief {
    return this.brief(c);
  }

  private brief(c: CaseRow): CaseBrief {
    const r = this.live.get(c.id);
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      updatedAt: c.updated_at,
      current: c.id === this.currentId,
      todos: r?.todoCount ?? 0,
      running: r?.isBusy ?? false,
      started: !!c.started,
      loaded: !!r,
    };
  }

  closeAll() {
    for (const r of this.live.values()) r.close();
    this.live.clear();
    this.lru = [];
    this.currentId = null;
  }

  private select(caseId: string) {
    this.currentId = caseId;
    this.lru = [...this.lru.filter((x) => x !== caseId), caseId];
    this.enforceLimit();
  }

  /**
   * 活跃会话限流：超上限就把最久未交互的那个降级——关掉它的会话，排查本身照旧在库里，
   * 点回去是新起一轮（ui.md §8.3）。
   *
   * **切换的时候查一次是不够的**：排查是在点「开始排查」那一刻才真的 spawn 出进程的，
   * 只在 `select` 里查，四个排查各自跑起来就谁也没被拦住。所以推快照那条路上也要过一遍。
   *
   * 三种不能选：当前这个、正在跑的、以及**挂着待办的**。最后一条最容易漏：
   * 降级会把等着人回答的 pending 就地作废，等于替人做了「这条不查了」的决定，
   * 而 ①档故意没有超时兜底正是因为自动填个假结果比让人等着更糟。
   *
   * 挑不出人选就让它超一个——拒绝新建、或杀掉一条正等着人的支线，都比多开一个进程糟。
   */
  enforceLimit() {
    const liveIds = () =>
      this.lru.filter((id) => this.live.get(id)?.sessionStatus === 'live');
    while (liveIds().length > this.maxLive) {
      const victim = liveIds().find((id) => {
        const r = this.live.get(id)!;
        return id !== this.currentId && !r.isBusy && r.todoCount === 0;
      });
      if (!victim) break;
      this.drop(victim);
    }
    this.trimIdle();
  }

  /**
   * 静止的运行时也要有上限。
   *
   * 活跃会话那条限流只看 `sessionStatus === 'live'`，所以**跑完的、崩了的、只点开看过一眼的
   * 一个都不会被收掉**——它们会一直躺在表里，连着 chat 一起占内存。
   * 收掉只是丢运行时，排查本身在库里，点回去由 `create()` 重建。
   */
  private trimIdle() {
    let over = this.live.size - this.maxLoaded;
    if (over <= 0) return;
    for (const id of [...this.lru]) {
      if (over <= 0) return;
      const r = this.live.get(id);
      // 当前的、跑着的、忙着的、挂着待办的都不动——理由同 evict
      if (!r || id === this.currentId || r.sessionStatus === 'live' || r.isBusy || r.todoCount > 0) {
        continue;
      }
      this.drop(id);
      over--;
    }
  }

  /**
   * 丢掉运行时。**必须从表里删干净**：留着一个已经收过尾的 runner，
   * 下次点开它会往那个已 ended 的 session 里接着写，库里就此多出一段
   * 「会话结束之后还在产生的步骤」。
   */
  private drop(caseId: string) {
    this.live.get(caseId)?.close();
    this.live.delete(caseId);
    this.lru = this.lru.filter((x) => x !== caseId);
  }
}
