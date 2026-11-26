# ARCHITECTURE-INVARIANTS —— 层 C 冻结契约与 DEFER 登记

> **性质**：**契约**，不是计划，也不是待办。本文件登记「已经决定、且**现在不实施**」的东西，
> 以及与它们绑定、**不许被单方面改动**的接口形状。
>
> **为什么要有一份文件**：本仓反复出现同一类事故 —— 一个决定只存在于某次会话的对话里，
> 下一个维护者看到代码，看不到「这里为什么是空的」。于是「还没做」被读成「不需要做」，
> 或者反过来，有人把 DEFER 的东西当成 TODO 开始实现，而它前面的三个门槛一个都没过。
>
> **来源**：`优化方案全量施工卡_15条_O1-O47_20261125.md` §5 / §6，
> 与 `08-阶段派工总表-v1.md`「判断 2」。
>
> **⚠️ 本文件里的 `DEFER` 不是 `PASS`，也不是 `TODO`。** 见 §三。

---

## 一、六条层 C 契约（冻结；启动门槛未到之前不得实现）

这六条是**接口形状**的约定。它们今天没有代码，也**不应该**有代码；冻结的意义是：
未来实现时，形状不由第一个实现者随手决定。

### O27 Core Node Contract

| 项 | 内容 |
|---|---|
| 契约 | 节点能力面固定为 `node.describe` / `capabilities.list` / `health.get` / `task.submit` / `task.get` / `task.cancel` / `task.events` / `artifact.get` |
| 边界 | 彼岸（BeiAn）能力是**可选 extension**，不是 core 的必选面 |
| 启动门槛 | 星火层立项 |

### O28 BeiAn Extension 协商

| 项 | 内容 |
|---|---|
| 契约 | extension 分三类：`core` / `optional-extension` / `host-specific`；缺仓时**只降级相关功能**，不得整体失效 |
| 契约 | 状态变化必须发 `state-change` 事件，而不是靠轮询发现 |
| 启动门槛 | 星火层立项 |

### O29 Spark Coordination

| 项 | 内容 |
|---|---|
| 契约 | Agent Registry / Task DAG / Dispatcher / Assignment Lease / Artifact Index / Decision Log / Independent Validator；对外适配 A2A / MCP |
| 边界 | **Graft 不感知编排** —— 协调层不得要求持久层理解「任务 DAG 是谁排的」 |
| 启动门槛 | 星火层立项 |

### O30 Dashboard Query Layer

| 项 | 内容 |
|---|---|
| 契约 | `NodeSnapshot` / `CapabilitySnapshot` / `TaskSnapshot` / `PluginSnapshot` 四种快照形状 |
| 边界 | 面板是**只读投影**：它不产生事实，只呈现已经存在的读数。这条与本仓既有的
「面板只说可观测事实」是同一条纪律的延伸 |
| 启动门槛 | 星火层立项 |

### O31 跨节点 Trace

| 项 | 内容 |
|---|---|
| 契约 | `trace_id` / `correlation_id` / `task_id` / `assignment_id` / `node_id` 贯穿一次调用链 |
| 契约 | **默认脱敏**；`replay` 不得重放副作用 |
| 启动门槛 | 星火层立项 |

### O32–O47 的冻结门槛（六条契约的第六项：**启动条件本身**）

O32–O47（Durable Mission State Machine / Artifact Registry / Idempotent Assignment /
Independent Evaluator / Research Pipeline / Dynamic Topology / Worktree Ownership / SMB Benchmark /
Self-Repair Controller / RSI Matched-Budget / Evolution Trust Boundary / Backpressure /
Failure Containment / Mission Control V3 / Digital Twin / OT Safety Gateway）
**当前四仓阶段一律不实施**。启动需**同时**满足三条：

**逐项登记**（一个范围句不点名任何一项 —— 而实现者动的是编号，不是范围）：

| 项 | 名称 | 状态 |
|---|---|---|
| O32 | Durable Mission State Machine | DEFER |
| O33 | Artifact Registry | DEFER |
| O34 | Idempotent Assignment | DEFER |
| O35 | Independent Evaluator | DEFER |
| O36 | Research Pipeline | DEFER |
| O37 | Dynamic Topology | DEFER |
| O38 | Worktree Ownership | DEFER |
| O39 | SMB Benchmark | DEFER |
| O40 | Self-Repair Controller | DEFER |
| O41 | RSI Matched-Budget | DEFER |
| O42 | Evolution Trust Boundary | DEFER |
| O43 | Backpressure | DEFER |
| O44 | Failure Containment | DEFER |
| O45 | Mission Control V3 | DEFER |
| O46 | Digital Twin | DEFER |
| O47 | OT Safety Gateway | DEFER（唯一条款：接真实物理设备时才升为 P0） |

启动需**同时**满足三条：

1. **长期会话门槛**：14–30 天 L4 运行通过（L3 以下不进 RSI/AGI 研究）；
2. **先决契约**：O27–O31 加 O32 / O33 / O34 / O35 / O42 全 **PASS 且独立验收**；
3. **OT 特别门槛**：O47 仅在接真实物理设备时成为 P0；纯软件系统不做 PLC。

未来立项的统一施工卡模板：Mission 对象 schema → 状态机 → durable store → 独立 oracle →
can-red → matched-budget 复验 → 晋级规则。

---

## 二、本仓在层 C 里的位置（一句话，逐仓不同）

> `dsh-paradise` 是**宿主/执行**层：它决定「一个会话怎么在这个宿主上真的跑起来」，它不知道任务来自哪一层。
> 层 C 的 O27–O31 全部在它**之上**：协调层可以调用它，但它不感知「任务是谁编排的」，
> 也不为协调层保留任何钩子。

同一条纪律的另外三份表述（在另外三个仓的同名文件里，一字不差地对照阅读即可看出差异）：

| 仓 | 它在层 C 里的位置 |
|---|---|
| `dsh-graft-slice` | 会话迁移层；协调层可调用它，它不感知编排 |
| `dsh-memory` | 记忆层；协调层可读它的图，它不感知「谁在调度」 |
| `dsh-observer` | 监督层；它观察一个主脑，不参与编排，也不向协调层暴露决策 |
| `dsh-paradise` | 宿主/执行层；协调层通过它启动会话，它不知道任务来自哪一层 |

---

## 三、`DEFER` 不是 `PASS`，也不是 `TODO`

这三个词在这份文件里的含义，必须严格区分：

| 词 | 含义 | 允许的下一步 |
|---|---|---|
| **PASS** | 已经实现、并且**有独立验收**（判据 + can-red） | 无（已完成） |
| **DEFER** | 已**决定不实施**，门槛未到，且门槛写成可判定条件 | 有人证明门槛已满足，否则**什么都不做** |
| **TODO** | 已决定要实施，只差排期 | 排期后实施 |

**禁止**：把 DEFER 项写进任何一张工单的「待开始」，或者写成「下一步做 O27」。
它不在计划里，它在**冻结名单**里 —— 启动它不是「推进」，是**越界**。

**判据（防退化）**：本文件中 `O27`–`O47` 的**每一项**都只能出现 `DEFER` 或**门槛描述**，
不得出现 `PASS` / `DONE` / `已完成` / `已实现` 这类完成态断言。这条由
`test/v366-layer-c-contracts.test.mjs` 机械核对（四仓同源）。

---

## 四、改这份文件的条件

1. **新增契约**需要一次明确的立项决定，并且要写清启动门槛（可判定，不是「以后再说」）；
2. **删除契约**必须同时说明它去哪了（被合并 / 被否决 / 已实现），不得静默删除；
3. **把 DEFER 改成 PASS** 必须附带「独立验收」的证据（判据 + can-red），否则改的是措辞不是事实。

> 与本仓其它长期规则一样：**一个只存在于对话里的决定，等于没有决定。**
