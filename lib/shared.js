/**
 * Shared logic of dsh_session_recyclebin and its Session Trash sub-plugin.
 *
 * Both host halves are entries of one npm package, so they share this module
 * directly — one implementation of "remove a session from the world" and one
 * implementation of "un-list a session from the live registry", which is what
 * makes a delete visible in the sidebar without a restart.
 *
 * The helpers here mirror the shipped backends exactly:
 *
 *  - `encodeSegment` / `projectKey` reproduce `dsh-session-persistence-jsonl`'s
 *    own path encoding, validated against the real on-disk session tree; the
 *    persistence root itself is read from the live service, never re-derived.
 *  - `unlistSessionInRegistry` uses ONLY the live `workspaceRegistry`'s own
 *    verbs. Each write is durable AND fires `domain/changed`, which the
 *    workspace feed pushes to every connected client as an increment — the
 *    same path archiving takes, which is why the row disappears immediately.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { rm, stat } from 'node:fs/promises'

/** Loader row id; used for log prefixes. */
export const PLUGIN_NAME = 'dsh_session_recyclebin'

/** Default JSONL persistence root when the live service cannot be read. */
export const DEFAULT_SESSIONS_ROOT = 'sessions'

/** Default storage root when the live service cannot be read. */
export const DEFAULT_STORAGES_ROOT = 'storages'

/** Projection-cache sub-path under the storage root. */
export const PROJCACHE_SESSIONS = join('session_projcache', 'sessions')

/** Attachment storage sub-path under the DSH home. */
export const ATTACHMENTS_DIR = 'attachments'

/**
 * Encode one session id as a single safe path segment, mirroring
 * `dsh-session-persistence-jsonl`'s own `encodeSegment`. Safe code units stay
 * literal; every other code unit becomes `~XXXX`; `.` and `..` are escaped so
 * a crafted id cannot traverse. Working in code units preserves lone
 * surrogates.
 *
 * @param {string} raw - the value to encode.
 * @returns {string} the escaped segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('session id must be a non-empty string')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = String.fromCharCode(raw.charCodeAt(i))
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the readable project-directory key for a working directory, mirroring
 * `dsh-session-persistence-jsonl`'s own `projectKey`. Separators and drive
 * colons collapse to `-`; unsafe code units use the `~XXXX` escape; the key is
 * bounded and the transformation is intentionally lossy, exactly as the
 * backend's is.
 *
 * @param {string} cwd - the session's project directory.
 * @returns {string} the `--...--` wrapped directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('project directory must be a non-empty string')
  }
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const ch = String.fromCharCode(cwd.charCodeAt(i))
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * The DSH home directory, preferring the environment variable the host sets
 * and falling back to the conventional `~/.dsh`.
 *
 * @returns {string} the absolute DSH home path.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Resolve the JSONL persistence root from the live service when it exposes
 * one, otherwise from the environment.
 *
 * @param {unknown} persistence - the live `sessionPersistence` service.
 * @returns {string} the absolute persistence root.
 */
export function sessionsRootOf(persistence) {
  const root = persistence?.root
  if (typeof root === 'string' && root.trim() !== '') return resolve(root)
  return join(dshHome(), DEFAULT_SESSIONS_ROOT)
}

/**
 * The storage root (`<home>/storages`).
 *
 * @returns {string} the absolute storage root.
 */
export function storagesRoot() {
  return join(dshHome(), DEFAULT_STORAGES_ROOT)
}

/**
 * Whether a path exists and is a directory.
 *
 * @param {string} path - the absolute path to test.
 * @returns {Promise<boolean>} true when it is a directory.
 */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether a path exists at all.
 *
 * @param {string} path - the absolute path to test.
 * @returns {Promise<boolean>} true when it exists.
 */
export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The basename of a workspace path, both separators accepted — the label DSH
 * itself falls back to for a session with no folded title.
 *
 * @param {string | undefined} cwd - the recorded project directory.
 * @returns {string | undefined} the final path segment, or undefined.
 */
export function basenameOf(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const trimmed = cwd.replace(/[/\\]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const base = trimmed.slice(cut + 1)
  return base !== '' ? base : undefined
}

/**
 * Resolve one session's DISPLAY title, the string the sidebar and the trash
 * panel both show.
 *
 * The durable session header carries `cwd` but never a title: a title is a
 * `session/title` event folded out of the log by `sessionTitle` /
 * `sessionQuery`, which is why reading `header.title` (the obvious move) always
 * yields `undefined` and a trash row ends up labelled with the session id or
 * the raw directory. This helper therefore asks the log-backed title service
 * first and only falls back to the directory basename and finally the id.
 *
 * @param {object} args
 * @param {unknown} [args.query] - the live `sessionQuery` service.
 * @param {unknown} [args.persistence] - the live `sessionPersistence` service.
 * @param {string} args.sessionId - the session to name.
 * @param {string} [args.cwd] - the recorded project directory, when known.
 * @returns {Promise<string>} the best available display title.
 */
export async function resolveSessionTitle({ query, persistence, sessionId, cwd }) {
  const title = await readFoldedTitle(query, sessionId)
  if (title !== undefined) return title

  // Forward-compatibility: a future header shape that carries a title wins over
  // a derived directory label, so it is still consulted before the fallbacks.
  const header = await readSessionHeader(persistence, sessionId)
  const headerTitle = typeof header?.title === 'string' ? header.title.trim() : ''
  if (headerTitle !== '') return headerTitle

  const base = basenameOf(cwd ?? header?.cwd)
  if (base !== undefined) return base
  return sessionId
}

/**
 * Fold the latest title out of one session's log without activating it.
 *
 * @param {unknown} query - the live `sessionQuery` service.
 * @param {string} sessionId - the session to read.
 * @returns {Promise<string | undefined>} the trimmed title, or undefined.
 */
async function readFoldedTitle(query, sessionId) {
  if (query === undefined || typeof query.readTitle !== 'function') return undefined
  try {
    const snapshot = await query.readTitle(sessionId)
    const title = typeof snapshot === 'string' ? snapshot : snapshot?.title
    if (typeof title !== 'string') return undefined
    const trimmed = title.trim()
    return trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}

/**
 * Read one session's durable header through the persistence service, without
 * activating a Session or an Agent.
 *
 * @param {unknown} persistence - the live `sessionPersistence` service.
 * @param {string} sessionId - the session to read.
 * @returns {Promise<{ cwd?: string, title?: string } | undefined>} the header.
 */
export async function readSessionHeader(persistence, sessionId) {
  if (persistence === undefined || typeof persistence.stat !== 'function') return undefined
  try {
    const snapshot = await persistence.stat(sessionId)
    return snapshot?.header
  } catch {
    return undefined
  }
}

/**
 * Enumerate every project directory under the persistence root.
 *
 * @param {string} root - the persistence root.
 * @returns {Promise<string[]>} the project directories that exist.
 */
export async function projectDirsOf(root) {
  const { readdir } = await import('node:fs/promises')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
}

/**
 * Locate the session directory that owns one session id.
 *
 * @param {object} args - the lookup arguments.
 * @param {string} args.root - the persistence root.
 * @param {string} args.sessionId - the session id to find.
 * @param {string} [args.cwd] - the session's recorded project directory.
 * @returns {Promise<string | undefined>} the absolute session directory.
 */
export async function locateSessionDir({ root, sessionId, cwd }) {
  const encoded = encodeSegment(sessionId)
  if (typeof cwd === 'string' && cwd !== '') {
    const candidate = join(root, projectKey(cwd), encoded)
    if (await isDirectory(candidate)) return candidate
  }
  for (const projectDir of await projectDirsOf(root)) {
    const candidate = join(projectDir, encoded)
    if (await isDirectory(candidate)) return candidate
  }
  return undefined
}

/**
 * Remove one session's durable artifacts.
 *
 * @param {object} args - the removal arguments.
 * @param {string} args.sessionId - the session to delete.
 * @param {string} [args.cwd] - the session's recorded project directory.
 * @param {unknown} args.persistence - the live persistence service.
 * @returns {Promise<{ sessionDir?: string, removedProjection: boolean, removedAttachments: boolean }>} what was removed.
 */
export async function removeSessionArtifacts({ sessionId, cwd, persistence }) {
  const root = sessionsRootOf(persistence)
  const sessionDir = await locateSessionDir({ root, sessionId, cwd })
  if (sessionDir !== undefined) {
    await rm(sessionDir, { recursive: true, force: true })
  }

  const projectionPath = join(storagesRoot(), PROJCACHE_SESSIONS, `${encodeSegment(sessionId)}.json`)
  let removedProjection = false
  if (await pathExists(projectionPath)) {
    await rm(projectionPath, { force: true })
    removedProjection = true
  }

  const attachmentsDir = join(dshHome(), ATTACHMENTS_DIR, encodeSegment(sessionId))
  let removedAttachments = false
  if (await pathExists(attachmentsDir)) {
    await rm(attachmentsDir, { recursive: true, force: true })
    removedAttachments = true
  }

  return { sessionDir, removedProjection, removedAttachments }
}

/**
 * The workspace registry face this plugin uses. Only these members are read,
 * and every write goes through the registry's own operation queue so its
 * in-memory projections and the pushed domain increments stay authoritative.
 *
 * @typedef {object} RegistryFace
 * @property {() => Array<{ id: string, path: string, sessionIds: readonly string[], attachSession?: (sessionId: string) => Promise<void>, detachSession?: (sessionId: string) => Promise<void> }>} list
 * @property {(sessionId: string, options?: { stopActivity?: boolean }) => Promise<unknown>} archiveSession
 * @property {(sessionId: string) => Promise<unknown>} unarchiveSession
 * @property {(sessionId: string) => Promise<unknown>} pinSession
 * @property {(sessionId: string) => Promise<unknown>} unpinSession
 * @property {readonly string[]} archivedSessionIds
 * @property {readonly string[]} pinnedSessionIds
 */

/**
 * Un-list one session through the live workspace registry's OWN verbs, so
 * every removal is a registry-queued, durable, pushed domain mutation — the
 * same path archiving takes, which is why the sidebar row disappears without
 * a restart. The plugin never touches the registry's domain facility, cached
 * global state, or record snapshots directly: each call below keeps its cache
 * authoritative and emits the increment every connected client follows.
 *
 *  - `archiveSession(id, { stopActivity: true })` is the supported way to stop
 *    a session's running work from the Host side: it stops the turn,
 *    subagents, jobs, and schedules the way the stop button does, and the
 *    archive-set write hides the row. A bare agent cancel would leave jobs
 *    alive against files deleted underneath them.
 *  - `detachSession(id)` removes the id from the owning workspace's durable
 *    account, so no later rescan or reconnection re-adopts the session; the
 *    `workspaces` upsert carries the corrected `sessionIds` to every client.
 *  - `unarchiveSession(id)` (the purge flavor only) drops the archive mark
 *    taken above, so the archive set never outlives the session and no
 *    restore surface offers to resurrect a purged one. The trash flavor
 *    KEEPS the mark: the archive state is the trash's hide mechanism, and a
 *    restore un-archives what a move archived.
 *  - `unpinSession(id)` is defensive: the archive step normally drops the
 *    pin, but a session archived before this call can still hold one.
 *
 * A session the registry never knew (`WorkspaceUnknownSessionError`) is not a
 * failure — there is nothing to un-list. Every step is idempotent.
 *
 * @param {RegistryFace | undefined} registry - the live registry service.
 * @param {string} sessionId - the session to forget.
 * @param {object} [options] - procedure options.
 * @param {boolean} [options.keepArchived] - leave the archive mark in place
 *   (the trash flavor: the mark hides the row and a restore clears it).
 * @param {object} [options.logger] - the plugin logger, for registry traces.
 * @returns {Promise<boolean>} true when any registry write was committed.
 */
export async function hideSessionInRegistry(registry, sessionId, { keepArchived = false, logger } = {}) {
  if (registry === undefined) {
    throw new Error('workspace registry is unavailable; refusing to delete without un-listing the session')
  }
  if (typeof registry.archiveSession !== 'function' || typeof registry.list !== 'function') {
    throw new Error('workspace registry does not expose the verbs this delete needs')
  }

  let changed = false
  let archivedByUs = false

  const alreadyArchived = registry.archivedSessionIds?.includes?.(sessionId) ?? false
  if (!alreadyArchived) {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      archivedByUs = true
      changed = true
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkspaceUnknownSessionError') {
        logger?.info?.(`${PLUGIN_NAME}: session "${sessionId}" is unknown to the registry; nothing to un-list`)
        return false
      }
      throw error
    }
  }

  for (const workspace of registry.list()) {
    if (!workspace.sessionIds?.includes?.(sessionId)) continue
    if (typeof workspace.detachSession !== 'function') continue
    await workspace.detachSession(sessionId)
    changed = true
  }

  if (!keepArchived && (archivedByUs || alreadyArchived) && typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId)
    changed = true
  }

  if (registry.pinnedSessionIds?.includes?.(sessionId) && typeof registry.unpinSession === 'function') {
    await registry.unpinSession(sessionId)
    changed = true
  }

  return changed
}

/**
 * Un-list a session for permanent deletion: hide it and leave no archived
 * mark behind (the id is about to have no files at all).
 *
 * @param {RegistryFace | undefined} registry - the live registry service.
 * @param {string} sessionId - the session to forget.
 * @param {object} [logger] - the plugin logger.
 * @returns {Promise<boolean>} true when any registry write was committed.
 */
export async function unlistSessionInRegistry(registry, sessionId, logger) {
  return hideSessionInRegistry(registry, sessionId, { keepArchived: false, logger })
}

/**
 * Delete one session end to end: un-list it, then remove its artifacts.
 *
 * @param {object} args - the deletion arguments.
 * @param {{ persistence?: unknown, registry?: RegistryFace | undefined }} args.services
 * @param {string} args.sessionId - the session to delete.
 * @param {object} [args.logger] - the plugin logger.
 * @returns {Promise<object>} a report of what happened.
 */
export async function deleteSession({ services, sessionId, logger }) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('sessionId is required')
  }

  const { persistence, registry } = services
  const header = await readSessionHeader(persistence, sessionId)
  const cwd = header?.cwd
  const forgot = await unlistSessionInRegistry(registry, sessionId, logger)
  const artifacts = await removeSessionArtifacts({ sessionId, cwd, persistence })

  return {
    ok: true,
    sessionId,
    title: header?.title,
    cwd,
    removedWorkspaceRecord: forgot,
    sessionDir: artifacts.sessionDir,
    removedProjection: artifacts.removedProjection,
    removedAttachments: artifacts.removedAttachments
  }
}

/**
 * Read a bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @param {number} [maxBytes] - the largest body accepted.
 * @returns {Promise<unknown>} the parsed body, or `undefined` when empty.
 */
export async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  return JSON.parse(text)
}

/**
 * Write one JSON response and end it.
 *
 * @param {import('node:http').ServerResponse} res - the response to write.
 * @param {number} status - the HTTP status code.
 * @param {unknown} payload - the JSON payload.
 * @returns {void}
 */
export function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/**
 * Write one error response in the plugin's own envelope.
 *
 * @param {import('node:http').ServerResponse} res - the response to write.
 * @param {number} status - the HTTP status code.
 * @param {string} code - a stable machine-readable code.
 * @param {string} message - a human-readable message.
 * @returns {void}
 */
export function writeError(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}
