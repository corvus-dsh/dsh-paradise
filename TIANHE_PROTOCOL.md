# TIANHE_PROTOCOL.md — 天河协议 v0.1

> 状态：**设计文档 + 已落地的类型定义**　日期：2026-11-06
> 落点：`dsh-paradise/src/protocol/network.ts`（类型）· 本文件（规范与语义）
>
> **本文件是独立设计文档。代码里没有任何跨节点 API 被提前引入。**
> 天河协议描述的是**两个彼岸层实例之间**如何交换工作，不是某个插件的新功能。
> 在彼岸层没有完成自举之前，它只是一张图纸；现在图纸有了一个可编译的骨架。

---

## 0. 一句话

> **天河协议把"一次任务"定义为一个纯 JSON 的票据，把"一次结果"定义为一个纯 JSON 的回执。**
> 票据可以被序列化、排队、重试、转发到任何一台机器；回执可以被校验、归档、作为下一张票据的输入。
>
> 没有函数、没有类实例、没有闭包、没有共享内存。**只有 JSON。**

---

## 1. 为什么需要它

彼岸层现在能在一台机器上承载一个完整的能力层。天河系统要回答的是下一个问题：

> 当同一个任务需要**多台机器**协作时，它们之间交换什么？

答案不能是"把 adapter 传过去"——那需要两个进程共享同一个对象图，而网络的本质就是不共享任何东西。所以协议必须是**值**，不是**引用**。

---

## 2. TianheTicket — 一张票据

### 2.1 形状

```json
{
  "ticketId": "tkt-7f3a9c21",
  "protocol": "tianhe/1",
  "createdAt": 1730937600000,
  "deadlineAt": 1730938200000,

  "task": {
    "kind": "memory.harvest",
    "action": "从已退休会话中提取四层记忆"
  },

  "goal": {
    "statement": "完成 3 个会话的记忆提取，且不产生重复记录",
    "acceptance": [
      "每个会话的四层记录都已落盘",
      "processed 游标已推进",
      "没有任何技能被丢弃（dropped 为空）"
    ]
  },

  "payload": {
    "sessionIds": ["auto-graft-mw3ob7d3-rzsy6u"],
    "options": { "maxPerSession": 3 }
  },

  "dependsOn": ["tkt-a1b2c3d4"],

  "workspace": "D:\\持久层能力架构",
  "idempotencyKey": "harvest:2026-11-06:batch-17",

  "origin": {
    "nodeId": "node-alpha",
    "issuedBy": "tianhe.scheduler"
  }
}
```

### 2.2 字段语义

| 字段 | 必填 | 语义 | 为什么必须存在 |
|---|---|---|---|
| `ticketId` | ✔ | 票据的全局唯一标识 | 回执要能对上票据；重投递要能去重 |
| `protocol` | ✔ | 协议版本，如 `tianhe/1` | 版本是唯一能让旧节点拒绝新票据的东西 |
| `createdAt` / `deadlineAt` | ✔ | 毫秒时间戳 | 没有 deadline，一张票据会在队列里永久有效 |
| `task.kind` | ✔ | **封闭词汇表**里的任务类型 | 开放词汇意味着接收方无法拒绝未知任务 |
| `task.action` | ✔ | 人可读的一句话 | 日志里 `kind` 不够，人需要读一句话 |
| `goal.statement` | ✔ | 这次任务要达到什么 | 执行方不能只知道"做什么"，还要知道"算成功" |
| `goal.acceptance` | ✔ | **可判定的**验收条件列表 | 不可判定的验收 = 无法自动交付 |
| `payload` | ✔ | 任务专属的输入，**纯 JSON** | 这是 tasks 之间的唯一差异 |
| `dependsOn` | ✘ | 必须先完成的票据 id 列表 | 这是 DAG 的边；没有它，图调度退化成队列 |
| `workspace` | ✘ | 绝对工作目录 | 与 `SessionRef.cwd` 同一条铁律：**永不猜测** |
| `idempotencyKey` | ✔ | 重投递时的同一性凭据 | 网络超时与写入成功不可区分，见 §2.3 |
| `origin` | ✔ | 谁签发的 | 出事时第一个问题是"谁让它跑的" |

### 2.3 `idempotencyKey` 为什么是必填

网络的核心困难不是"消息丢了"，而是**"我不知道它丢没丢"**。

```
发送方 → 写入 → [网络] → 接收方
                ↑
        在这里超时，发送方无法知道
        写入到底发生了没有
```

没有幂等键，唯一的"安全"做法是**永不重试**，而永不重试的分布式系统等于永远失败。
有了幂等键，重试变成一次**声明**而不是一次**新动作**：接收方看到同一个 key，就知道"这是同一件事，我已经做过 / 我还没有做"，两种情况都能给出确定的答案。

> 这与 `paradise.storage` 的本地 `compareAndSet` 是同一个思想的两种形态：
> 本地用**版本号**排除并发，跨节点用**幂等键**排除重投递。

---

## 3. TianheResult — 一张回执

### 3.1 形状

```json
{
  "ticketId": "tkt-7f3a9c21",
  "protocol": "tianhe/1",
  "completedAt": 1730937654321,
  "nodeId": "node-beta",

  "status": "succeeded",

  "artifacts": [
    {
      "kind": "memory.layers",
      "location": "memory/negatives.jsonl",
      "count": 1,
      "digest": "sha256:9f2c…"
    }
  ],

  "metrics": { "elapsedMs": 4321, "modelCalls": 3, "tokensIn": 12044, "tokensOut": 988 },

  "error": null,

  "warnings": ["1 条事实没有 timestamp，无法参与严格时序排序"]
}
```

### 3.2 `status` 是四值，不是二值

| 状态 | 语义 | 调用方该做什么 |
|---|---|---|
| `succeeded` | 验收条件全部满足 | 继续下游 |
| `failed` | **确定**没有成功 | 按 error 决定重试或放弃 |
| `rejected` | 接收方主动拒绝（能力不足 / 前置不满足） | **不要重试**，重试也是同样的拒绝 |
| `indeterminate` | **无法判定**（网络断在关键点） | 用 `idempotencyKey` 查询真实状态后再决定 |

> **`indeterminate` 是这份协议最重要的一个值。**
> 一个只有 `succeeded` / `failed` 的协议，在遇到"写了一半"时会**被迫撒谎**——
> 说成功是错的，说失败会导致重复执行。承认"我不知道"，是唯一诚实的第三选项。

### 3.3 `error` 的形状

```json
{
  "code": "HOST_CAPABILITY_MISSING",
  "stage": "harvest",
  "message": "缺少 llm 服务：无法提取，只能扫描",
  "retryable": true,
  "evidence": ["last-extraction-raw-2026-11-06.txt"]
}
```

`retryable` 必须由**产生错误的一方**判断，而不是接收方猜 —— 它知道自己是等一会儿就好，还是永远好不了。

---

## 4. 节点间状态同步：`NetworkStorageAdapter`

### 4.1 为什么它**扩展**而不是**替换** `StorageAdapter`

见 `src/protocol/network.ts` 的文件头。一句话：本地契约诚实，网络契约需要多说三件事，但那三件事不应该让本地实现也要实现一遍。

```ts
export interface NetworkStorageAdapter extends StorageAdapter {
  readonly guarantees: NetworkGuarantees
  readonly endpoint: string
  readRemote(key: string): Promise<NetworkReadReport>
  writeRemote(request: NetworkWriteRequest): Promise<MutationReceipt & { version?: number }>
  compareAndSetRemote(request: NetworkWriteRequest & { expectedVersion: number }): Promise<...>
  healthy(): Promise<boolean>
}
```

### 4.2 `guarantees` —— 每个字段都是一个**必须能被辩护的声明**

| 字段 | 取值 | 含义 |
|---|---|---|
| `linearizable` | bool | 是否存在单一的全局写入顺序。gossip 复制的存储答 `false` |
| `staleByMs` | number | 副本最多可能多旧。`0` = 这次读去了主节点，是权威的 |
| `idempotentRetries` | bool | 同一个幂等键是否**恰好产生一次**效果 |
| `compareAndSetScope` | `cluster` / `node` / `none` | CAS 的原子性范围 |

> **这些字段的存在本身，就是这份协议的态度**：
> 一个无法提供跨节点互斥的存储，**必须**回答 `compareAndSetScope: 'node'`，
> 而不是假装自己有集群级原子性。
> 这与本地租约的 `exclusive: boolean` 是同一条纪律 —— **能力不足就说不足**。

### 4.3 一次写的时间线

```
1. 调用方 readRemote(key)        → { value, version: 7, servedBy: "node-a", stalenessMs: 0 }
2. 调用方决定 newValue
3. writeRemote({ key, value, idempotencyKey: "u-42", expectedVersion: 7 })
4. 网络超时 —— 调用方不知道结果
5. 调用方用 SAME idempotencyKey 重试
6. 接收方答：{ ok: true, version: 8 }   ← 第一次其实成功了，本次是重放，不重复生效
```

**没有第 3 步的 `idempotencyKey` 和第 6 步的语义，第 5 步就是一次危险的重复写。**

### 4.4 明确**不做**的事

| 不做 | 为什么 |
|---|---|
| 共识算法（Raft/Paxos） | 那是某个具体分布式算法的属性，塞进存储接口会逼每个实现假装自己有 |
| 成员管理 / 选主 | 同上，且涉及运维语义，不是存储语义 |
| 向量时钟 | 一个实现如果不需要，就不应该被迫携带 |
| 传输层（HTTP/gRPC/WebSocket） | 协议只定义**交换什么**，不定义**怎么送**。用 `NetworkEnvelope` 表达一次调用，传输由适配器决定 |

---

## 5. `NetworkEnvelope` —— 一次调用上线时的样子

```json
{
  "op": "compareAndSet",
  "callId": "call-9a8b7c",
  "key": "cursor:harvest",
  "payload": { "expectedVersion": 7, "value": 8, "idempotencyKey": "u-42" },
  "deadlineAt": 1730937660000
}
```

- `op` 是**封闭词汇表**：`read` / `write` / `remove` / `keys` / `compareAndSet` / `healthy`。未知 op 必须被拒绝，而不是被忽略。
- `callId` 让重试可被识别为**同一次调用**。
- `deadlineAt` 让调用方自己的超时能**穿过一跳**，而不是在内层无限等待。

---

## 6. 三条不可协商的规则

### 规则 1：票据和回执只能是纯 JSON

不能有函数、类实例、`BigInt`、`Date` 对象、`undefined`、循环引用。
理由：任何"有点特殊"的值都会在序列化边界上变成 `undefined`，而 `undefined` 会让接收方以为字段缺失。

**时间一律用毫秒数字**，不用 ISO 字符串：字符串有时区歧义，数字没有。

### 规则 2：没有 `idempotencyKey` 的副作用操作，不予执行

不是"警告"，是**拒绝**。一条无法安全重试的指令，在网络上等价于一条无法投递的指令。

### 规则 3：`rejected` 与 `failed` 必须分开

- `rejected` = "我不做，因为我做不了 / 不该做" → 重试没有意义
- `failed` = "我做了，但失败了" → 可能可以重试

把两者合并成 `failed`，会让调度器对每一次能力不足都重试 N 次，**把一次拒绝放大成一场风暴**。

---

## 7. 与因果图的关系（天河调度的数据基础）

天河调度器不是队列，是**图调度器**。它需要知道"这个任务的前置是否已经成立"，而这个答案来自 `recursiveCausalChain`（见 `dsh-memory`）：

```
TianheTicket.goal.statement
        │
        ▼
recursiveCausalChain(memory, skills, goal)      ← 已在 dsh-memory 实现，23/23 验证
        │
        ├── L0  技能：这个动作有已知做法吗
        ├── L0  负知识：这个动作被禁止吗       → 有阻塞边 ⇒ 拒绝调度
        ├── L1..Ln  前置事实：做它之前必须成立什么
        └── 边（relations）→ 依赖图的形状
```

**票据的 `dependsOn` 是"票据之间"的边；因果图的 `edges` 是"知识之间"的边。**
两者正交，且都需要 —— 前者决定**执行顺序**，后者决定**是否可以执行**。

---

## 8. 现状与下一步

| 项 | 状态 |
|---|---|
| `NetworkStorageAdapter` 类型定义 | ✅ 已落地（`src/protocol/network.ts`），协议纯度门禁通过 |
| `TianheTicket` / `TianheResult` 的**形状** | ✅ 本文件定义 |
| `TianheTicket` / `TianheResult` 的**运行时类型** | ⏸ 未写进 `protocol/` —— 它们属于**跨节点层**，不属于单进程协议 |
| 一个真实的网络存储实现 | ⏸ 未写（没有可测的第二台机器） |
| 调度器 | ⏸ 未写 |

> **为什么票据类型没有直接写进 `src/protocol/`**：
> 那个目录的纯度高到会被测试拒绝任何宿主概念，而"节点""网络""票据"同样不是"一个进程内的存储契约"。
> 天河协议是**彼岸层之上**的一层。在它有自己的实现和测试之前，把类型塞进协议层只会让纯度门禁变成噪音。
> **图纸先落地，代码等实现。**
