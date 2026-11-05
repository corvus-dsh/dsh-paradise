# dsh-paradise — 彼岸层

> **`v0.4.0`（2026-11-06）— 存储加固与租约：可恢复的持久化 + 基于同一契约的互斥**
>
> 一句话：彼岸层只回答「**怎么在宿主上安全地造一个会话并往里写东西，以及怎么把它读回来**」，
> 不回答「**什么时候该造、造来干什么**」。
>
> **v0.2.0**：一套不出现任何宿主字样的协议（`SessionAdapter` / `StorageAdapter` / `ToolAdapter`）。
> **v0.3.0**：写层从 observer-inject / graft 里抽离成四个模块，**能力靠探测而非断言**。
> **v0.4.0**：存储从「原子写」升级到「**原子写 + 快照 + 自恢复**」；新增**租约**（epoch fencing、
> 过期回收、有界等待），并让**两个宿主共用同一份租约实现**——因为并发规则不该有第二份。

## 三层结构

```
src/protocol/        契约。不含宿主字样。源码与产物双重机械校验。
src/adapters/<host>/ 宿主的全部特性：服务名、目录布局、渲染规则、消息形状、写机制。
src/read/            宿主中立的读取器。接受路径或"给我路径"的回调，永不知晓布局。
```

判定一段代码该放哪层的唯一问题：

> **换一个完全不同的宿主，这段代码还有意义吗？**
> 有 → `protocol/` 或 `read/`。答案需要"其实在另一个宿主上不一样"的解释 → `adapters/<host>/`。

两条闸门守着它：

| 测试 | 守什么 |
|---|---|
| `protocol-purity.test.mjs` | `src/protocol/` 出现宿主名或宿主概念即失败，**注释也算** |
| `isolation.test.mjs` | `adapters/` **之外**出现宿主服务名即失败；目录树也被枚举断言 |

## P2 写层：四个模块

| 文件 | 职责 | 抽离自 |
|---|---|---|
| `adapters/dsh/inject.ts` | 骨架与消息构造 + 全量校验（`buildTape` / `materialiseTape` / `assertTape` / `describeRendered`） | observer 的 `buildInjectTape` |
| `adapters/dsh/session-writer.ts` | 冷目标创建整条事务：prepare → build → validate → create → append → flush → close → 冷读校验 | observer 的 `injectColdSession` |
| `adapters/dsh/trigger.ts` | 点火：标记 + 幂等 + AbortSignal + 双模式回落 | graft 的点火链 |
| `adapters/dsh/delete.ts` | 删除 + `stat` 核实 + 删不掉则标记 `[孵化失败]` | observer 的 `rollbackInjectedSession` |

### 三条不可退让的性质

**1. `cwd` 强校验，坏 cwd 什么都不留。** 空或相对路径 → `CWD_REQUIRED`，发生在**预留 id 之前**。
`prepare` 之后还会核对 `header.cwd === cwd`（不等即 `CWD_MISMATCH`）。

**2. 中途失败必须回滚。** 顺序是防御性的：所有不会留痕的步骤先跑，`create` 是第一个预留 id 的操作，
其后任何失败都会先回滚再抛出。回滚的结论是**挣来的**：`stat` 前后各一次；删不掉就写 `[孵化失败]` 标题，
绝不留一个"看起来能用"的空壳。

**3. 冷读用同一个校验器全量重跑。** 只比对 count/seq/type 会漏掉每一个形状缺陷（丢 `surfaceOp`、
role 变、标题引用失配）。读回来的那份必须通过写出去的那份通过的**同一个** `assertTape`。

### `rendered` 回执：从实际事件推导，不从请求回显

```ts
rendered: [{ id, requested: 'visible', rendered: true, reason: '…' }]
```

`rendered` 由 tape 里**实际是什么事件类型**决定。请求 `visible` 而宿主降级成不可见时，
回执会如实说 `false` 并给出原因——这正是"写成功、渲染为零"那次事故的防线。

## 完整度对照（这张表必须保持准确）

| 能力 | 状态 |
|---|---|
| 协议定义（三适配器） | ✅ 完成，纯净性测试守着 |
| 无宿主参考实现 `adapters/memory` | ✅ 完成，读+写全套，conformance 每次跑它 |
| 宿主 `readLog` / `subscribe` | ✅ 真实接线 |
| 宿主 **`create`** | ✅ 事务式冷写入 + 冷读自校验 + 回滚 |
| 宿主 **`trigger`** | ✅ 幂等 + 双模式回落 |
| 宿主 **`probeDeletion`** | ✅ 三值答案（absent / present / unverifiable） |
| 宿主 `inject`（**向已存在会话追加**） | ⛔ 未接线——本宿主的写是 create 时的一整份 tape；追加需要持久句柄增量写 |
| 宿主 `injectIntoRunning` | ⛔ 同上，如实报 `false` |
| 宿主 `StorageAdapter` | ✅ 原子写 + **快照**；半截 JSON **自恢复**（回退快照并就地修复）；`readDetailed` 区分 ok/missing/recovered/corrupt；`compareAndSet` 原子读改写 |
| 宿主 `ToolAdapter` | ✅ 超时、错误即结果、按被调方法解析 |
| **租约**（Epoch + fencing） | ✅ 一份宿主中立的实现（`lease-adapter.ts`），两个宿主共用；`withLease` 有界等待、必释放、陈旧检测 |
| **graft-slice 改用适配器** | ✅ 已完成（create / 冷读校验 / 回滚 / trigger 全走此层） |
| **observer 改用适配器** | ✅ 已完成（`observer-inject.ts` 保留为存档，不再被引用） |
| **memory 改用适配器** | ⛔ 未开始，且**需要一次范围裁决**：`SKILL.md` 是用户级可编辑文件树，键值存储表达不了（memory 的**锁**已改用本层租约，见 v0.30） |
| **能力降级断言（升级预演）** | ✅ `assert-capabilities.ts`：缺 API 时 `HOST_CAPABILITY_MISSING`，逐条给出**后果**与**要改哪个文件**；`strict` 开关供升级预演使用（默认宽松，以保留「空宿主如实报 false」这一性质） |

> 把 ⛔ 写成 ✅ 的表格，就是协议 §2.5 禁止的那种假成功，只不过发生在文档里。

## 能力是探测出来的

```ts
createDshAdapters({}).session.capabilities.create                    // false —— 没有 sessions.prepare
createDshAdapters(mountedCtx).session.capabilities.create            // true  —— 两半都在
```

| 能力 | 依赖 |
|---|---|
| `create` | `sessions.prepare` **且** `sessionPersistence.create`（缺一半就整体拒绝） |
| `trigger` | `sessionController.prompt` |
| `verifyDeletion` | `sessionPersistence.stat` |
| `subscribe` | ctx 有 `on` |
| `readLog` | 无（读取器只接受路径） |

缺哪一项，`unavailable` 里就有一条带**后果**的说明，调它则返回具名 `NOT_WIRED`——绝不是安静的成功。

## 接入新宿主

读 **[PARADISE_SPEC.md](PARADISE_SPEC.md)**。让 `test/conformance.test.mjs` 与
`test/write-lifecycle.test.mjs` 通过即视为接入完成。

## 测试与校验

```
node scripts/build.mjs && node scripts/preflight.mjs && node --test test/*.test.mjs
```

**当前 104/104。** preflight 14 项，其中三项是这一层独有：

- 产物里的**协议区不含宿主名**（源码干净 ≠ 打包后干净）；
- 两条拒绝路径仍然存在（`NOT_IMPLEMENTED` 与 `NOT_WIRED`）；
- 写机制导出齐全（`deleteSession` 丢了下游回滚就静默坏掉）。

## 已知边界

1. **路径推导依赖未被承诺的目录布局。** 已标成 `derived:`，失效方式是"读文件失败"，不会伪造成功。
2. **`RENDERED_CONVERSATION_TYPES` 是实测常量**（住在 `adapters/dsh/policy.ts`），只用于**报告**。
3. **`inject` 只覆盖 create 时放置**。向已存在会话追加是另一条路径（打开持久句柄写 step-scoped 事件），未接线且如实报告。
4. **`dsh-observer` 仍走自己的 `observer-inject.ts`**。本轮是"并存"，不是"切换"——旧路径 208 条测试原封不动全绿。
5. **`graft-slice` 一行未动。**

## 许可

MIT
