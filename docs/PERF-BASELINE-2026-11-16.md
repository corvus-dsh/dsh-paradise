# 性能基线 · 2026-11-16（B0.5）

> **本批不设阈值。** 这是基线，不是门禁。

## 1. 环境

| 项 | 值 |
|---|---|
| Node | v24.21.0 |
| V8 | 13.6.233.17-node.53 |
| OS | win32 x64, 10.0.19045（Windows 10 22H2） |
| CPU | 11th Gen Intel(R) Core(TM) i5-11260H @ 2.60GHz × 12 逻辑核 |
| 内存 | 15.8 GB |
| 测量时间 | 2026-11-16 18:10–18:26（Asia/Shanghai） |

## 2. bench-smoke：本仓的纯函数微基准

被测函数：`isWellFormedProvenance`（`src/policy.ts`，sha256 `535c9b11920a`）

命令：`node scripts/bench-smoke.mjs`
规模：100 000 次调用 × 7 轮，报**每轮 per-call 耗时的中位数**。

| 轮次 | 三次独立运行的中位数（ms/call） |
|---|---|
| run 1 | 3.873e-5 |
| run 2 | 3.881e-5 |
| run 3 | 3.725e-5 |

- **中位数：3.87e-5 ms/call**（约 38.7 ns）
- 三次运行极差 / 最小值 = **1.04×**
- can-red 自检：空实现中位数 3.8e-6 ms，**分离度 10.08×**，SIGNAL-OK

选它的理由：纯函数（无状态、无 IO、无 `Date.now()`），输入固定，
守的是 provenance 标记的格式契约 —— 变慢意味着正则退化，那值得知道。

**两个候选被否，记录在此**：

- `opaqueId`：耗时更漂亮（2.6e-4 ms/call），但它内部调 `Date.now()`，**不是纯函数**，
  每轮输入都不同，基线不可复现。纯函数是这个量具的前提，不是加分项。
- `leaseOwnedBy` / `isLeaseExpired`：实测 separation 只有 1.13× / 1.19×，
  与空调用同量级，NO-SIGNAL —— 量具测不到函数体。

**第一版还犯过一个输入错误**：我最初把 input 写成对象 `{ origin, at }`，
而签名是 `(origin: unknown)`，内部第一句 `typeof origin === 'string' && ...` 直接短路返回 false。
实测 separation=0.44×（比空函数还"快"）。改成字符串后 4.64×，SIGNAL-OK。
**can-red 自检当场指出了这个错误**，否则会入库一个假的 1.36e-5 ms 基线。

## 3. 五个既有 bench 的实测值（B0.5 ①）

全部用 `node scripts/<bench>` 原样运行，**不传 `--json`**（避免把结果写进 `docs/` 弄脏工作树）。

| bench | 命令 | exit | 耗时 | 状态 |
|---|---|---|---|---|
| bench-prestep | `node scripts/bench-prestep.mjs` | 0 | 10.4 s | ✅ |
| bench-lock | `node scripts/bench-lock.mjs` | — | 300 s | ⚠️ **未测** |
| bench-lock-contend | `node scripts/bench-lock-contend.mjs` | — | 300 s | ⚠️ **未测** |
| bench-lock-spin | `node scripts/bench-lock-spin.mjs` | 0 | 2.9 s | ✅ |
| bench-lock-trace | `node scripts/bench-lock-trace.mjs` | 0 | 0.2 s | ✅ |

**两个超时的理由**：`bench-lock` 与 `bench-lock-contend` 都是多进程/多会话争用测量
（后者从注释看会 spawn 子进程跑并发争用），单条超过 5 分钟未结束。
⚠️ **本项未测**（不是「测了但没值」）。

**原因**：`bench-lock` / `bench-lock-contend` 是多进程争用测量，单次跑 300s 未到稳态，
B0 不设该时间预算。

**影响**：锁争用的基线**目前为空**，B4 做性能回归门禁时**必须先补测**，
否则该门禁无基线可比 —— 一个没有基线的回归门禁只能报「不知道」，
而报「不知道」的门禁在第一次被忽略之后就会被永久忽略。

### bench-prestep（关键数字，p50 / p95，单位 ms）

| tier | n=1 | n=5 | n=10 | n=20 | n=50 |
|---|---|---|---|---|---|
| T1-graft-only | 0.04 / 0.08 | 0.14 / 0.31 | 0.19 / 0.36 | 0.39 / 0.71 | 0.99 / 1.60 |
| T2-json | 0.07 / 0.13 | 0.33 / 0.45 | 0.72 / 1.01 | 1.61 / 2.12 | 4.25 / 5.41 |
| T3-sqlite | 0.08 / 0.14 | 0.38 / 0.57 | 0.76 / 1.13 | 1.58 / 1.84 | 4.55 / 5.49 |
| T2b-no-retrieval | 0.02 / 0.02 | 0.08 / 0.10 | 0.16 / 0.34 | 0.35 / 0.71 | 0.94 / 1.64 |
| T2c-single-session | 0.08 / 0.11（n=2500） | — | — | — | — |

纯函数部分：`checkSafeHarbor` 1000 次 / 16.2 ms → **0.0162 ms/call**。

**必须一并记下的噪声事实**：`spread(p95)` 在 n=1 档高达 **285%**（T1）、129%（T2b），
在 n=20 档降到 **6%**（T1）。这不是抖动，是**并发数本身就影响方差**：
低并发时每次测量只覆盖很少的调度事件，单个慢调用就能把 p95 拉走。

**这正是「本批不设阈值」最硬的实证**：如果拿 n=1 的 0.08 ms 当基线，
一个 2 倍的正常波动就会被误报成回归；而拿 n=20 的 0.71 ms 当基线，
又会漏掉低并发路径上的真实退化。**同一份数据在不同 n 下讲不同的故事**，
所以阈值必须等有了波动范围之后才谈。

### bench-lock-spin（等待期的 CPU 成本）

```
wait = 50 ms × 20 repeats, median reported
control        wall=0.00ms cpu=0.000ms ratio=0.0%
graft          wall=61.94ms cpu=0.000ms ratio=0.0%
memory         wall=62.48ms cpu=0.000ms ratio=0.0%
```

CPU burned per 50 ms of waiting: graft 0.00 ms vs memory 0.00 ms (0.0× more)

**读数**：等待期间 CPU 消耗为 0，说明两者都是**让出 CPU 的等待**，不是自旋。
wall 61.94 / 62.48 ms 对应 50 ms 的设定等待，多出的 ~12 ms 是进程与测量开销。

### bench-lock-trace（每轮锁获取次数）

```
rounds measured: 10
graft: 0 acquisitions = 0.00/turn
memory: 0 acquisitions = 0.00/turn
READ-ONLY paths:  memory_stats 0, memory_graph_read 0     ← 预期为 0，锁只保护写
WRITE paths:      memory_graph_update 1  (memory/task-graph.json.lock)
                  memory_graph_update (2nd) 1
                  memory_harvest 0
```

**读数**：读路径 0 次获取，写路径 1 次 —— 与「锁只保护写」的设计一致。

## 4. 为什么**不设阈值**

**先有基线，才有阈值。** S2 性能基线（2026-11-09）的教训：50 并发 p95 = 7.26ms 里
**76.6% 是排队**，不是计算。用「并发 p95」当分母，会把排队时间当成自己的预算，
把可见的计算增长说成"可忽略"。

所以 B0 只记基线：**基线是事实，阈值是判断**。判断需要知道正常波动范围，
而那个范围现在还不知道。本仓的数据尤其说明这一点：`spread(p95)` 从 n=1 的 285%
到 n=20 的 6%，跨一个数量级 —— **在知道这个形状之前，任何阈值都是猜的**。

## 5. bench-smoke 自带 can-red

脚本内部跑两次：一次真函数、一次空实现 `() => {}`，并断言**真函数的中位数必须显著更高**
（当前门槛 2×）。不满足就打印 `NO-SIGNAL`，而不是装作测到了。

本仓这条自检**否掉了三个候选**（`opaqueId` 非纯、`leaseOwnedBy`/`isLeaseExpired` 无信号），
还抓出了我自己一次输入喂错（0.44×）。没有它，这里会有三个看似正常、实则无意义的数字。
