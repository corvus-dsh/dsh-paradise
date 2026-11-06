/**
 * ROUTE CONFIGURATION ON DISK — `adapters/raw/route-config.ts`.
 *
 * WHY A FILE AT ALL, WHEN ENVIRONMENT VARIABLES ARE SIMPLER
 *
 * An environment variable is fixed at process start. The situation this module exists for is exactly the
 * one where the process is ALREADY RUNNING and its key has just been exhausted — nobody wants to restart
 * a harness mid-repair to change a URL. A file can be rewritten by a running process, and re-read by the
 * same process on the next failure.
 *
 * THE THREE-WAY PRECEDENCE, AND WHY IT IS THAT ORDER
 *
 *   1. ENVIRONMENT — an operator override. Always wins, never persisted, and survives a config rewrite.
 *   2. THE FILE      — the durable answer, writable at runtime.
 *   3. NOTHING       — reported as absent, which is a legitimate state (no fallback configured yet).
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 *
 * It does not validate that the endpoint WORKS. A config that points at a dead host is a config that will
 * fail on the next call, with a real error — and pre-flighting it here would mean this module knows how to
 * speak the provider's health protocol, which is the LLM adapter's job.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** The shape stored in `config.json`. Every field optional: a partial file is a legitimate file. */
export interface RouteConfig {
  /** The PRIMARY endpoint. */
  baseUrl?: string
  /** The PRIMARY key. Its presence here is a deliberate trade — see the warning below. */
  apiKey?: string
  model?: string
  /** The fallback endpoint used when the primary reports a spent budget. */
  fallbackBaseUrl?: string
  /** The fallback key. */
  fallbackApiKey?: string
  fallbackModel?: string
}

export interface ResolvedRoute {
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly model?: string
}

/** Where the file lives when a caller does not name one. */
export function defaultRouteConfigPath(cwd: string = process.cwd()): string {
  return resolve(cwd, 'dsh-paradise', 'config.json')
}

/**
 * READ THE FILE. A missing or broken file is `{}`, never a throw.
 *
 * WHY A BROKEN FILE IS NOT AN ERROR: this is read on the failure path, immediately after a 429. Turning a
 * malformed config into an exception there would replace "your quota is spent" with "your JSON has a
 * trailing comma" — losing the information the operator actually needs.
 */
export function readRouteConfig(path: string): RouteConfig {
  try {
    const parsed = JSON.parse(readFileSync(resolve(path), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const source = parsed as Record<string, unknown>
    const pick = (key: string): string | undefined => {
      const value = source[key]
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
    }
    return {
      ...(pick('baseUrl') === undefined ? {} : { baseUrl: pick('baseUrl') }),
      ...(pick('apiKey') === undefined ? {} : { apiKey: pick('apiKey') }),
      ...(pick('model') === undefined ? {} : { model: pick('model') }),
      ...(pick('fallbackBaseUrl') === undefined ? {} : { fallbackBaseUrl: pick('fallbackBaseUrl') }),
      ...(pick('fallbackApiKey') === undefined ? {} : { fallbackApiKey: pick('fallbackApiKey') }),
      ...(pick('fallbackModel') === undefined ? {} : { fallbackModel: pick('fallbackModel') }),
    } as RouteConfig
  } catch {
    return {}
  }
}

/**
 * WHICH FALLBACK ROUTE IS CONFIGURED, from environment first then the file.
 *
 * RETURNED AS A PURE FUNCTION OF (env, file) so a test can state both without touching either. The LLM
 * adapter calls this from `loadFallbackRoute`, which is why it must be side-effect free.
 */
export function resolveFallbackRoute(
  path: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedRoute | undefined {
  const envUrl = env.FALLBACK_API_URL ?? env.FALLBACK_BASE_URL
  const envKey = env.FALLBACK_API_KEY
  const envModel = env.FALLBACK_MODEL
  if (typeof envUrl === 'string' && envUrl.trim().length > 0 && typeof envKey === 'string' && envKey.trim().length > 0) {
    return {
      baseUrl: envUrl.trim(),
      apiKey: envKey.trim(),
      ...(typeof envModel === 'string' && envModel.trim().length > 0 ? { model: envModel.trim() } : {}),
    }
  }
  const file = readRouteConfig(path)
  if (
    typeof file.fallbackBaseUrl === 'string' &&
    file.fallbackBaseUrl.length > 0 &&
    typeof file.fallbackApiKey === 'string' &&
    file.fallbackApiKey.length > 0
  ) {
    return {
      baseUrl: file.fallbackBaseUrl,
      apiKey: file.fallbackApiKey,
      ...(file.fallbackModel === undefined ? {} : { model: file.fallbackModel }),
    }
  }
  return undefined
}

/**
 * REWRITE THE FILE — atomically, keeping every field the caller did not mention.
 *
 * WHY MERGE AND NOT REPLACE: the caller of this function is a REPAIR — it knows the one thing that is
 * wrong (the endpoint) and nothing about the rest. A replace would drop the operator's model choice and
 * any fields a future version adds, turning a targeted edit into a data-loss event.
 *
 * WHY ATOMIC: this file is read on a failure path. A half-written config read by a concurrent process
 * would report "no fallback configured" at the exact moment the fallback was being configured.
 */
export function rewriteRouteConfig(path: string, patch: RouteConfig): { ok: boolean; path: string; merged: RouteConfig; error?: string } {
  const target = resolve(path)
  const existing = readRouteConfig(target)
  const merged: RouteConfig = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    /**
     * `rename` REPLACES ON BOTH NTFS AND POSIX. `rmSync` first would open a window where the file does not
     * exist at all — and a reader in that window concludes "no config", which is the wrong answer.
     */
    renameSync(temp, target)
    return { ok: true, path: target, merged }
  } catch (error) {
    return { ok: false, path: target, merged: existing, error: String((error as any)?.message ?? error) }
  }
}

/** Does a config file exist? Used by a diagnostic to say "configured" versus "absent". */
export function routeConfigExists(path: string): boolean {
  return existsSync(resolve(path))
}
