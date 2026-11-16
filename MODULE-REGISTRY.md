# 模块登记表（source of truth）

> **这张表是「哪些模块存在、各自干什么、依赖谁」的唯一权威。**
> 由 `test/module-registry.test.mjs` 双向守护：磁盘上多一个文件、或表里多一行幽灵，都会红。

## 分母算法（先说清，否则数字没有意义）

- 覆盖目录：`src`，**递归**（含 `adapters/dsh/`、`adapters/http/`、`adapters/memory/`、`adapters/raw/`、
  `protocol/`、`read/`、`write/` 七个子目录）
- 计入条件：文件名 `endsWith('.ts')`
- 实测：跑 `node --test test/module-registry.test.mjs`，它以诊断（`ℹ` 行）打印
  「模块数 / 总行数 / > 800 的文件 / 最大文件」——**这四个数不写在这份文档里**。
  原因不是嫌麻烦：数字写进文档就会过时，而**没有任何门禁会因为文档里的数字过时而红**，
  偏偏「实测」两个字让它看起来最像证据。本节唯一保留的是**判定规则**，不是快照。
- 三个方向都查：① 磁盘 → 表（新文件不能悄悄进）；② 表 → 磁盘（删掉的行不能留着）；
  ③ 依赖列 → 磁盘（不能指向不存在的模块）。第四条额外查：表本身不能有**值**环。
- 第五个方向：`ROW` 正则必须能**读进来**每一个真实文件名 —— 一个读不进表的文件名，
  等于一个不受监管的文件名（下划线、子目录斜杠在 memory / observer 上各踩过一次）。

## 为什么本仓的第一张表必须「先红后立」

`test/module-registry.test.mjs` 是**先移植测试、再建表**的：测试先跑，报
`MODULE-REGISTRY.md must exist (it is the only authority on module coverage)`；
建表后 6 条断言转绿。这张表的 54 行不是「照着 ls 抄一遍」，而是**被差集逼出来的**：
表里少一行，方向①就红；多一行幽灵，方向②就红。

## 依赖列的两种边必须分开写

`x.ts` 是**值**边（运行时真的会执行），`x.ts (type-only)` 是**类型**边（`import type` 被擦除）。
门禁区分二者：值边成环必须红，类型边成环是合法的（`protocol/` 与本仓都存在这样的环）。
把一条值边标成 type-only 来骗过成环检查，会被第六个方向（标签为真）当场抓住。

## 本仓的依赖形态（写在这里是因为它是结构事实，不是数字）

- `protocol/` 是被所有人依赖的**最底层**：它只依赖自己的 `types.ts` / `lease.ts` / `firewall.ts` / `adapters.ts`。
- `adapters/dsh/` 与 `adapters/raw/` 是**两套并列的宿主适配**，彼此不互相依赖。
  `index.ts` 同时依赖两者，这是唯一的汇合点。
- `index.ts` 是唯一的「全仓汇」：54 个模块里 32 个直接挂在它的依赖列上。**这是它体积的来源**  （`families.mjs apply` 实测：`apply` 一个声明 55 行，`index.ts` 本体 600+ 行）。
- 没有任何模块反向依赖 `index.ts`（`check-cycles` 的 ACYCLIC 结论就是这么来的）。

| 模块 | 职责（一句话） | 导出 | 依赖（本地模块） |
|---|---|---|---|
| `adapters/dsh/assert-capabilities.ts` | 断言宿主具备本层要求的能力，缺哪个就指名报出 | `RequiredCapability`, `REQUIRED_HOST_CAPABILITIES`, `REQUIRED_HOST_SERVICES`, `CapabilityAssertion`, `probeHostCapabilities`, `assertHostCapabilities` … (+1) | `errors.ts`, `adapters/dsh/services.ts` |
| `adapters/dsh/capability.ts` | 探测「这个运行时到底能做什么」，结果随适配器走 | `HostCapabilities`, `probeCapabilities` | `adapters/dsh/services.ts` |
| `adapters/dsh/delete.ts` | 删除半成品会话，并且**没有真删掉就不许说删掉了** | `DeleteReceipt`, `deleteSession`, `verifyDeletion` | `adapters/dsh/services.ts` |
| `adapters/dsh/index.ts` | 宿主适配器的总装：这个运行时与其他运行时不同的一切 | `DSH_ADAPTER_NAME`, `createDshAdapters` | `adapters/dsh/session.ts`, `adapters/dsh/storage.ts`, `lease-adapter.ts`, `adapters/dsh/assert-capabilities.ts`, `adapters/dsh/tools.ts`, `read/disk.ts`, `adapters/dsh/policy.ts` |
| `adapters/dsh/inject.ts` | 注入：先造事件，并在预留任何东西**之前**证明形状 | `TapeSeed`, `TapeEvent`, `SURFACE_TYPES`, `BRIEFING_ID_PREFIX`, `InjectShape`, `InjectShapeError` … (+8) | `adapters/dsh/policy.ts` |
| `adapters/dsh/lease-sync.ts` | 建在目录之上的**同步**租约（给同步写路径用） | `guardSteals`, `GuardOutcome`, `SyncLeaseOptions`, `createSyncLeaseAdapter` | `protocol/index.ts`, `protocol/lease.ts` |
| `adapters/dsh/paths.ts` | 这一个宿主的路径布局 | `escapeSessionDirName`, `sessionLogPath` | `policy.ts` |
| `adapters/dsh/policy.ts` | 这一个宿主的形状策略（常量 + 判定） | `RENDERED_CONVERSATION_TYPES`, `MESSAGE_TYPE_FOR_INTENT`, `PLUGIN_SOURCE_PREFIX`, `SESSION_LOG_FILENAME`, `SESSION_HEADER_TYPE`, `isRenderedByConversation` … (+7) | — |
| `adapters/dsh/publish.ts` | 工作区挂载与客户端宣告 | `PublishReceipt`, `PUBLISH_CAPABILITIES` | — |
| `adapters/dsh/services.ts` | 本运行时唯一的服务解析入口（同目录适配器共用） | `service` | — |
| `adapters/dsh/session-writer.ts` | 建 COLD 会话并把整条 tape 在一个事务里写进去 | `WriteReceipt`, `CreateOptions`, `createSession` | `protocol/index.ts` (type-only), `adapters/dsh/inject.ts`, `adapters/dsh/delete.ts`, `adapters/dsh/policy.ts`, `adapters/dsh/publish.ts` (type-only), `adapters/dsh/services.ts` |
| `adapters/dsh/session.ts` | 本运行时的会话适配器（含删除与触发接线） | `createDshSessionAdapter`, `dshEscapeSessionDirName`, `deleteSession` | `read/disk.ts`, `adapters/dsh/paths.ts`, `adapters/dsh/services.ts`, `adapters/dsh/session-writer.ts`, `adapters/dsh/delete.ts`, `adapters/dsh/trigger.ts`, `adapters/dsh/policy.ts` |
| `adapters/dsh/storage.ts` | 本运行时的存储适配器 | `createDshStorageAdapter` | `protocol/index.ts` (type-only), `protocol/lease.ts`, `adapters/dsh/services.ts` |
| `adapters/dsh/tools.ts` | 本运行时的工具适配器 | `createDshToolAdapter` | `protocol/index.ts` (type-only), `adapters/dsh/services.ts` |
| `adapters/dsh/trigger.ts` | 让一个会话开始工作；做不到时如实说做不到 | `TriggerReceipt`, `TriggerOptions`, `alreadyTriggered`, `triggerSession` | `adapters/dsh/policy.ts`, `adapters/dsh/services.ts` |
| `adapters/http/network-storage.ts` | 真网络存储：同一契约 + 网络多出来的那一个事实 | `NetworkServerOptions`, `NetworkServer`, `startNetworkNode`, `NetworkClientOptions`, `connectNetworkNode` | — |
| `adapters/memory/index.ts` | 没有宿主的参考实现（不是玩具，理由在文件头） | `MemoryHost`, `createMemoryHost` | `protocol/lease.ts`, `lease-adapter.ts` |
| `adapters/raw/firewall.ts` | 零信任防火墙的**实现**（注入屏蔽 + 动作护栏 + 审计） | `UNTRUSTED_OPEN`, `UNTRUSTED_CLOSE`, `UNTRUSTED_PREAMBLE`, `createInjectionShield`, `createFirewall`, `createActionGuard` … (+5) | `protocol/firewall.ts` |
| `adapters/raw/ignition.ts` | 裸机点火：不依赖宿主也能让会话开始 | `IgnitionTriggerInput`, `IgnitionReceipt`, `IgnitionSession`, `IgnitionOptions`, `createBareIgnition` | `protocol/harness.ts` (type-only) |
| `adapters/raw/index.ts` | 裸机适配器总装（模型 / 消息 / 工具 / 点火 / 路由） | `RAW_ADAPTER_NAME`, `createRawAdapters`, `RouteConfigShape`, `ResolvedRouteShape`, `createRawLlm`, `createRawMessages` … (+26) | `adapters/raw/llm.ts`, `adapters/raw/messages.ts`, `adapters/raw/tools.ts`, `adapters/raw/ignition.ts`, `protocol/index.ts` (type-only), `adapters/raw/route-config.ts` (type-only) |
| `adapters/raw/llm.ts` | 只用 `fetch` 实现的模型适配器（含配额与重试判定） | `ToolRunner`, `RawLlmOptions`, `isQuotaExhausted`, `createRawLlm` | — |
| `adapters/raw/messages.ts` | 把对话当成一个数组来管（含粗略 token 估算） | `approximateTokens`, `RawMessageOptions`, `createRawMessages` | `protocol/index.ts` (type-only) |
| `adapters/raw/route-config.ts` | 磁盘上的路由配置：读、改、回退 | `RouteConfig`, `ResolvedRoute`, `defaultRouteConfigPath`, `readRouteConfig`, `resolveFallbackRoute`, `rewriteRouteConfig` … (+1) | — |
| `adapters/raw/sandbox.ts` | 沙箱：worker 内执行 + 根目录收窄（**已知边界：junction 可绕过**） | `SandboxCapabilities`, `SANDBOX_CAPABILITIES`, `SandboxOptions`, `SandboxResult`, `runInSandbox`, `ensureRoot` … (+5) | — |
| `adapters/raw/session.ts` | 裸机会话（不依赖宿主插件即可持久化） | `RawSessionOptions`, `createRawSessionAdapter` | — |
| `adapters/raw/tools.ts` | 运行时才创建的工具工厂 | `RawToolFactoryOptions`, `createRawToolFactory` | `protocol/index.ts` (type-only), `adapters/raw/sandbox.ts` |
| `agent-loop.ts` | 一个底下没有宿主的、真能跑的 agent 循环 | `AgentTool`, `AgentTurnResult`, `AgentLoopEvent`, `AgentLoopOptions`, `runAgentTurn`, `createMemoryMessages` | `protocol/index.ts` (type-only) |
| `dispatcher.ts` | 天河的调度器：票据进、回执出，中间是节点 | `TianheTicket`, `TianheReceipt`, `NodeRunner`, `DispatcherOptions`, `DispatcherEvent`, `DispatchReport` … (+1) | `spawn-node.ts`, `adapters/dsh/inject.ts` (type-only) |
| `emergency-repair.ts` | 应急修复会话：宿主挂了也要能跑 | `RepairBrief`, `RepairSessionResult`, `EMERGENCY_SETUP`, `EmergencyRepairOptions`, `createEmergencyRepair`, `extractToolSource` … (+1) | `protocol/index.ts` (type-only) |
| `errors.ts` | 本层的错误词汇表（阶段 + 可恢复性） | `ParadiseStage`, `ParadiseError`, `asParadiseError`, `ParadiseUnavailableError` | — |
| `harness-http.ts` | 把 harness 与它的 UI 放进同一个进程 | `HarnessServerOptions`, `createHarnessServer`, `ServerOptions`, `SessionStatus` | `harness-server.ts`, `ws-server.ts`, `topology.ts` |
| `harness-server.ts` | 宿主本体：会话状态机 + 事件流 + 轮次 | `SessionStatus`, `HarnessSessionState`, `HarnessOptions`, `HarnessEvent`, `TurnResult`, `createParadiseHarness` … (+1) | `agent-loop.ts`, `protocol/index.ts` (type-only) |
| `harness.ts` | 独立 harness：CLI 入口、配置解析、健康探针 | `HarnessConfig`, `parseArgs`, `resolveConfig`, `isProcessAlive`, `createPidFileProbe`, `createAlwaysHealthyProbe` … (+19) | `launcher.ts`, `emergency-repair.ts`, `adapters/raw/index.ts`, `adapters/raw/sandbox.ts`, `adapters/raw/route-config.ts`, `protocol/index.ts` (type-only), `adapters/raw/session.ts` |
| `index.ts` | 彼岸层对外入口：插件 apply + 全仓汇出（32 个直接依赖，唯一汇合点） | `VERSION`, `PACKAGE_NAME`, `resolveService`, `name`, `inject`, `apply` … (+204) | `adapters/dsh/policy.ts`, `adapters/dsh/paths.ts`, `read/disk.ts`, `adapters/dsh/capability.ts`, `adapters/dsh/services.ts`, `errors.ts`, `write/contract.ts`, `adapters/dsh/publish.ts`, `protocol/index.ts`, `adapters/dsh/index.ts`, `adapters/dsh/delete.ts`, `adapters/memory/index.ts`, `lease-adapter.ts`, `adapters/dsh/lease-sync.ts`, `lease.ts`, `storage-memory.ts`, `storage-tiers.ts`, `adapters/raw/index.ts`, `protocol/firewall.ts`, `launcher.ts`, `adapters/http/network-storage.ts`, `adapters/raw/route-config.ts` (type-only), `adapters/raw/ignition.ts` (type-only), `protocol/lease.ts`, `agent-loop.ts`, `repair-session.ts`, `watchdog.ts`, `spawn-node.ts`, `dispatcher.ts`, `harness-server.ts`, `harness-http.ts`, `topology.ts` |
| `launcher.ts` | 双模接管：起宿主、看健康、按策略修复 | `HealthProbe`, `LauncherState`, `LauncherEvent`, `LauncherOptions`, `RepairAttempt`, `RepairStrategy` … (+3) | `protocol/index.ts` (type-only), `emergency-repair.ts` |
| `lease-adapter.ts` | 完全建在 `StorageAdapter` 之上的租约 | `defaultLeaseOwner`, `asLeaseRecord`, `leaseStorageKey`, `createStorageLeaseAdapter` | `protocol/index.ts`, `protocol/lease.ts` |
| `lease.ts` | 带 fencing 的互斥：每个调用点三行 | `WithLeaseResult`, `withLease` | `protocol/index.ts` |
| `policy.ts` | 中立的策略助手：不含宿主词汇、不含宿主常量 | `isWellFormedProvenance`, `normaliseVisibility`, `opaqueId` | — |
| `protocol/adapters.ts` | 协议：宿主必须提供的三个适配器（会话 / 存储 / 工具） | `SessionAdapter`, `DeletionProbe`, `SessionCapabilities`, `RenderedItem`, `StorageAdapter`, `StorageTransaction` … (+7) | `protocol/lease.ts` (type-only) |
| `protocol/firewall.ts` | 零信任防火墙的**契约**（信任序、注入判定、动作裁决） | `TrustOrigin`, `TRUST_ORDER`, `InjectionVerdict`, `SanitizeAction`, `SanitizeVerdict`, `FirewallAdapter` … (+6) | — |
| `protocol/harness.ts` | 外骨骼：模型、消息列表、运行时创建的契约 | `ToolSchema`, `ChatMessage`, `ToolCall`, `FinishReason`, `GenerationResult`, `GenerateOptions` … (+5) | `protocol/types.ts` (type-only) |
| `protocol/index.ts` | 协议的桶文件 + 每个调用者都会用的那一个函数 | `ProtocolError`, `bindHost`, `isParadiseHost`, `SessionRef`, `ContextItem`, `ContextVisibility` … (+60) | `protocol/lease.ts` (type-only), `protocol/firewall.ts`, `protocol/adapters.ts` (type-only), `protocol/types.ts` (type-only) |
| `protocol/lease.ts` | 租约：键控持久状态上的互斥 + fencing 规划 | `LeaseRecord`, `LeaseAttempt`, `LeaseRequest`, `LeaseAdapter`, `LEASE_RELEASE`, `isLeaseExpired` … (+6) | `protocol/types.ts` (type-only) |
| `protocol/network.ts` | 网络存储：与本地同契约，外加网络多出来的保证 | `NetworkGuarantees`, `NetworkReadReport`, `NetworkWriteRequest`, `NetworkStorageAdapter`, `NetworkEnvelope` | `protocol/types.ts` (type-only), `protocol/adapters.ts` (type-only) |
| `protocol/types.ts` | 协议：宿主中立的值类型 | `SessionRef`, `ContextItem`, `ContextVisibility`, `TriggerMode`, `TurnTrigger`, `LogEvent` … (+6) | — |
| `read/disk.ts` | 读：逐帧解码一条持久会话日志（含 zstd 帧识别） | `configureReadDefaults`, `DiskBriefing`, `DiskReading`, `PathProbe`, `PathDeriver`, `DiskReadOptions` … (+2) | — |
| `repair-session.ts` | 修复会话：不需要宿主也能存在的维护性对话 | `RepairSessionOptions`, `RepairSessionEvent`, `RepairSessionResult`, `runRepairSession`, `REPAIR_TOOL_NAMES`, `resolveInside` … (+1) | `agent-loop.ts`, `protocol/index.ts` (type-only) |
| `spawn-node.ts` | 生成独立的 agent 节点（本仓的「从无到有」原语） | `SpawnNodeInput`, `SpawnNodeContextItem`, `SpawnNodeReceipt`, `SpawnNodeContext`, `spawnNode`, `canSpawnOnHost` | `adapters/dsh/inject.ts`, `adapters/dsh/capability.ts` |
| `storage-memory.ts` | L1：内存存储驱动 | `MemoryStorageOptions`, `MemoryStorageAdapter`, `createMemoryStorageAdapter` | — |
| `storage-tiers.ts` | 存储档位工厂（按需要选 L1/L2/L3） | `StorageTier`, `StorageTierChoice`, `chooseStorageTier`, `STORAGE_TIERS`, `parseStorageTier` | `protocol/index.ts` (type-only), `storage-memory.ts` |
| `topology.ts` | 任务拓扑 DAG 的数据面：读与 memory 插件同一批文件 | `TopologyNode`, `TopologyEdge`, `TopologyView`, `TopologyInput`, `readTopology` | — |
| `watchdog.ts` | 进程看门狗：发现宿主死了并把它拉起来 | `WatchdogState`, `WatchdogEvent`, `WatchdogProbe`, `WatchdogOptions`, `WatchdogReport`, `buildDiagnosis` … (+1) | — |
| `write/contract.ts` | 写层：**P2 只有契约，故意未实现**（拒绝时必须 `NOT_IMPLEMENTED`） | `WRITE_LAYER_PHASE`, `writeNotImplemented`, `CARRYING_MESSAGE_RULE`, `UNIFIED_RULES` | `errors.ts` |
| `ws-server.ts` | 只用 Node 内置实现的极简 WebSocket 服务 | `Socket`, `SocketServerOptions`, `encodeFrame`, `decodeFrames`, `attachSocketServer`, `acceptKeyFor` … (+1) | — |
