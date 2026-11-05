/**
 * A LEASE BUILT ENTIRELY ON `StorageAdapter` — `src/lease-adapter.ts`.
 *
 * WHY THIS IS NOT UNDER `adapters/<host>/`
 *
 * It names no host. It needs exactly one thing from the host: `storage.compareAndSet`, an ATOMIC
 * read-modify-write. That is a protocol capability, not a filesystem trick — the in-memory reference
 * host implements it too (by serialising its own callbacks), and this same code runs on both. Putting
 * it here is what stops two hosts from drifting into two subtly different fencing rules.
 *
 * THE ONE HOST FACT IT READS: `storage.name`, for reporting. And `compareAndSet` being ABSENT makes
 * the lease advisory (`exclusive: false`) rather than a lie — `withLease` then refuses to use it.
 *
 * WHY THE RECORD CARRIES ITS OWN KEY: a lease document is written to the same store as everything
 * else, and a torn write is exactly what that store exists to survive. A record that does not name its
 * own key is treated as garbage rather than believed.
 */

import type { LeaseAdapter, LeaseAttempt, LeaseRecord, LeaseRequest, MutationReceipt, StorageAdapter } from './protocol/index.js'
import { isLeaseExpired, planAcquire, planRelease, planRenew } from './protocol/index.js'
import { LEASE_RELEASE } from './protocol/lease.js'

/** Default validity. Covers a pass over a large session; short enough to self-heal after a crash. */
const DEFAULT_TTL_MS = 30_000

/** Upper bound on one claim's life, so a renewal loop cannot hold a key forever by accident. */
const MAX_TTL_MS = 10 * 60_000

/** Who is asking by default: this process. Opaque to the layer; useful in an audit line. */
export function defaultLeaseOwner(): string {
  return `pid:${process.pid}`
}

/** Read a stored value as a lease record, refusing anything that does not name its own key. */
export function asLeaseRecord(key: string, value: unknown): LeaseRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.key !== key) return undefined
  if (typeof candidate.owner !== 'string' || candidate.owner.length === 0) return undefined
  if (!Number.isFinite(Number(candidate.epoch))) return undefined
  if (!Number.isFinite(Number(candidate.expiresAt))) return undefined
  return {
    key,
    owner: candidate.owner,
    epoch: Number(candidate.epoch),
    acquiredAt: Number(candidate.acquiredAt) || 0,
    expiresAt: Number(candidate.expiresAt),
  }
}

/** The storage key a lease lives under. Namespaced so it cannot collide with a caller's own key. */
export function leaseStorageKey(key: string): string {
  return `lease-${key.replace(/[^a-z0-9._-]/giu, '-')}`
}

export function createStorageLeaseAdapter(storage: StorageAdapter): LeaseAdapter {
  const canCompareAndSet = typeof storage.compareAndSet === 'function'

  async function readLease(key: string): Promise<LeaseRecord | undefined> {
    return asLeaseRecord(key, await storage.read(leaseStorageKey(key)))
  }

  function resolveTtl(request: LeaseRequest): number {
    const requested = Number.isFinite(Number(request.ttlMs)) ? Math.max(1, Number(request.ttlMs)) : DEFAULT_TTL_MS
    return Math.min(MAX_TTL_MS, requested)
  }

  return {
    name: `${storage.name}-lease`,
    exclusive: canCompareAndSet,

    async acquire(key: string, request: LeaseRequest = {}): Promise<LeaseAttempt> {
      const now = Number.isFinite(Number(request.now)) ? Number(request.now) : Date.now()
      const owner = typeof request.owner === 'string' && request.owner.length > 0 ? request.owner : defaultLeaseOwner()
      const ttlMs = resolveTtl(request)
      if (!canCompareAndSet) {
        return {
          ok: false,
          stage: 'lease:advisory',
          warnings: [],
          reason: `${storage.name} 没有 compareAndSet，租约只能是提示性的`,
        }
      }

      let refusal: LeaseRecord | undefined
      const result = await storage.compareAndSet!(leaseStorageKey(key), (current) => {
        /**
         * THE DECISION IS NOT MADE HERE — it is made in `protocol/lease.ts`, shared with the
         * SYNCHRONOUS driver. This function only supplies the current value and writes what it is told.
         */
        const decision = planAcquire(key, asLeaseRecord(key, current), { owner, now, ttlMs })
        if (!decision.ok) {
          refusal = decision.holder
          return undefined
        }
        return decision.lease
      })

      if (!result.ok) {
        return {
          ok: false,
          stage: 'lease:busy',
          ...(refusal === undefined ? {} : { holder: refusal }),
          warnings: result.warnings,
          reason:
            refusal === undefined
              ? 'compareAndSet 未取得（守卫繁忙或写入失败）'
              : `已被 ${refusal.owner} 持有（epoch=${refusal.epoch}）`,
        }
      }
      const lease = asLeaseRecord(key, result.value)
      if (lease === undefined) {
        return { ok: false, stage: 'lease:corrupt', warnings: result.warnings, reason: '写入后的租约记录不可读' }
      }
      return { ok: true, stage: 'lease:acquired', lease, warnings: result.warnings }
    },

    async renew(lease: LeaseRecord, request: LeaseRequest = {}): Promise<LeaseAttempt> {
      const now = Number.isFinite(Number(request.now)) ? Number(request.now) : Date.now()
      const ttlMs = resolveTtl(request)
      if (!canCompareAndSet) {
        return { ok: false, stage: 'lease:advisory', warnings: [], reason: `${storage.name} 没有 compareAndSet` }
      }
      const result = await storage.compareAndSet!(leaseStorageKey(lease.key), (current) => {
        // The fence lives in `planRenew`, shared with the synchronous driver.
        const next = planRenew(asLeaseRecord(lease.key, current), lease, { now, ttlMs })
        return next === undefined ? undefined : next
      })
      if (!result.ok) {
        const holder = await readLease(lease.key)
        return {
          ok: false,
          stage: 'lease:lost',
          ...(holder === undefined ? {} : { holder }),
          warnings: result.warnings,
          reason: `epoch=${lease.epoch} 已不是当前代（现任 ${holder?.owner ?? '无'}，epoch=${holder?.epoch ?? '-'}）`,
        }
      }
      return {
        ok: true,
        stage: 'lease:renewed',
        lease: asLeaseRecord(lease.key, result.value) ?? lease,
        warnings: result.warnings,
      }
    },

    async release(lease: LeaseRecord): Promise<MutationReceipt> {
      if (!canCompareAndSet) {
        return {
          ok: false,
          stage: 'lease:advisory',
          warnings: [],
          error: { code: 'LEASE_ADVISORY', stage: 'release', message: `${storage.name} 没有 compareAndSet` },
        }
      }
      const result = await storage.compareAndSet!(leaseStorageKey(lease.key), (current) => {
        /**
         * SAME FENCE AS `renew`, and it matters MORE here: deleting a successor's claim would hand the
         * key to a third writer while the successor still believes it is alone. A refused release is
         * the correct outcome for a stale holder, not an error to work around.
         */
        return planRelease(asLeaseRecord(lease.key, current), lease)
      })
      if (!result.ok) {
        return {
          ok: false,
          stage: 'lease:release-refused',
          warnings: result.warnings,
          error: {
            code: 'LEASE_STALE',
            stage: 'release',
            message: `epoch=${lease.epoch} 不是当前代，拒绝释放（否则会删掉继任者的租约）`,
          },
        }
      }
      return { ok: true, stage: 'lease:released', warnings: result.warnings }
    },

    async inspect(key: string): Promise<LeaseRecord | undefined> {
      const lease = await readLease(key)
      return isLeaseExpired(lease, Date.now()) ? undefined : lease
    },
  }
}
