# 门禁接线台账（paradise）

> 立此文件的直接原因：这个仓此前有 **54 个 `.ts` / 15,869 行 / 403 个顶层声明**，
> 而**架构门禁数量为 0**。唯一在跑的是 `preflight.mjs`（14 项，三项为本层独有），
> 它回答的是「产物能不能被加载」，不是「依赖图是否成立」「文档是否漂移」。

---

## 一、接线前 / 接线后

| 脚本 | 接线前 | 接线后 |
|---|---|---|
| `closure.mjs` | 本仓没有 | 有（逐字节同 memory），仪器（不接 CI） |
| `check-cycles.mjs` | 本仓没有 | 有 ⇒ **`npm run check` + CI `Gates` 步** |
| `type-budget.mjs` | 本仓没有 | 有 ⇒ `npm run check` + CI `Gates` 步（经 `run-gate` 包裹） |
| `type-check.mjs` | 本仓没有 | 有（`type-budget` 的上游，仪器） |
| `families.mjs` | 本仓没有 | 有（仪器） |
| `who-references.mjs` | 本仓没有 | 有（仪器） |
| `move-gate.mjs` | 本仓没有 | 有（仪器） |
| `check-readme-counts.mjs` | 有，**无入口** | **`npm run check` + CI `Gates` 步** |
| `preflight.mjs` | 有，且在 CI | 不动（本仓最强的门） |

## 二、为什么是「复制」而不是「适配」

派工单要求 7 个脚本**逐字节**等于 memory 的对应文件。这不是省事，是**判据纪律**：
「一个判据只能有一份实现」。四仓各有自己的 `preflight`（各自的语义不同），
但 `check-cycles` / `closure` / `type-budget` / `families` / `who-references` / `move-gate`
回答的是**同一个问题**，它们不该有四个版本 —— 四个版本就是四次漂移的机会，
而 observer 与 graft 上一轮已经因此各修过一次同一个缺陷（`families` 的成员正则漏 `let/var`）。

实测哈希（SHA-256 前 16 位）—— **不是手抄的**：

```
closure.mjs          6AB8FDB73B4E4CB6   == memory
check-cycles.mjs     5B061466C7F3BCAD   == memory
type-check.mjs       B510BA3D6BA37A4B   == memory
families.mjs         1663B1D8E619992F   == memory
who-references.mjs   5B0080DFE9F02D27   == memory
move-gate.mjs        A7784C85DAFCBBBA   == memory
```

**`type-budget.mjs` 不在上面那张表里，而且不能进去。** 结构同源，**基线本地**：

```
type-budget.mjs      paradise 00452631762B0E5D ≠ memory 40F8E5C0092658E0
                     ↑ 同样的代码逻辑，不同的 BASELINE / BASELINE_IDENTITIES
```

`BASELINE` / `BASELINE_IDENTITIES` 记的是**本仓的缺陷**，必须由 `--baseline` 生成本仓的值；
复制过来后立刻用 `--baseline` 重写了这两块，其余一行未动。

> ── W3-2：这行原来写的是 `9793ED9E01D59CB8 == memory`（B4-0b-2 W3-2）
>
> 那个哈希**两边都不是**：既不是 paradise 的，也不是 memory 的。它不是抄错了一位，是抄的是
> 一个第三个文件，或者一次已经被后来的编辑改掉的状态 —— 无论哪种，它**从来没有等于过任何一个
> 实测值**，而它就写在「实测哈希」这四个字下面。
>
> 这一行之所以能活这么久，是因为**没有任何东西比对过它**：文档里的数字只有作者本人一个来源。
> 这正是 W1-12 里「检查的来源只有一处更新」那个形态，只不过这次连检查都没有 —— 只有一句声明。
>
> 修法有两条，都做了：
>   1. **这句话改成它真正是的东西**：结构同源、基线本地，两个哈希都是实测值，且写明「不相等」；
>   2. **数字改由脚本比对**：`test/v277-gate-wiring-hashes.test.mjs` 解析上面两个代码块，
>      逐行 `sha256sum` 实测，`== memory` 的必须真相等，`≠` 的必须真不等。
>      任何人手工改一个字节（或手抄一个数字），这条测试就红。
>
> 判据：改 `type-budget.mjs` 一个字节 ⇒ v277 红；把 `== memory` 改成 `≠` ⇒ 也红（那是在撒谎）。

## 三、`type-budget` 在本仓的处置（重要，不要简化）

`paradise` 此前**从未跑过类型检查**。第一次跑出来：

```
CODE HEALTH: 58 diagnostic(s)     ← 真的类型缺陷
ENVIRONMENT: 97 diagnostic(s)     ← @types/node 缺席造成，不是缺陷
```

**处置：把 58 条如实冻结进基线表，不修。**

- 为什么不修：B0 的任务是「让门禁存在」。修类型是 B1 的 6 条类型欠账，两者混一起，
  B0 就无法按时交付，而且「先修再看门禁」会让门禁永远见不到红。
- 为什么必须写清它是快照：58 不是「类型健康」，是**当日实测**。
  `type-budget` 自己的输出就把这句说出来了：
  `scope: measured under strict:false — this is "what the loose settings can see", not "type health". strict:true reports 159 here`。
- 2459（imported-but-not-exported，搬移专属失效模式）在本仓是 **0**，且是**绝对判据**
  （与「触及了哪些文件」无关）。

## 四、RESOURCE 的处置（与 observer 同一份 `run-gate.mjs`）

`package.json` 声明零依赖 ⇒ CI 上没有 `typescript` ⇒ `type-budget` exit 2。
`run-gate.mjs` 的那条规则（用户 2026-11-12 裁定）：
**exit 2 ⇒ 打印 `RESOURCE — gate … NOT CHECKED this run` + exit 0；exit 1 ⇒ exit 1**。
本机有编译器（`D:\持久层能力架构\node_modules\typescript` 在上级目录），所以本机是真跑过的。

## 五、paradise 的三个数（实测，2026-11-16）

| 指标 | 实测 |
|---|---|
| 声明总数 | **403**（跨 54 个文件；`closure.mjs --declarations`） |
| 模块级可变绑定 | **2**（`adapters/dsh/lease-sync.ts:guardStealCount`、`read/disk.ts:rendersByDefault`） |
| 依赖图 | nodes **54** / value edges **90** / all edges **117** / unresolved **0** / **ACYCLIC** |

对照：memory 20 个模块级可变绑定、graft 14 个、observer 5 个，paradise **2 个**。
这个数字值得单独说一句：它意味着 paradise 的 54 个文件**几乎全是无状态适配器**，
「状态与写者同走」在四仓里做得最好。此前没人知道，因为它从没被算过。
