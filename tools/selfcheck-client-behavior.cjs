// Isolated Session SnapshotStore behavior checks. No network or real sessions.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const source = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8')
let plugin
const storage = new Map()
const sandbox = {
  console, Set, Map,
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  window: { __ModuleLoader__: { load: declaration => {
    plugin = declaration.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }) }))
  } } }
}
// Expose private helpers only inside this VM; the shipped bundle stays untouched.
vm.runInNewContext(source.replace('exports.store = store', `exports.test = {
  attachSessionFilter, hideSessions, acceptTrashList, DeleteSessionRow,
  markPermanent: id => permanentSessionIds.add(id),
  setContext: ctx => { clientCtx = ctx }
}; exports.store = store`), sandbox)
let state = {
  ids: ['keep', 'deleted'], byId: { keep: { id: 'keep' }, deleted: { id: 'deleted' } },
  phase: 'ready', projectionsBySession: {}
}
const listeners = new Set()
const list = {
  getSnapshot: () => state,
  set: next => { state = next; for (const listener of listeners) listener() },
  subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
}
const baseline = () => list.set({
  ...state, ids: ['keep', 'deleted'], byId: { keep: { id: 'keep' }, deleted: { id: 'deleted' } }
})
let refreshes = 0
const sessions = {
  list,
  refresh() { assert.equal(this, sessions); refreshes++; baseline(); return Promise.resolve() },
  projectList: baseline
}
plugin.test.setContext({ get: name => { assert.equal(name, 'sessions'); return sessions } })
const off = plugin.test.attachSessionFilter()
plugin.test.hideSessions(['deleted'])
assert.equal(state.ids.join(','), 'keep')
assert.equal(state.byId.deleted, undefined)
baseline()
assert.equal(state.ids.join(','), 'keep', 'merged baseline cannot revive deleted rows')
plugin.test.acceptTrashList({ hiddenSessionIds: ['deleted'], entries: [] })
baseline()
assert.equal(state.ids.join(','), 'keep', 'purged tombstones survive empty trash')
plugin.test.acceptTrashList({ hiddenSessionIds: [], entries: [] })
;(async () => {
  await plugin.store.refreshSessionList()
  assert.equal(refreshes, 1)
  assert.equal(state.ids.join(','), 'keep,deleted', 'restored rows reappear')
  let request
  const row = plugin.test.DeleteSessionRow({
    sessionId: 'deleted', displayTitle: 'Raw title', useMenuOpenState: () => [true, () => {}],
    requestDelete: value => { request = value }, t: (key, args) => args ? 'Delete ' + args.title : 'Delete'
  })
  row.children[1].props.onClick()
  assert.equal(request.title, 'Raw title')
  plugin.test.markPermanent('deleted')
  plugin.test.hideSessions(['deleted'])
  plugin.test.acceptTrashList({ hiddenSessionIds: [], entries: [] })
  baseline()
  assert.equal(state.ids.join(','), 'keep', 'host trash authority cannot clear permanent local deletions')
  off()
  assert.equal(listeners.size, 0)
  assert.equal(state.ids.join(','), 'keep,deleted', 'unload restores the current manager presentation')
  console.log('PASS: immediate filter, merged baseline, purge, restore, permanent deletion, refresh receiver, raw title, disposal; no real session IO.')
})().catch(error => { console.error(error); process.exitCode = 1 })
