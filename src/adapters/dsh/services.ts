/**
 * SERVICE RESOLUTION FOR THIS RUNTIME — the one copy, shared by this directory's adapters.
 *
 * WHY IT IS A SHARED MODULE INSIDE `adapters/<host>/` AND NOT IN `protocol/`
 *
 * "Resolve a service by the method you are about to call" is a fact about how THIS runtime exposes
 * its services through two accessors. A different harness may have a DIFFERENT resolution story
 * (or none). So the rule lives with the host, and the protocol only says an adapter has to be able to
 * answer its own capabilities.
 *
 * WHY THE RULE EXISTS AT ALL: several services here expose different faces through the two accessors
 * — the tool registry's direct property may carry only `register`, while the accessor is where
 * `execute` lives. Resolving positionally picked a candidate that could not do the work, and the
 * symptom read as "the service is missing" for an hour.
 */

/** Resolve a service, preferring the accessor that actually has `method`. */
export function service(ctx: any, name: string, method?: string): any {
  const candidates: any[] = []
  try {
    const direct = ctx?.[name]
    if (direct !== undefined && direct !== null) candidates.push(direct)
  } catch {
    // A property getter that throws is simply not a candidate.
  }
  try {
    const viaGet = ctx?.get?.(name)
    if (viaGet !== undefined && viaGet !== null) candidates.push(viaGet)
  } catch {
    // Same for `get`.
  }
  if (candidates.length === 0) return undefined
  if (method === undefined) return candidates[0]
  return candidates.find((candidate) => typeof candidate?.[method] === 'function')
}
