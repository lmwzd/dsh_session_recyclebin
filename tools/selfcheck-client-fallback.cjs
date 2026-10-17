// Version-resilience behavior: the client half must work when the host has no
// deferred injection at all (older kernel), including proper disposal.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const source = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8')
let plugin
const storage = new Map()
const sandbox = {
  console, Set, Map, Promise, setTimeout, clearTimeout,
  localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  window: {
    __ModuleLoader__: {
      load: (declaration) => {
        plugin = declaration.factory(() => ({
          createElement: (type, props, ...children) => ({ type, props, children })
        }))
      }
    }
  }
}
// The legacy context has no `inject`, so the retry path is the live one here.
assert.ok(!/ctx\.inject\('sessions'/.test('ctx.inject'), 'sanity')
vm.runInNewContext(source.replace('exports.store = store', `exports.test = { attachSessionFilter, hideSessions, acceptTrashList }; exports.store = store`), sandbox)

const registrations = []
const teardowns = []
let state = { ids: ['keep', 'deleted'], byId: { keep: { id: 'keep' }, deleted: { id: 'deleted' } }, phase: 'ready', projectionsBySession: {} }
const listeners = new Set()
const list = {
  getSnapshot: () => state,
  set: (next) => { state = next; for (const listener of listeners) listener() },
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
}
let publishSessions = false
const sessions = { list, refresh: async () => {} }

const ctx = {
  slots: {
    inject: (key, callback) => { callback(); return () => {} },
    register: (options) => { registrations.push(options); return () => {} }
  },
  locale: { bind: () => (key) => key, register: () => () => {} },
  effect: (fn) => { const off = fn(); teardowns.push(typeof off === 'function' ? off : () => {}) },
  // The session service is genuinely absent at first, as on a host whose list
  // owner is published later or renamed.
  get: (name) => (name === 'sessions' && publishSessions ? sessions : undefined)
}

const locale = { bind: () => (key) => key, register: () => () => {} }
ctx.locale = locale
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
plugin.apply(ctx)
assert.equal(typeof ctx.inject, 'undefined', 'this harness exercises the no-deferred-injection host')

;(async () => {
  // The filter must not have attached while the service is missing.
  assert.equal(state.ids.join(','), 'keep,deleted', 'nothing is filtered before the owner exists')
  publishSessions = true
  // Give the retry loop time to observe the newly published service.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && listeners.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(listeners.size, 1, `the retry path must subscribe once, got ${listeners.size}`)
  plugin.test.acceptTrashList({ hiddenSessionIds: ['deleted'], entries: [] })
  assert.equal(state.ids.join(','), 'keep', 'the retry path filters deleted rows')
  for (const off of teardowns.reverse()) off()
  assert.equal(listeners.size, 0, 'unload must release the retry-path subscription')
  console.log('PASS: no-deferred-injection host — retry bind, filtering works, subscription released on unload')})().catch((error) => { console.error(error); process.exitCode = 1 })
