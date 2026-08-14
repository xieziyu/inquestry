# Inquestry

线上问题排查小助手，Electron + React + better-sqlite3，单人自用。一句话定位：harness 完整留存每次工具调用的原始输入输出，agent 的文字只做索引和判断，不承担搬运证据的职责。

**动手前先读 [`docs/design/overview.md`](docs/design/overview.md)**：它是决策的来源（含决策清单），拆出的几份只做展开。别在这儿复述它们已经写过的东西。

---

## 文档纪律

**默认不动 `docs/`。** 一轮开发的产物是代码和它的注释；文档只收决策。

### 一条判断落在哪

先写进**离它最近的代码注释**。只有当下面这句为真时，才升到 `docs/`：

> 不知道这条的人，会不会**重新提议一个已经否决过的做法**，或者**悄悄改坏一个不会报错的东西**？

两种典型：

- **否决过的路。** 写清「选了什么 + 否决了什么 + 代价」。只写结论，下一个人只会把否决过的那条重新推一遍。
- **跨文件的契约。** 一处改了另一处必须跟着改，而对不上时没有任何报错（CSS 没有语法检查，两处各管一段的约束也不会红）。写的时候要指名另一处在哪。

不满足就留在注释里。**不确定的时候留在注释里**——注释跟着代码走，文档不会。

### 明确不写进文档的

- 某个类 / 函数 / 样式当前长什么样，或它现在有哪些成员
- 实现步骤、这一轮改了哪几个文件、进度和待办
- 会随代码变的数字与条数（`overview.md` 开头那条约定，例外只有设计定死的封闭集）

### 推翻一条已记的决策时

**改那条本身，不要在它旁边加一条新的。** 两条并存的结果是下一个人按旧那条做，而两条都在文档里、都看着像现行的。同理，一轮里同一个意图的反复不要各留一个提交，把它们合成最终那一版。

`docs/design/mockups/` 是冻结件：过时了就在它头上写一句说明，**不要为了让它跟上代码去改它**。

---

## 怎么跑、怎么验

```bash
npm run app        # 跑 app（含无人值守探针）
npm run spike:all  # 跑全套自检
```

**这两条各自把 `better-sqlite3` 的 ABI 切好了，别自己拼 `npx electron-vite preview`。** 忘了切的表现是安静的错答案：app 停在启动失败屏上干等到超时，spike 打出 0 PASS / 0 FAIL（脚本在 import 阶段就崩了，计数看着像全过）。**"跑了很久没输出"先想 ABI，别去怀疑刚改的代码。**

改哪一带先跑哪一条 spike（清单看 `package.json`）。起真会话的那几条靠订阅凭据，过期了要在终端 `claude` 重登。

### 验界面

- **调版面先用 `npm run preview:ui`**（浏览器开 `http://localhost:5178`，`?screen=` 直达某屏）：真组件真 CSS，只换掉 `window.inquestry`，改一行立刻看得到。🔴 **但它没有 main 进程**——落库、重开会话、真导出、模型探测一律不经过，凡是这类判断仍旧只能在真 app 里验。细节与两处"像而不是"看 [`docs/design/ui.md`](docs/design/ui.md) §11。
- 现成的无人值守开关看 [`docs/design/ui.md`](docs/design/ui.md) §11。
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
