# v0.38 报告 — 天河协议、因果计算、外骨骼与双模接管

> 日期：2026-11-06
> 阶段一：`TIANHE_PROTOCOL.md` · `recursiveCausalChain` · `SELF_HEALING_PROMPT.md`
> 阶段二：`LLMAdapter`/`MessageAdapter`/`ToolFactory` · `adapters/raw/` · `launcher.ts` · `HARNESS_ARCHITECTURE.md`
> 验证：四套 **545 / 263 / 183 / 179** 全绿（快照；memory 的 TD-M8 偶发抖动见 §6.1）· 递归因果 **23/23** · 外骨骼 **51/51** · 裸机自举 **32/32** · 协议自举 **39/39**

---

## 1. 六个交付物，逐条对账

| 你的要求 | 状态 | 证据 |
|---|---|---|
| 一.1 `TIANHE_PROTOCOL.md`（Ticket/Result + NetworkStorageAdapter） | ✅ | 文档 + `src/protocol/network.ts` |
| 一.2 `recursiveCausalChain` 多级回溯（3-5 级、深度限制） | ✅ | `dsh-memory/src/causal.ts`，**23/23** |
| 一.3 `SELF_HEALING_PROMPT.md` | ✅ | 基于 `HOST_CAPABILITY_MISSING` 具名拒绝 |
| 二.1 `LLMAdapter`/`MessageAdapter`/`ToolFactory` + `adapters/raw` fetch | ✅ | `src/protocol/harness.ts` · `src/adapters/raw/{llm,messages,tools}.ts` |
| 二.2 `launcher.ts` 双模接管 | ✅ | `src/launcher.ts`，**51/51** 中含 4 组 launcher 断言 |
| 二.3 `HARNESS_ARCHITECTURE.md` | ✅ | 含**诚实的缺口清单** |

---

## 2. 阶段一：因果计算是真的多级，不是同层重复

### 2.1 第一版只走到 1 级 —— 原因在我的实现和夹具里

```
深度1: 6 节点 / 深度 0
深度3: 9 节点 / 深度 1     ← 卡在这里
深度5: 9 节点 / 深度 1
```

**两个独立的错误叠在一起**：

1. **实现**只跟随 `evidence[0]`，而 experience 的 `evidence` 通常是空的 —— 于是 cause 指向的下一级永远走不到；
2. **夹具**把"更深"理解成"另一个记录"，但数据模型的真实语义是**记录引用会话日志的 seq**，更深一级 = 下一级引用了**另一个 seq**。

修正后：

```
深度1:  6 节点 /  3 边 / 深度 0
深度3: 15 节点 / 23 边 / 深度 3   ← L0:6 L1:5 L2:4
深度5: 15 节点 / 23 边 / 深度 3   ← 链走完即止，不再凭空增长
```

**最后一行是关键**：`maxDepth=5` 与 `maxDepth=3` 结果相同，因为链只有 3 级。一个会随参数无限增长的图是在造节点，不是在回溯。

### 2.2 截断报告的一次真实修复

第一版在**事后**收集 `depth === maxDepth` 的节点来判定截断，结果恒为 0 —— 因为"没有被展开的节点"按定义就不在 `nodes` 里。

改成**在停止展开的那一刻记录**：

```ts
if (item.depth + 1 > maxDepth) {
  if (!truncatedAt.includes(entry.id)) truncatedAt.push(entry.id)
  continue
}
```

实测（`maxDepth=2`）：`truncatedAt=1`，带警告。`maxDepth=3`：`truncatedAt=0` —— **这是正确结果**，链走完了，不该谎报截断。

> **我的断言第一版写成"maxDepth=3 必须有截断"，把"图走完了"当成了"函数坏了"。**
> 这条留在报告里，因为"测试红"有两种，先分清哪一种再改代码是纪律。

### 2.3 给调度器的数据形状

```ts
CausalGraphNode { layer, id, title, relation, depth, via?, pointer?, revisited? }
CausalGraphEdge { from, to, relation }
```

- 节点带 **depth + via** → 调度器知道每一级的来源；
- 边带 **relation** → 可单独取出 `blocker` 边据此拒绝调度；
- 循环标 `revisited` 而不是静默丢弃 → 消费者能区分"图有环"和"没有更多"。

---

## 3. 阶段一：天河协议的两条硬规则

### 3.1 `indeterminate` 是这份协议最重要的值

一个只有 `succeeded` / `failed` 的协议，在"写了一半"时会**被迫撒谎**：说成功是错的，说失败会导致重复执行。承认"我不知道"，是唯一的第三选项。

### 3.2 没有 `idempotencyKey` 的副作用操作，**不予执行**

不是警告，是拒绝。一条无法安全重试的指令，在网络上等价于一条无法投递的指令。

### 3.3 `NetworkStorageAdapter` **扩展**而非替换

本地契约诚实，网络契约需要多说三件事（幂等、来源、版本），但那三件事不应该让本地实现也实现一遍。`guarantees` 的每个字段都是一个**必须能被辩护的声明**——无法提供跨节点互斥的存储必须回答 `compareAndSetScope: 'node'`，而不是假装。

---

## 4. 阶段二：外骨骼与双模接管

### 4.1 三个接口，各自回答一个以前答不了的问题

| 接口 | 回答 | 关键设计 |
|---|---|---|
| `LLMAdapter` | 怎么问模型 | `generate` 是契约，流式**可选**（不让简单调用方被迫写 `for await`） |
| `MessageAdapter` | 上下文放哪 | **纯数组**，不是宿主日志；`compact` 返回**被删的消息** |
| `ToolFactory` | 怎么造工具 | `isolation: 'none'` 是**诚实标记**，不是缺陷 |

### 4.2 `adapters/raw/llm.ts` 的三种出口

| 出口 | 含义 |
|---|---|
| 模型给文本 | 完成 |
| 要调工具 + 有 `executeTool` | 跑工具、回填、再问 |
| 要调工具 + **无** `executeTool` | **原样交回** —— 不吞掉、不假装完成 |

第三种出口是 `GenerationResult` 带 `toolCalls` 的全部理由。

### 4.3 launcher 的四个设计决定

| 决定 | 理由 |
|---|---|
| `failureThreshold` 默认 **2** | 单次慢探针不是故障；因它降级会**模式抖振** |
| `maxRepairAttempts` 默认 **2**（很小） | 同一错误喂两次得同一个修复；**第三次需要新证据，那是人的工作** |
| `UNRESOLVED` 立刻 `gave-up` | 模型说"需要人"，就不该烧完剩余预算 |
| 探针抛异常 = 不健康，不是崩溃 | 会抛异常的探针把"降级"变成"崩溃" |

**修复是一次 `tool define`，不是一次 file patch**：工具是编译、运行、可撤销的，同样的收益，小得多的爆炸半径。

失败被拆成三种不同结果（没输出 / 不编译 / 抛了），因为下一步不同。压成"修复失败"会让循环变瞎。

---

## 5. 我对测试做的一处修改，以及为什么

`test/isolation.test.mjs` 有一条"`src/` 下不允许出现白名单外的顶层文件"的门禁，`launcher.ts` 触发了它。

**我没有绕过它，而是核实后加入白名单，并把承诺变成断言**：

```
launcher.ts 的唯一 import 是 './protocol/index.js'
```

新增一条测试：`launcher.ts` 的任何 import 只要离开 `protocol/` 就失败。理由写进了测试注释：

> 一个"为了监控宿主而 import 宿主"的 supervisor 看起来合理，却摧毁了 supervisor 唯一有用的性质——**在它监控的东西死掉时还能跑**。

这条门禁因此比之前**更严**，不是更松。

---

## 6. 红线复核

| 约束 | 本轮 | 证据 |
|---|---|---|
| 1. 不用 `live.append` / `{turn:0,step:0}` | ✅ | 未触及 |
| 2. 协议接口无 dsh/cordis 字样 | ✅ | `protocol/*.ts` 零匹配；`launcher.ts`/`raw/*` 代码中也零匹配（注释除外，且已逐条核查） |
| 3. 不得因重构改变行为 | ✅ | 四套全绿；`dsh-memory` 的 `causalChain` 签名、返回值、警告文案全未变 |
| 4. 直接 fs / 写死绝对路径 | ✅ | 新代码零绝对路径；`raw/` 只用注入的 `fetchImpl` |
| 5. 只在适配层改，上层插件不动 | ✅ | 唯一插件改动是 `dsh-memory/src/causal.ts` **新增**导出，未改既有函数 |

**第 3 条的具体证据**：`causalChain()` 的 20 个既有调用点和 4 个测试文件全部未改，`recursiveCausalChain` 是**新函数**。测试从 174 → 179 的 5 条增量全部是新增（2 条协议纯度、1 条隔离、2 条来自新模块被扫描）。

### 6.1 一处必须如实说明的抖动（TD-M8，既有问题）

`dsh-memory` 全量跑时，`v0.25 P1: eight PROCESSES entering at once` 仍会**偶发**失败。本轮实测 **8 次跑 · 2 次红**，且**两次都是同一条**：

```
run 1 fail=1 ✖ v0.25 P1: eight PROCESSES entering at once all keep their record
run 6 fail=1 ✖ v0.25 P1: eight PROCESSES entering at once all keep their record
```

**这不是本轮引入的**，理由与上一轮相同且仍然成立：该测试只走 `dsh-memory/lib/store.js`，而本轮**没有修改任何 store 代码**；它隔离运行时稳定通过；失败形态恒为「N 个 worker 全部干净退出，只有 N-1 行」，与 `dsh-memory/ARCHITECTURE.md` 的 **TD-M8「已知并发边界：高负载下的文件系统极限」** 逐字一致。

按你此前的裁决（TD-M8 标记为已知、不再死磕），**我没有动它**，也没有靠加大重试预算把它「调绿」。

> 这就是为什么本轮的报告写的是 **545 / 263 / 183 / 179**（一次全绿的快照），
> 而不是声称"四套永久稳定"。**偶发的红是真实的，藏起来它才是问题。**

---

## 7. 诚实的缺口（不修饰）
| # | 没做到 | 代价 |
|---|---|---|
| 1 | **没有 `harness.js` CLI 入口** | 现在是"零件齐全"，不是"整机可跑" |
| 2 | `graft-slice` / `observer` 未在裸机验证 | 三大插件里只有 `dsh-memory` 完成了裸机验证 |
| 3 | `ToolFactory` **无沙箱** | 模型写的坏代码可以把 Harness 带走 |
| 4 | `compact` 用近似 token 计数 | 预算可能偏 20% |
| 5 | launcher 只在测试里 tick 过 | 没有真实宿主可供 kill，崩溃检测时序未验证 |
| 6 | `NetworkStorageAdapter` **只有类型** | 没有第二台可测机器，传输层是图纸 |

**第 1 条最重要。** 零件齐全与能跑之间，差的往往不是代码量，而是**一个必须做出的形状决定**：裸机上"一个会话"是什么？把它留到下一轮，因为它值得被单独看见，而不是被顺手带过。

---

## 8. 本轮文件清单

| 文件 | 动作 |
|---|---|
| `dsh-paradise/src/protocol/network.ts` | **新建** — `NetworkStorageAdapter` + guarantees + envelope |
| `dsh-paradise/src/protocol/harness.ts` | **新建** — `LLMAdapter` / `MessageAdapter` / `ToolFactory` / `HarnessBundle` |
| `dsh-paradise/src/adapters/raw/{index,llm,messages,tools}.ts` | **新建** — fetch 实现、数组上下文、运行时工具 |
| `dsh-paradise/src/launcher.ts` | **新建** — 四态双模接管 |
| `dsh-paradise/TIANHE_PROTOCOL.md` | **新建** |
| `dsh-paradise/SELF_HEALING_PROMPT.md` | **新建** |
| `dsh-paradise/HARNESS_ARCHITECTURE.md` | **新建** |
| `dsh-memory/src/causal.ts` | **新增** `recursiveCausalChain`（既有函数未改） |
| `dsh-paradise/src/{index,protocol/index}.ts` | 导出新符号 |
| `dsh-paradise/test/isolation.test.mjs` | 白名单 + **1 条新断言**（更严） |
| `_scratch/verify-recursive-causal.mjs` | **新建** — 23 项 |
| `_scratch/verify-exoskeleton.mjs` | **新建** — 51 项 |
