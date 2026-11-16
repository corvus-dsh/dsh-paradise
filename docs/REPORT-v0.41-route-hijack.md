# v0.41 报告 — 换血续命：API 路由热切换，与裸机适配的核实

> 日期：2026-11-06
> 交付物：`adapters/raw/route-config.ts`（新建）· `adapters/raw/llm.ts`（路由热切换）· `test/route-hijack.test.mjs`
> 验证：四套 **201 / 545 / 263 / 183** · API 热切换 **45/45** · 裸机切片 29/29 · 网络互通 50/50 · 闭环 38/38
> 启动耗时：**91–142 ms**

---

## 1. 三项要求，逐条对账

| 你的要求 | 状态 | 证据 |
|---|---|---|
| 一.1 两插件靠注入获取 SessionAdapter / LLMAdapter | ✅ **上一轮已完成** | `setHostGateway` / `setWriteAdapterProvider` |
| 一.2 裸机验证 graft 切片 + observer 监控 | ✅ / ⚠️ | 切片 29/29；observer 写路径已验证，**读路径仍绑文件** |
| 一.3 **移除内部对 dsh/* 的直接 import** | ✅ **本来就是零** | 见 §2 |
| 二.1 LLMAdapter 捕获 429 / QUOTA_EXCEEDED | ✅ | `isQuotaExhausted` |
| 二.2 读 FALLBACK_API_URL / KEY 触发重路由 | ✅ | env → file 的优先级链 |
| 二.3 替换端点与凭证，重发失败的 generate | ✅ | **45/45**，真 429 真换端口 |
| 二.4 进阶：改 config.json 的 base_url 再重载 | ✅ | 已构造的 adapter 不重启即生效 |
| 三.1 harness 启动耗时 | ✅ | **91–142 ms**（`--once` 完整一轮 100–129 ms） |
| 三.2 四大模块全绿 | ✅ | **201 / 545 / 263 / 183** |

---

## 2. 一.3 的核实：**没有 dsh/* 的直接 import，一处都没有**

你要求「移除它们内部对 dsh/* 的直接 import」。我先查了才动手 —— 结果是 **0 处**：

```
grep "from '.*\/dsh\/"  dsh-graft-slice/src  →  No matches found
grep "from '.*\/dsh\/"  dsh-observer/src     →  No matches found
```

再查更宽的 `adapters/dsh` 字符串，命中 4 处，**全部是注释**：

| 文件 | 行 | 内容 |
|---|---|---|
| `graft/src/core/ignition.ts` | 9, 353, 382 | 注释：「prompt 通道已移到 paradise 的 trigger.ts」 |
| `observer/src/index.ts` | 94 | 注释：同上 |

**我没有为了让报告好看而去改动这些注释。** 它们记录的是「这段逻辑为什么在彼岸层而不是在这里」，删掉会丢失设计意图。

所以这一项的正确结论是：**它已经是纯净的，本轮无需改动。**

### 2.1 graft 的点火路径本来就走注入

点火通过 `binding.triggers` 拿，而 `binding` 来自 `ensureParadiseWrite(ctx)` —— 上一轮已经加了 provider 接缝：

```ts
async function ensureParadiseTrigger(ctx) {
  const binding = await ensureParadiseWrite(ctx)
  return binding.ok ? binding.triggers : undefined
}
```

所以「通过注入的 adapter 点火」**不需要新代码**，只需要在 provider 里提供 `triggers`。实测里空 ctx 切片能跑通，但**点火那一步在裸机上返回 `TRIGGER_UNAVAILABLE`** —— 因为我的 BareGateway 没给触发器。这是**正确的行为**（没有执行器就不声称能点火），不是缺陷。

---

## 3. 二、路由热切换 —— 本轮的核心

### 3.1 分类：什么才算「额度耗尽」

| 信号 | 算 | 为什么 |
|---|---|---|
| HTTP 429 | ✅ | 标准「慢点或走开」 |
| 403/400 + `QUOTA_EXCEEDED` | ✅ | 多个兼容 provider 这么答，只看状态码会漏掉 |
| 400 + `额度` / `余额不足` | ✅ | 中文 provider 的常见形态 |
| HTTP 500 | ❌ | **瞬时故障可以重试；花光的账户重试永远是同一句拒绝** |
| 400 + `invalid parameter` | ❌ | 参数错换端点也没用 |

**这条区分是整个机制的地基。** 把 500 也当作要切换，会让一个抖动把流量永久推到备用账户上。

### 3.2 切换顺序是设计，不是巧合

```
1. QUOTA 失败 → 换端点/凭证 → 重发同一请求
2. 换不了（或已换过）→ 换 model
3. 都不行 → 如实报错
```

**为什么配额优先于 model**：一个花光的 key 对每个模型都答同一句拒绝。先换 model 会浪费一轮去学同一个事实，而真正有用的东西（另一个账户）永远试不到。

### 3.3 实测：一个真 429，同一个 generate() 自己换了端口

```
primary  :61962  → HTTP 429 {"code":"QUOTA_EXCEEDED"}
fallback :61963  → 200 {"model":"fallback-model"}

3c generate 最终成功（没把 429 抛给调用方）
3d 拿到的是备用端点的回答 — "备用端点回答（收到的 key: fallba…）"
3h 切换事件被报告了 — {"from":"...:61962","to":"...:61963","status":429,...}
3l 第二次调用不再打 primary
```

**第 3l 条是关键**：切换是持久的。否则每次调用都要先吃一个 429，等于把延迟翻倍。

### 3.4 没有备用路由时：具名拒绝

```
错误码：LLM_QUOTA_EXHAUSTED
信息：HTTP 429 …（没有可用的备用路由：设置 fallbackRoute / FALLBACK_API_URL + FALLBACK_API_KEY）
```

**不是返回空字符串。** 一个"成功"的空回答会让上游以为任务做完了。

### 3.5 进阶：改 config.json，不重启就生效

`loadFallbackRoute` 是个**函数**而不是值：

```ts
loadFallbackRoute: () => resolveFallbackRoute(configPath)
```

所以每次需要切换时才去读文件。实测：

```
6a 配置文件初始不存在
6f 追加备用路由            ← 此时 adapter 已经构造好了
6j 已经构造的 adapter 用上了新写的配置
6k 它真的打到了备用端点
```

**这就是「热」的含义。** 构造时读死会让进程钉在启动那一刻的配置上，而那一刻操作员往往还在修。

`rewriteRouteConfig` 用 **merge 而不是 replace**，并且**原子写**（temp + rename）：

- merge：调用者是修复动作，它只知道一个字段错了，replace 会丢掉操作员设的 model；
- 原子：这个文件在失败路径上被读，半写的文件会被读成"没配置"——恰好在配置的那一刻。

### 3.6 一个边界：备用 == 主 时不算切换

```
7a 同端点同 key 时不切换 — 0 次
7b 于是如实报配额耗尽
7c 没有无限循环
```

否则会是一个"切换了但什么都没变"的死循环，把真实的失败藏起来。

---

## 4. 三、harness 启动性能

| 场景 | 耗时 |
|---|---|
| `--help` 冷启动 ×5 | 142 / 94 / 92 / 91 / 98 ms |
| `--once` 完整一轮 ×4（探针 + 沙箱 + 报告） | 129 / 114 / 100 / 101 ms |

**不是"秒级"，是亚秒级。** 原因是单文件 bundle（188 KB，16 模块内联）+ 零外部依赖 —— 没有 `node_modules` 解析，没有第三方初始化。

**这一项没有优化工作，只是量了一下。** 如果测出来是 3 秒，我会去找原因；测出来是 100ms，如实报告就好。

---

## 5. 红线复核

| 约束 | 本轮 | 证据 |
|---|---|---|
| 1. `live.append` / `{turn:0,step:0}` | ✅ | 未触及 |
| 2. 协议无 dsh/cordis 字样 | ✅ | `protocol/*.ts` 零匹配 |
| 3. 不得因重构改变行为 | ✅ | 四套 201/545/263/183；既有 545+183 项全未改 |
| 4. 直接 fs / 写死绝对路径 | ✅ | 配置路径由参数派生；测试用 `mkdtempSync` |
| 5. 只在适配层改，上层插件不动 | ✅ | **本轮零插件改动**，全部在 `dsh-paradise` 内 |

**第 5 条**：本轮改了 `adapters/raw/llm.ts`（适配层）、新增 `adapters/raw/route-config.ts`（适配层）、`src/harness.ts`（装配件）。两个业务插件**一个字符都没动**。

---

## 6. 打包器守卫抓到的两次同类错误

两次都是同一种写法：`export { x } from './y.js'`。

```
Error: bundle would ship an unresolved relative import (line 7854): { isQuotaExhausted } from './llm.js'
```

内联打包里这条语句会**原样留下一个相对路径**，运行时 `import` 失败。守卫在构建期就拦住，而不是等到部署时。

改成 **import + 裸 export** 后通过。**这个守卫在本轮抓到两次，说明它值得存在。**

---

## 7. 诚实的边界

| # | 状态 |
|---|---|
| API 热切换 | ✅ 已实现并验证（45/45） |
| 配置文件热重载 | ✅ 已实现（不重启生效） |
| harness 启动 | ✅ 100ms 量级 |
| **observer 读路径** | ⚠️ **仍需第二个网关** —— `inspectSessionLog` 走 `readDiskEvents` |
| graft 裸机点火 | ⚠️ BareGateway 没给触发器，所以 `TRIGGER_UNAVAILABLE`。给一个 LLM 触发器即可，本轮未做 |
| TD-M8 | ⚠️ 仍在（本轮全绿，但那条测试本身仍是偶发） |

**「graft 在裸机上通过 LLMAdapter 点火」这条我只做到了一半。** 切片链路完全跑通，点火通道的接缝在（`binding.triggers`），但我没在 BareGateway 里实现一个"用 LLM 生成回复并写回会话"的触发器。

**说成"点火也通了"是不诚实的。** 它现在是**正确地在裸机上报告"我不能点火"**，这比假装能点更好，但确实还不是你要的那件事。

---

## 8. 本轮文件清单

| 文件 | 动作 |
|---|---|
| `dsh-paradise/src/adapters/raw/llm.ts` | 改 — 路由热切换 + `isQuotaExhausted` + `routeState` |
| `dsh-paradise/src/adapters/raw/route-config.ts` | **新建** — 读/合并/原子写 config |
| `dsh-paradise/src/adapters/raw/index.ts` | 改 — 导出（两次踩 `export … from`，守卫抓住） |
| `dsh-paradise/src/harness.ts` | 改 — `loadFallbackRoute` + `--route-config` |
| `dsh-paradise/src/index.ts` | 改 — 导出路由函数 |
| `dsh-paradise/test/route-hijack.test.mjs` | **新建** — 6 条 |
| `_scratch/verify-route-hijack.mjs` | **新建** — 45 项 |

---

## 9. 启动命令（含换血续命）

```bash
# 用备用额度续命：主端点花光 → 自动切到备用
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_MODEL=deepseek-chat \
LLM_API_KEY=sk-primary \
FALLBACK_API_URL=https://other-provider.example/v1 \
FALLBACK_API_KEY=sk-backup \
FALLBACK_MODEL=other-model \
node dsh-paradise/dist/harness.js --home=./.harness --sandbox-root=./work
```

或写进配置文件（可以被运行时改掉）：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "fallbackBaseUrl": "https://other-provider.example/v1",
  "fallbackApiKey": "sk-backup",
  "fallbackModel": "other-model"
}
```
