import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, purgeTrashEntry, TrashStore } from '../lib/trash.js'
import { encodeSegment, projectKey, pathExists } from '../lib/shared.js'

const home = await mkdtemp(join(tmpdir(), 'session-delete-routes-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const routes = [], disposers = [], entries = new Map()
const cwd = home
const workspace = { id: 'w', path: cwd, sessionIds: [], async detachSession(id) { this.sessionIds = this.sessionIds.filter(x => x !== id) }, async attachSession(id) { this.sessionIds.push(id) } }
const registry = { list: () => [workspace], archivedSessionIds: [], pinnedSessionIds: [], async archiveSession(id) { this.archivedSessionIds.push(id) }, async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(x => x !== id) } }
const persistence = { root: join(home, 'sessions'), stat: async id => ({ header: entries.get(id) }) }
const services = { workspaceRegistry: registry, sessionPersistence: persistence, sessionQuery: { readTitle: async id => ({ title: `Conversation ${id}`, eventSeq: 1 }) } }
async function seed(id) {
  entries.set(id, { cwd, id })
  workspace.sessionIds.push(id)
  const path = join(persistence.root, projectKey(cwd), encodeSegment(id))
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'session.jsonl'), JSON.stringify({ type: 'session/title', seq: 1, data: { title: `Conversation ${id}` } }) + '\n')
  return path
}
async function call(method, payload = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  req.url = `/session-delete/api/trash/${method}`
  req.method = 'POST'
  let status, body
  await routes[0].handler(req, { writeHead(code) { status = code }, end(text) { body = JSON.parse(text) } })
  assert.equal(status, 200, JSON.stringify(body))
  return body
}
try {
  apply({ logger: {}, get: key => services[key], webServer: { register(route) { routes.push(route); return () => {} } }, provide() { return () => {} }, effect(fn) { const off = fn(); if (off) disposers.push(off) } })
  const path = await seed('one')
  await call('move', { sessionId: 'one' })
  assert.equal(await pathExists(path), false)
  let list = await call('list')
  assert.equal(list.entries[0].title, 'Conversation one')
  assert.ok(list.hiddenSessionIds.includes('one'))
  // Existing entries with workspace labels recover names from parked logs.
  services.sessionQuery.readTitle = async () => undefined
  assert.equal((await call('list')).entries[0].title, 'Conversation one')
  services.sessionQuery.readTitle = async id => ({ title: `Conversation ${id}`, eventSeq: 1 })
  await call('restore', { sessionId: 'one' })
  assert.ok(await pathExists(path))
  assert.equal((await call('list')).hiddenSessionIds.includes('one'), false)
  await call('move', { sessionId: 'one' })
  await call('purge', { sessionId: 'one' })
  assert.equal(await pathExists(join(home, 'session-delete', 'logs', 'one')), false)
  list = await call('list')
  assert.equal(list.entries.length, 0)
  assert.ok(list.hiddenSessionIds.includes('one'), 'purged live identity stays hidden')
  await seed('two'); await seed('three')
  await call('move', { sessionId: 'two' }); await call('move', { sessionId: 'three' })
  const empty = await call('empty')
  assert.equal(empty.failed, 0)
  assert.equal(empty.purged, 2)
  assert.equal((await call('list')).entries.length, 0)
  // Failure of the shared purge must preserve the only recoverable log.
  const failureStore = new TrashStore(join(home, 'failure', 'trash.json'))
  const parked = join(home, 'failure', 'logs', 'retry')
  await mkdir(parked, { recursive: true })
  await failureStore.mutate(() => failureStore.entries.set('retry', { sessionId: 'retry', deletedAt: Date.now(), parkedLogPath: parked }))
  await assert.rejects(purgeTrashEntry({ store: failureStore, sessionId: 'retry', purge: async () => { throw new Error('unavailable') } }))
  assert.ok(await pathExists(parked))
  assert.ok(failureStore.entries.has('retry'))
  const durable = JSON.parse(await readFile(join(home, 'session-delete', 'trash.json'), 'utf8'))
  assert.equal(durable.hiddenSessionIds.length, 3)
  console.log('Host routes: move, actual title snapshot, restore, purge, empty, durable hidden ids passed')
} finally {
  for (const off of disposers.reverse()) off()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}
