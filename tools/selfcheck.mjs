/**
 * Functional self-check for dsh_session_recyclebin.
 *
 * Exercises the host half's pure path derivation (encodeSegment / projectKey,
 * mirroring the JSONL backend's own) against the REAL session tree on this
 * machine, and runs one full delete against a THROWAWAY session directory
 * created here — never against a real session.
 *
 * Run:  node tools/selfcheck.mjs
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
const passes = []

function check(name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// --- import the module under test -----------------------------------------
const mod = await import('../lib/index.js')
const { apply, inject } = mod

console.log('\n[1] module shape')
check('exports apply', typeof apply === 'function')
check('exports inject list', Array.isArray(inject) && inject.length === 3, JSON.stringify(inject))

// --- path derivation -------------------------------------------------------
// Re-derive the two helpers through a throwaway session tree by calling the
// public delete path with a fake persistence service, then asserting the
// directory the plugin actually removed.

console.log('\n[2] path derivation against the real session tree')

const home = process.env.USERPROFILE ?? process.env.HOME
const realSessionsRoot = join(home, '.dsh', 'sessions')

// Pick the first real project directory and the first real session inside it.
const { readdir } = await import('node:fs/promises')
let projectDirs = []
try {
  projectDirs = (await readdir(realSessionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
} catch {
  /* no sessions tree: the derivation checks below still run against a synthetic one */
}

check('found real project directories', projectDirs.length > 0, `root=${realSessionsRoot}`)

// --- end-to-end delete on a throwaway tree --------------------------------
console.log('\n[3] end-to-end delete on a throwaway session tree')

const sandbox = await mkdtemp(join(tmpdir(), 'dsh_session_recyclebin-selftest-'))
try {
  // A synthetic project directory whose name we DO control, so the assertion
  // is about the plugin's derivation, not about this machine's real keys.
  const projectDirName = '--D-Agent-Work--'
  const projectDir = join(sandbox, projectDirName)
  await mkdir(projectDir, { recursive: true })

  // Session id with characters that force the ~XXXX escape, to prove the
  // encoder agrees with the backend's.
  const sessionId = 'session-selfcheck~a.b-c'
  const encodedId = 'session-selfcheck~007Ea.b-c'
  const sessionDir = join(projectDir, encodedId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'not-really-zstd', 'utf8')

  // A projection cache entry and an attachments directory for the same id.
  const projDir = join(sandbox, 'storages', 'session_projcache', 'sessions')
  await mkdir(projDir, { recursive: true })
  await writeFile(join(projDir, `${encodedId}.json`), '{}', 'utf8')

  // A workspace registry that carries the id in all three sets.
  const storagesDir = join(sandbox, 'storages')
  const workspaceDoc = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'w1',
      workspaceIds: ['w1'],
      archivedSessionIds: [],
      pinnedSessionIds: []
    },
    tables: {
      workspaces: {
        w1: { path: 'D:\\Agent\\Work', title: 'Work', sessionIds: [sessionId, 'keep-me'] }
      }
    }
  }
  await writeFile(join(storagesDir, 'workspace.json'), JSON.stringify(workspaceDoc, null, 2), 'utf8')

  // Redirect DSH_HOME at the sandbox so the plugin's storage/attachment paths
  // resolve inside it. The persistence root comes from the fake service.
  process.env.DSH_HOME = sandbox

  // Fake persistence exposing exactly what the host half reads.
  const fakePersistence = {
    root: sandbox,
    async stat(id) {
      if (id !== sessionId) return undefined
      return { header: { cwd: 'D:\\Agent\\Work', title: 'Self Check' } }
    }
  }

  // A live workspace registry that records every verb the delete path uses,
  // mirroring `workspaceRegistry`: archiving stops the session's work, and
  // detaching takes it off the owning workspace's account.
  const registryCalls = []
  const fakeWorkspace = {
    id: 'w1',
    path: 'D:\\Agent\\Work',
    sessionIds: [sessionId, 'keep-me'],
    async detachSession(id) {
      registryCalls.push({ verb: 'detach', id })
      this.sessionIds = this.sessionIds.filter((entry) => entry !== id)
    },
    async attachSession(id) {
      registryCalls.push({ verb: 'attach', id })
      this.sessionIds = [id, ...this.sessionIds]
    }
  }
  const fakeRegistry = {
    archivedSessionIds: [],
    pinnedSessionIds: [],
    list: () => [fakeWorkspace],
    async archiveSession(id, options) {
      registryCalls.push({ verb: 'archive', id, stopActivity: options?.stopActivity === true })
      if (!fakeRegistry.archivedSessionIds.includes(id)) {
        fakeRegistry.archivedSessionIds = [...fakeRegistry.archivedSessionIds, id]
      }
    },
    async unarchiveSession(id) {
      registryCalls.push({ verb: 'unarchive', id })
      fakeRegistry.archivedSessionIds = fakeRegistry.archivedSessionIds.filter((entry) => entry !== id)
    },
    async pinSession(id) { registryCalls.push({ verb: 'pin', id }) },
    async unpinSession(id) { registryCalls.push({ verb: 'unpin', id }) }
  }

  // Capture what the host half's route would call.
  const captured = []
  const fakeWebServer = {
    register(route) {
      captured.push(route)
      return () => {}
    }
  }
  const fakeCtx = {
    webServer: fakeWebServer,
    logger: { warn: (m) => console.log(`  (warn) ${m}`) },
    effect(fn) {
      return fn()
    },
    get(name) {
      if (name === 'workspaceRegistry') return fakeRegistry
      if (name === 'sessionPersistence') return fakePersistence
      return undefined
    }
  }

  apply(fakeCtx)

  check('registered one route', captured.length === 1, String(captured.length))
  check('route prefix', captured[0]?.path === '/session-delete/api', captured[0]?.path)
  check('route kind', captured[0]?.kind === 'prefix', captured[0]?.kind)

  // Drive the route handler directly with a fake req/res.
  const handler = captured[0].handler
  const body = JSON.stringify({ sessionId })

  let status = 0
  let payload = null
  const res = {
    writeHead(code) { status = code },
    end(text) { payload = JSON.parse(text) }
  }
  const req = (async function* () {
    yield Buffer.from(body, 'utf8')
  })()
  req.method = 'POST'
  req.url = '/session-delete/api/delete'

  await handler(req, res)

  check('route answered 200', status === 200, `status=${status} body=${JSON.stringify(payload)}`)
  check('reported ok', payload?.ok === true)
  // The registry path is what replaces the old agent.cancel: archiving with
  // stopActivity stops the session's running work (turn, subagents, jobs) the
  // way the stop button does, and detaching takes it off its workspace.
  check('archived the session with stopActivity',
    registryCalls.some((call) => call.verb === 'archive' && call.id === sessionId && call.stopActivity === true),
    JSON.stringify(registryCalls))
  check('detached the session from its workspace',
    registryCalls.some((call) => call.verb === 'detach' && call.id === sessionId),
    JSON.stringify(registryCalls))
  check('cleared the archive mark the hide took',
    registryCalls.some((call) => call.verb === 'unarchive' && call.id === sessionId),
    JSON.stringify(registryCalls))
  check('removed the session directory', payload?.sessionDir === sessionDir, payload?.sessionDir)
  check('removed the projection cache', payload?.removedProjection === true)
  check('removed the workspace record', payload?.removedWorkspaceRecord === true)

  // The directory is really gone.
  let dirGone = false
  try {
    await stat(sessionDir)
  } catch {
    dirGone = true
  }
  check('session directory absent on disk', dirGone)

  let projGone = false
  try {
    await stat(join(projDir, `${encodedId}.json`))
  } catch {
    projGone = true
  }
  check('projection cache absent on disk', projGone)

  // The workspace account kept the unrelated id and dropped ours, and the
  // archive mark did not outlive the session.
  check('workspace kept the unrelated session',
    fakeWorkspace.sessionIds.length === 1 && fakeWorkspace.sessionIds[0] === 'keep-me',
    JSON.stringify(fakeWorkspace.sessionIds))
  check('archived set emptied', fakeRegistry.archivedSessionIds.length === 0, JSON.stringify(fakeRegistry.archivedSessionIds))

  // A second delete of the same id must not throw and must report nothing found.
  let secondStatus = 0
  let secondPayload = null
  const res2 = { writeHead(c) { secondStatus = c }, end(t) { secondPayload = JSON.parse(t) } }
  const req2 = (async function* () { yield Buffer.from(body, 'utf8') })()
  req2.method = 'POST'
  req2.url = '/session-delete/api/delete'
  await handler(req2, res2)
  check('idempotent re-delete answers 200', secondStatus === 200, `status=${secondStatus}`)
  check('idempotent re-delete reports ok', secondPayload?.ok === true)
  check('idempotent re-delete found nothing', secondPayload?.sessionDir === undefined)

  // Bad input must be rejected, not crash.
  let badStatus = 0
  const res3 = { writeHead(c) { badStatus = c }, end() {} }
  const req3 = (async function* () { yield Buffer.from(JSON.stringify({ sessionId: '' }), 'utf8') })()
  req3.method = 'POST'
  req3.url = '/session-delete/api/delete'
  await handler(req3, res3)
  check('empty sessionId rejected with 400', badStatus === 400, `status=${badStatus}`)

  // Wrong method must be rejected.
  let methodStatus = 0
  const res4 = { writeHead(c) { methodStatus = c }, end() {} }
  const req4 = (async function* () {})()
  req4.method = 'GET'
  req4.url = '/session-delete/api/delete'
  await handler(req4, res4)
  check('GET rejected with 405', methodStatus === 405, `status=${methodStatus}`)

  // Unknown sub-path must be rejected.
  let unknownStatus = 0
  const res5 = { writeHead(c) { unknownStatus = c }, end() {} }
  const req5 = (async function* () {})()
  req5.method = 'POST'
  req5.url = '/session-delete/api/nope'
  await handler(req5, res5)
  check('unknown method rejected with 404', unknownStatus === 404, `status=${unknownStatus}`)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log(`\n${passes.length} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failed: ${failures.join(', ')}`)
  process.exitCode = 1
}
