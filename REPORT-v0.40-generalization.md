# v0.40 报告 — 泛化：两个插件上裸机，天河协议落地到真实网络

> 日期：2026-11-06
> 交付物：`host-gateway.ts`（graft）· `paradise-write` 接缝（observer）· `adapters/http/network-storage.ts`
> 验证：四套 **195 / 545 / 263 / 183** · 裸机切片 **29/29** · 网络互通 **50/50**

---

## 1. 两项要求，逐条对账

| 你的要求 | 状态 | 证据 |
|---|---|---|
| 一.1 把「外部给定的 Adapter」注入进两个插件 | ✅ | `setHostGateway` / `setWriteAdapterProvider` |
| 一.2 graft 通过传入的 Adapter 读 JSONL 日志 | ✅ | 空 ctx 上跑通 |
| 一.3 触发一次切片，生成新 JSONL 带上下文 | ✅ | **29/29**，真实产出 10 事件的文件 |
| 二.1 手写基于 node http 的 NetworkStorageAdapter | ✅ | `startNetworkNode` / `connectNetworkNode` |
| 二.2 两节点状态同步，工单与因果数据互通 | ✅ | **50/50**，真 socket |

---

## 2. 一、两个插件上裸机

### 2.1 原来为什么跑不通 —— 不是逻辑错，是**问题的问法错了**

迁移管线只从宿主取五样东西：

```
ctx.sessions.get(newId)                 预检：这个 id 被占了吗
ctx.get('sessionPersistence')           预检：有持久存储吗
ctx.sessionQuery.readSession(id)        源日志 + 冷读回
ctx.sessions.get(sourceId).append(...)  给源打 [已转移] 标题
persistence.stat(newId)                 没有半写的目标吗
```

五个调用点，一个答案：「宿主服务容器里的 live handle」。裸机上没有容器，只有一堆 `.jsonl`。

### 2.2 改动方式：**窄网关 + 默认实现逐字转写**

`src/core/host-gateway.ts` 把五个问题收到一个接口后面，默认实现是**原来那五行代码的转写**：

```ts
export function resolveGateway(ctx: any): HostGateway {
  return installed ?? hostGatewayFromContext(ctx)
}
```

**管线里没有一处 `if (bareMachine)`。** 只有一条管线，和一个可替换的网关。

两处细节值得单独说：

- **`writesThroughParadise` 是个字段，不是条件分支。** 「必须有 sessionPersistence」这条检查对宿主网关**正确**（裸 `sessions.create` 不持久），对自写文件的网关**错误**（它明明做得了这件事，却被拒）。所以这条要求从管线搬到了网关身上。
- **`readLogIncludesHeader` 同理。** 冷读校验拿磁带的事件数比对数，而磁带**不含 header**。一个会吐 header 事件的读取器，必须先剥掉它——见 §2.4。

### 2.3 实测：空 ctx 上真的切出了一份新会话

```js
const emptyCtx = { logger, get: () => undefined, on: () => {} }   // 没有 sessions / sessionPersistence / sessionQuery
await graft.graftSliceAndInject(emptyCtx, { autoGraft: false }, 'bare-source-1', 'bare-target-1')
```

产物是一个 10 事件的 `.jsonl`：

```
seq=-1  session (header, isSeeded:false)     ← 单独标记，不占 TAPE 编号
seq= 0  turn/start
seq= 1  step/start
seq= 2  system/message   (surfaceOp: append)
seq= 3  user/message     「这个会话的任务：…」+ graft-identity 元数据
seq= 4  session/title
seq= 5  assistant/message  [Turn 1] 【我 (seq 4)】…
seq= 6  assistant/message  交接任务看板（含"停泊点"）
seq= 7  step/end
seq= 8  turn/end
```

**带着上下文**的判别性证据：目标里有 `sourceSessionId: "bare-source-1"`、有源会话的结论摘要、有 `graft_read_result` 回读通道。

### 2.4 三个坑，全部是**我的网关错、插件的校验对**

| 报错 | 我错了什么 | 为什么插件是对的 |
|---|---|---|
| `SEEDED_HEADER` | header 没写 `isSeeded: false` | 交接目标是全新顶层会话，不是 fork 子会话 |
| `cold-read event count 10 ≠ written 9` | header 被我当成事件 0 编号 | 磁带只有事件，header 写在事件流之外 |
| `system/message is not an append surface event` | 丢了磁带的 `surface:true` → `surfaceOp:'append'` 映射 | 没有它，续接时无法知道哪些消息对用户可见 |

**「没有 DSH」不等于「没有规则」。** 一个裸机宿主仍要产出满足协议的 header。这三条我写进了脚本注释。

### 2.5 对照组证明接缝是真的

卸掉网关后，同样的空 ctx 立刻失败，且**失败码是 `PERSISTENCE_REQUIRED`** —— 是"这个部署需要网关"，不是"插件坏了"。这两件事在日志里长得像，意思相反。

observer 侧同样：`ensureWriteAdapter` 在装了 provider 后**每次调用都问**（实测 2 次），`null` 则穿透回落宿主路径。

---

## 3. 二、天河协议落地到真实网络

### 3.1 两个真 HTTP 节点，真 socket

```
节点 A: http://127.0.0.1:61117   node-alpha
节点 B: http://127.0.0.1:61118   node-beta
```

`guarantees` 每个字段都是**可辩护的**：

| 字段 | 值 | 为什么能这么答 |
|---|---|---|
| `linearizable` | `true` | 单个服务进程持有状态，没有副本可滞后 |
| `staleByMs` | `0` | 每次读都是一次请求 |
| `idempotentRetries` | `true` | 服务端有幂等账本 |
| `compareAndSetScope` | `'node'` | **诚实**：CAS 在该进程内原子，两个服务不会互相仲裁 |

### 3.2 幂等账本是网络存储的核心

```
写入 counter=1, key=idem-1   → v=1
重投 counter=999, key=idem-1 → v=1   ← 答的是第一次的结果
读出 counter                 → 1     ← 幂等不是"最后一次赢"
写入 counter=2, key=idem-2   → v=2   ← 换 key 才真的改
```

网络层最难的不是"消息丢了"，是**"我不知道它丢没丢"**。没有账本，唯一的"安全"做法是永不重试，而永不重试的分布式系统等于永远失败。

### 3.3 工单流转与因果数据互通

```
A: ticket → 读出来 → 写进 B → B 执行 → result 写回 A
```

- 工单结构完整到达（`ticketId` / `goal.acceptance` 2 条 / `origin.nodeId`）；
- 回执状态是四值之一 `succeeded`，带产物清单；
- **因果图原样传输**：9 节点 / 11 边 / 深度 1，`layer` 与 `relation` 都活着，边数组逐字节相同（复合指针没丢）。

因果图是 `dsh-memory` **真实产出**的，不是手捏的 JSON —— 验证的是"我们的因果数据能不能过网络"。

### 3.4 一个真实缺陷：`readRemote` 会抛

打到死端口时，`fetch` reject，而 `readRemote` 没包住，异常直接逃出去把调用方带走。

**协议明说「读不得抛」，而我违反了它。** 修好后状态是 `corrupt` 而非 `missing`：

> "我够不到这个存储" 和 "存储说你没写过" 是**相反的事实**。把它们混为一谈的调用方，会覆盖掉自己还拥有的数据。

---

## 4. 红线复核

| 约束 | 本轮 | 证据 |
|---|---|---|
| 1. `live.append` / `{turn:0,step:0}` | ✅ | 未触及 |
| 2. 协议无 dsh/cordis 字样 | ✅ | `protocol/*.ts` 零匹配 |
| 3. 不得因重构改变行为 | ✅ | 四套 195/545/263/183；graft 545 项全部未改仍绿 |
| 4. 直接 fs / 写死绝对路径 | ✅ | 网关路径全由调用方给；测试用 `mkdtempSync` |
| 5. 只在适配层改，上层插件不动 | ⚠️ **本轮破了例，且是有意的** | 见下 |

**第 5 条必须说清楚**：本轮改的正是**上层插件**（`graft-slice`、`observer`）—— 因为你的要求一就是"让两个插件适配裸机"。但改动方式是**加接缝**，不是改逻辑：

- `graft` 的五处宿主调用改为走网关，默认实现是原代码的转写；
- `observer` 加一个 provider，`null` 时完全回落；
- 两个插件的 **545 / 183 项既有测试全部未改、全部通过**。

---

## 5. 诚实的边界

| # | 状态 |
|---|---|
| graft 上裸机 | ✅ **已关闭**（29/29） |
| observer 上裸机 | ⚠️ **部分**：写路径的接缝已验证；它的**读路径**（`readDiskEvents`）仍走 paradise 的磁盘读取器，需要第二个网关才能完全裸机 |
| NetworkStorageAdapter | ✅ **已实现**（50/50），但**无认证、无复制、无共识** |
| TD-M8 | ⚠️ 仍在（本轮 5 跑 1 红，恒为同一条） |

**observer 的读路径是真实缺口。** 它的 `inspectSessionLog` 仍然调用 `binding.reader.readDiskEvents`，那是一个**文件形状**的读取器。要让 observer 完全裸机，需要给它同样的读写网关——本轮没做，因为要求一写的是"两个插件"，而 observer 的**写**路径是它真正干活的地方。

---

## 6. 现在可以体验的命令

```bash
# 裸机切片（不需要 DSH）
node _scratch/verify-bare-graft.mjs

# 两节点网络互通（真 socket）
node _scratch/verify-network-store.mjs

# 独立 harness
node dsh-paradise/dist/harness.js --help
```

---

## 7. 本轮文件清单

| 文件 | 动作 |
|---|---|
| `dsh-graft-slice/src/core/host-gateway.ts` | **新建** — 窄网关 + 默认转写 |
| `dsh-graft-slice/src/core/gateway-types.ts` | **新建** — 三个值类型 |
| `dsh-graft-slice/src/core/paradise-write.ts` | 改 — `setParadiseWriteProvider` 长期接缝 |
| `dsh-graft-slice/src/index.ts` | 改 — 五处宿主调用走网关；导出接缝 |
| `dsh-observer/src/core/paradise-write.ts` | 改 — `setWriteAdapterProvider` |
| `dsh-observer/src/index.ts` | 改 — 导出接缝 |
| `dsh-paradise/src/adapters/http/network-storage.ts` | **新建** — 服务端 + 客户端 |
| `dsh-paradise/src/index.ts` | 改 — 导出两个网络函数 |
| `dsh-paradise/test/host-independence-seams.test.mjs` | **新建** — 7 条（把接缝钉死） |
| `_scratch/verify-bare-graft.mjs` | **新建** — 29 项 |
| `_scratch/verify-network-store.mjs` | **新建** — 50 项 |
