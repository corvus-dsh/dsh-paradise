# PARADISE SPEC — 接入一个新 LLM Harness 需要做什么

> 版本：v0.2.0 · 日期：2026-11-05 · 适用包：`dsh-paradise`
> 读者：要么是一个准备接入新宿主的开发者，要么是**一个拿着报错日志、准备自修复的 AI**。
> 本文档是那份"唯一说明书"：只读这一份，应能完成接入。

---

## 0. 三十秒版本

你要实现**三个适配器**，放进 `src/adapters/<你的宿主名>/`：

| 适配器 | 回答什么问题 | 必需？ |
|---|---|---|
| `SessionAdapter` | 怎么造会话、塞内容、点火、读日志、监听 | **必需** |
| `StorageAdapter` | 怎么把小状态原子地落盘 | **必需** |
| `ToolAdapter` | 怎么执行工具 | 可选 |

然后让 `test/conformance.test.mjs` 通过。**不要改 `src/protocol/`，也不要改上层业务。**

---

## 1. 三层结构，以及为什么这么切

```
src/protocol/        ← 契约。不含任何宿主字样。有测试机械强制。
src/adapters/<host>/ ← 宿主的全部特性：服务名、目录布局、渲染规则、消息形状。
src/read/            ← 宿主中立的读取器。接受路径或"给我路径"的回调，永不知晓布局。
```

判定一条代码该放哪层的唯一问题：

> **换一个完全不同的宿主，这段代码还有意义吗？**
>
> 有 → `protocol/` 或 `read/`。答案需要一段"其实在另一个宿主上不一样"的解释 → `adapters/<host>/`。

这条线是被**机器**守着的，不是靠自觉：

- `test/protocol-purity.test.mjs` 扫描 `src/protocol/`，出现宿主名或宿主概念（后者更阴险：`surfaceOp`、turn/step、服务名）就**让测试失败**，注释也算；
- `scripts/preflight.mjs` 在**产物**里再扫一遍协议区，因为源码干净不等于打包后干净。

---

## 2. `SessionAdapter` — 五个动词

```ts
interface SessionAdapter {
  readonly name: string
  readonly capabilities: SessionCapabilities
  create(input: { cwd: string; title?: string; id?: string }): Promise<MutationReceipt & { session?: SessionRef }>
  inject(session: SessionRef, items: ContextItem[]): Promise<MutationReceipt & { rendered: RenderedItem[] }>
  trigger(session: SessionRef, trigger: TurnTrigger): Promise<MutationReceipt>
  readLog(session: SessionRef): Promise<LogReading>
  subscribe(session: SessionRef, listener: (event: SessionEvent) => void): Unsubscribe
}
```

### 五条硬性要求（每条都有事故背景）

**2.1 `cwd` 必须绝对，且必须由调用方给出。**
协议**无法表达**"帮我猜一个工作目录"。空字符串 → `WORKSPACE_REQUIRED`；相对路径 → `WORKSPACE_RELATIVE`。
背景：一次摄入没有归属的会话，落到"选择工作区"的草稿页，用户再也找不到它。"归属靠猜"是本生态最贵的一课。

**2.2 `create` 失败时不得留下半成品。**
背景：一个"看起来能用"的空壳会话，比一次明确的失败更难排查。

**2.3 `inject` 必须逐项回答"到底会不会被显示"。**
`rendered: RenderedItem[]`，每项含 `requested` / `rendered` / `reason`。
**不允许**用一个全局布尔概括。
背景：`developer/message` 被正确写入了，磁盘上有全文，UI 一律不渲染——整整一个版本没人发现。

**2.4 `inject` 必须在会话**空闲**和**运行中**都合法**，或通过 `capabilities` 明说做不到。
背景：向运行中的会话写 step-scoped 事件，需要匹配它**当前打开的**那一对计数器；猜 `{turn:0,step:0}` 曾被整批拒绝。

**2.5 每个变更方法返回**回执**，不是布尔。**
`{ ok, stage, warnings, error? }`，**成功也带 `stage`**。
背景：每个事故的第一个问题都是"它走到哪一步了？"。`true` 回答不了。

### `capabilities` 必须诚实

```ts
interface SessionCapabilities {
  create: boolean
  injectIntoIdle: boolean
  injectIntoRunning: boolean
  trigger: boolean
  readLog: boolean
  subscribe: boolean
  verifyDeletion: boolean
  unavailable: Array<{ capability: string; consequence: string }>
}
```

做不到的动词，调它必须返回**失败**（带 `code` 和 `stage`），**绝不能**返回一个安静的 `ok: true`。
参考实现：`src/adapters/dsh/session.ts` 对未接线的写动词返回 `NOT_WIRED` 并写明属于 P2。

**这是本规范最重要的一条。** 一个"假装能创建会话"的适配器，会让上层在第七步才发现问题，而那时产物已经产生了一半。

### `readLog` 永不抛

```ts
{ readable: false, pathSource: 'unavailable', notes: ['…为什么…'], ... }
```
"读不到"与"不存在"是两件事，必须能区分。
背景：早期版本把"文件根本没打开"打印成"没有找到承载方案的消息"，回答了一个它并没有问过的问题。

### `subscribe` 无事件总线时

返回一个**空操作的 unsubscribe**，并在 `capabilities.subscribe = false` 说明。不要抛异常。

---

## 3. `StorageAdapter` — 四个方法，故意很小

```ts
interface StorageAdapter {
  readonly name: string
  read(key: string): Promise<unknown>          // undefined = 未存；null = 存了 null。两者不同。
  write(key: string, value: unknown): Promise<MutationReceipt>   // 必须原子
  remove(key: string): Promise<MutationReceipt>                  // 必须幂等
  keys(prefix?: string): Promise<string[]>
}
```

**接受 KEY，不接受路径。** 调用方不该能指定绝对路径——那立刻就会写到自己的命名空间之外，这是插件互相污染的起点。

**原子性是唯一重要的性质。** 临时文件 + rename。本宿主被中途杀掉过；一张撕裂的绑定表就是"配对凭空消失"。

---

## 4. `ToolAdapter` — 两个方法

```ts
interface ToolAdapter {
  readonly name: string
  list(): Promise<ToolDescriptor[]>
  execute(input: { name: string; arguments: Record<string, unknown>; timeoutMs?: number }): Promise<ToolOutcome>
}
```

**未知工具是 `isError: true` 的**结果**，不是抛出的异常。**
调用方通常是代表模型行动的插件，它必须能在同一句话里说"工具失败了"和"整个操作成功了"。
异常会把这两件事糊成一件，并丢掉工具自己的错误消息。

`list()` 拿不到目录时返回空数组并在文档里说明——空数组意味着"这个宿主不告诉我"，不是"没有工具"。

---

## 5. 接入清单（照着做）

```
1.  mkdir src/adapters/<host>/
2.  写 session.ts  → createSessionAdapter(ctx): SessionAdapter
3.  写 storage.ts  → createStorageAdapter(ctx, config): StorageAdapter
4.  写 tools.ts    → createToolAdapter(ctx): ToolAdapter   （宿主有工具系统才需要）
5.  写 index.ts    → create<Host>Adapters(ctx)，把三者装成一个 bundle
6.  写 policy.ts   → 该宿主的形状常量（见 §6）
7.  写 paths.ts    → 该宿主的日志路径推导（若有）
8.  让 test/conformance.test.mjs 通过
9.  在 manifest/文档里登记这个适配器
```

**不要做的事**：不要改 `src/protocol/`，不要改 `src/read/`，不要为了"顺手"改上层插件。

---

## 6. `policy.ts` — 宿主的形状常量

这些**必须**在 `adapters/<host>/` 里，因为它们是一条宿主事实：

| 常量 | 含义 | 本项目宿主的取值 |
|---|---|---|
| `RENDERED_CONVERSATION_TYPES` | 会话视图会渲染哪些消息类型 | `['user/message', 'assistant/message']`（实测） |
| `MESSAGE_TYPE_FOR_INTENT` | `visible` / `context-only` 各自写成什么类型 | `user/message` / `developer/message` |
| `PLUGIN_SOURCE_PREFIX` | 插件来源标记前缀 | `plugin:` |
| `SESSION_LOG_FILENAME` | 持久日志文件名 | `session.v4.jsonl.zstd` |
| `isRenderedByConversation(type)` | 单个类型是否会被渲染 | 查上表 |

⚠️ **`RENDERED_CONVERSATION_TYPES` 只用于报告，不用于决定写什么。**
写什么由调用方的**意图**决定（`visibility`），不由探测结果决定。宿主一改投影它就会过期，那时你会希望自己的写入逻辑没依赖它。

---

## 7. 自修复协议（给 AI 的操作手册）

> 目标：宿主升级到新版本，**只改 `adapters/<host>/`，不碰上层业务**。

### 7.1 触发条件

你拿到的是：一份**报错日志** + 一份**新宿主的版本号**。典型症状：

- `capabilities` 探测结果与上一版不同；
- `readDiskEvents` 返回 `readable: false`，但文件确实存在；
- 某个动词突然返回 `NOT_WIRED` / 新的 `code`；
- 上层插件第一次出现"能写入但看不见"。

### 7.2 定位流程

```
1. 跑 `node scripts/preflight.mjs`
   → 若协议区检查失败：有人把宿主字样写进了 protocol/。回退那处改动，不要"将就"。
   → 若产物与源码不一致：先 build。

2. 跑 `node --test test/conformance.test.mjs`
   → 失败 → 契约被破坏了。看是哪个动词，回到 §2 逐条核对。
   → 全绿 → 契约没坏，是宿主行为变了。继续。

3. 跑 `node --test test/*.test.mjs`（本包）
   → 失败在 `disk.test.mjs` / `session-dir.test.mjs` / `host-contract.test.mjs`
     → 大概率是 adapters/<host>/ 的常量或布局过期。改那一处。

4. 用报错日志里的具体数值对拍
   → 路径不对：改 paths.ts（转义规则？目录层级？文件名？）
   → 渲染判断错：改 policy.ts 的 RENDERED_CONVERSATION_TYPES
   → 某个动词报 code：改对应文件，并在 capabilities 里同步它
```

### 7.3 修改边界（硬约束）

| 允许改 | 禁止改 |
|---|---|
| `src/adapters/<host>/**` | `src/protocol/**` |
| 该宿主的 `manifest`/`policy`/`paths` | `src/read/**` |
| 该宿主的 conformance 例外说明 | 上层插件（graft / observer / memory） |

**如果修复需要改 `src/protocol/`，那不是宿主升级，是协议设计有缺陷。**
那要走一次协议变更：改契约 → 改所有适配器 → 提升 major 版本。不要偷偷在适配器里塞特例。

### 7.4 修复完成后必须做的

```
1. node scripts/build.mjs && node scripts/preflight.mjs
2. node --test test/*.test.mjs        项目内全绿
3. 通知上层：capabilities 里哪一项变了
```

第 3 步不能省。上层的降级决策依赖 `capabilities`，它变了而不说，等于让上层按旧地图开车。

---

## 8. 现状：哪些是真的，哪些还没

| 能力 | 状态 |
|---|---|
| 协议定义（三适配器） | ✅ 完成，有纯净性测试 |
| 无宿主参考实现（`adapters/memory`） | ✅ 完成，conformance 每次都跑它 |
| 宿主适配器 `readLog` / `subscribe` | ✅ 真实接线 |
| 宿主适配器 `create` / `inject` / `trigger` / `verifyDeletion` | ⛔ `NOT_WIRED`，属于 P2 |
| `StorageAdapter` 宿主实现 | ✅ 原子写、key 校验 |
| `ToolAdapter` 宿主实现 | ✅ 超时、错误即结果 |
| 上层插件改用适配器 | ⛔ 未开始（`graft` / `observer` 仍直接调宿主服务） |

**这个表必须保持准确。** 一个把 ⛔ 写成 ✅ 的表格，就是本规范 §2.5 禁止的那种假成功，只不过发生在文档里。

---

## 9. 为什么这些规则值得遵守（证据）

| 规则 | 它防的事故 |
|---|---|
| 协议不得含宿主字样 | 两份实现已经在七处漂移，四处是真实事故（草案 §1.2） |
| `cwd` 必须显式绝对 | 会话落到无归属草稿页，用户找不到 |
| 逐项报告 `rendered` | 写成功、渲染为零，整整一版无人发现 |
| 回执带 `stage` | 每个事故的第一个问题都是"走到哪一步了" |
| 未接线必须报错 | 假成功比失败难查一个数量级 |
| 读不到 ≠ 不存在 | 打印"没找到"而其实从未打开文件 |
| 按将被调用的方法解析服务 | 按 `rename` 挑却调 `create`，症状读起来像"服务缺失" |
| 删除必须核实 | 一边敢说"删了"，一边只能说"接口调过" |

---

## 10. 一句话总结

> **协议只描述"任何宿主都得会做的事"。**
> **适配器只装"这个宿主怎么做这件事"。**
>
> 二者之间那条线，由测试守着。
