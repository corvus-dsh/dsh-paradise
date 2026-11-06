# BOOTSTRAP_GUIDE.md — 彼岸自举协议 · 第一分册

> 版本：v0.1　日期：2026-11-06
> 适用对象：一个**想在没有 DSH 的裸机上把彼岸层拉起来**的人，或者一个**被要求自己完成这件事的 AI**。
>
> 本文只回答两个问题，且要求答案可被机器验证：
> 1. 彼岸层运行所需的**绝对最小原子能力**是什么？
> 2. `adapters/dsh/` 里，哪些是**DSH 特有的**，哪些是**任何宿主都会需要的**？

---

## 0. 一句话结论

> **彼岸层的最小可行宿主 = 一个能跑 Node.js 20+ 的进程 + 一个可写目录 +（可选）一个 LLM HTTP 端点。**
>
> 不需要 UI、不需要数据库、不需要事件总线、不需要进程守护、不需要任何 DSH 的环境变量。
> `_scratch/naked-node-bootstrap.mjs` 是本结论的可执行证明 —— 它在纯 Node 下用 ~700 行拉起了一整套持久化能力层，完成了 retrieve 与 harvest。

---

## 1. 最小可行宿主环境（MVHE）

### 1.1 硬性三件套

| # | 原子能力 | 为什么不可再少 | 缺了会怎样 |
|---|---|---|---|
| **A1** | **一个 Node.js ≥ 20 的进程** | 彼岸层的全部实现是 ESM 模块；`stripTypeScriptTypes` 需要 22.6+，但**运行时**只需要 20+（构建产物已是纯 JS） | 什么都不成立 |
| **A2** | **一个可读写的目录**（单一根即可） | 存储层、技能库、账本、游标全在里面。彼岸层不要求它是"哪个"目录，只要求**能给一个** | 无法持久化；retrieve 只能读到空库，harvest 无处落盘 |
| **A3** | **`node:fs` / `node:path` / `node:crypto` / `node:zlib`** | 这四个是 Node 内置，不需要安装；彼岸层的 L0 驱动直接用它们 | 用 L1 内存驱动可以绕开 fs，但**重启即失忆** |

### 1.2 可选（缺失时降级，不崩溃）

| # | 能力 | 缺失时的降级 | 谁需要它 |
|---|---|---|---|
| **B1** | **一个 LLM 的 HTTP 端点 + Key** | `retrieve` 退化为**纯词法检索**（`semanticFilter:false`）；`harvest` 的 `extractor` 退化为 `off`（只扫账本，不提取）。**不报错，只是变笨** | `extractEpisode()` / `selectApplicableSkillsDetailed()` |
| **B2** | **一个"会话日志"读取通道** | `harvest` 跳过所有会话，返回一条 `readSession returned nothing` 的警告 | `ctx.sessionQuery.readSession(id)` |
| **B3** | **stdout / stderr** | 无日志。功能不受影响 | 人 |
| **B4** | **网络以外的任何服务** | 无 | 无人需要 |

### 1.3 明确**不需要**的（这张表同样重要）

| 常被误认为必需 | 实际上 |
|---|---|
| 一个 UI / 浏览器 | ❌ 全链路无 UI 依赖 |
| 数据库 / SQLite | ❌ L0 是文件，L1 是内存 Map + 异步落盘 |
| 事件总线 / pub-sub | ❌ `subscribe` 在无事件源时返回 no-op 取消函数，这是协议允许的 |
| 进程守护 / supervisor | ❌ 无守护进程概念 |
| `DSH_*` 环境变量 | ❌ **零个必需**。`DSH_PROFILE_DIR` 只作为存储目录的一个**兜底来源**，有 `config.dataDir` 就轮不到它 |
| Windows / macOS / Linux 任一特定平台 | ❌ 唯一平台相关处是路径分隔符，`node:path` 已处理 |
| `dsh` / `cordis` 包 | ❌ **协议层零引用**（`protocol-purity.test.mjs` 守着这条） |

### 1.4 一个真实的下限，量给你看

```
入口        dsh-memory/lib/index.js               ← 纯 JS，无构建步骤
协议        dsh-paradise/index.js                 ← 纯 JS
存储        <你给的任意目录>                        ← 一个 mkdtemp 就够
LLM         POST <任意 OpenAI 兼容端点>            ← 一个 fetch 就够
--------------------------------------------------------------
总依赖包     0 个（除 Node 内置）
总环境变量   0 个必需
总外部服务   0 个必需
```

---

## 2. `adapters/dsh/` 逐文件分类

判定标准只有一条：
> **换一个宿主，这个文件的"内容"还需要重写吗？**
> 需要重写 = **宿主特有**（Host-Specific，必须由新宿主提供）
> 只用改注入的值 = **通用**（Portable，可原样复用）

### 2.1 宿主特有 —— 换宿主必须重写（9 个文件）

| 文件 | 它知道什么 DSH 的事 | 换宿主要做什么 |
|---|---|---|
| `paths.ts` | 会话目录的 `~XXXX` 转义、`--` 包裹、`sessions/<escaped cwd>/<id>/` 布局、`session.v4.jsonl.zstd` 文件名 | **整个重写**。别的宿主可能根本没有"会话目录"这个概念 |
| `policy.ts` | 哪些事件类型会被对话视图**渲染**（`user/message`、`assistant/message`）、intent→type 的映射、`plugin:` 前缀 | **重写映射表**。这是"这个宿主的 UI 怎么显示"的测量结果 |
| `session.ts` | 五个会话动词压在 `sessions` / `sessionPersistence` / `sessionController` 上 | **重写**。除非新宿主恰好也叫这些名字、也有这些方法 |
| `session-writer.ts` | 冷会话的"prepare → create → append → flush → close"五步落盘法 | **重写**。别的宿主的写入原语不同 |
| `inject.ts` | 转录事件的具体形状（`surfaceOp`、`stream: []`、`no sourceEventSeqs`……） | **重写**。这是 DSH 的磁带格式 |
| `trigger.ts` | `sessionController.prompt` + `remote.session.prompt` 两条点火通道 | **重写**。别的宿主怎么"让会话开始跑"是它自己的事 |
| `delete.ts` | `sessionPersistence` 的删除 + 核实语义 | **重写** |
| `lease-sync.ts` | **一个同步租约，建在"目录即锁"上** —— 因为 DSH 侧有个端到端同步的 store，转成 async 会改签名 | **重写或删除**。裸机上如果有 L1 内存驱动，就不需要它 |
| `capability.ts` / `assert-capabilities.ts` | 探测的**是一张 DSH 服务名清单**（`sessions`、`sessionPersistence`、`sessionQuery`、`workspaceRegistry`、`sessionController`） | **重写清单**。探测的**机制**（见下）可以照抄 |

### 2.2 通用 —— 任何宿主都需要的（3 个文件，机制可原样复用）

| 文件 | 通用的是什么 | 换宿主怎么改 |
|---|---|---|
| `services.ts` | **"按你即将调用的方法去解析服务"** —— 先试 `ctx[name]`，再试 `ctx.get(name)`，选**真的有那个方法**的那个 | **一行不用改**。任何"服务容器"都有这个歧义 |
| `storage.ts` | **原子写 + 快照回滚 + 损坏自愈**的完整机制 | 改 `baseDir` 的来源（`config.dataDir` → 别的）。**机制一行不用改** |
| `tools.ts` | **把异常变成 `isError: true` 的结果**、超时用 AbortSignal、`list` 尽力而为 | 改 `service(ctx,'tools')`。**机制一行不用改** |

### 2.3 装配 / 占位（3 个文件）

| 文件 | 是什么 |
|---|---|
| `index.ts` | **装配**：把 adapter 打包成一处，并在此处决定 strict。换宿主照抄结构、换 import 路径 |
| `publish.ts` | **能力常量**（`workspaceRegistry.resolveByPath` / `ctx.emit`）+ 一个"未实现"抛出器。换宿主重写这两个常量 |
| `capability.ts` 已计入 2.1 | — |

### 2.3 已经是通用的 —— 根本不在 `adapters/` 里

| 模块 | 位置 | 说明 |
|---|---|---|
| 协议全部 | `src/protocol/` | **零宿主名**，`protocol-purity.test.mjs` 守着 |
| 租约 | `src/lease.ts` / `lease-adapter.ts` | 建在 `StorageAdapter` 之上，对宿主无感 |
| L1 内存驱动 | `src/storage-memory.ts` | 纯 JS 对象，零宿主 |
| 分层选择 | `src/storage-tiers.ts` | `chooseStorageTier()` 是唯一决定"哪层活着"的地方 |
| 磁盘读 | `src/read/disk.ts` | 收路径或"给我路径"的回调，不知道路径怎么来的 |

### 2.4 分类的量化

```
adapters/dsh/ 共 15 个文件
├── 宿主特有（必须重写）      9 个    60%   paths policy session session-writer
│                                          inject trigger delete lease-sync
├── 通用机制（改注入值即可）   3 个    20%   services storage tools
├── capability 探测           1 个     7%   assert-capabilities
└── 装配 / 占位               2 个    13%   index publish
```

> 注：`capability.ts` 与 `assert-capabilities.ts` 是同一件事的两半（探测 + 拒绝），
> 表中按"探测"合并计一行。

**这个比例就是自举的成本**：一个 AI 要在新宿主上重建彼岸层，需要写的是 **9 个文件**，其中真正"动脑"的是 4 个（paths / policy / session / inject），另外 5 个是**照着现有实现的形状填空**。

---

## 3. 一个 AI 要自举，需要读到什么

按重要性排序，这也是 `SELF_HEALING_PROMPT.md` 会喂给它的材料：

| # | 材料 | 在哪 | 为什么 |
|---|---|---|---|
| 1 | **协议接口定义** | `src/protocol/adapters.ts` | 它要实现的就是这几个 interface |
| 2 | **现有实现的形状** | `src/adapters/dsh/*.ts` | 照抄**结构**，替换**内容** |
| 3 | **一个能跑的参照** | `_scratch/naked-node-bootstrap.mjs` | 一个**完整的、最小的、可执行的**宿主 |
| 4 | **失败的具体形态** | `assertHostCapabilities` 的报错 | 说清"缺哪个方法、代价是什么、该改哪个文件" |
| 5 | **一致性测试** | `test/conformance.test.mjs` | 它写的适配器对不对，这里有答案 |

### 3.1 `assertHostCapabilities` 的报错契约（自修复的锚点）

`strict: true` 时，缺能力会抛出**具名拒绝**，而不是静默关闭：

```
HOST_CAPABILITY_MISSING
  缺什么      : sessions.prepare
  谁需要它    : write/create
  代价是什么  : 无法建造 detached 会话；孵化必须整体拒绝，绝不退化成 live append
```

这三段信息是自修复协议能工作的**全部依据** —— 有了它，AI 才知道"要补的是哪个方法"，而不是拿到一句 `undefined is not a function`。

---

## 4. 自举的四个台阶（每一阶都可独立验证）

| 台阶 | 目标 | 验证方式 | 状态 |
|---|---|---|---|
| **T0** | 协议在零宿主下跑通 | `_scratch/bootstrap-test.mjs` | ✅ **39/39**（上一轮） |
| **T1** | 一个**手写的最小宿主**能承载协议 | 同上 B 组（~60 行 NativeFileAdapter） | ✅ **9/9** |
| **T2** | **真实插件**（dsh-memory）在这个宿主上完成真实工作 | `_scratch/naked-node-bootstrap.mjs` | ✅ **32/32**（本轮） |
| **T3** | 宿主缺失时，AI 能**自己补出适配器** | `SELF_HEALING_PROMPT.md` | ⏸ 待你指令 |

**T2 是分水岭**：T0/T1 证明的是"协议可实现"，T2 证明的是"**一个真实的、有 263 项测试的插件，在裸机上认不出自己在哪，却照样工作**"。

T2 的 32 项分成六组，每一组都在证一件事：

| 组 | 证明什么 |
|---|---|
| 0 | 裸机前提：`DSH_*` 环境变量已移除、无宿主 ctx |
| 1 | 手写宿主满足协议；L1 内存层可架在它上面 |
| 2 | `dsh-memory` 在这个 ctx 上可以求值 |
| 3 | **retrieve**：检索到技能、因果链可走 |
| 4-5 | **harvest**：认出已退休会话、四层提取全部落盘 |
| 6 | 重读：记忆从磁盘重建，不是内存假象 |
| 7 | **加载图终检**：DSH 适配器一次都没被加载/激活 |
| 8 | **降级**：LLM 挂了它优雅失败，不伪造内容、不标记已处理 |

### 4.1 T2 暴露的两条"插件对会话形状的真实要求"

这两条**与 DSH 无关**，是 `dsh-memory` 自己的契约。写在这里，因为它们是最容易踩的坑，而且报错完全不指向根因：

| # | 要求 | 不满足时 |
|---|---|---|
| 1 | 分层记忆只接受**三类 seq** 作证据：助手结论、成功的 `tool/result`、失败的 `tool/result` | 用户的提问、`turn/start`、`tool/call` 的 seq 会被 `asSeq()` 丢弃 |
| 2 | 正文必须放在 **`message.content[]` 的 `{type:'text', text}` 块**里 | 写成 `message.text` 会被 `textOf()` 读成空串，那个 seq 既不算成功也不算失败，**永远不进证据集** |

第二条尤其隐蔽：日志里"明明看得见那段文字"，但因果链和技能提取对它完全免疫。**这是我在本轮亲手踩到的**，`naked-node-bootstrap.mjs` 的注释里留了完整记录。

---

## 5. 裸机自举时，三个插件各自的处境

| 插件 | 在裸机上需要什么 | 状态 |
|---|---|---|
| **dsh-paradise** | 无。它**就是**要被拉起的对象 | ✅ 本身就是裸的 |
| **dsh-memory** | `paths`(可选) / `llm`(可选) / `sessionQuery`(可选) —— **三个全部可选** | ✅ 已在裸机上跑通（本轮） |
| **dsh-graft-slice** | 基本是**宿主特有的**：它的存在意义就是"切 DSH 的会话日志、点 DSH 的火"。裸机上它没有可切的对象 | ⚠️ 需要一个新的宿主给它"会话"概念 |
| **dsh-observer** | 同理，它观察的是宿主的会话生命周期 | ⚠️ 同上 |

> **这是一个必须说清楚的边界**：彼岸层 + `dsh-memory` 在裸机上是**真跑得起来**的（本轮已证）。
> 但 `graft-slice` 与 `observer` 在裸机上需要**先有一个"会话"的概念** —— 而"什么是会话"恰恰是 DSH 提供的。
>
> 所以要"让三大插件都在裸机上跑"，缺的不是彼岸层，而是**一个最小的 SessionAdapter 实现**（把"会话"定义成一个 jsonl 文件 + 一个 prompt 回调）。这正是 T3 之后的事。

---

## 6. 本指南的可执行附录

```bash
# 验证 T0 + T1（协议在手写宿主上跑通）
node _scratch/bootstrap-test.mjs

# 验证 T2（裸机拉起真实的 dsh-memory，跑 retrieve + harvest）
node _scratch/naked-node-bootstrap.mjs

# 验证适配器分类没有说谎（协议层零宿主名）
cd dsh-paradise && node --test test/protocol-purity.test.mjs
```

---

## 7. 留给下一个实现者的一句话

> 你不需要理解 DSH。
> 你需要理解 **`src/protocol/adapters.ts` 里的那几个 interface**，然后回答一个具体的问题：
> **"在我脚下这台机器上，'创建一个会话'到底是什么动作？"**
>
> 答完这个问题，剩下的都是填空。
