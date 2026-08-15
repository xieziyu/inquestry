/**
 * 给一次调查起个短标题。
 *
 * **问题描述不是标题。** 人写进新建面板的是一段现象描述——几十上百字，常常还带着日志片段
 * 与 traceId。拿它的首行去截，列表、顶栏、导出文件名上得到的就是一句半截话，
 * 而这三处正是要一眼认出「是哪一次调查」的地方。所以标题由 agent 读完问题之后总结，
 * 立案那一刻先落的那句截断值只是个兜底（`titleOf`）。
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

const SYSTEM =
  '你在给一次线上问题的调查起标题。只输出标题本身，不要引号、不要句号、不要任何解释或前后缀。' +
  `标题用中文，${MAX_TITLE} 字以内，写清「哪个系统 / 什么现象」，` +
  '不要写「调查」「排查」「问题」「分析」这类没有信息量的词，也不要编造描述里没有的服务名或结论。';

/**
 * 起标题。**取的是模型输出的第一行**：说了要只给标题它多半就只给标题，
 * 但偶尔会自己补一句说明，那时第一行仍然是对的。
 */
export async function proposeCaseTitle(question: string, model = 'haiku'): Promise<string | null> {
  const text = question.trim();
  if (!text) return null;
  try {
    const q = query({
      prompt: `给下面这段排查请求起一个标题：\n\n${text}`,
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
      return clean(out);
    } finally {
      clearTimeout(timer);
      q.close();
    }
  } catch (err) {
    console.error('[main] 起标题失败，沿用截断的兜底标题', err);
    return null;
  }
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
