/**
 * 读一遍问题描述，定下两件建单那一刻定不了的事：**短标题**与**基准日期**。
 *
 * 两件都由这一趟 spawn 出：它们要的输入完全相同（那段问题描述），而 spawn 一次 CLI
 * 是这条路上唯一贵的一步。
 *
 * **基准日期在这儿而不是让人填**：日志时间串多半只有时分秒，基准决定它们落在哪一天，
 * 而这个信息往往就写在问题里（「昨晚十一点多」）。让人填的代价见 ui.md §8.1；
 * 让 agent 推的代价是它可能推错或不答——所以 harness 那侧另有两道网：
 * 推不出来时沿用建单当天并标成未确认，落证据时再提醒 agent 写全日期。
 *
 * **问题描述不是标题。** 人写进新建面板的是一段现象描述——几十上百字，常常还带着日志片段
 * 与 traceId。拿它的首行去截，列表、顶栏、导出文件名上得到的就是一句半截话，
 * 而这三处正是要一眼认出「是哪一次调查」的地方。所以标题由 agent 读完问题之后总结，
 * 建单那一刻先落的那句截断值只是个兜底（`titleOf`）。
 *
 * 这一次 spawn **与调查会话完全无关**，因此三条纪律：
 *
 * - **不加载磁盘 settings**（`settingSources: []`）。真会话故意加载它们（继承 skill 与 MCP），
 *   代价是项目 `hooks` 加载即执行 shell（ui.md §8.1 那段红字）。起个标题不值得付这个代价，
 *   而且人这时刚点完「新建」，屏幕上没有任何东西说明有进程在跑
 * - **不进那个工作区目录**：cwd 落在临时目录，连带把项目 CLAUDE.md 与 `.mcp.json` 也挡在外面
 * - **不给调查用的那套工具**：系统提示词是自备的一句话，不是 claude_code 预设
 *
 * 失败一律回 null——标题起不出来是件不该有任何后果的事，兜底那句照旧在库里。
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';

/** 标题的字数上限。超了当场截，不指望提示词自觉——它只是个建议，而列宽是硬的。 */
const MAX_TITLE = 24;

/** 探测超时。到点放弃，兜底标题照旧——人这时多半已经在写下一步了。 */
const TIMEOUT_MS = 30_000;

/**
 * 基准日期最多能往回推几天。**不是怕模型算错几天，是怕它把描述里某个无关的日期当成事故日**
 * （粘贴的日志里常带着别的年份，或者「上次 3 月那回」这样的对比）。超出这个范围的推断
 * 一律丢掉、沿用建单当天——错得离谱好过错得像真的。
 */
const MAX_BACKDATE_DAYS = 30;

const SYSTEM =
  '你在读一段线上问题的排查请求，输出两件事。只输出一个 JSON 对象，不要代码块、不要任何解释。\n' +
  `字段 title：这次调查的标题，中文，${MAX_TITLE} 字以内，写清「哪个系统 / 什么现象」，` +
  '不要写「调查」「排查」「问题」「分析」这类没有信息量的词，也不要编造描述里没有的服务名或结论。\n' +
  '字段 incidentDate：这次事故**发生在哪一天**，格式 YYYY-MM-DD。' +
  '只有描述里明确说了日子（含「昨天」「前天」「今早」这类相对说法，按给你的今天换算）才填，' +
  '**说不准就填 null**——不要从日志片段里的时间戳猜，也不要因为想填点什么就填今天。';

/** 推断出来的两件事。哪一件都可能是 null——那一件就沿用建单那一刻的兜底。 */
export type CaseFacts = { title: string | null; incidentDate: string | null };

/**
 * 读一遍问题，给出标题与基准日期。
 *
 * `today` 由调用方传**建单那一天**，不在这里取时钟：换算「昨天」要有个今天，
 * 而这一趟是异步的，它跑起来时可能已经过了午夜。
 */
export async function proposeCaseFacts(
  question: string,
  today: string,
  model = 'haiku',
): Promise<CaseFacts> {
  const none: CaseFacts = { title: null, incidentDate: null };
  const text = question.trim();
  if (!text) return none;
  try {
    const q = query({
      prompt: `今天是 ${today}。读下面这段排查请求：\n\n${text}`,
      options: {
        model,
        settingSources: [],
        cwd: tmpdir(),
        systemPrompt: SYSTEM,
        maxTurns: 1,
        // 起标题不需要任何工具；留着的话模型会去读那段描述里提到的文件，一轮就用光了
        disallowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
      },
    });
    const timer = setTimeout(() => void q.interrupt().catch(() => {}), TIMEOUT_MS);
    try {
      let out = '';
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const content = (msg as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              const t = (b as { type?: string; text?: string }).text;
              if ((b as { type?: string }).type === 'text' && t) out += t;
            }
          }
        }
      }
      return parseFacts(out, today);
    } finally {
      clearTimeout(timer);
      q.close();
    }
  } catch (err) {
    console.error('[main] 读问题失败，标题与基准日期都沿用建单那一刻的兜底', err);
    return none;
  }
}

/**
 * 解析模型那一段。**解析不出来就整个作废**，不去从半截文本里捞标题——
 * 标题捞错了只是难看，基准日期捞错了会让整条时间线静默错位，
 * 而这两件在这里是同一段输出。
 */
export function parseFacts(raw: string, today: string): CaseFacts {
  const none: CaseFacts = { title: null, incidentDate: null };
  // 说了不要代码块它还是会给，而外面那对反引号会让 JSON.parse 直接失败
  const body = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return none;
  let obj: { title?: unknown; incidentDate?: unknown };
  try {
    obj = JSON.parse(body.slice(start, end + 1));
  } catch {
    return none;
  }
  return {
    title: typeof obj.title === 'string' ? clean(obj.title) : null,
    incidentDate: typeof obj.incidentDate === 'string' ? checkDate(obj.incidentDate, today) : null,
  };
}

/**
 * 日期的三道闸：格式、不晚于建单当天、不早于 `MAX_BACKDATE_DAYS`。
 *
 * **未来那一档是最要紧的**：查的是已经发生的事，一个未来的基准日期一定是推错的，
 * 而它落进去之后所有纯时分秒的证据都会排到未来，报告里看着却完全正常。
 */
export function checkDate(raw: string, today: string): string | null {
  const d = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  // 两个都是本地日期串，按同一个时区解析，差值才是天数
  const at = Date.parse(`${d}T00:00:00`);
  const now = Date.parse(`${today}T00:00:00`);
  if (Number.isNaN(at) || Number.isNaN(now)) return null;
  const days = (now - at) / 86_400_000;
  return days >= 0 && days <= MAX_BACKDATE_DAYS ? d : null;
}

/** 模型再听话也会带上引号或书名号，而那两个字符会一路进到导出的文件名里。 */
function clean(raw: string): string | null {
  const first = raw
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return null;
  const stripped = first.replace(/^[「『"'“”‘’《【\[(]+|[」』"'“”‘’》】\])。.!！]+$/g, '').trim();
  if (!stripped) return null;
  return stripped.length > MAX_TITLE ? `${stripped.slice(0, MAX_TITLE)}…` : stripped;
}
