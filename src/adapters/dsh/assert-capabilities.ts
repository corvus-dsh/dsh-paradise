/**
 * HOST CAPABILITY ASSERTIONS — refuse loudly, and say WHICH FILE TO EDIT.
 *
 * THE PROBLEM THIS SOLVES, IN ONE SENTENCE: a breaking host upgrade removes a method, and the layer
 * carries on with a capability silently switched off — so the failure surfaces much later, in a
 * different component, wearing a different error.
 *
 * This ecosystem has already paid for that shape three times: `sessions.prepare` disappearing (the cold
 * write path), `sessionController.prompt`'s signature changing (every ignition dying), and a service
 * exposed on one accessor but not the other. Each time the symptom was far from the cause.
 *
 * WHAT THIS FILE ADDS
 *
 *   - a REQUIRED-API table: each entry names the service, the method, and THE FILE that implements it;
 *   - `assertHostCapabilities(ctx, { strict })`, which reports every missing piece at once, each with the
 *     instruction an AI needs ("edit adapters/dsh/session.ts"), and
 *   - `HOST_CAPABILITY_MISSING` as the code, so a caller can branch on it instead of matching text.
 *
 * WHY IT IS NOT THROWN BY DEFAULT
 *
 * A bare context is a LEGITIMATE input: the capability probe and the conformance suite both construct
 * adapters from `{}` to prove that a host with nothing mounted reports `false` rather than pretending.
 * Throwing there would delete that property. So the refusal is OPT-IN (`strict`), and the non-strict
 * path keeps reporting the same facts through `capabilities.unavailable` — which already names the
 * consequence for every missing piece.
 *
 * The upgrade drill — the state this file exists for — turns `strict` ON.
 */

import { ParadiseError } from '../../errors.js'
import { service } from './services.js'

/** One API this adapter's implementation depends on. */
export interface RequiredCapability {
  /** The service name, as this host exposes it. */
  readonly service: string
  /** The method the implementation calls. `(service)` means "the service itself must exist". */
  readonly method?: string
  /** What breaks if it is gone — the CONSEQUENCE, not the name. */
  readonly consequence: string
  /** THE FILE AN AI SHOULD EDIT to adapt, relative to this package. */
  readonly editIn: string
}

/**
 * THE TABLE. Every entry was added because something in this package calls it, and the `editIn` column
 * is the answer to "the upgrade broke it — now what?".
 */
export const REQUIRED_HOST_CAPABILITIES: readonly RequiredCapability[] = [
  {
    service: 'sessions',
    method: 'prepare',
    consequence: '无法预留零继承会话头，冷目标写不出来（create 整体不可用）',
    editIn: 'src/adapters/dsh/session-writer.ts',
  },
  {
    service: 'sessionPersistence',
    method: 'create',
    consequence: '没有持久化句柄：冷会话写不出去，live append 会撞 SessionStore',
    editIn: 'src/adapters/dsh/session-writer.ts',
  },
  {
    service: 'sessionPersistence',
    method: 'stat',
    consequence: '无法用 stat 证实会话确实不存在；删除回执只能写"接口调过"',
    editIn: 'src/adapters/dsh/delete.ts',
  },
  {
    service: 'sessionQuery',
    method: 'readSession',
    consequence: '冷读校验与幂等检查都读不到目标日志',
    editIn: 'src/adapters/dsh/session-writer.ts',
  },
  {
    service: 'sessionController',
    method: 'prompt',
    consequence: '没有 prompt 通道：会话可手动打开，但不会自动开始工作',
    editIn: 'src/adapters/dsh/trigger.ts',
  },
]

/**
 * THE SERVICE NAMES THE TABLE REQUIRES, DEDUPED — what a plugin's `inject` MUST declare.
 *
 * ── WHY THIS EXISTS AT ALL (2026-11-08) ────────────────────────────────────────────────────────
 *
 * The boot drill asserts the table above. With nothing declared in `inject`, the fiber waits for
 * nothing, `apply` runs before this host has finished mounting, the drill measures an EMPTY host and
 * refuses to mount — and Cordis marks the fiber `failed` for the life of the process. Measured:
 * re-mounting the same row after the host was up flipped it to `active` with no code change.
 *
 * `inject` is this framework's mechanism for "wait until these exist", so the requirement and the
 * declaration have to come from ONE source. They did not, and the declaration was empty.
 *
 * IT LIVES HERE, NOT IN `index.ts`, because the service names are host specifics: the neutral layer
 * may not name them (the isolation gate scans every source file outside `src/adapters/`). The entry
 * point therefore declares `inject` from this symbol without naming a single service itself.
 */
export const REQUIRED_HOST_SERVICES: readonly string[] = [
  ...new Set(REQUIRED_HOST_CAPABILITIES.map((entry) => entry.service)),
]

export interface CapabilityAssertion {  ok: boolean
  /** Every missing API, with its consequence and the file to edit. */
  missing: Array<RequiredCapability & { how: string }>
  /** The one-line refusal, ready to throw or print. */
  message: string
}

/**
 * Which REQUIRED APIs are absent from this context?
 *
 * Structural and side-effect free: it resolves services the same way the adapters do (`service`, which
 * tries the direct property then the accessor), so it cannot disagree with what the implementation will
 * actually find at call time.
 */
export function probeHostCapabilities(ctx: any): CapabilityAssertion {
  const missing: Array<RequiredCapability & { how: string }> = []
  for (const required of REQUIRED_HOST_CAPABILITIES) {
    const resolved = service(ctx, required.service, required.method)
    if (resolved !== undefined) continue
    missing.push({
      ...required,
      how:
        `宿主缺少 ${required.service}${required.method === undefined ? '' : `.${required.method}`}。` +
        `后果：${required.consequence}。` +
        `修法：修改 ${required.editIn} 里对应的实现来适配新版本（协议层不需要改）。`,
    })
  }
  const message =
    missing.length === 0
      ? ''
      : `HOST_CAPABILITY_MISSING：当前 DSH 版本缺少 ${missing.length} 个本层依赖的 API。\n` +
        missing.map((entry, index) => `${index + 1}. ${entry.how}`).join('\n')
  return { ok: missing.length === 0, missing, message }
}

/**
 * Assert the host still has what this layer needs.
 *
 * `strict: true` THROWS `ParadiseError('HOST_CAPABILITY_MISSING', …)` with every missing API named and
 * the file to edit for each. Without it, the answer is returned so a caller can report it.
 *
 * WHERE STRICT IS DEFAULTED ON, AND WHY THE DEFAULT IS NOT GLOBAL
 *
 *   - `createDshAdapters()` stays LENIENT by default: a bare `{}` context is a legitimate input for the
 *     capability probe and the conformance suite, which build adapters from nothing to prove that a host
 *     with nothing mounted reports `false` rather than pretending. Throwing there would delete that
 *     property — so the default is the safe one for a LIBRARY.
 *
 *   - `apply()` / `activate()` are STRICT by default: that is the moment the plugin boots against a
 *     freshly upgraded host, and it is the only place where "the host is missing an API" must stop the
 *     load with a named refusal instead of a capability quietly switching off. There, leniency would mean
 *     the upgrade drill only works if someone remembered to pass a flag — which is not a drill, it is a
 *     hope.
 *
 * `PARADISE_STRICT_HOST` overrides BOTH directions (set it to `0` to force lenient boot, `1` to force
 * strict construction), so an operator diagnosing a bare profile is never trapped by the default.
 */
export function assertHostCapabilities(ctx: any, options: { strict?: boolean } = {}): CapabilityAssertion {
  const assertion = probeHostCapabilities(ctx)
  if (options.strict === true && !assertion.ok) {
    throw new ParadiseError('HOST_CAPABILITY_MISSING', 'assert', assertion.message)
  }
  return assertion
}

/**
 * The BOOT-TIME assertion — strict unless explicitly told otherwise.
 *
 * Separate from `assertHostCapabilities` so the two defaults cannot be confused: construction is a
 * library question (report), boot is an operational question (refuse). `PARADISE_STRICT_HOST` is the
 * override for a deliberately bare profile.
 */
export function assertHostCapabilitiesOnBoot(ctx: any): CapabilityAssertion {
  const override = String(process.env.PARADISE_STRICT_HOST ?? '').trim()
  const strict = override === '0' ? false : true
  return assertHostCapabilities(ctx, { strict })
}
