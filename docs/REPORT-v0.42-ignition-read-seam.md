# v0.42 报告 — 焊死最后两块拼图：裸机点火与 observer 读网关

> 日期：2026-11-06
> 交付物：`adapters/raw/ignition.ts`（新建）· `observer/src/core/paradise-bridge.ts`（读接缝）
> 验证：四套 **209 / 545 / 263 / 183** · 裸机切片+点火 **42/42** · observer 裸机 **27/27** · 网络 50/50 · 热切换 45/45

---

## 1. 两项要求，逐条对账

| 你的要求 | 状态 | 证据 |
|---|---|---|
| 一.1 裸机点火 = LLMAdapter.generate → 写回会话 | ✅ | `createBareIgnition` |
| 一.2 在 BareGateway 的 `binding.triggers` 里实现 | ✅ | provider 返回 `triggers` |
| 一.3 断言日志多出 `assistant/message` | ✅ | **2 → 3**，且正文写进去了 |
| 二.1 `inspectSessionLog` 换成可注入的 readLog | ✅ | `setSessionLogReader` |
| 二.2 DSH 侧读 zstd，BareGateway 读 JSONL | ✅ | 两条路都在，默认走宿主 |
| 二.3 observer 监控在裸机上跑通 | ✅ | **27/27**（含与 graft 联动） |
| 三 四套 + 29 项 + 50 项全量 | ✅ | 见 §5 |

---

## 2. 一、裸机点火：`TRIGGER_UNAVAILABLE` → 真的写出 assistant/message

### 2.1 三件事，每一件都是必需的

**1. 幂等靠日志，不靠内存标志。**

```ts
const already = before.events.some((event) =>
  ROLE_OF[event.type] === 'user' && textOfEvent(event).startsWith(marker))
```

`marker` 是**调用方给的**（graft 用 `[dsh-graft-slice 点火]`）。写死一个会让每个温热的目标看起来都是冷的，然后被重复点火——这正是 per-target admission map 存在的理由。而**日志是唯一持久的证据**：内存标志在重启后归零。

**2. 对话来自日志，不是只有一句触发词。**

实测模型收到了 5 条消息：

```
3.5e 模型收到的对话来自会话日志（不止一句触发词）— 5 条
3.5f 里面有 system/setup 消息
3.5g 里面有会话里原有的目标（回放内容）
3.5h 最后一条是触发词
```

**这条是整个功能的核心。** 一个迁移后的目标，上下文**已经写在日志里**了（设定、目标、重放历史）。只发触发词等于把那些全扔掉，然后回答一个没人问过的问题。

**3. 失败是回执，不是异常。**

调用方正在迁移中途。这里抛出去会留下一个半建的目标，而且没有诊断。所以每个失败路径都是具名回执：`SESSION_NOT_FOUND` / `LLM_CALL_FAILED` / `IGNITION_EMPTY_ANSWER` / `IGNITION_WRITE_FAILED`。

### 2.2 两个真实缺陷，都是我的 shim 错、插件的校验对

第一次跑，点火"成功"了，但 `assistant/message` 的数量没变：

```
FAIL  3.5i 目标日志里真的多了一条 assistant/message — 2 → 2
```

**根因**：我的 `inject` 把 `visible → user/message`，照抄了会话适配器的规则。那条规则对**注入上下文**是对的，对**模型的回答**是错的——一条助手回复存成 `user/message`，对之后每个消费者来说都成了"人说的话"。

修法：用 `origin` 区分（回答带 `ignition` 来源）。

第二个：

```
FAIL  3.5k 新事件的 seq 接续得上（没有跳号）— seq=10, tape=10
```

**根因**：用 `events.length`（11 行）当序号，而 header 是 `seq:-1`。于是写进去的 seq 是 **10，跳过了 9**。文件出现空洞，而空洞正是破坏续接的东西。

修法：从**最高 TAPE seq** 推下一个，header 不算。

> **两次都是"我的裸机实现错了，插件的规则是对的"。** 这和前几轮的 `SEEDED_HEADER`、`surfaceOp`、`content[]` 是同一类：**「没有 DSH」不等于「没有规则」。**

### 2.3 幂等的两层

```
3.5l 重复点火不会写第二条 — 3 → 3
3.5m 第二次回执说明"已经点过火"或"未尝试"
```

graft 自己的 admission map 是第一层，点火器的 marker 检查是第二层。两层都在，所以这里断言"不再增加"。

---

## 3. 二、observer 读网关

### 3.1 对照证明「写死了一条路」

不装 reader 时：

```
2a 没有接缝时读不到 jsonl 里的内容 — derived:sessions-layout
2b 它报告的是宿主侧的路径来源 — derived:sessions-layout
```

它会去**推导一个 DSH 的会话目录布局**，然后打开一个 zstd 帧文件。对一个 `.jsonl` 必然读不出来。

装上 reader 后：

```
3c 路径来源是裸机 reader — bare-jsonl
3e 事件数正确 — 9 vs 9
3g briefing 从事件里提取出来了 — {"seq":2,"type":"developer/message","role":"system",...
3h briefing 的第一行来自 system 消息 — 你是被监控的会话，专注完成交接的任务。
```

### 3.2 `briefing` 必须**推导**出来

这个字段原来由帧解码器免费提供。裸机 reader 只给事件，所以必须有人从事件里提取第一条非空行。

**如果忘了这件事，报告会打印 `briefing: null` —— 对一个明明有内容的会话。** 所以测试专门断言了 `textHead` 是**第一行**而不是全文。

### 3.3 三条降级路径

| 情况 | 行为 |
|---|---|
| 会话不存在 | `readable: false` + note |
| reader 抛错 | 报告里点名是哪个 reader 抛的（`3n`） |
| 卸载 reader | 恢复宿主路径（`4b`） |

### 3.4 联动：graft 切出来的会话，observer 能监控到

```
5a 切片成功 — obs-target
5b observer 能读到 graft 切出来的会话
5c 里面有事件 — 10 个
5e 也能读到源会话 — 6 个
```

**这是本轮最有意义的断言**：两个插件在裸机上不是各自能跑，而是**能互相看见对方的工作**。

---

## 4. 红线复核

| 约束 | 本轮 | 证据 |
|---|---|---|
| 1. `live.append` / `{turn:0,step:0}` | ✅ | 未触及 |
| 2. 协议无 dsh/cordis 字样 | ✅ | `protocol/*.ts` 零匹配 |
| 3. 不得因重构改变行为 | ✅ | 四套 209/545/263/183；graft 545、observer 183 全未改 |
| 4. 直接 fs / 写死绝对路径 | ✅ | 全部按参数派生 |
| 5. 只在适配层改，上层插件不动 | ⚠️ **改了一处，必须说明** | 见下 |

**第 5 条的破例**：我改了 `dsh-observer/src/core/paradise-bridge.ts`（加读接缝）和它的 `index.ts`（导出）。

**理由**：你要的就是让 observer 在裸机上跑，而读路径是它**真正干活的地方**。改法是**加接缝**，默认行为一字未变——183 项既有测试全部未改、全部通过。

`dsh-graft-slice` **零改动**：它的点火接缝（`binding.triggers`）上一轮就已经在了，本轮只是在**测试脚本**里给 provider 填上 `triggers`。

---

## 5. 全量验证

```
四套测试         209 / 545 / 263 / 183     全绿
裸机切片+点火     42 / 42
observer 裸机     27 / 27
网络适配器        50 / 50
API 热切换        45 / 45
```

**TD-M8 仍在**（本轮 memory 跑 1 次红、随后 4 次全绿）。它只走 `store.js`，本轮没动 store。

---

## 6. 现在可以跑的验证

```bash
# 裸机切片 + 点火（42 项，含 assistant/message 断言）
node _scratch/verify-bare-graft.mjs

# observer 裸机监控（27 项，含与 graft 的联动）
node _scratch/verify-bare-observer.mjs

# 网络 50 项 / 热切换 45 项
node _scratch/verify-network-store.mjs
node _scratch/verify-route-hijack.mjs
```

---

## 7. 本轮文件清单

| 文件 | 动作 |
|---|---|
| `dsh-paradise/src/adapters/raw/ignition.ts` | **新建** — 裸机点火触发器 |
| `dsh-paradise/src/adapters/raw/index.ts` | 改 — 导出 |
| `dsh-paradise/src/index.ts` | 改 — 导出 `createBareIgnition` |
| `dsh-observer/src/core/paradise-bridge.ts` | 改 — `setSessionLogReader` + `briefingOf` |
| `dsh-observer/src/index.ts` | 改 — 导出读接缝 |
| `dsh-paradise/test/bare-ignition-and-read-seam.test.mjs` | **新建** — 8 条 |
| `_scratch/verify-bare-graft.mjs` | 改 — 加 3.5 组（13 项点火） |
| `_scratch/verify-bare-observer.mjs` | **新建** — 27 项 |

---

## 8. 诚实边界

| # | 状态 |
|---|---|
| 裸机点火 | ✅ **已关闭** |
| observer 读路径 | ✅ **已关闭** |
| 两个插件互相看见 | ✅ 已验证 |
| TD-M8 | ⚠️ 仍在（已知，不动） |
| `NetworkStorageAdapter` | ✅ 已实现，但无认证/无复制/无共识 |

**现在三大插件在裸机上的状态：**

| 插件 | 裸机 | 说明 |
|---|---|---|
| `dsh-memory` | ✅ | 上一轮 32/32 |
| `dsh-graft-slice` | ✅ | 切片 + 点火 42/42 |
| `dsh-observer` | ✅ | 读 + 写接缝都已灌注，27/27 |

**这是三大插件第一次全部能在没有 DSH 的机器上完成各自的核心工作**，而且 graft 切出来的会话能被 observer 看见。

---

## 附：打包器守卫

你提到的「守卫再次抓到 export ... from 的坑」——本轮 `adapters/raw/index.ts` 里又踩了**两次**同一个写法（`isQuotaExhausted` 和 `route-config` 的导出）。两次都在构建期被拦下，没有进入产物。

一个守卫在同一个文件里抓到两次同类错误，说明它拦的不是"意外"，而是**一个容易养成的习惯**。这正是它值得存在的理由。
