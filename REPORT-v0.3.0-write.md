# v0.3.0 报告 — P2 写层落地

> 日期：2026-11-05
> 版本：`dsh-paradise 0.3.0`（测试 90 → **104**）· `dsh-observer 1.8.0`（**208** 不变，旧路径原封不动）
> 结论：**写层四个模块已从 observer/graft 抽离并真实接线；能力靠探测而非断言；跨宿主生命周期端到端跑通。**
> 产物：`index.js` **154,272 字节**，21 个内联模块；preflight 14 项全绿。

---

## 1. 你要求的第一步，逐条对照

| 要求 | 落地 | 证据 |
|---|---|---|
| `create` 抽离到 `session-writer.ts` | `prepare → build → validate → create → append → flush → close → 冷读校验`，全程事务 | `write-lifecycle.test.mjs` |
| 保留 cwd 强校验 | 空/相对 → `CWD_REQUIRED`；prepare 后核对 `header.cwd === cwd`，不等即 `CWD_MISMATCH` | 实测回放第 2 组 |
| 失败不留半成品 | `create` 之后任何失败都先回滚再抛；`stat` 前后各一次核实 | 实测回放第 4 组 |
| 错误带 stage | `stage` 覆盖 resolve-cwd / arguments / prepare / preflight / build-tape / create / handle / append / flush / close / verify / publish | 每一条拒绝都带 stage |
| `inject` 抽离到 `inject.ts` | `buildTape` / `materialiseTape` / `assertTape` / `describeRendered` | 与 observer 的 `buildInjectTape` 同形 |
| 保留 rendered 回执字段 | `rendered: [{ id, requested, rendered, reason }]`，**从实际事件推导** | 实测回放第 3 组 |
| `trigger` 抽离到 `trigger.ts` | 标记 + 幂等 + `AbortSignal`（兼超时）+ 双模式回落 | 实测回放第 5 组 |
| `verifyDeletion` 抽离到 `delete.ts` | `discard → remove → sessions.remove → stat 复核 → 标记 [孵化失败]` | 实测回放第 6 组 |

---

## 2. 一个决定：`inject` 的诚实边界

你要求「把 observer-inject.ts 的注入逻辑完全抽离成 inject.ts」。

抽离的部分是**形状**：骨架构造、消息构造、全量校验、渲染回执。它们现在住 `adapters/dsh/inject.ts`。

但**协议动词 `inject(session, items)`** 在本宿主上只能覆盖一半，我选择如实标注而不是假装：

| 场景 | 状态 |
|---|---|
| 创建时一并放入内容 | ✅ 已实现（`create(items)`，整份 tape 一次事务） |
| **向已存在的会话追加内容** | ⛔ `NOT_WIRED`，返回具名原因 |
| 向**运行中**的会话投递 | ⛔ `capabilities.injectIntoRunning = false` |

理由：本宿主的写入是 create 时的一整份 tape 事务；向已存在会话追加需要**打开持久句柄写 step-scoped 事件**，
那是另一条机制（也正是 v1.2.2 撞墙的那条）。它没有被偷偷混进 create 的语义里——那样会让
`injectIntoIdle: true` 变成一句谎话。

> 这个边界直接影响下一步：observer 切换时，它的注入走的是 create-time 路径，可以整体切过去；
> 而 supervisor 的纠偏走的是 `prompt(steer)`，与 `inject` 无关。所以这条限制不妨碍 observer 迁移。

---

## 3. 能力是探测出来的，不是写死的

```ts
createDshAdapters({}).session.capabilities.create           // false —— 没有 sessions.prepare
createDshAdapters(mountedCtx).session.capabilities.create   // true  —— 两半都在
```

| 能力 | 依赖 | 缺了会怎样 |
|---|---|---|
| `create` | `sessions.prepare` **且** `sessionPersistence.create` | 整体拒绝，绝不放宽成 live append |
| `trigger` | `sessionController.prompt` | 会话可手动打开，但不会自动开始 |
| `verifyDeletion` | `sessionPersistence.stat` | 回执只能写"接口调过"，不能写"确实没了" |
| `subscribe` | ctx 有 `on` | 只能轮询 readLog |
| `readLog` | 无 | 读取器只接受路径 |

`create` 的"两半都在"是刻意的：只声明一半会让适配器在第七步失败，而那时产物已经预留了。

---

## 4. 三条不可退让的性质，都是被测的

### 4.1 坏 cwd 什么都不留

```
相对路径   false CWD_REQUIRED stage=resolve-cwd
空 cwd     false CWD_REQUIRED
```

发生在**预留 id 之前**。测试还断言 `host.dump().sessions.size === 0`。

### 4.2 中途失败必须回滚

```
失败@append   false CREATE_FAILED | persisted 0→0
  回滚说明  已回滚并删除空会话 session-980e…（persistence.discardPrepared, persistence.remove）
失败@flush    false CREATE_FAILED | persisted 0→0
```

回滚的结论是**挣来的**：`stat` 前后各一次。删不掉就写 `[孵化失败]` 标题——一个没标记的空壳，
与"孵化了但没拿到方案"的会话在 UI 上完全无法区分。

### 4.3 冷读用同一个校验器全量重跑

```
appended 事件数       8
冷读逐字段校验          true
tape 序列             turn/start → step/start → system/message → user/message
                      → assistant/message → session/title → step/end → turn/end
```

只比对 count/seq/type 会漏掉每一个形状缺陷（丢 `surfaceOp`、role 变、标题引用失配）。
读回来的那份必须通过写出去的那份通过的**同一个** `assertTape`。

---

## 5. 跨宿主生命周期端到端

**同一个调用方函数**（`fullLifecycle`，全程只使用协议词汇、无宿主分支）在两个宿主上跑：

```
无宿主 memory            true at=done visible=1
宿主适配器（裸 ctx）       false at=create why=SESSIONS_UNAVAILABLE
```

这两行看着一胜一负，其实是**同一件事的两面**：

- 无宿主宿主上，协议完整可实现（create → inject → trigger → readLog → probeDeletion 全程通过）；
- 宿主适配器在**没有 service 的 ctx** 上，在正确的步骤给出**具名拒绝**，而不是崩溃或假成功。

第三个用例跑了完整挂载的宿主：`create` → `verified: true` → `trigger via sessionController.prompt`
→ `probeDeletion: present` → `deleteSession` → `probeDeletion: absent`。**删除是被证实的，不是被声称的。**

---

## 6. 旧代码可回退：本轮是"并存"，不是"切换"

| 项 | 状态 |
|---|---|
| `dsh-observer/src/core/observer-inject.ts` | **原封不动**，208 条测试全绿 |
| `dsh-observer` 是否已切换到适配器 | ⛔ 未切换——按你的要求，等这一步验收后再动 |
| `graft-slice` | **一行未动** |
| 是否需要 `if (paradise)` 开关 | **不需要**，因为两条路径完全独立：observer 走自己的 `injectColdSession`，适配器是新增的平行实现 |

你说"可以先让适配器的写层和原有逻辑并存，用 if (paradise) 开关控制"。我做的是**更彻底也更安全**的那一种：
零开关、零共享状态。切换时是把调用点改一行，而不是让旧代码变成一条永不执行的分支。

---

## 7. 测试与产物

| 包 | 测试 | preflight |
|---|---|---|
| `dsh-paradise 0.3.0` | **104 / 104**（90 → 104，新增 14） | 14 项 OK |
| `dsh-observer 1.8.0` | **208 / 208**（不变） | 11 项 OK |

新增 `test/write-lifecycle.test.mjs`（12 条）+ conformance/isolation 里的能力探测补充（2 条）：

| 组 | 盯什么 |
|---|---|
| create | stage 恒在、warnings 为空是挣来的、坏 cwd 零残留、重复 id 不覆盖原件 |
| inject | 逐项回执、只有 visible 被转录、缺会话时回执字段仍存在 |
| trigger | 两种模式是不同结果、真把会话标成 running、缺会话时报错 |
| probeDeletion | present → absent、从未存在也答 absent、**从不猜** |
| capabilities | 内存宿主全绿、宿主适配器按 service 探测 |
| **lifecycle** | 同一调用方：无宿主跑通 / 裸 ctx 具名拒绝 / 完整挂载跑完整条 |

preflight 新增两项，都针对"两边都能坏"的地方：

- 两条拒绝路径仍存在（`NOT_IMPLEMENTED` 与 `NOT_WIRED`）——任一消失就是假成功；
- 写机制导出齐全（`deleteSession` 丢了下游回滚会静默坏掉）。

---

## 8. 本轮踩到的三个真坑（都记下来）

1. **Node 的类型剥离器比 `tsc` 小。** `readonly T[]`、`: never` 返回标注都会被拒，构建报 `Expected ',', got 'ident'`。
   改用 `ReadonlyArray<T>` 并去掉那个标注，注释里写清了原因——否则下一个人会重新踩。
2. **单作用域 bundle 的别名会被抹掉。** 我写了 `import { verifyDeletion as verifySessionDeletion }`，
   内联时 `import` 被删，别名随之消失，运行时 `ReferenceError`。改成导入本名 + `const` 别名。
3. **一个真实的语法错误被自己的构建抓到**：`inject.ts` 里有一行字符串漏了引号
   （`developer/message 只在…`）。构建直接报出来，没有进到产物。

---

## 9. 下一步（等你确认后动）

按你定的顺序，接下来是**让 observer 切过去**。可行性已经确认：

| observer 现有调用 | 对应适配器 | 可切换？ |
|---|---|---|
| `injectColdSession`（创建+写入） | `session.create(items)` | ✅ 形状一致 |
| `ignition.igniteSession`（点火） | `session.trigger` | ✅ 已抽离同一套逻辑 |
| `rollbackInjectedSession`（回滚） | `deleteSession` 直接可用 | ✅ |
| 磁盘核对 | 上轮已切 | ✅ |

需要的开关（如果你想保留回退）：`config.useParadiseAdapter: boolean`，默认 false，
切换后 `observer-inject.ts` 保留一版不删。

再下一步才是 graft ——那要重跑 542 条测试做基线对比。

---

## 10. 本轮改动的文件

```
新增  dsh-paradise/src/adapters/dsh/inject.ts          骨架/消息/校验/渲染回执
新增  dsh-paradise/src/adapters/dsh/session-writer.ts  冷目标创建事务 + 冷读自校验 + 回滚
新增  dsh-paradise/src/adapters/dsh/trigger.ts         点火（标记/幂等/AbortSignal/双模式）
新增  dsh-paradise/src/adapters/dsh/delete.ts          删除 + stat 核实 + 标记
改    dsh-paradise/src/adapters/dsh/session.ts         四个动词真实接线；能力改为探测
改    dsh-paradise/src/adapters/dsh/policy.ts          新增 PROMPT_MARKER / TRIGGER_TIMEOUT / SYSTEM_HEAD
改    dsh-paradise/src/protocol/adapters.ts            新增 probeDeletion（三值答案）+ DeletionProbe
改    dsh-paradise/src/adapters/memory/index.ts         写层补齐 + probeDeletion
改    dsh-paradise/src/index.ts                        导出写机制；VERSION 0.3.0
新增  dsh-paradise/test/write-lifecycle.test.mjs       12 条（含跨宿主生命周期）
改    dsh-paradise/test/conformance.test.mjs           能力探测断言
改    dsh-paradise/test/isolation.test.mjs             能力探测断言
改    dsh-paradise/scripts/preflight.mjs               两条拒绝路径 + deleteSession 导出
改    dsh-paradise/{package,manifest}.json / README.md 0.3.0 + 完整度表更新
新增  _scratch/v030-write.mjs                          实测回放
```
