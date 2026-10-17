/**
 * Session Trash — the optional sub-plugin of dsh_session_recyclebin (host half).
 *
 * Enabled, it turns every "Delete Session" into a move to the trash instead
 * of an immediate purge: the session disappears from the sidebar (un-listed
 * through the live workspace registry, so the row fades without a restart),
 * while its logs park in the plugin's trash directory. A small trash button at the sidebar
 * foot — contributed by this plugin's client half through the
 * `sidebar.footer.action` seat — opens a panel that lists the parked
 * sessions; from it the user can restore one (re-attach it to its workspace
 * and re-list it), purge it for good, or empty the whole trash. Entries older
 * than a retention the user configures between 3 and 30 days are purged
 * automatically on the Host's own timer and again at boot, because a trash
 * nobody opens still has to empty itself.
 *
 * Ownership model
 * ---------------
 * The trash index is the ONE authority on what a deleted session is. An entry
 * records enough to put the session back exactly as the registry saw it:
 *   - sessionId, title, cwd (from the durable header at move time)
 *   - the workspace id that accounted for it (the restore target)
 *   - the archived / pinned marks it held at move time
 *   - deletedAt, the retention clock
 * Restore re-attaches through the live registry (which also re-emits the
 * domain increments that make the row re-appear without a restart); purge
 * reuses `deleteSession` from `lib/shared.js`, so "remove a session from the
 * world" stays a single implementation shared with the main half.
 *
 * Hiding mechanism
 * ----------------
 * A moved session leaves the sidebar for good, by having its durable session
 * log moved out of the persistence root into the trash's own directory. The
 * sidebar combines persisted and live sessions. Relocation handles persisted
 * records; durable hiddenSessionIds drive the client snapshot filter for live
 * records, independently of the archived view option. `archiveSession`
 * (which also stops the session's running work) and `detachSession` still run
 * first, so the registry agrees the session is gone from every account, and
 * the archive mark is what keeps the registry quiet while the files park.
 *
 * A move that cannot relocate the log is REFUSED: the trash must never hold a
 * session the sidebar still lists. Restore moves the log back to the exact
 * path it came from and re-attaches it, so the row becomes available again.
 *
 * Durability
 * ----------
 * The index lives under the plugin's own data directory
 * (`<DSH_HOME>/session-delete/trash.json`), never inside the workspace or
 * session domains — this plugin must not corrupt a domain it does not own.
 * Every mutation persists through a temp-file + rename so a crash mid-write
 * cannot truncate the index; a malformed index is quarantined
 * (`trash.corrupt-<stamp>.json`) and the plugin starts fresh rather than
 * trusting half-parsed records.
 *
 * Interaction with the main plugin
 * --------------------------------
 * While enabled this entry provides the `sessionDeleteTrash` service; the
 * main delete route probes it per request and hands deleted sessions over.
 * Disabling this sub-plugin therefore reverts deletes to direct purges with
 * no restart, and enabling it never affects the main half's boot. The trash's
 * own HTTP surface is one prefix, `/session-delete/api/trash`, with fixed
 * method names and no free-form path handling.
 */

import { basename, dirname, join } from 'node:path'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import {
  PLUGIN_NAME,
  deleteSession,
  dshHome,
  encodeSegment,
  readSessionHeader,
  hideSessionInRegistry,
  locateSessionDir,
  pathExists,
  projectKey,
  readJsonBody,
  resolveSessionTitle,
  sessionsRootOf,
  storagesRoot,
  writeJson,
  writeError,
  PROJCACHE_SESSIONS,
  ATTACHMENTS_DIR
} from './shared.js'

/** HTTP prefix of the trash routes, under the main plugin's own prefix. */
export const TRASH_API_PREFIX = '/session-delete/api/trash'

/** Service name this entry provides; must match the main half's probe. */
export const TRASH_SERVICE = 'sessionDeleteTrash'

/** Data file holding the trash index, under the DSH home. */
const TRASH_DATA_FILE = join('session-delete', 'trash.json')

/** Directory holding the parked session logs, under the DSH home. */
const TRASH_LOGS_DIR = join('session-delete', 'logs')

/** Boundaries of the user-configurable retention, in days. */
export const RETENTION_MIN_DAYS = 3
export const RETENTION_MAX_DAYS = 30
export const RETENTION_DEFAULT_DAYS = 7

/** How often the sweeper checks for expired entries. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {object} TrashEntry
 * @property {string} sessionId
 * @property {string} title - display title at move time, resolved from the log.
 * @property {string | undefined} cwd - workspace path at move time.
 * @property {string | undefined} workspaceId - the workspace that accounted for the session.
 * @property {boolean} wasArchived - archived mark held at move time.
 * @property {boolean} wasPinned - pinned mark held at move time.
 * @property {string} logPath - where the session log lived before the move.
 * @property {string} parkedLogPath - where the log parks while trashed.
 * @property {number} deletedAt - epoch ms the entry was moved to the trash.
 */

/**
 * Clamp a requested retention into the supported [3, 30] day window.
 *
 * @param {number} days
 * @returns {number}
 */
export function clampRetention(days) {
  if (typeof days !== 'number' || !Number.isFinite(days)) return RETENTION_DEFAULT_DAYS
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, Math.round(days)))
}

/**
 * The trash store: one durable JSON document, an in-memory map, and a write
 * tail. All reads and edits go through this class; every mutation is atomic
 * on disk (temp + rename) and serialized through an in-memory tail so two
 * concurrent requests cannot interleave partial writes.
 */
export class TrashStore {
  /**
   * @param {string} filePath - absolute path of trash.json.
   * @param {object} [logger]
   */
  constructor(filePath, logger) {
    this.filePath = filePath
    this.logger = logger
    /** @type {Map<string, TrashEntry>} */
    this.entries = new Map()
    this.hiddenSessionIds = new Set()
    /** @type {{ retentionDays: number }} */
    this.settings = { retentionDays: RETENTION_DEFAULT_DAYS }
    this.tail = Promise.resolve()
    this.loaded = false
  }

  /** Load the index once; a malformed file is quarantined, not fatal. */
  async ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    let raw
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      await this.quarantine(error)
      return
    }
    if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
      await this.quarantine(new Error('trash.json is not a trash document'))
      return
    }
    for (const id of Array.isArray(raw.hiddenSessionIds) ? raw.hiddenSessionIds : []) {
      if (typeof id === 'string' && id !== '') this.hiddenSessionIds.add(id)
    }
    for (const entry of raw.entries) {
      if (typeof entry?.sessionId !== 'string' || entry.sessionId === '') continue
      if (typeof entry.deletedAt !== 'number' || !Number.isFinite(entry.deletedAt)) continue
      this.hiddenSessionIds.add(entry.sessionId)
      this.entries.set(entry.sessionId, {
        sessionId: entry.sessionId,
        title: typeof entry.title === 'string' ? entry.title : undefined,
        cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
        workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : undefined,
        wasArchived: entry.wasArchived === true,
        wasPinned: entry.wasPinned === true,
        logPath: typeof entry.logPath === 'string' ? entry.logPath : undefined,
        parkedLogPath: typeof entry.parkedLogPath === 'string' ? entry.parkedLogPath : undefined,
        deletedAt: entry.deletedAt
      })
    }
    const retention = raw.settings?.retentionDays
    if (typeof retention === 'number' && Number.isFinite(retention)) {
      this.settings.retentionDays = clampRetention(retention)
    }
  }

  /** Move a corrupt index aside so the fresh one cannot overwrite evidence. */
  async quarantine(error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = join(dirname(this.filePath), `trash.corrupt-${stamp}.json`)
    try {
      await rename(this.filePath, backup)
      this.logger?.warn?.(`${PLUGIN_NAME}/trash: quarantined unreadable index to ${basename(backup)}: ${error?.message ?? error}`)
    } catch {
      this.logger?.warn?.(`${PLUGIN_NAME}/trash: index unreadable and not movable; starting fresh`)
    }
    this.entries.clear()
  }

  /** Serialize `operation` behind the write tail; persist when it succeeds. */
  async mutate(operation) {
    const run = this.tail.then(async () => {
      await this.ensureLoaded()
      const result = await operation()
      await this.flush()
      return result
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Atomic durable write of the whole document. */
  async flush() {
    const document = {
      version: 1,
      settings: this.settings,
      hiddenSessionIds: [...this.hiddenSessionIds],
      entries: [...this.entries.values()].sort((a, b) => b.deletedAt - a.deletedAt)
    }
    const temp = `${this.filePath}.tmp`
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temp, this.filePath)
  }
}

/**
 * Where one session's log parks while it is in the trash.
 *
 * The parked path is derived, not stored per entry, except as a breadcrumb:
 * it is `<home>/session-delete/logs/<encoded session id>`.
 *
 * @param {string} sessionId
 * @returns {string} absolute path of the parked log directory.
 */
export function parkedLogPath(sessionId) {
  return join(dshHome(), TRASH_LOGS_DIR, encodeSegment(sessionId))
}

/**
 * Move one session into the trash: stop its work, un-list it through the live
 * registry, and move its durable session log out of the persistence root so
 * the sidebar stops listing it at all.
 *
 * Log relocation removes the persisted record. The durable hidden id also
 * filters live records at the client, including the "show archived" view.
 *
 * The title is folded out of the session LOG (a `session/title` event) BEFORE
 * the log moves, for the same reason: after the move the log is out of the
 * root and the fold would have nothing to read.
 *
 * Validate the source and destination before registry changes. Failed log
 * relocation or index persistence restores the moved log and registry marks.
 *
 * @param {object} args
 * @param {import('./shared.js').RegistryFace | undefined} args.registry
 * @param {unknown} [args.persistence]
 * @param {unknown} [args.query] - the `sessionQuery` service, for the title fold.
 * @param {TrashStore} args.store
 * @param {string} args.sessionId
 * @param {object} [args.logger]
 * @returns {Promise<TrashEntry>} the stored entry.
 */
export async function moveToTrash({ registry, persistence, query, store, sessionId, logger }) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('sessionId is required')
  }
  await store.ensureLoaded()
  if (store.entries.has(sessionId)) {
    throw new Error(`session "${sessionId}" is already in the trash`)
  }

  const header = await readSessionHeader(persistence, sessionId)
  const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
  const workspaceId = owningWorkspaceId(registry, sessionId)
  const wasArchived = registry?.archivedSessionIds?.includes?.(sessionId) ?? false
  const wasPinned = registry?.pinnedSessionIds?.includes?.(sessionId) ?? false
  // Read the title while the log is still in the persistence root.
  const title = await resolveSessionTitle({ query, persistence, sessionId, cwd })

  // Move the log out of the persistence root — the actual removal. Without a
  // log directory to relocate there is nothing to park, and a move that cannot
  // guarantee the row disappears is refused outright.
  const root = sessionsRootOf(persistence)
  const logPath = await locateSessionDir({ root, sessionId, cwd })
  if (logPath === undefined) {
    throw new Error(
      `session "${sessionId}" has no session log under the persistence root; ` +
      'the move was aborted because the sidebar would keep listing it'
    )
  }
  const target = join(dirname(store.filePath), 'logs', encodeSegment(sessionId))
  if (await pathExists(target)) throw new Error('trash log destination already exists; refusing to overwrite history')
  await hideSessionInRegistry(registry, sessionId, { keepArchived: true, logger })
  try {
    await mkdir(dirname(target), { recursive: true })
    await rename(logPath, target)
  } catch (error) {
    const workspace = registry.list().find(item => String(item.id) === workspaceId)
    await workspace?.attachSession?.(sessionId)
    if (!wasArchived) await registry.unarchiveSession?.(sessionId)
    if (wasPinned) await registry.pinSession?.(sessionId)
    throw error
  }

  const entry = {
    sessionId,
    title,
    cwd,
    workspaceId,
    wasArchived,
    wasPinned,
    logPath,
    parkedLogPath: target,
    deletedAt: Date.now()
  }

  try {
    await store.mutate(() => {
      store.entries.set(sessionId, entry)
      store.hiddenSessionIds.add(sessionId)
      return true
    })
  } catch (error) {
    store.entries.delete(sessionId)
    store.hiddenSessionIds.delete(sessionId)
    await rename(target, logPath)
    const workspace = pickRestoreTarget(registry, entry)
    await workspace?.attachSession?.(sessionId)
    if (!wasArchived) await registry.unarchiveSession?.(sessionId)
    if (wasPinned) await registry.pinSession?.(sessionId)
    throw error
  }
  return entry
}

/**
 * Find the workspace that currently accounts for a session, so a restore can
 * re-attach it to the same place. The registry's `sessionIds` getter filters
 * by canonical cwd, so a visible session is on exactly one account.
 *
 * @param {import('./shared.js').RegistryFace | undefined} registry
 * @param {string} sessionId
 * @returns {string | undefined}
 */
function owningWorkspaceId(registry, sessionId) {
  for (const workspace of registry?.list?.() ?? []) {
    if (workspace.sessionIds?.includes?.(sessionId)) return String(workspace.id)
  }
  return undefined
}

/**
 * Restore one trashed session: put its session log back exactly where it came
 * from, re-attach it to its owning workspace, then clear the archive mark the
 * move used. A pinned session is pinned again best-effort.
 *
 * @param {object} args
 * @param {import('./shared.js').RegistryFace | undefined} args.registry
 * @param {TrashStore} args.store
 * @param {string} args.sessionId
 * @param {object} [args.logger]
 * @returns {Promise<TrashEntry>} the entry that was restored.
 */
export async function restoreFromTrash({ registry, store, sessionId, logger }) {
  await store.ensureLoaded()
  const entry = store.entries.get(sessionId)
  if (entry === undefined) throw new Error(`session "${sessionId}" is not in the trash`)
  if (registry === undefined) {
    throw new Error('workspace registry is unavailable; cannot restore')
  }

  const workspace = pickRestoreTarget(registry, entry)
  if (workspace === undefined) {
    throw new Error(
      `cannot restore "${sessionId}": its workspace registration is gone` +
      (entry.cwd !== undefined ? ` (looked for "${entry.cwd}")` : '')
    )
  }
  if (typeof workspace.attachSession !== 'function') {
    throw new Error('workspace registry cannot attach sessions; restore is unsupported here')
  }

  // Put the log back FIRST: the row cannot return until the persistence root
  // scans it again, and an attach against a missing log would be a lie.
  await restoreParkedLog(entry)

  await workspace.attachSession(sessionId)
  // The archive mark the move left behind is what hid the row; clear it, then
  // put back the mark the session actually held before the move — a session the
  // user had already archived must not come back un-archived.
  if (typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId)
  }
  if (entry.wasArchived === true && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      logger?.warn?.(`${PLUGIN_NAME}/trash: restored "${sessionId}" but re-archive failed: ${error?.message ?? error}`)
    }
  }
  if (entry.wasPinned && typeof registry.pinSession === 'function') {
    try {
      await registry.pinSession(sessionId)
    } catch (error) {
      logger?.warn?.(`${PLUGIN_NAME}/trash: restored "${sessionId}" but re-pin failed: ${error?.message ?? error}`)
    }
  }

  await store.mutate(() => {
    store.entries.delete(sessionId)
    store.hiddenSessionIds.delete(sessionId)
  })
  return entry
}

/**
 * Put one trashed session's log back where it came from.
 *
 * The recorded `logPath` is rebuilt when it is missing (an entry written
 * before the relocation existed), and its parent directory is created, so a
 * restore works even if the project directory has since been cleaned away.
 *
 * @param {TrashEntry} entry
 * @returns {Promise<void>}
 */
async function restoreParkedLog(entry) {
  const parked = typeof entry.parkedLogPath === 'string'
    ? entry.parkedLogPath
    : parkedLogPath(entry.sessionId)
  if (!(await pathExists(parked))) return

  const target = typeof entry.logPath === 'string' && entry.logPath !== ''
    ? entry.logPath
    : entry.cwd ? join(sessionsRootOf(), projectKey(entry.cwd), encodeSegment(entry.sessionId)) : undefined
  if (!target) throw new Error('original session log location is unavailable')
  if (await pathExists(target)) throw new Error('original session log destination already exists; refusing to overwrite history')
  await mkdir(dirname(target), { recursive: true })
  await rename(parked, target)
}

/**
 * The workspace a restored session should re-join: its recorded id when that
 * registration still exists, else the one whose path equals the recorded cwd.
 *
 * @param {import('./shared.js').RegistryFace | undefined} registry
 * @param {TrashEntry} entry
 * @returns {{ id: string, attachSession?: (sessionId: string) => Promise<void> } | undefined}
 */
function pickRestoreTarget(registry, entry) {
  const workspaces = registry?.list?.() ?? []
  if (entry.workspaceId !== undefined) {
    const direct = workspaces.find((workspace) => String(workspace.id) === entry.workspaceId)
    if (direct !== undefined) return direct
  }
  if (entry.cwd !== undefined) {
    return workspaces.find((workspace) => workspace.path === entry.cwd)
  }
  return undefined
}

/**
 * Purge one trash entry for good: delete its parked session log and the
 * artifacts the shared delete path removes, then drop the index record.
 *
 * The parked log is removed here because it is no longer under the
 * persistence root, so the shared artifact removal cannot see it.
 *
 * The record is dropped only AFTER a successful purge, so a failed purge
 * leaves the entry visible for retry rather than silently orphaning files.
 *
 * @param {object} args
 * @param {(sessionId: string) => Promise<object>} args.purge - the bound shared delete.
 * @param {TrashStore} args.store
 * @param {string} args.sessionId
 * @returns {Promise<object>} the purge report.
 */
export async function purgeTrashEntry({ purge, store, sessionId }) {
  await store.ensureLoaded()
  const entry = store.entries.get(sessionId)
  if (entry === undefined) throw new Error(`session "${sessionId}" is not in the trash`)

  // Keep the recoverable log until the shared purge has completed successfully.
  const report = await purge(sessionId)
  const parked = typeof entry.parkedLogPath === 'string'
    ? entry.parkedLogPath
    : parkedLogPath(sessionId)
  let removedParkedLog = false
  if (await pathExists(parked)) {
    await rm(parked, { recursive: true, force: true })
    removedParkedLog = true
  }

  await store.mutate(() => {
    store.hiddenSessionIds.add(sessionId)
    return store.entries.delete(sessionId)
  })
  return { ...report, removedParkedLog, entry }
}

/**
 * Purge every entry older than the configured retention.
 *
 * @param {object} args
 * @param {(sessionId: string) => Promise<object>} args.purge
 * @param {TrashStore} args.store
 * @param {number} [args.now] - injectable clock.
 * @param {object} [args.logger]
 * @returns {Promise<{ swept: number, failed: number }>}
 */
export async function sweepExpired({ purge, store, now = Date.now(), logger }) {
  await store.ensureLoaded()
  const limit = store.settings.retentionDays * DAY_MS
  let swept = 0
  let failed = 0
  for (const entry of [...store.entries.values()]) {
    if (now - entry.deletedAt < limit) continue
    try {
      await purgeTrashEntry({ purge, store, sessionId: entry.sessionId })
      swept += 1
    } catch (error) {
      failed += 1
      logger?.warn?.(`${PLUGIN_NAME}/trash: sweep failed for "${entry.sessionId}": ${error?.message ?? error}`)
    }
  }
  return { swept, failed }
}

/**
 * Build the trash route handler.
 *
 * Fixed method names, no free-form path handling:
 *
 *   POST /list      → { ok, entries: [...], retentionDays }
 *   POST /move      { sessionId }         → { ok, entry }
 *   POST /restore   { sessionId }         → { ok, entry }
 *   POST /purge     { sessionId }         → { ok, report }
 *   POST /empty     {}                  → { ok, purged, failed }
 *   POST /settings  { retentionDays }   → { ok, retentionDays }  (clamped 3–30)
 *
 * @param {object} deps - the wiring this handler needs.
 * @param {() => import('./shared.js').RegistryFace | undefined} deps.registry
 * @param {() => unknown} deps.persistence
 * @param {() => unknown} [deps.query] - the `sessionQuery` service, for the title fold.
 * @param {(sessionId: string) => Promise<object>} deps.purge - the full delete, pre-bound.
 * @param {TrashStore} deps.store
 * @param {object} [deps.logger]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
async function readParkedTitle(entry) {
  const root = entry.parkedLogPath ?? parkedLogPath(entry.sessionId)
  let title
  async function scan(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isDirectory()) { await scan(path); continue }
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue
      const input = createReadStream(path, { encoding: 'utf8' })
      const lines = createInterface({ input, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (event.type === 'session/title' && typeof event.data?.title === 'string') {
              if (!title || (event.seq ?? 0) >= title.seq) title = { seq: event.seq ?? 0, text: event.data.title }
            }
          } catch { /* Ignore incomplete trailing lines. */ }
        }
      } finally { lines.close(); input.destroy() }
    }
  }
  try { await scan(root) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return title?.text?.trim() || undefined
}

export function createTrashHandler({ registry, persistence, query = () => undefined, purge, store, logger }) {
  const TRASH_METHODS = ['list', 'move', 'restore', 'purge', 'empty', 'settings']
  return async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const method = pathname.startsWith(`${TRASH_API_PREFIX}/`)
      ? pathname.slice(TRASH_API_PREFIX.length + 1)
      : undefined

    if (method === undefined || !TRASH_METHODS.includes(method)) {
      writeError(res, 404, 'not-found', 'unknown session-trash API method')
      return
    }
    if (req.method !== 'POST') {
      writeError(res, 405, 'method-error', 'method not allowed')
      return
    }

    try {
      const payload = await readJsonBody(req)
      const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim() !== ''
        ? payload.sessionId
        : undefined

      if (method === 'list') {
        await store.ensureLoaded()
        const now = Date.now()
        const queryService = query()
        const entries = []
        for (const entry of [...store.entries.values()].sort((a, b) => b.deletedAt - a.deletedAt)) {
          // Entries written before the title fold used `header.title`, which the
          // header never carried, so their stored title is absent or a raw
          // directory. Resolve it on read: a trash row must never be labelled
          // with a session id or a file path.
          const folded = await resolveSessionTitle({ query: queryService, sessionId: entry.sessionId })
          const parkedTitle = await readParkedTitle(entry)
          let title = parkedTitle ?? (folded !== entry.sessionId ? folded : entry.title?.trim()) ?? ''
          if (title === '') {
            title = await resolveSessionTitle({
              query: queryService,
              persistence: persistence(),
              sessionId: entry.sessionId,
              cwd: entry.cwd
            })
          }
          entries.push({
            sessionId: entry.sessionId,
            title,
            cwd: entry.cwd,
            deletedAt: entry.deletedAt,
            remainingDays: Math.max(0, Math.ceil(
              (store.settings.retentionDays * DAY_MS - (now - entry.deletedAt)) / DAY_MS
            ))
          })
        }
        writeJson(res, 200, { ok: true, entries, hiddenSessionIds: [...store.hiddenSessionIds], retentionDays: store.settings.retentionDays })
        return
      }

      if (method === 'move') {
        const entry = await moveToTrash({
          registry: registry(),
          persistence: persistence(),
          query: query(),
          store,
          sessionId,
          logger
        })
        writeJson(res, 200, { ok: true, entry })
        return
      }

      if (method === 'restore') {
        const entry = await restoreFromTrash({ registry: registry(), store, sessionId, logger })
        writeJson(res, 200, { ok: true, entry })
        return
      }

      if (method === 'purge') {
        if (sessionId === undefined) throw new Error('sessionId is required')
        const report = await purgeTrashEntry({ purge, store, sessionId })
        writeJson(res, 200, { ok: true, report })
        return
      }

      if (method === 'empty') {
        await store.ensureLoaded()
        let purged = 0
        let failed = 0
        const failures = []
        for (const entry of [...store.entries.values()]) {
          try {
            await purgeTrashEntry({ purge, store, sessionId: entry.sessionId })
            purged += 1
          } catch (error) {
            failed += 1
            failures.push({ sessionId: entry.sessionId, message: error?.message ?? String(error) })
            logger?.warn?.(`${PLUGIN_NAME}/trash: empty failed for "${entry.sessionId}": ${error?.message ?? error}`)
          }
        }
        writeJson(res, 200, { ok: true, purged, failed, failures })
        return
      }

      // settings: clamp into [3, 30] and report what was actually stored, so
      // the panel always shows the effective retention.
      store.settings.retentionDays = clampRetention(Number(payload?.retentionDays))
      await store.mutate(() => true)
      writeJson(res, 200, { ok: true, retentionDays: store.settings.retentionDays })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`${PLUGIN_NAME}/trash: request failed: ${message}`)
      writeError(res, 400, 'trash-failed', message)
    }
  }
}

/**
 * Sub-plugin body.
 *
 * Version resilience: the entry declares NO hard service dependencies and does
 * not assume a DSH release. When the host context offers Cordis' deferred
 * `inject`, the real body starts only once its services exist — and starts again
 * later if a service is published after this entry (a changed load order, a
 * renamed bundle, or a service that appears on demand). Without that API the
 * body starts immediately, and every read still goes through `ctx.get` at call
 * time. Neither path pins a DSH version.
 *
 * @param {import('./context-types').HostContext} ctx - the host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  if (typeof ctx.inject !== 'function') {
    boot(ctx)
    return
  }
  ctx.inject(['webServer', 'sessionPersistence', 'workspaceRegistry'], boot)
}

/**
 * Start the trash: its HTTP surface, its handoff service, and the sweeper.
 *
 * @param {import('./context-types').HostContext} ctx - the activated context.
 * @returns {void}
 */
function boot(ctx) {
  const store = new TrashStore(join(dshHome(), TRASH_DATA_FILE), ctx.logger)

  const services = () => ({
    persistence: ctx.get('sessionPersistence'),
    registry: ctx.get('workspaceRegistry')
  })
  // The log-backed title fold. Read per call, never held: the query service may
  // be published after this entry applies, and a cold read stays correct.
  const query = () => ctx.get('sessionQuery')
  const purge = (sessionId) => deleteSession({
    services: services(),
    sessionId,
    logger: ctx.logger
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: TRASH_API_PREFIX,
    handler: createTrashHandler({
      registry: () => ctx.get('workspaceRegistry'),
      persistence: () => ctx.get('sessionPersistence'),
      query,
      purge,
      store,
      logger: ctx.logger
    })
  }), `${PLUGIN_NAME}/trash: ${TRASH_API_PREFIX} routes`)

  // The handoff face the main delete route probes while this entry is live.
  ctx.effect(() => ctx.provide(TRASH_SERVICE, {
    moveToTrash: (sessionId) => moveToTrash({
      registry: ctx.get('workspaceRegistry'),
      persistence: ctx.get('sessionPersistence'),
      query: query(),
      store,
      sessionId,
      logger: ctx.logger
    })
  }), `${PLUGIN_NAME}/trash: ${TRASH_SERVICE} service`)

  // Expired entries leave the disk on the Host's clock, not the page's: a
  // trash nobody opens still has to empty itself. One interval plus one sweep
  // at boot covers a long-running Host and a quick restart alike.
  const sweep = () => sweepExpired({ purge, store, logger: ctx.logger })
    .then((result) => {
      if (result.swept > 0 || result.failed > 0) {
        ctx.logger?.info?.(`${PLUGIN_NAME}/trash: swept ${result.swept} expired` +
          `${result.swept === 1 ? ' entry' : ' entries'}` +
          (result.failed > 0 ? ` (${result.failed} failed)` : ''))
      }
    })
    .catch((error) => {
      ctx.logger?.warn?.(`${PLUGIN_NAME}/trash: sweep failed: ${error?.message ?? error}`)
    })

  ctx.effect(() => {
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
    timer.unref?.()
    void sweep()
    return () => clearInterval(timer)
  }, `${PLUGIN_NAME}/trash: sweeper`)
}

/**
 * Version resilience: the trash host half declares NO hard dependency, so a
 * changed service set or a replaced package name in a newer DSH cannot keep
 * this entry from loading. `webServer` / `sessionPersistence` /
 * `workspaceRegistry` are bound late by {@link apply} when Cordis offers
 * deferred injection, and every other service is read through `ctx.get` at the
 * moment it is needed.
 */
export const inject = []
