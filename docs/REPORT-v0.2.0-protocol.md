# v0.2.0 报告 — Paradise Protocol（彼岸标准协议）

> 日期：2026-11-05
> 版本：`dsh-paradise 0.2.0`（测试 51 → **90**）· `dsh-observer 1.8.0`（**208** 不变）
> 结论：**协议层已定义并被机械守住；宿主特性全部收进 `adapters/dsh/`；一个无宿主实现每次运行都证明协议可实现。**
> 构建两包 `build` + `preflight` 全绿，产物字节可复现。

---

## 0. 先回答"P1 完成了吗"

你要求「请先完成 P1（disk-log 抽离），然后立刻开始进行 Interface 的定义」。

P1 在**上一轮**已交付并验收：`disk-log.ts` 物理删除、迁入 `src/read/disk.ts`、observer 接入、
51 条测试。本轮已在它的基础上直接进入接口定义，没有重复劳动。

---

## 1. 四步逐条对照

| 你的要求 | 落地 | 可核验处 |
|---|---|---|
| 一.1 `SessionAdapter`：创建/注入/点火/监听/读日志 | `src/protocol/adapters.ts`，五动词 | `conformance.test.mjs` 逐动词 |
| 一.1 `StorageAdapter`：配置读写、状态落盘 | 同上，四方法（read/write/remove/keys） | 同上 |
| 一.1 `ToolAdapter`：执行工具、获取列表 | 同上，list/execute | 同上 |
| 一.2 **不得出现 dsh/cordis 字样或特性** | `protocol/` 零宿主字样；**源码 + 产物双检** | `protocol-purity.test.mjs`（8 条）+ `preflight` 第 5 项 |
| 二.2 宿主特有逻辑收敛进 `adapters/dsh/` | 服务名/布局/渲染规则/消息形状**全部迁入** | `isolation.test.mjs`（7 条）实测 0 泄漏 |
| 二.1 上层逐步改用适配器 | **未开始**——如实标注，见 §6 | README 对照表 |
| 三.1 `PARADISE_SPEC.md` | 已写，10 节，含接入清单与自修复手册 | 文件本身 |
| 三.2 自修复只改 `adapters/dsh/` | 规范 §7 给了操作流程与**硬边界** | 同上 |

---

## 2. 协议长什么样

```ts
interface SessionAdapter {
  readonly name: string
  readonly capabilities: SessionCapabilities
  create(input: { cwd, title?, id? }): Promise<MutationReceipt & { session?: SessionRef }>
  inject(session, items: ContextItem[]): Promise<MutationReceipt & { rendered: RenderedItem[] }>
  trigger(session, trigger: TurnTrigger): Promise<MutationReceipt>
  readLog(session): Promise<LogReading>
  subscribe(session, listener): Unsubscribe
}
interface StorageAdapter { read / write（原子）/ remove（幂等）/ keys(prefix) }
interface ToolAdapter    { list / execute（失败是结果，不是异常） }
```

### 五条硬性要求，每条都有事故背景

| 要求 | 它防的事故 |
|---|---|
| `cwd` 必须绝对且显式 | 会话落到无归属草稿页，用户再也找不到 |
| `create` 失败不留半成品 | "看起来能用"的空壳比明确失败更难查 |
| `inject` 逐项报告 `rendered` | 写对了、磁盘有全文、UI 一律不渲染，一个版本没人发现 |
| `inject` 空闲/运行中都合法或明说做不到 | 猜 `{turn:0,step:0}` 曾被整批拒绝 |
| 回执带 `stage`，成功也带 | 每个事故的第一个问题都是"走到哪一步了" |

**最重要的一条**：做不到的动词必须返回带 `code` + `stage` 的**失败**，绝不能返回安静的 `ok: true`。
`adapters/dsh/session.ts` 对未接线的写动词返回 `NOT_WIRED` 并写明属于 P2 —— 这是模板。

---

## 3. "不能说 dsh" 是怎么被强制住的

一句话不够。所以有两道**机械**闸门：

### 3.1 源码闸门（`protocol-purity.test.mjs`，8 条）

- 扫 `src/protocol/*.ts`，出现 `dsh` / `cordis` 即失败，**注释也算**；
- 更阴险的一类也扫：`surfaceOp`、turn/step、`sessionPersistence`、`sessionController`、
  `sessionQuery`、`workspaceRegistry`、`systemPrompt`、`projectSessionConversation`
  ——**宿主概念**比宿主名字更容易混进来；
- 断言协议只导出三个值（`ProtocolError` / `bindHost` / `isParadiseHost`），杜绝"把某个宿主的写入形状也导出"。

> 这套闸门在开发中当场抓了我自己两次：第一次我把 `dsh` 写进注释解释规则，第二次我在注释里
> 举例写了 "turn/step pairs"。两次都被它打回。**规则能自证，是因为它不认作者。**

### 3.2 产物闸门（`preflight.mjs` 第 5 项）

源码干净 ≠ 打包后干净：宿主字样可能从 re-export、从协议导入的共享模块、从错误的内联顺序进来。
所以 preflight 在**产物**中定位协议区（用存活下来的 banner 注释），再扫一遍。

> 这里也踩了一个坑：最初用 `export interface SessionRef` 作锚点，永远失败——因为**类型在打包时
> 被抹掉了**，只有运行时的东西才活得下来。改用 banner 注释后通过。

### 3.3 隔离闸门（`isolation.test.mjs`，7 条）

第二道要求：宿主逻辑不能只是"搬到隔壁"。所以还断言：

- `adapters/` **之外**任何文件出现宿主服务名即失败（当前 18 个源文件，**0 泄漏**）；
- `read/disk.ts` 必须**接受 `derivePath` 选项**而不是 import 一个布局（`assert.equal(/from '../adapters\//.test(source), false)`）；
- 中立 `policy.ts` 不得持有渲染白名单 / 消息类型映射 / 日志文件名；
- `src/` 顶层目录被**枚举断言**：只允许 `adapters / protocol / read / write / index.ts / policy.ts / errors.ts`。

最后一条是结构性的：将来谁想加回 `src/host/`，测试会把它当成**结构变更**提示出来，而不是埋在一行 import 的 diff 里。

---

## 4. 这一轮真正迁移了什么

不只是"新建了 protocol 目录"，而是把**已有的宿主耦合真的一件件搬走了**：

| 原位置 | 新位置 | 为什么必须搬 |
|---|---|---|
| `read/disk.ts` 的 `escapeSessionDirName` | `adapters/dsh/paths.ts` | 目录转义是一条宿主事实 |
| `read/disk.ts` 的 `sessionLogPath` | `adapters/dsh/paths.ts` | 磁盘布局是一条宿主事实 |
| `policy.ts` 的 `RENDERED_CONVERSATION_TYPES` | `adapters/dsh/policy.ts` | 渲染白名单是实测的宿主行为 |
| `policy.ts` 的 `PLUGIN_SOURCE_PREFIX` / 文件名 | `adapters/dsh/policy.ts` | 同上 |
| `host/services.ts`（能力探测 + 服务解析） | `adapters/dsh/capability.ts` + `services.ts` | 整份清单都是宿主服务名 |
| `publish/contract.ts` | `adapters/dsh/publish.ts` | 工作区分组与客户端通告是宿主概念 |
| `errors.ts` 注释里的服务名 | 改成中立的阶段名 | 概念泄漏 |

**迁移中的一个真实回归**：`read/disk.ts` 不再 import 布局后，observer 的派生路径回落**静默失效**了
（`visibility.test.mjs` 抓到）。修法不是把 import 加回去，而是让桥接把彼岸层自己发布的
`sessionLogPath` 作为 `derivePath` 传回去——**调用方不重新实现方案，而是把层自己的函数交还给它**。

---

## 5. 一致性套件：协议真的可实现吗

`adapters/memory/` 是一个**没有任何宿主包袱**的实现：会话在 Map 里、没有日志文件、没有压缩、
没有事件总线、没有服务注册表。

```
conformance: the reference host satisfies the structural check      ✔
session: create refuses an empty workspace … WORKSPACE_REQUIRED      ✔
session: create refuses a relative workspace … WORKSPACE_RELATIVE    ✔
session: inject reports per-item what the transcript will SHOW       ✔
session: trigger records the mode it was asked for                   ✔
session: readLog reports what was written, incl. renderability       ✔
session: subscribe delivers events for THIS session only             ✔
storage: undefined ≠ stored null                                     ✔
storage: a write is a SNAPSHOT                                       ✔
tools:   an unknown tool is a RESULT with isError, never a throw     ✔
neutrality: a caller using only the protocol words works end to end  ✔
neutrality: the same caller works on a SECOND host unmodified        ✔
honesty: the host adapter REPORTS which verbs it cannot do           ✔
```

`neutrality` 那两条是真正的证明：一个**只使用协议词汇**的调用方（`handOff` 函数）在两个不同宿主上
都跑通。它从没听说过 turn 对、surface 操作、服务 getter 或日志文件。

---

## 6. 诚实边界（这张表必须准确）

| 项 | 状态 |
|---|---|
| 协议定义 | ✅ |
| 无宿主参考实现 | ✅ |
| 宿主 `readLog` / `subscribe` | ✅ 真实接线 |
| 宿主 `create` / `inject` / `trigger` / `verifyDeletion` | ⛔ `NOT_WIRED`，属于 P2 |
| 宿主 `StorageAdapter` / `ToolAdapter` | ✅ 已实现 |
| **graft-slice 改用适配器** | ⛔ **未开始** |
| **observer 改用适配器** | ⛔ **未开始**（仍直接调 `sessionPersistence` 等） |

还有两条要知道：

1. **`dsh-observer` 仍通过彼岸层直接调用 `sessionLogPath` / `escapeSessionDirName`。**
   这是下一步迁移，本层如实标注，没当成已完成。
2. **`probeCapabilities` 现在住在 `adapters/dsh/capability.ts`，仍没有消费方。** 它是给 P2 写层
   和"上层决定降级还是拒绝"准备的。

---

## 7. 自修复：现在这套结构支持到什么程度

`PARADISE_SPEC.md` §7 给了 AI 的操作手册，核心是三条：

**7.1 定位流程**

```
preflight → 协议区检查失败？回退那处改动，不要"将就"
conformance → 失败？契约被破坏，回到 §2 逐条核对
本包测试 → 失败在 disk/session-dir/host-contract？适配器常量或布局过期，改那一处
报错日志对拍 → 路径不对改 paths.ts，渲染判断错改 policy.ts，动词报 code 改对应文件
```

**7.2 修改边界（硬约束）**

| 允许改 | 禁止改 |
|---|---|
| `src/adapters/<host>/**` | `src/protocol/**` |
| 该宿主的 policy / paths / manifest | `src/read/**` |
| 该宿主的 conformance 例外说明 | 上层插件（graft / observer / memory） |

规范里写死了一句：**如果修复需要改 `src/protocol/`，那不是宿主升级，是协议设计有缺陷。**
那要走一次协议变更：改契约 → 改所有适配器 → 提升 major 版本。不要偷偷在适配器里塞特例。

**7.3 修复后必须做的**

```
build + preflight → 项目内全绿 → 通知上层：capabilities 里哪一项变了
```

第三步不能省。上层降级决策依赖 `capabilities`，它变了而不说，等于让上层按旧地图开车。

---

## 8. 测试与产物

| 包 | 测试 | preflight |
|---|---|---|
| `dsh-paradise 0.2.0` | **90 / 90**（51 → 90，新增 39） | 13 项 OK |
| `dsh-observer 1.8.0` | **208 / 208**（不变） | 11 项 OK |

新增测试分布：

| 文件 | 条数 | 守什么 |
|---|---|---|
| `protocol-purity.test.mjs` | 8 | 协议不得含宿主名/概念；只导出三个值 |
| `isolation.test.mjs` | 7 | `adapters/` 之外零宿主服务名；目录树被枚举断言 |
| `conformance.test.mjs` | 24 | 三适配器逐动词契约 + 跨宿主中性证明 + 适配器如实报告 |

产物：`dsh-paradise/index.js` **90,784 字节**，17 个内联模块。

---

## 9. 本轮改动的文件

```
新增  dsh-paradise/src/protocol/types.ts        宿主中立的值类型
新增  dsh-paradise/src/protocol/adapters.ts     三个适配器接口
新增  dsh-paradise/src/protocol/index.ts        barrel + bindHost + ProtocolError
新增  dsh-paradise/src/adapters/memory/index.ts 无宿主参考实现（协议可实现的证明）
新增  dsh-paradise/src/adapters/dsh/session.ts  五动词（读真接线，写 NOT_WIRED）
新增  dsh-paradise/src/adapters/dsh/storage.ts  原子写 + 幂等删 + key 校验
新增  dsh-paradise/src/adapters/dsh/tools.ts    超时 + 错误即结果
新增  dsh-paradise/src/adapters/dsh/policy.ts   渲染白名单 / 消息类型 / 文件名（从 policy.ts 迁入）
新增  dsh-paradise/src/adapters/dsh/paths.ts    目录转义 + 磁盘布局（从 read/disk.ts 迁入）
新增  dsh-paradise/src/adapters/dsh/services.ts 按被调方法解析（从 host/services.ts 迁入）
新增  dsh-paradise/src/adapters/dsh/capability.ts 能力探测（从 host/services.ts 迁入）
新增  dsh-paradise/src/adapters/dsh/publish.ts  发布契约（从 publish/contract.ts 迁入）
新增  dsh-paradise/src/adapters/dsh/index.ts    适配器 bundle
重写  dsh-paradise/src/policy.ts                只留中立助手（原名下的宿主常量已搬走）
重写  dsh-paradise/src/read/disk.ts             接受 derivePath，不再 import 布局
改    dsh-paradise/src/index.ts                 导出门面 + 版本 0.2.0
改    dsh-paradise/src/errors.ts                注释去宿主服务名，阶段名改中性
改    dsh-paradise/scripts/preflight.mjs        新增产物协议区扫描 + 12 导出 + 参考宿主
删除  dsh-paradise/src/host/services.ts           → adapters/dsh/
删除  dsh-paradise/src/publish/contract.ts        → adapters/dsh/publish.ts
新增  dsh-paradise/PARADISE_SPEC.md             接入新宿主 + 自修复手册
新增  dsh-paradise/test/protocol-purity.test.mjs 8 条
新增  dsh-paradise/test/conformance.test.mjs     24 条
新增  dsh-paradise/test/isolation.test.mjs       7 条
改    dsh-paradise/README.md / manifest.json / package.json
改    dsh-observer/src/core/paradise-bridge.ts   传 derivePath（修复派生路径回归）
新增  _scratch/v200-protocol.mjs                 实测回放
```

---

## 10. 下一步建议（等你定序）

1. **P2 写层**：`create / inject / trigger` 接进 `adapters/dsh/session.ts`，届时 `NOT_WIRED` 变成真实现；
2. **observer 改用适配器**（低风险，先只换 `readLog`/`subscribe` 之外的部分）；
3. **graft-slice 改用适配器**（高风险，542 条测试是基线）；
4. **删掉两处的重复实现**，让 `grep sessionPersistence.create` 只出现在 `adapters/dsh/`。

每一步的验收口径同前：**另一仓的测试数字不变**。
