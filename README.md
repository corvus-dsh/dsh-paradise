# dsh-paradise — 彼岸层

> ## ⚠️ 自修复是**测试功能**：不填凭据就只是适配层
>
> **先把边界说清楚，否则你会以为它能做它没做的事。**
>
> | 你填了什么 | 彼岸是什么 | 能做什么 |
> |---|---|---|
> | **不填**账号 / API Key | 只是一个**适配层** | 协议 + 适配器 + 独立宿主 / 看门狗 / UI。能**检测**宿主异常、能降级、能把崩溃现场记录下来。**不会自己拉起会话去修**——没有模型，就没有"修"这个动作。 |
> | **填入你自己的**账号 / API Key | 才具备自修复链路 | 检测到宿主失效 → **自动拉起维修会话**（走你自己的 API）→ 读崩溃信息与源码 → 产出修复 → 执行 → **重启宿主 → 再探一次确认它真的回来了**。 |
>
> **它的目标场景是最难受的那一种**：宿主里的会话在开发插件时把宿主本身搞崩了，界面死在半路、对话不会再继续——这时彼岸被拉起来，用你的 API 起一个维修会话，把宿主修好并拉回来。
>
> **凭据是你自己的**：仓库里不含任何 Key，也不会自动获取。配置方式见下文「三、没有模型 Key 时会怎样」。
>
> **为什么仍标"测试功能"**：请先在非生产环境演练一遍。已知限制——沙箱是**抬高门槛**而不是安全边界（`node:vm` 官方明确不是安全机制）；模型写出的修复脚本可能有误，所以每次尝试都会落进 `reports/` 供事后审计。

<!-- INSTALL:BEGIN -->
## 安装

两条路都可用。**按你需要选一条**，不要混装同一插件。

## 路线 A：npm registry（beta 通道）

四个包都发布在 `@corvus-dsh/*` 作用域下，当前通道是 **beta**：

```bash
dsh plugin add @corvus-dsh/dsh-paradise@beta
dsh plugin add @corvus-dsh/dsh-memory@beta
dsh plugin add @corvus-dsh/dsh-graft-slice@beta
dsh plugin add @corvus-dsh/dsh-observer@beta
```

先确认 registry 上是哪一版：

```bash
npm view @corvus-dsh/dsh-paradise@beta version
```

## 路线 B：GitHub 直装

```bash
dsh plugin add github:corvus-dsh/dsh-paradise
dsh plugin add github:corvus-dsh/dsh-memory
dsh plugin add github:corvus-dsh/dsh-graft-slice
dsh plugin add github:corvus-dsh/dsh-observer
```

## 两条路的区别（选之前先读这三行）

| | registry（路线 A） | GitHub 直装（路线 B） |
|---|---|---|
| 拿到的是什么 | **已发布、已固化**的产物 | **仓库当前状态**（可能含未发布提交） |
| 复现某版本 | 可以：`@corvus-dsh/dsh-paradise@0.9.1-beta.1` | 不可以（要 checkout 对应 tag 再装） |
| 适合 | 部署、回归、报 bug 时给出确切版本 | 跟进最新修复、本地开发 |

**顺序有意义**：`dsh-paradise` 是内核，其余三个都依赖它提供的协议。先装内核，后装业务插件。

## 装完确认

```bash
dsh plugin list
```

应该看到四行，`fiberPhase` 都是 `active`：

```
include:dsh-paradise       dsh-paradise        active
include:dsh-graft-slice    dsh-graft-slice     active
include:dsh-memory         dsh-memory          active
include:dsh-observer       dsh-observer        active
```

如果某个是 `null` 或显示「异常」，看宿主日志里该包的启动错误——最常见的原因是 Node 版本低于 22.5。

## 卸载

```bash
dsh plugin remove dsh-observer
dsh plugin remove dsh-graft-slice
dsh plugin remove dsh-memory
dsh plugin remove dsh-paradise
```

## 从源码运行（不装插件）

如果只是想跑独立宿主和 Web UI，不需要 DSH：

```bash
git clone https://github.com/corvus-dsh/dsh-paradise
cd dsh-paradise
node dist/harness-server.js
# 浏览器打开 http://127.0.0.1:38080
```

详见《星火 OS 独立运行指南》。

## 要求

| 项 | 版本 |
|---|---|
| Node | ≥ 22.5.0（`node:sqlite` 需要） |
| DSH | ≥ 0.2.1-rc.5 |
| 外部依赖 | **零**。全部只用 Node 内置模块 |

## 为什么包名带作用域

npm 上的**裸名** `dsh-memory` 和 `dsh-observer` 已被第三方注册，包内容与我们无关。
我们不愿为一个名字支付赎金，也不愿让用户装到别人的包，所以改用作用域命名
（`@corvus-dsh/*`）——**请始终用带作用域的名字**，裸名指向的不是本项目的包。
<!-- INSTALL:END -->

<!-- HOST:GUIDE:BEGIN -->
## 星火 OS 独立宿主与看门狗

> 本节回答：怎么把彼岸层当宿主用，怎么让它自己发现崩溃并自愈，以及没有模型 Key 时它还能做什么。

---

## 一、独立宿主：`node dist/harness-server.js`

**这是完全脱离 DSH 桌面端的运行方式。** 一条命令启动宿主和 Web 界面。

```bash
cd dsh-paradise
node dist/harness-server.js
```

然后浏览器打开 **http://127.0.0.1:38080**

### 能做什么

| 区域 | 内容 |
|---|---|
| 侧边栏 | 节点列表（状态、消息数、token 数），点击切换 |
| 主聊天区 | 与选中节点对话，气泡按角色着色 |
| 状态面板 | 模型状态、节点统计、软接管次数、记忆库四层计数、工单 |
| 宿主守护 | 看门狗是否运行、DSH 存活状态、崩溃原因与日志路径 |

### 三个按钮

- **+ 新节点**：建一个空白节点
- **建 3 节点**：一键创建 策划 / 开发 / 测试，各带独立 system prompt，同时生成 3 张工单
- **一键提炼记忆**：对历史会话提炼四层记忆（无模型时明确拒绝，不假装成功）

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `38080` | 监听端口 |
| `--host` | `127.0.0.1` | 绑定地址（默认仅本机） |
| `--home` | `./.starfire` | 数据目录（会话、节点、记忆） |
| `--quiet` | — | 不打印启动横幅 |

### 数据落盘

```
<home>/
├── sessions/node-*.jsonl   会话日志，一行一个事件，重启后自动恢复
├── nodes/                  spawnNode 产出的节点种子
└── memory/                 facts / experiences / negatives
```

### 常用 API

```bash
curl http://127.0.0.1:38080/api/state                    # 全部状态
curl -X POST http://127.0.0.1:38080/api/session -d '{}'  # 建节点
curl -X POST http://127.0.0.1:38080/api/team -d '{}'     # 建三角色
curl -X POST http://127.0.0.1:38080/api/repair \
  -H "content-type: application/json" \
  -d '{"reason":"host died","crashLog":"/path/crash.log"}'  # 触发维修节点
```

---

## 二、看门狗：`node dist/watchdog.js`

### 两种状态

```
HOSTED      DSH 活着。只探测，不做别的。
REPAIRING   DSH 死了。拉起独立环境，下发维修指令，直到 DSH 回来。
```

**顺序是关键：维修环境由看门狗启动，不由 DSH 启动。** 活在被修对象里的维修会话会和它一起死。

### 启动

```bash
# 同时探测 pid 文件和端口
node dist/watchdog.js \
  --pid-file ./.starfire/dsh.pid \
  --probe-port 8080 \
  --repair-env-port 38080 \
  --interval 10000
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--pid-file` | — | 被监视进程的 pid 文件 |
| `--probe-port` | — | 被监视服务必须应答的端口 |
| `--repair-env-port` | `38080` | 独立环境端口 |
| `--repair-home` | `./.starfire` | 独立环境数据目录 |
| `--log-root` | 同 repair-home | 崩溃日志搜索根目录 |
| `--interval` | `10000` | 探测间隔（毫秒） |
| `--once` | — | 只探测一次然后退出 |
| `--dry-run` | — | 不启动独立环境 |

### 触发后发生什么

```
探测失败（连续达阈值）
  → 找崩溃日志（排除自己的 watchdog.log）
  → 启动 harness-server.js（若未运行）
  → POST /api/repair，用 createSession 造一个维修节点
  → 维修节点出现在 UI 节点列表，标题「维修 · <原因>」
  → 状态写入 watchdog-state.json，UI 守护面板亮红灯
```

**实测**：强杀 DSH 到维修节点创建完成，1.6 秒。

### 它不做什么

- **不重启 DSH**。诊断和改配置是模型的工作。看门狗只负责让维修环境就位并知道发生了什么。
- **不在没有模型时假装修好**。没有 Key 时维修节点会记录拒绝，而不是编造一个修复方案。

---

## 三、没有模型 Key 时会怎样

**这一条必须写清楚，因为它决定你能不能用。**

| 能力 | 有 Key | 无 Key |
|---|---|---|
| 启动宿主 / 打开 UI | ✅ | ✅ |
| 建节点 / 切换节点 / 看列表 | ✅ | ✅ |
| 会话持久化 / 重启恢复 | ✅ | ✅ |
| 与节点对话得到**真实回答** | ✅ | ❌ 明确回复「没有配置模型凭据」 |
| 提炼记忆生成 SKILL.md | ✅ | ❌ 明确拒绝 |
| 看门狗发现崩溃 | ✅ | ✅ |
| 看门狗拉起维修环境 | ✅ | ✅ |
| 维修节点**诊断并写出修复** | ✅ | ❌ 记录拒绝 |

### 结论

> **如果没有配置 Key，系统能自愈到降级状态，但需要人类介入修复。**

具体地：看门狗能发现 DSH 死了、能拉起独立环境、能创建一个维修节点并把崩溃原因和日志路径写进去 ——
但这些**不会变成一个真正的修复**，因为写修复需要模型。你需要：

1. 看 UI 守护面板的红灯和原因；
2. 打开那个「维修」节点，看它记录了什么；
3. **自己**读日志、改配置、重启 DSH。

这不是缺陷，是把「机器能做到什么」和「只有在有模型时才能做到什么」分开说清楚。

### 配置 Key

```bash
# PowerShell
$env:DSH_HARNESS_BASE_URL="https://api.deepseek.com/v1"
$env:DSH_HARNESS_API_KEY="sk-..."
$env:DSH_HARNESS_MODEL="deepseek-chat"
node dist/harness-server.js
```

```bash
# bash
export DSH_HARNESS_BASE_URL=https://api.deepseek.com/v1
export DSH_HARNESS_API_KEY=sk-...
export DSH_HARNESS_MODEL=deepseek-chat
node dist/harness-server.js
```

配置成功后，UI 右上角「模型」显示 **已连接**（绿色）。

---

## 四、软接管

宿主在 agent loop 内监控两个指标：

| 指标 | 阈值 | 含义 |
|---|---|---|
| 连续工具失败 | 3 次 | 同一个操作反复失败 = 在循环，不是在学 |
| 上下文估算 token | 60000 | 对话太长，马上要丢掉开头 |

超限时注入：

```
[强制中断] 连续 3 次工具失败。请立刻停止当前做法，改用不同的思路；
如果无法推进，直接说明卡在哪里，不要重复同一个失败的操作。
```

接管次数在 UI 状态面板可见。**它不重写对话、不声称已修复** —— 一个声称解决了问题的接管比没有更糟。

---

## 五、请求重试与故障

**端口被占**：`--port 38081`

**启动即退出**：终端会打印具体原因（EADDRINUSE / EACCES / 其他），不会静默退出。

**页面空白**：检查终端有没有 `在浏览器打开：http://...`。没有说明进程退了。

**发消息无反应**：看状态面板「模型」是否「未配置」。

---

*完整验证脚本：`_scratch/e2e-harness.mjs`（8 项）、`_scratch/e2e-two-state.mjs`（6 项）。*
<!-- HOST:GUIDE:END -->



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
| **observer 改用适配器** | ✅ 写路径已完成（走 `paradise.session`）。`observer-inject.ts` 保留为存档，但**仍被 4 个只读助手 import**（`InjectError` / `resolveInheritedCwdAsync` / `resolveService` / `shortSessionTag`）；彻底移出是下一次清理。 |
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

**当前 354/354。** preflight 14 项，其中三项是这一层独有：

- 产物里的**协议区不含宿主名**（源码干净 ≠ 打包后干净）；
- 两条拒绝路径仍然存在（`NOT_IMPLEMENTED` 与 `NOT_WIRED`）；
- 写机制导出齐全（`deleteSession` 丢了下游回滚就静默坏掉）。

## 已知边界

> **v2.1.0 更新**：本节第 4、5 条曾经是事实，现在是**过期陈述**，已删除。
> 下游两个插件早已切换到本层，见下。

1. **路径推导依赖未被承诺的目录布局。** 已标成 `derived:`，失效方式是"读文件失败"，不会伪造成功。
2. **`RENDERED_CONVERSATION_TYPES` 是实测常量**（住在 `adapters/dsh/policy.ts`），只用于**报告**。
3. **`inject` 只覆盖 create 时放置**。向已存在会话追加是另一条路径（打开持久句柄写 step-scoped 事件），未接线且如实报告。
4. **沙箱的 fs 白名单不是安全边界。** `within()` 只做词法规范化（`path.resolve`），
   **不解析符号链接 / Windows 目录联接**——沙箱根内若存在一个指向外部的 junction，
   白名单可以被绕过。需要真正隔离请用 `node --permission` / 容器 / seccomp。
   这条一直写在 `sandbox.ts` 的注释里，现在也写进 README，因为它是用户该知道的事。
5. **裸机模式不含宿主能力诊断。** `assertHostCapabilities` / `REQUIRED_HOST_CAPABILITIES`
   只从插件入口 `index.js` 导出，`dist/harness.js`（独立 CLI）里没有。也就是说
   "宿主升级导致插件加载失败"能诊断，但"宿主彻底起不来"时只能靠 CLI 的通用探针。
6. **TD：自愈闭环的两条端到端用例不稳定（2026-11-09 登记，冻结期不修）。**
   - **现象**：`test/v090-selfheal-loop.test.mjs` 的
     `self-heal: a chatty model still closes the loop, and the host is restarted exactly once` 与
     `self-heal: an unusable reply fails LOUDLY and names the text that was compiled` 偶发失败，
     套件计数随之从 **354 掉到 353 / 352**。
   - **实测频率（2026-11-09，本机）**：**单跑 10 次红 2 次**；此前并行跑全量时 6 次观察到 1 次。
     两个数字都记下来，因为「只在并行时现」与「单跑也会红」指向完全不同的原因，而实测支持后者。
   - **性质**：这两条是**真起子进程、真重启宿主、再查 pid 存活**的端到端用例，
     涉及进程退出与端口占用的时序，不是纯函数断言。
   - **为什么不修**：冻结期只做事实层收敛，改它属业务逻辑；且根因尚未定性
     （子进程退出时序 / 端口复用 / 日志 watchdog 竞态都还没排除）。
   - **复查方式**：单跑 10 次；若单跑稳定为 0 红，则说明是并行资源争用，只需降低并发；
     若单跑仍红，才是代码时序问题，届时应改用「等待条件」而不是固定等待。
   - **对闸门的影响**：`scripts/check-readme-counts.mjs` 在套件未全绿时**判红并列出失败用例**，
     且**不**据此断定「文档过期」——否则一次 flaky 会报出假的文档错误，假红会让闸门被关掉。

### 下游插件：彼岸层已经完全接管（不再是"并存"）

| 插件 | 现状 | 证据 |
|---|---|---|
| **`dsh-observer`** | ✅ **写路径完全切换**。孵化/点火/回滚必经本层（`paradise-write.ts` → `paradise.session.create` / `paradise.session.trigger` / `paradise.deleteSession`）。`observer-inject.ts` 仅作存档留在磁盘上，**生产代码零调用**；它仍被 import 的只有**只读辅助**（cwd 供体链、错误类型）与 `injectionInternals`（测试用的内存校验器）。 | observer 的 `manifest.json` 红线 `singleWritePath`；`scripts/preflight.mjs` 会**拒绝**任何 `await injectColdSession(` 调用；`test/paradise-bridge.test.mjs` |
| **`dsh-graft-slice`** | ✅ **完全切换**。切片写入、冷读校验、回滚、点火全走本层适配器。 | graft 的 `src/core/paradise-write.ts`；`test/inject.test.mjs` |
| **`dsh-memory`** | ⚠️ **部分**：**锁**已改用本层租约（v0.30），**存储**仍是自己的 SKILL.md 文件树（键值存储表达不了用户级可编辑文件树，这是一次刻意的范围裁决）。 | memory 的 `src/lease-bridge.ts`；`test/v030-lease-lock.test.mjs` |

> 曾经的"observer 走自己的 `observer-inject.ts`"与"graft-slice 一行未动"不再是边界，
> 而是**历史**。把过期陈述留在"已知边界"里，读者会把它当事实——那正是本节要避免的事。

## 许可

MIT
