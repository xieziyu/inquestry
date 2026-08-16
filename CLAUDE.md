# Inquestry

线上问题排查小助手，Electron + React + better-sqlite3，单人自用。一句话定位：harness 完整留存每次工具调用的原始输入输出，agent 的文字只做索引和判断，不承担搬运证据的职责。

**动手前先读 [`docs/design/overview.md`](docs/design/overview.md)**：定位、词汇与核心概念。设计与实现细节一律以代码和它旁边的注释为准。发布链路的决策在 [`docs/design/release.md`](docs/design/release.md)。

---

## 文档纪律

**默认不动 `docs/`。** 它只有 `overview.md` 与 `release.md` 两份，只写不随代码变的东西（定位、词汇、核心概念、外部实测的硬约束、发布链路的决策）。一轮开发的产物是代码和它的注释。

一条判断（否决过的路、跨文件契约、写错了不报错的约束）写进**离它最近的代码注释**，不升进文档。别在注释里罗列当前成员、实现步骤、进度待办，也别写会随代码变的数字与条数（例外只有设计定死的封闭集）。

推翻一条已写下的判断时，**改那条本身，不要在旁边加一条新的**——两条并存的结果是下一个人按旧那条做。同理，一轮里同一个意图的反复不要各留一个提交，合成最终那一版。

mockup / 视觉稿是临时读物，只为当场读方案：放 scratchpad 或仓库里用浏览器看，决策落地进代码后即删，**不进版本追踪**（`docs/design/mockups/` 与 `*.mockup.html` 已在 .gitignore 里）。

---

## 怎么跑、怎么验

```bash
npm run dev        # 开发跑 app（HMR）
npm run app        # 跑 app（含无人值守探针）
npm run spike:all  # 跑全套自检
npm run seed       # 往开发库里塞几份假调查，只为了看界面
```

**这几条各自把 `better-sqlite3` 的 ABI 切好了，别自己拼 `npx electron-vite dev/preview` 或 `npx tsx scripts/…`，也别用 `npm start`（它不切）。** 忘了切的表现是安静的错答案：app 停在启动失败屏上干等到超时，spike 打出 0 PASS / 0 FAIL（脚本在 import 阶段就崩了，计数看着像全过）。**"跑了很久没输出"先想 ABI，别去怀疑刚改的代码。**

改哪一带先跑哪一条 spike（清单看 `package.json`）。起真会话的那几条靠订阅凭据，过期了要在终端 `claude` 重登。

### 验界面

- **调版面先用 `npm run preview:ui`**（浏览器开 `http://localhost:5178`，`?screen=` 直达某屏）：真组件真 CSS，只换掉 `window.inquestry`，改一行立刻看得到。🔴 **但它没有 main 进程**——落库、重开会话、真导出、模型探测一律不经过，凡是这类判断仍旧只能在真 app 里验。夹具与直达参数看 `src/renderer/preview/`。
- 现成的无人值守开关（`INQUESTRY_AUTOSTART` / `INQUESTRY_SHOT` / `INQUESTRY_EXPORT_*` 等）的用法看 `src/main/index.ts` 里那段自检。
- 🔴 **`screencapture` 在这台机器上被 TCC 挡成全黑图，别拿它验 UI。** 可靠的做法是 `npx electron . --user-data-dir=<临时目录> --remote-debugging-port=9222`，再用 node 内置 `WebSocket` 走 CDP：`Runtime.evaluate` 读 DOM 与 `getComputedStyle`、`Page.captureScreenshot` 拍图。**读 computed style 与 `getBoundingClientRect` 比看图靠谱**，而且能写成会失败的断言。
- 🔴 **走 CDP 前先确认 9222 是自己那一份**：旧实例没死会占着端口，新起的那个只在自己日志里报 `Address already in use`，而 CDP 照常连得上——连的是旧窗口。表现是"改完重启，界面一点没变"，而代码是对的。`pkill -f` 要按完整路径匹配。**每次截图前先读一句 DOM 核对这是哪一屏。**
- 🔴 **验"重启后还在"必须真重启 app**，刷新 renderer 什么都证明不了——状态活在 runner 里。
- ⚠️ 窗口未获焦点时 `capturePage()` 会返回过期帧，`scrollIntoView({behavior:'smooth'})` 与 `ResizeObserver` 一次都不跑。**这个 app 的验证环境天然不获焦点，凡是依赖帧的东西在那儿验不出来。**

### 检查写完了要问一句

**退回旧写法能 FAIL，只证明检查非空，不证明它验的是对的事。** 给一条自己推出来的规则补检查时，额外问：这条规则本身是谁定的？空检查的三个成因——夹具里没有能触发那个 bug 的数据、检查走的路径和修的那条不是同一条、同一个约束由两处各管一段而只验了一处。

renderer 的状态没有 node 侧的回归网：能提成纯函数的就提出来进 spike，其余用临时探针在真 app 里驱动，**验完把探针删干净**。

---

## 版本控制

用 GitButler（`but`），不用 git 的写命令。`git status` 的输出说明不了有没有活，只有 `but status` 算数。一个 session 一条分支，提交信息用 `type(scope): description` 且**一律英文**。不主动 push、不主动开 PR。
