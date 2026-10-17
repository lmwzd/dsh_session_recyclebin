/**
 * Focused checks for the title fold, the hide verification, and the trash-row
 * fallback — the two behaviours the trash panel and the sidebar depend on.
 *
 * Run: node tools/selfcheck-title.mjs
 */
import { basenameOf, resolveSessionTitle } from '../lib/shared.js'
import { moveToTrash, restoreFromTrash, TrashStore } from '../lib/trash.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * A trash store rooted in a fresh temp directory, so no run can read or write
 * another run's index. `TrashStore` persists through `mutate`, so a shared path
 * would leak entries between cases.
 *
 * @returns {Promise<{ store: TrashStore, dispose: () => Promise<void> }>}
 */
async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'session-delete-title-'))
  return {
    store: new TrashStore(join(dir, 'trash.json')),
    dispose: () => rm(dir, { recursive: true, force: true })
  }
}

/**
 * A hermetic persistence root holding one session's log directory, laid out the
 * way `dsh-session-persistence-jsonl` lays it out:
 * `<root>/<projectKey(cwd)>/<encoded session id>/`.
 *
 * A moveToTrash call relocates that directory, so every case needs a real tree
 * on disk rather than a stubbed `persistence`.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} [args.cwd]
 * @returns {Promise<{ root: string, logPath: string, persistence: object, dispose: () => Promise<void> }>}
 */
async function freshPersistence({ sessionId, cwd = 'D:\\Agent\\Work' }) {
  const dir = await mkdtemp(join(tmpdir(), 'session-delete-root-'))
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { projectKey, encodeSegment } = await import('../lib/shared.js')
  const logPath = join(dir, projectKey(cwd), encodeSegment(sessionId))
  await mkdir(logPath, { recursive: true })
  await writeFile(join(logPath, 'session.jsonl'), '{"type":"header"}\n', 'utf8')
  return {
    root: dir,
    logPath,
    persistence: { root: dir, stat: async () => ({ header: { cwd, id: sessionId } }) },
    dispose: () => rm(dir, { recursive: true, force: true })
  }
}

console.log('[1] basenameOf')
check('posix basename', basenameOf('/home/me/project') === 'project', basenameOf('/home/me/project'))
check('windows basename', basenameOf('D:\\Agent\\Work') === 'Work', basenameOf('D:\\Agent\\Work'))
check('trailing separator trimmed', basenameOf('D:\\Agent\\Work\\') === 'Work', basenameOf('D:\\Agent\\Work\\'))
check('root returns undefined', basenameOf('/') === undefined, String(basenameOf('/')))
check('empty returns undefined', basenameOf('') === undefined, String(basenameOf('')))
check('non-string returns undefined', basenameOf(undefined) === undefined)

console.log('[2] resolveSessionTitle prefers the log fold')
{
  const query = { readTitle: async () => ({ title: '  Fix the parser  ', eventSeq: 4, updatedAt: 1 }) }
  const title = await resolveSessionTitle({ query, persistence: undefined, sessionId: 's1', cwd: 'D:\\Agent\\Work' })
  check('log title wins and is trimmed', title === 'Fix the parser', title)
}
{
  const query = { readTitle: async () => '   ' }
  const title = await resolveSessionTitle({ query, persistence: undefined, sessionId: 's1', cwd: 'D:\\Agent\\Work' })
  check('blank log title falls back to the directory', title === 'Work', title)
}
{
  const query = { readTitle: async () => { throw new Error('cold read failed') } }
  const title = await resolveSessionTitle({ query, persistence: undefined, sessionId: 'session-abc', cwd: 'D:\\Agent\\Work' })
  check('a failing fold degrades to the directory', title === 'Work', title)
}
{
  const title = await resolveSessionTitle({ query: undefined, persistence: undefined, sessionId: 'session-abc', cwd: undefined })
  check('no query, no cwd degrades to the id', title === 'session-abc', title)
}
{
  const query = { readTitle: async () => 'A name' }
  const title = await resolveSessionTitle({ query, persistence: undefined, sessionId: 's1' })
  check('title resolves without a cwd', title === 'A name', title)
}

// DSH 0.2.1 keeps all physical format generations in the session directory.
// Relocation must preserve every generation without decoding or rewriting it.
console.log('[3] moveToTrash parks the log so the sidebar stops listing it')
{
  const { store, dispose } = await freshStore()
  const p = await freshPersistence({ sessionId: 'session-x' })
  const { writeFile, readFile } = await import('node:fs/promises')
  const generations = ['v0.jsonl.zstd', 'v1.jsonl.zstd', 'v2.jsonl.zstd']
  for (const file of generations) await writeFile(join(p.logPath, file), `opaque-${file}`)
  try {
    const workspace = { id: 'w1', path: 'D:\\Agent\\Work', sessionIds: ['session-x'] }
    workspace.detachSession = async () => {
      workspace.sessionIds = workspace.sessionIds.filter((id) => id !== 'session-x')
    }
    workspace.attachSession = async () => {
      workspace.sessionIds = ['session-x', ...workspace.sessionIds]
    }
    const query = { readTitle: async () => ({ title: 'My conversation', eventSeq: 4, updatedAt: 1 }) }

    const registry = {
      archivedSessionIds: [],
      pinnedSessionIds: [],
      list: () => [workspace],
      archiveSession: async function () { this.archivedSessionIds.push('session-x') },
      unarchiveSession: async () => {},
      pinSession: async () => {},
      unpinSession: async () => {}
    }
    const entry = await moveToTrash({
      registry,
      persistence: p.persistence,
      query,
      store,
      sessionId: 'session-x'
    })
    check('the move records the folded title', entry.title === 'My conversation', entry.title)
    check('the entry records the cwd', entry.cwd === 'D:\\Agent\\Work', entry.cwd)
    check('the entry is indexed', store.entries.has('session-x'))
    check('the entry records where the log came from', entry.logPath === p.logPath, entry.logPath)
    check('the entry records where the log parks', typeof entry.parkedLogPath === 'string', entry.parkedLogPath)

    // The log really left the persistence root — this is what removes the row.
    const { pathExists } = await import('../lib/shared.js')
    check('the log is gone from the persistence root', !(await pathExists(p.logPath)))
    check('the log is parked under the trash', await pathExists(entry.parkedLogPath))
    for (const file of generations) {
      check(`move preserves ${file}`, await readFile(join(entry.parkedLogPath, file), 'utf8') === `opaque-${file}`)
    }
    check('the session is off every workspace account', !workspace.sessionIds.includes('session-x'), workspace.sessionIds.join(','))
    check('the archive mark is kept', registry.archivedSessionIds.includes('session-x'))

    // And a restore puts it back exactly where it came from.
    const restored = await restoreFromTrash({
      registry,
      store,
      sessionId: 'session-x',
      logger: undefined
    })
    check('restore returns the entry', restored.sessionId === 'session-x')
    check('restore puts the log back', await pathExists(p.logPath))
    for (const file of generations) {
      check(`restore preserves ${file}`, await readFile(join(p.logPath, file), 'utf8') === `opaque-${file}`)
    }
    check('restore empties the parked slot', !(await pathExists(entry.parkedLogPath)))
    check('restore drops the index record', !store.entries.has('session-x'))
    check('restore re-attaches the session', workspace.sessionIds.includes('session-x'), workspace.sessionIds.join(','))
  } finally {
    await dispose()
    await p.dispose()
  }
}

console.log('[3b] moveToTrash refuses a session with no log to park')
{
  const { store, dispose } = await freshStore()
  const p = await freshPersistence({ sessionId: 'session-other' })
  try {
    const workspace = { id: 'w1', path: 'D:\\Agent\\Work', sessionIds: [] }
    const registry = {
      archivedSessionIds: [],
      pinnedSessionIds: [],
      list: () => [workspace],
      archiveSession: async function () { this.archivedSessionIds.push('session-z') },
      unarchiveSession: async () => {},
      pinSession: async () => {},
      unpinSession: async () => {}
    }
    let threw = null
    try {
      await moveToTrash({
        registry,
        persistence: p.persistence,
        query: undefined,
        store,
        sessionId: 'session-z'
      })
    } catch (error) {
      threw = error
    }
    check('a logless move throws', threw !== null, threw === null ? 'no throw' : threw.message)
    check('the message names the persistence root', threw !== null && /persistence root/.test(threw.message), threw?.message)
    check('nothing was indexed', store.entries.size === 0, String(store.entries.size))
    const { pathExists } = await import('../lib/shared.js')
    check('the unrelated log is untouched', await pathExists(p.logPath))
  } finally {
    await dispose()
    await p.dispose()
  }
}

console.log('[4] restoreFromTrash puts back a prior archive mark')
{
  const { store, dispose } = await freshStore()
  try {
    store.entries.set('session-y', {
      sessionId: 'session-y',
      title: 'Previously archived chat',
      cwd: 'D:\\Agent\\Work',
      workspaceId: 'w1',
      wasArchived: true,
      wasPinned: false,
      deletedAt: Date.now()
    })
    const calls = []
    const workspace = { id: 'w1', path: 'D:\\Agent\\Work', sessionIds: [] }
    workspace.attachSession = async () => { calls.push('attach') }
    const registry = {
      archivedSessionIds: ['session-y'],
      pinnedSessionIds: [],
      list: () => [workspace],
      archiveSession: async () => { calls.push('archive') },
      unarchiveSession: async () => { calls.push('unarchive') },
      pinSession: async () => { calls.push('pin') },
      unpinSession: async () => {}
    }
    await restoreFromTrash({ registry, store, sessionId: 'session-y' })
    check('the session is re-attached', calls.includes('attach'), calls.join(','))
    check('the trash mark is cleared', calls.includes('unarchive'), calls.join(','))
    check('the prior archive mark is restored', calls.includes('archive'), calls.join(','))
    check('the entry leaves the index', !store.entries.has('session-y'))
  } finally {
    await dispose()
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failed: ${failures.join(', ')}`)
  process.exit(1)
}
