/**
 * HOST CAPABILITY PROBING — a fact about THIS runtime, so it lives with the adapter.
 *
 * WHY THIS MOVED OUT OF `src/host/`
 *
 * It answers "which of this runtime's services are mounted, and what does an absence cost?" — a
 * question whose very SUBSTANCE is a list of this runtime's service names. Keeping it outside
 * `adapters/<host>/` meant a second host had to edit a shared file to describe itself, which is the
 * coupling this whole restructure exists to remove.
 *
 * The protocol's answer to "what can this host do?" is `SessionAdapter.capabilities`, declared BY the
 * adapter. This module is the older, broader probe the write layer will use once it lands; it stays
 * host-side until then.
 */

import { service } from './services.js'

/** What this host can physically do. Computed per context, read by every caller. */
export interface HostCapabilities {
  can: {
    prepareCold: boolean
    persistenceCreate: boolean
    persistenceOpen: boolean
    persistenceStat: boolean
    discardPrepared: boolean
    readSession: boolean
    workspaceAttach: boolean
    clientAnnounce: boolean
    controllerPrompt: boolean
  }
  /** Capabilities that are NOT available, with what it costs the caller. */
  unavailable: Array<{ capability: string; neededBy: string; consequence: string }>
}

/**
 * Probe the host ONCE and answer, for each capability, "can it, and if not, what does that cost".
 *
 * The draft (§3.5) makes this a first-class output because it is what lets a caller decide between
 * degrading and refusing BEFORE it starts writing. A caller that discovers a missing capability
 * halfway through a seven-step write has already produced an artifact.
 */
export function probeCapabilities(ctx: any): HostCapabilities {
  const has = (name: string, method: string): boolean => {
    const found = service(ctx, name, method)
    return found !== undefined && typeof found[method] === 'function'
  }

  const can = {
    prepareCold: has('sessions', 'prepare'),
    persistenceCreate: has('sessionPersistence', 'create'),
    persistenceOpen: has('sessionPersistence', 'open'),
    persistenceStat: has('sessionPersistence', 'stat'),
    discardPrepared: has('sessionPersistence', 'discardPrepared'),
    readSession: has('sessionQuery', 'readSession'),
    workspaceAttach: has('workspaceRegistry', 'resolveByPath'),
    clientAnnounce: typeof ctx?.emit === 'function',
    controllerPrompt: has('sessionController', 'prompt'),
  }

  const unavailable: HostCapabilities['unavailable'] = []
  const note = (capability: string, neededBy: string, consequence: string): void => {
    unavailable.push({ capability, neededBy, consequence })
  }
  if (!can.prepareCold) {
    note('sessions.prepare', 'write/create', '无法建造 detached 会话；孵化必须整体拒绝，绝不退化成 live append')
  }
  if (!can.persistenceCreate) {
    note('sessionPersistence.create', 'write/create', '无法落盘冷产物；孵化必须拒绝')
  }
  if (!can.persistenceStat) {
    note('sessionPersistence.stat', 'write/discard', '删除后无法核实；回执必须写 removalUnverifiable')
  }
  if (!can.readSession) {
    note('sessionQuery.readSession', 'read/cold', '写后无法冷读校验；verify 只能报告 skipped')
  }
  if (!can.workspaceAttach) {
    note('workspaceRegistry.resolveByPath', 'publish', '会话不会挂到工作区分组（侧边栏可能未分组），但产物有效')
  }
  if (!can.clientAnnounce) {
    note('ctx.emit', 'publish', '客户端不会收到 api-session/added，需要刷新才看见会话')
  }
  if (!can.controllerPrompt) {
    note('sessionController.prompt', 'ignite', '无法自动点火；会话仍可手动打开')
  }

  return { can, unavailable }
}
