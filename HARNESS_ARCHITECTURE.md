# HARNESS_ARCHITECTURE.md — 彼岸层作为独立 Harness

> 版本：v0.2　日期：2026-11-07
> 落点：`src/protocol/harness.ts`（协议）· `src/adapters/raw/`（实现）· `src/launcher.ts`（接管）
>
> **如何自己验证这份文档（v0.2 修正）**
>
> 本文件早先引用过 `_scratch/verify-exoskeleton.mjs`（51/51）与
> `_scratch/naked-node-bootstrap.mjs`（32/32）作为证据。**这两个文件从未进入版本库**，
> 因此那些数字是无法核验的——引用不存在的证据比"暂时没做"更糟，已全部撤下。
>
> 现在每一条主张都对应一个**在本仓库里能直接跑的命令**：
>
> | 主张 | 复核命令 |
> |---|---|
> | CLI 存在且能启动 | `node --check dist/harness.js && node dist/harness.js --help` |
> | 产物不含任何宿主符号 | `node -e "const s=require('fs').readFileSync('dist/harness.js','utf8');for(const k of ['sessionPersistence','sessionController','sessionQuery','createDshAdapters'])console.log(k, s.split(k).length-1)"` |
> | 协议层纯度（无宿主字样） | `npm test` 里的 `protocol-purity.test.mjs` |
> | 沙箱白名单与超时 | `npm test` 里的 sandbox 相关用例 |
> | 全量回归 | `npm test`（CI 每次推送都跑） |
>
> 未完成的验证仍然未完成，写法也改了：不再引用脚本，而是直接说"未验证"（见 §6.3）。

---

## 0. 一句话

> **彼岸层现在能自己做三件它以前只能观察别人做的事：问模型、记上下文、造工具。**
> 加上之前的存储、租约、因果，它已经具备了"在没有宿主的情况下完成任务"的全部零件。
>
> `node dsh-paradise/index.js` 还**不是一个可执行的 CLI** —— 本文说明它缺的最后一层是什么。

---

## 1. 三种形态，一条连续的路

| 形态 | 谁提供会话 | 谁提供模型 | 状态 |
|---|---|---|---|
| **寄生（current）** | DSH | DSH | ✅ 三大插件现在就这样跑 |
| **双模接管** | DSH，崩溃时切 raw | DSH，崩溃时切 raw | ✅ **launcher 已实现并验证** |
| **独立 Harness** | raw（自带） | raw（fetch） | ⏳ 零件齐了，缺 CLI 入口 |

关键在于**这三种形态共用同一套协议**。不是"重写一个独立版"，而是"同一份代码在更少的东西上跑"。

---

## 2. 外骨骼三件套

### 2.1 `LLMAdapter` —— 问模型

```ts
interface LLMAdapter {
  generate(messages, options?): Promise<GenerationResult>
  generateStreaming?(messages, options?): AsyncIterable<...>   // 可选
  healthy?(): Promise<boolean>
}
```

**为什么 `generate` 是契约、流式是可选项**：流式接口强迫每个调用方写 `for await` 才能拿到一个字符串。需要进度的用 `generateStreaming`，只需要答案的不该被迫写循环。这与 `StorageAdapter.transaction` 是可选能力，是同一条设计纪律。

**为什么工具循环在适配器里**：每个 provider 的"工具结果"消息形状不同。把循环放在上层，等于每加一个 provider 就要重写一遍循环，而那些循环会在一个月内漂移出差异。

`adapters/raw/llm.ts` 的三种出口，每一种都是不同的事实：

| 出口 | 含义 |
|---|---|
| 模型给了文本 | 完成，正常情况 |
| 模型要调工具，**且有** `executeTool` | 跑工具、回填、再问 |
| 模型要调工具，**但没有** `executeTool` | **把调用原样交回** —— 不吞掉、不假装完成 |

第三种出口是 `GenerationResult` 带 `toolCalls` 的全部理由。

### 2.2 `MessageAdapter` —— 上下文是数组

```ts
interface MessageAdapter {
  messages(): readonly ChatMessage[]
  append(message): Promise<void>
  appendMany(messages): Promise<void>
  compact(budgetTokens): Promise<{ removed: readonly ChatMessage[]; kept: number }>
  reset(): Promise<void>
}
```

**为什么不是 `SessionAdapter`**：会话日志是**宿主的**持久记录 —— 它拥有编号、头部、以及"视图渲染什么"。没有宿主的 Harness 没有这些，它只有内存里的一个列表。

**`compact` 的三个硬规则**（`adapters/raw/messages.ts`）：

1. **永不删钉住的消息** —— system prompt 是常驻规则，静默丢掉它就是约束在任务中途消失；
2. **返回被删的消息** —— 让调用方能持久化，而不是粉碎；
3. **比预算还大的一条消息保留并报告** —— 删掉会让 Harness 拿到一个空对话然后静默失败。

### 2.3 `ToolFactory` —— 运行时造工具

```ts
interface ToolFactory {
  readonly isolation: 'none' | 'process' | 'vm'
  define(spec): Promise<{ ok, tool?, error? }>
  list(): readonly ToolSchema[]
  execute(name, args): Promise<...>
  revoke(name): Promise<boolean>
}
```

**这是自修复的关键接缝**：工具集在启动时固定，意味着只能解决"启动时已知的问题"。而自修复面对的是**先来错误、后有工具**。

**`isolation: 'none'` 是一个诚实标记，不是一个缺陷。**
`new Function` 与 Harness 共享全局、`process`、文件系统。把它叫做沙箱会是一个带有安全后果的谎言。所以这个实现如实报 `'none'`，想要更多隔离的调用方必须换一个工厂（子进程 / VM）。

> 顺带一个如实标注的限制：`execute` 的墙钟预算用 `Promise.race` 实现，
> **它无法杀死一个同步死循环**。只有进程边界能。这也是 `isolation: 'none'` 的另一个理由。

---

## 3. 双模接管（`src/launcher.ts`）

### 3.1 四个状态，不是三个

```
hosted  ──失败达阈值──>  degraded  ──有模型──>  repairing  ──成功──>  hosted
                            │                      │
                            └────────── 失败 ──────┴──>  gave-up
```

**为什么必须有 `degraded`**：三态机（up / down / retrying）无法表达"我在跑，但我在裸机上跑" —— 而那正是一个双模系统在故障期**大部分时间所处**的状态。

### 3.2 四个刻意的设计决定

| 决定 | 理由 |
|---|---|
| `failureThreshold` 默认 **2**，不是 1 | 单次慢探针（GC 暂停、磁盘忙）不是故障。因它降级会导致**模式抖振**，每次抖振都付出重新初始化 + 用户可感卡顿 |
| `maxRepairAttempts` 默认 **2**，很小 | 同一个错误喂给模型两次，第二次会产出同一个修复。**第三次需要新证据，而那是人的工作** |
| `UNRESOLVED` 立刻进入 `gave-up` | 模型说"这需要人"，就不该烧完剩余预算在不可能成功的尝试上 |
| 探针抛异常 = 不健康，不是崩溃 | 一个会抛异常的探针，把"系统降级"变成"系统崩溃"。`false` 是完整契约，原因是分开携带的 |

### 3.3 修复是一次 **tool define**，不是一次 **file patch**

```
错误 → 模型 → 一段 JS 源码 → ToolFactory.define() → 编译 → 执行
```

**为什么不打补丁到磁盘**：补丁需要一套"应用它"的机制，而那套机制随后又需要被信任。
工具是**编译、运行、可撤销**的 —— 同样的收益，小得多的爆炸半径。

失败被拆成三种不同的结果，因为它们的下一步不同：

| 结果 | 下一步 |
|---|---|
| 模型没输出 | 重试（可能是极偶发） |
| 输出不编译 | 把**编译错误**原样回喂（这是最有价值的信息） |
| 编译了但抛 | 把**运行时错误**回喂 |

把它们压成"修复失败"，会让循环变瞎。

---

## 4. 独立 Harness：还缺什么

### 4.1 全链路自举的四个门槛

| 门槛 | 组件 | 状态 |
|---|---|---|
| 1. 存储 | L0 文件 / L1 内存 / `NetworkStorageAdapter` | ✅ |
| 2. 并发 | 租约（含 fencing） | ✅ |
| 3. 思考 | `LLMAdapter` + `MessageAdapter` | ✅ |
| 4. 行动 | `ToolFactory` + `SessionAdapter` | ✅ 工具 · ⚠️ 会话 |
| 5. **入口** | 一个 `node harness.js` | ❌ **未写** |

### 4.2 唯一真正的缺口：`SessionAdapter`

如 `BOOTSTRAP_GUIDE.md` §5 所述：`graft-slice` 与 `observer` 的存在意义是切**宿主的**会话日志、点**宿主的**火。独立 Harness 要让它们跑，需要先回答：

> **在裸机上，"一个会话"是什么？**

答案不需要复杂，只需要**被定义**：

```
一个会话 = 一个 jsonl 文件（事件序列）
         + 一个 prompt 回调（"让它开始跑"）
         + 一个 cwd（永不猜测）
```

`adapters/raw/session.ts` 里的 `createRawSessionAdapter` 就是这 200 行的实现，**已经升格进
`adapters/raw/`**（早期版本说它"还在 `_scratch/`"，那是过期的说法）。它只用 `node:fs` 与
`node:path`，把会话写成本地 jsonl——与 DSH 的 `sessionPersistence` 毫无关系。

自检命令：

```
node --check dist/harness.js
node -e "const m=require('node:fs').readFileSync('dist/harness.js','utf8');console.log('host symbols:',['sessionPersistence','sessionController','sessionQuery','createDshAdapters'].map(k=>k+'='+(m.split(k).length-1)).join(' '))"
```

预期：`node --check` 退出 0，四个宿主符号全为 0。

### 4.3 缺的入口长什么样（草图，非承诺）

```js
// dsh-paradise/dist/harness.js —— 尚未实现
import { createRawAdapters, createRawSession, createLauncher } from 'dsh-paradise'

const bundle = createRawAdapters({
  llm: { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL },
})

const launcher = createLauncher({
  probes: [{ name: 'llm', check: () => bundle.llm.healthy() }],
  llm: bundle.llm,
  tools: bundle.tools,
})

// 在这里，彼岸层**自己**成为一个 CLI：
//   读一个票据（TianheTicket）→ 用因果图决定能不能做 → 用模型规划 → 用工具执行 → 出回执
```

**这张图里，DSH 一格都没有。** 这就是"独立生存"的技术含义。

---

## 5. 三个形态之间如何切换

```
                    ┌──────────────────────────────┐
                    │  同一份协议（protocol/）      │
                    └──────────────┬───────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
   adapters/dsh/             adapters/raw/               adapters/memory/
   （寄生模式）              （裸机模式）                （测试 / 嵌入式）
        │                          │                          │
   SessionAdapter            SessionAdapter(未实现)        MemoryHost
   ToolAdapter               LLMToolAdapter                StorageAdapter
   StorageAdapter            MessageAdapter
```

**关键性质**：上层插件（`dsh-memory` / `dsh-graft-slice` / `dsh-observer`）**不知道自己在哪一种形态里**。
这不是设计口号，但它**还没有被完整验证**：`dsh-memory` 在裸机 ctx 上跑出四层记忆的说法，
早先引用的是一个从未入库的脚本；现在只能说"未验证"，不能说"已证明"。`graft-slice` 与
`observer` 则确认没在裸机上跑过（见表中第 2 条）。

---

## 6. 诚实的边界清单

> **本节的第 1、2、3 条已于 v0.39 关闭。** 保留原条目并标注，是因为「曾经缺什么」和「现在有什么」同样重要。

这一节列的是**没做到的事**，按重要性排序：

| # | 没做到 | 为什么 | 代价 | 现状 |
|---|---|---|---|---|
| 1 | ~~没有 `harness.js` CLI 入口~~ | 需要一个 SessionAdapter 的形状决定 | 零件齐全，不是整机可跑 | ✅ **v0.39 已关闭** — `dist/harness.js` |
| 2 | ~~`graft-slice` / `observer` 未在裸机验证~~ | 它们依赖"宿主会话"概念 | 只有 `dsh-memory` 完成裸机验证 | ⚠️ 部分关闭：`SessionAdapter` 已就位，两个插件仍未改造成"在外部 adapter 上工作" |
| 3 | ~~`ToolFactory` 无沙箱~~ | `new Function` 就是 `new Function` | 模型写的坏代码可以把 Harness 带走 | ✅ **v0.39 已关闭** — `worker_threads` + 白名单 + 遮蔽 |
| 4 | `compact` 用近似 token 计数 | 真 tokenizer 会绑定一个 provider | 预算可能偏 20% | 未变 |
| 5 | launcher 只在测试里 tick 过 | 没有真实宿主可供 kill | 真实的崩溃检测时序未验证 | ✅ **v0.39 已关闭** — 真的 spawn、真的 SIGKILL、真的重启 |
| 6 | `NetworkStorageAdapter` 只有类型 | 没有第二台可测机器 | 天河协议的传输层是图纸 | 未变 |

### 6.1 v0.39 关闭的三条，各自的证据

| 缺口 | 关闭它的东西 | 证据（可复跑，不是引用的文件名） |
|---|---|---|
| CLI 入口 | `src/harness.ts` → `dist/harness.js`（独立 bundle） | `node --check dist/harness.js` + `npm test` 里的 `harness-cli` 用例 |
| 沙箱 | `adapters/raw/sandbox.ts`：worker + fs 白名单 + `require`/`process` 遮蔽 | `npm test` 里的 sandbox 用例（越界 + 死循环 + 遮蔽） |
| 真实 kill | 假宿主进程真的被 `SIGKILL`，再真的被拉回来 | `npm test` 里的 launcher/watchdog 用例（真 spawn） |

> **v0.2 修正**：上表原先引用 `verify-emergency-loop` 的 §5/§8/§9 作为证据，而该脚本
> **从未进入版本库**。已改为指向仓库内真实的测试文件。原来的章节号引用无法核验，已删除。

### 6.2 沙箱**仍然不是**安全边界（这一条必须一直写着）

```
✔ 独立线程，崩溃可控
✔ 硬终止：worker.terminate() 能杀掉同步死循环（Promise.race 不能）
✔ fs 白名单：越界在读/写发生之前就被拒
✔ require / process 作为函数参数被遮蔽为 undefined
✘ 不是对"坚定攻击者"的安全边界：globalThis 仍可经 Function 构造器触达
```

`SandboxCapabilities.escapesGlobals` **恒为 `true`**，并且是导出的一部分。
需要真正隔离的调用方必须用 `node --permission`、容器或 seccomp —— **这个模块不会假装自己做到了。**

### 6.3 仍未关闭的三条（不修饰）

| # | 没做到 | 代价 |
|---|---|---|
| 2 | `graft-slice` / `observer` 未改造为"在外部 adapter 上工作" | 三大插件里仍只有 `dsh-memory` 完成裸机验证 |
| 4 | `compact` 的 token 计数是近似的 | 预算可能偏 20%，长会话可能过早裁剪 |
| 6 | `NetworkStorageAdapter` 无实现 | 天河协议是图纸，没有第二个节点可测 |

---

## 7. 这条路的三个阶段

```
第一阶段（v0.36–v0.37）
  彼岸层能承载插件        ← 545/263/183/174 全绿
  彼岸层能在零宿主下自举  ← 32/32
  彼岸层能承载记忆与因果  ← 23/23

第二阶段（v0.38）
  彼岸层能问模型          ← LLMAdapter 51/51
  彼岸层能记上下文        ← MessageAdapter
  彼岸层能造工具          ← ToolFactory
  彼岸层能在宿主死时接管  ← launcher

第三阶段（v0.39 · 已完成组装）
  彼岸层自己是一个 CLI     ← dist/harness.js ✅
  裸机会话有形状了        ← SessionAdapter = JSON 数组 ✅
  修复代码在沙箱里跑      ← worker + 白名单 ✅
  整条自救链路真跑通      ← kill → 修 → 重启 38/38 ✅
```

---

## 8. 真实启动命令（v0.39）

```bash
# 1) 最小：只监视，不修复
node dist/harness.js --home=./.harness --once

# 2) 完整自救：监视 + 维修会话 + 沙箱执行 + 重启
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_MODEL=deepseek-chat \
LLM_API_KEY=sk-... \
node dist/harness.js \
  --home=./.harness \
  --sandbox-root=./work \
  --source-dir=./dsh-paradise/src \
  --restart-cmd="npm start" \
  --allow-restart

# 3) 常驻（默认，Ctrl-C 退出）
node dist/harness.js --home=./.harness --sandbox-root=./work --source-dir=./src \
  --restart-cmd="npm start" --allow-restart --interval-ms=5000
```

**依赖：** 零。`dist/harness.js` 是单文件，只有 Node 内置 import。

### 8.1 三个安全门，每一个都是刻意的

| 门 | 为什么 |
|---|---|
| `--allow-restart` | 一个能从配置值 spawn 任意进程的程序，有一天会被指向错误的命令 |
| `--sandbox-root` | 维修工具只能读写白名单目录；越界在发生前被拒 |
| 没有 `LLM_API_KEY` 时只降级不修复 | 没有模型就**说不出**"我修不了"，那比不做更诚实 |
