# v0.37 报告 — 彼岸自举协议：最小可行宿主、裸机模拟，与"火种"

> 日期：2026-11-06
> 交付物：`dsh-paradise/BOOTSTRAP_GUIDE.md`（新建）· `_scratch/naked-node-bootstrap.mjs`（新建）
> 验证：裸机自举 **32/32** · 四套测试 **545 / 263 / 183 / 174** 全绿
> 结论：**在没有任何 DSH 的纯 Node.js 环境里，彼岸协议拉起了一整套持久化能力层，并让真实的 `dsh-memory` 完成了 retrieve 与 harvest。**

---

## 1. 你要的两件事，做完了

| 你的要求 | 状态 | 证据 |
|---|---|---|
| 一.1 最小可行宿主环境的原子能力 | ✅ | `BOOTSTRAP_GUIDE.md` §1：**3 项硬性 + 4 项可选 + 6 项"明确不需要"** |
| 一.2 `adapters/dsh/` 逐文件分类 | ✅ | 同 §2：**15 个文件 → 9 特有 / 3 通用 / 1 探测 / 2 装配** |
| 二.1 完全脱离 DSH 的脚本 | ✅ | `naked-node-bootstrap.mjs`，`DSH_*` 全部移除，加载图终检 |
| 二.2 手写 RawNodeAdapter（fs + fetch） | ✅ | 会话 = 一个 jsonl 文件；存储 = 原子写；LLM = 一次 fetch |
| 二.3 拉起 dsh-memory，跑 retrieve + harvest | ✅ | **32/32**，四层记忆全部落盘 |
| 二.4 纯 CLI 存活 | ✅ | 全程无 UI、无浏览器、无事件总线 |

**没有**写 `SELF_HEALING_PROMPT.md` —— 你说了"请先完成第一、二项"。

---

## 2. 最小可行宿主：三件硬性 + 一件可选

```
A1  一个 Node.js ≥ 20 的进程
A2  一个可读写的目录
A3  node:fs / node:path / node:crypto / node:zlib   （全部内置，零安装）
B1  一个 LLM 的 HTTP 端点 + Key                      （可选，缺了只是变笨）
```

### 2.1 更值得注意的是"明确不需要"那张表

| 常被误认为必需 | 实际上 |
|---|---|
| UI / 浏览器 | ❌ 全链路无 UI 依赖 |
| 数据库 / SQLite | ❌ L0 是文件，L1 是内存 Map + 异步落盘 |
| 事件总线 | ❌ `subscribe` 在无事件源时返回 no-op（协议允许） |
| 进程守护 | ❌ 无此概念 |
| **`DSH_*` 环境变量** | ❌ **零个必需**（脚本里实测移除了 6 个，功能不受影响） |
| `dsh` / `cordis` 包 | ❌ 协议层零引用 |

---

## 3. 裸机模拟：32 项断言，八组

### 3.1 脚本做了什么

```
RawNodeAdapter   ~200 行手写宿主
  ├── 会话 = sessions/<id>.jsonl（没有 zstd、没有转义目录、没有 workspace 分组）
  ├── 存储 = kv/<key>.json，原子写用 temp + rename
  └── sessionQuery.readSession = 直接读那个 jsonl

RawNodeLlm      两种实现，同一份插件代码
  ├── createScriptedLlm  离线确定性回答（AsyncIterable 契约完整）
  └── createFetchLlm     一次 fetch 到 OpenAI 兼容端点，SSE → delta
```

这不是"简化版 DSH"，这是**一个不同的宿主**。它证明协议不要求 DSH 的形状。

### 3.2 八组断言

| 组 | 证明 | 结果 |
|---|---|---|
| 0 | 裸机前提：`DSH_*` 已移除、无宿主 ctx | 3/3 |
| 1 | 手写宿主满足协议；L1 内存层可架其上并落盘 | 6/6 |
| 2 | `dsh-memory` 在这个 ctx 上可求值 | 1/1 |
| 3 | **retrieve**：检索到技能、因果链可走 | 3/3 |
| 4 | **harvest**：认出已退休会话、零丢弃 | 4/4 |
| 5 | 四层全部落盘，且带**复合证据指针** | 5/5 |
| 6 | 重读：记忆从磁盘重建 | 3/3 |
| 7 | **加载图终检**：DSH 适配器一次都没被加载 | 3/3 |
| 8 | **降级**：LLM 挂了优雅失败，不伪造内容 | 4/4 |

### 3.3 几个数字

```
harvest 后：negatives=1  facts=1  experiences=1  processed 游标已写
复合指针：  [{"sourceSessionId":"naked-source-1","seq":6}]   ← 不是裸 seq
三次重跑：  32/32  ·  32/32  ·  32/32                        ← 稳定，非偶然
```

### 3.4 第 7 组为什么值得单独存在

前六组证明的是"**我没写 `import` DSH**"。第 7 组证明的是"**它真的没被加载**"—— 两者不是一回事：一次间接 re-export、一次导入的副作用，都可能把 `adapters/dsh/` 拖进来，而源码里看不到一行 import。

所以第 7 组直接查运行时事实。三条互相独立的证据：

- `E1` 独立模块缓存里没有 `adapters/dsh/*` 文件；
- `E2` 依赖链上的会话适配器自报名字是 `raw-node`，**不是** `dsh-0.2.2`；
- `E3` 能力清单是手写宿主那一套，**不含** `sessionPersistence` 等 DSH 服务名。

> **一条我放弃了的路，理由要说清楚**：我本想把 `createDshAdapters` 换成一个计数的壳来断言"调用 0 次"。**ESM 模块命名空间是不可变的**，`Object.defineProperty` 直接抛 `TypeError: Cannot redefine property`。这不是障碍，是语言在正确地说"你不该这样测"。改用上面三条不依赖篡改的证据。

---

## 4. 本轮踩的两个坑（都是插件契约，不是 DSH 契约）

这两个坑报错完全不指向根因，价值高于任何"顺利跑通"的记录：

### 4.1 分层记忆只接受三类 seq 作证据

`segmentSession()` 算出的 `episode.evidence` **只包含**：
- 助手结论（`assistant/message`）
- 成功的 `tool/result`
- 失败的 `tool/result`

用户的提问、`turn/start`、`tool/call` 的 seq **不在其中**。我第一次写了 `seq: 3`（一个 `tool/call`）和 `seq: 5`，被 `asSeq(item.seq, allowed)` **全部丢弃**。

**那不是 harvest 失败 —— 那是校验在工作。** 一份"随便给个 seq"的记忆库，正是这个校验要阻止的东西。

### 4.2 正文必须在 `message.content[]` 里，不能在 `message.text`

`textOf()` 只从 `content[]` 取 `{type:'text', text}` 块。写成 `message.text` 会被读成**空串**，于是那个 seq 既不是成功也不是失败，**永远不进证据集**。

这个更隐蔽：日志里"明明看得见那段文字"，但因果链和技能提取对它完全免疫。

> 两次都是**我的脚本错、插件的校验对**。我把这两条写进了 `BOOTSTRAP_GUIDE.md` §4.1，也写在脚本的注释里 —— 省下一个人两小时。

---

## 5. 一个必须说清楚的边界

你说"让三大插件在裸机上跑"。**本轮只证到 `dsh-memory`。**

| 插件 | 裸机处境 |
|---|---|
| **dsh-paradise** | ✅ 它**就是**被拉起的对象 |
| **dsh-memory** | ✅ **已跑通**（本轮 32/32） |
| **dsh-graft-slice** | ⚠️ 它的存在意义是"切 DSH 的会话日志、点 DSH 的火"。裸机上**没有可切的对象** |
| **dsh-observer** | ⚠️ 同理，它观察的是宿主的会话生命周期 |

**缺的不是彼岸层，是"什么是会话"这个定义。** 那个定义目前由 DSH 提供。

要让三大插件都上裸机，需要一个**最小的 SessionAdapter 把"会话"定义成"一个 jsonl + 一个 prompt 回调"** —— 本轮脚本里其实已经写出来了（`RawNodeAdapter`），只是 `graft-slice` 还没有被改造成"在一个外部给定的 adapter 上工作"。

**这是诚实的缺口，不是失败。** 说成"三大插件都跑起来了"是不诚实的。

---

## 6. 红线复核

| 约束 | 本轮 | 证据 |
|---|---|---|
| 1. 不用 `live.append` / `{turn:0,step:0}` | ✅ | 未触及 |
| 2. 协议 Interface 无 dsh/cordis | ✅ | `protocol/*.ts` 零匹配（上一轮已验，本轮未改协议） |
| 3. 不得因重构改变行为 | ✅ | 四套 **545/263/183/174** 全绿；**本轮未改任何插件源码**，只新增两个文件 |
| 4. 检查直接调用 fs / 写死绝对路径 | ✅ | 新脚本的路径全部 `fileURLToPath(import.meta.url)` 派生；临时目录用 `mkdtempSync` |
| 5. 只在适配层改，上层插件不动 | ✅ | **本轮零插件改动** —— 全部是新文件 |

**第 5 条要特别说明**：本轮一个字符都没改 `dsh-memory` / `dsh-paradise` / `dsh-graft-slice` 的源码。裸机能跑通这件事，**是在现有代码上验证出来的，不是改出来的**。这比任何重构都更能说明抽象站得住。

---

## 7. 下一步（等你指令）

1. **`SELF_HEALING_PROMPT.md`** —— 第三项。锚点已经就位：`assertHostCapabilities` 的具名拒绝（缺什么 / 谁需要 / 代价是什么）是自修复能工作的全部依据。
2. **最小 SessionAdapter 让 `graft-slice` 上裸机** —— 把"会话"定义成 jsonl + prompt 回调，这是 §5 那个缺口的正式出口。
3. `TIANHE_PROTOCOL.md` 草案。

---

## 附：本轮文件清单

| 文件 | 动作 |
|---|---|
| `dsh-paradise/BOOTSTRAP_GUIDE.md` | **新建** — 最小可行宿主 + 15 文件分类 + 四个自举台阶 |
| `_scratch/naked-node-bootstrap.mjs` | **新建** — 32 项断言的裸机自举证明 |
| 其余 | **零改动** |
