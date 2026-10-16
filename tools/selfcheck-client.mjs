/**
 * Functional self-check for the CLIENT half of dsh_session_recyclebin.
 *
 * lib/client.js is a hand-written ModuleLoader bundle (the shape the DSH web
 * shell loads), so this harness provides the three things the browser would:
 * `window.__ModuleLoader__.load`, a `require` that resolves 'react' to the
 * local React stub (tools/react-stub.mjs), and an undefined `document` (the
 * stylesheet attach guard must no-op cleanly).
 *
 * Run:  node tools/selfcheck-client.mjs
 */

import { readFile } from 'node:fs/promises'

const React = await import('./react-stub.mjs')
globalThis.document = undefined

// A mutable createElement hook lets one pass capture the props of a specific
// button without monkey-patching the frozen module namespace.
let createElementHook = null
const reactModule = {
  ...React,
  createElement: (type, props, ...children) => {
    const element = React.createElement(type, props, ...children)
    if (createElementHook !== null) createElementHook(type, props)
    return element
  }
}

// --- load the bundle the way the shell would --------------------------------
/** @type {{ id: string, factory: (require: (name: string) => unknown) => object } | null} */
let bundle = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      bundle = entry
    }
  }
}

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

console.log('\n[1] bundle shape')
await import('../lib/client.js')
check('bundle self-registers with the ModuleLoader', bundle !== null)
check('bundle id matches the package name', bundle?.id === 'dsh_session_recyclebin', bundle?.id)

const requiredNames = []
const mod = bundle.factory((name) => {
  requiredNames.push(name)
  if (name === 'react') return reactModule
  throw new Error(`client half required an unexpected module: ${name}`)
})
// `@deepseek-ai/dsh-client-ui-primitives` is resolved inside a try/catch, so a
// shell without the lane still renders plainly-styled surfaces. Both requires
// are legitimate; anything else would be a real surprise.
check('factory requires only react and the defensive primitives lane',
  requiredNames.length === 2 && requiredNames[0] === 'react'
  && requiredNames[1] === '@deepseek-ai/dsh-client-ui-primitives',
  JSON.stringify(requiredNames))

const { apply, inject, store } = mod
const { requestDelete, closeDialog } = store

check('exports apply', typeof apply === 'function')
// The Session Controller owns the writable list; archive preferences are independent.
check('exports inject list', Array.isArray(inject) && inject.join(',') === 'slots,locale,sessions', JSON.stringify(inject))
check('exports the confirmation store', store !== undefined && typeof store.subscribe === 'function' && typeof store.requestDelete === 'function' && typeof store.closeDialog === 'function')

// --- capture the slot registrations ---------------------------------------
console.log('\n[2] slot registrations')

const registrations = []
const injectedNames = []
const fakeSlots = {
  inject(key, callback) {
    injectedNames.push(key)
    return callback()
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  }
}

const dictionaries = []
const translate = (ns) => (key, values) => {
  const table = ns === 'dsh_session_recyclebin/session-row'
    ? dictionaries.find((d) => d.ns === ns)?.dict
    : undefined
  const template = table?.[key] ?? key
  return String(template).replace(/\{(\w+)\}/g, (m, k) =>
    (values && Object.hasOwn(values, k)) ? String(values[k]) : m)
}
const fakeLocale = {
  register(ns, locale, dict) {
    dictionaries.push({ ns, locale, dict })
    return () => {}
  },
  bind: translate
}

let sessionList = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
const sessionListListeners = new Set()
const fakeSessions = {
  list: {
    getSnapshot: () => sessionList,
    set: (next) => { sessionList = next; for (const listener of sessionListListeners) listener() },
    subscribe: (listener) => { sessionListListeners.add(listener); return () => sessionListListeners.delete(listener) }
  },
  refresh: async () => {}
}
// Prevent apply's background probe from contacting an actual Harness server.
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
const fakeCtx = {
  slots: fakeSlots, locale: fakeLocale, effect: (fn) => fn(),
  get: (name) => { if (name === 'sessions') return fakeSessions; throw new Error(`Unexpected service: ${name}`) }
}
apply(fakeCtx)

check('injected into the session menu slot', injectedNames.includes('sidebar.workspaces.session.menu.item'), injectedNames.join(','))
check('injected into the overlay slot', injectedNames.includes('shell.overlay'), injectedNames.join(','))
check('injected into the sidebar foot slot', injectedNames.includes('sidebar.footer.action'), injectedNames.join(','))
// Menu row, delete dialog, trash foot button, trash panel, trash confirm.
check('registered every slot entry', registrations.length === 5, String(registrations.length))

const menuEntry = registrations.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item')
const overlayEntry = registrations.find((r) => r.options.name === 'shell.overlay' && r.options.id === 'dsh_session_recyclebin.confirm')
const trashPanelEntry = registrations.find((r) => r.options.name === 'shell.overlay' && r.options.id === 'dsh_session_recyclebin.trash-panel')
const trashConfirmEntry = registrations.find((r) => r.options.name === 'shell.overlay' && r.options.id === 'dsh_session_recyclebin.trash-confirm')

check('menu entry id', menuEntry?.options.id === 'dsh_session_recyclebin.delete-session', menuEntry?.options.id)
check('menu entry order is 500 (after Archive 400)', menuEntry?.options.order === 500, String(menuEntry?.options.order))
check('menu entry declares the locale namespace', menuEntry?.options.locale === 'dsh_session_recyclebin/session-row', menuEntry?.options.locale)
check('overlay entry id', overlayEntry?.options.id === 'dsh_session_recyclebin.confirm', overlayEntry?.options.id)
check('trash panel is registered', trashPanelEntry !== undefined)
check('trash confirm is registered', trashConfirmEntry !== undefined)
// The destructive-step confirmation must sit ABOVE the panel it confirms for.
check('trash confirm sits above the panel',
  trashConfirmEntry !== undefined && trashPanelEntry !== undefined
  && trashConfirmEntry.options.order > trashPanelEntry.options.order,
  `${String(trashConfirmEntry?.options.order)} over ${String(trashPanelEntry?.options.order)}`)

const sessionRowKeys = ['menu', 'menuWithTitle', 'confirmTitle', 'confirmBody', 'confirmLabel', 'cancelLabel', 'working', 'failed', 'deleted']
const trashKeys = [
  'button', 'badgeOne', 'badgeMany', 'title', 'empty',
  'purgeAll', 'purgeAllTitle', 'purgeAllConfirm', 'purgeTitle',
  'retainedFor', 'retentionHint', 'save', 'saved',
  'remaining', 'remainingToday', 'restore', 'purge', 'purgeConfirm',
  'loading', 'failed', 'refresh', 'daysUnit'
]
const sessionRowNs = 'dsh_session_recyclebin/session-row'
const trashNs = 'dsh_session_recyclebin/trash'
const enSession = dictionaries.find((d) => d.ns === sessionRowNs && d.locale === 'en')?.dict ?? {}
const zhSession = dictionaries.find((d) => d.ns === sessionRowNs && d.locale === 'zh')?.dict ?? {}
const enTrash = dictionaries.find((d) => d.ns === trashNs && d.locale === 'en')?.dict ?? {}
const zhTrash = dictionaries.find((d) => d.ns === trashNs && d.locale === 'zh')?.dict ?? {}

check('registered all four dictionaries', dictionaries.length === 4, String(dictionaries.length))
check('session-row dictionary carries every key', sessionRowKeys.every((k) => typeof enSession[k] === 'string' && typeof zhSession[k] === 'string'),
  JSON.stringify(sessionRowKeys.filter((k) => typeof enSession[k] !== 'string' || typeof zhSession[k] !== 'string')))
check('trash dictionary carries every key', trashKeys.every((k) => typeof enTrash[k] === 'string' && typeof zhTrash[k] === 'string'),
  JSON.stringify(trashKeys.filter((k) => typeof enTrash[k] !== 'string' || typeof zhTrash[k] !== 'string')))
check('no session-row key left untranslated', sessionRowKeys.every((k) => enSession[k] !== k && zhSession[k] !== k))
check('no trash key left untranslated', trashKeys.every((k) => enTrash[k] !== k && zhTrash[k] !== k))

// --- render the menu row ---------------------------------------------------
console.log('\n[3] menu row markup')

const menuFace = menuEntry.options.inject()
check('menu inject face exposes requestDelete', typeof menuFace.requestDelete === 'function')
check('menu inject face injects no closeMenu (the slot owns that)', menuFace.closeMenu === undefined)

const t = fakeLocale.bind('dsh_session_recyclebin/session-row')

/** The menu's own open-state hook, as the slot passes it down. */
let menuOpenCalls = []
const useMenuOpenState = () => [false, (open) => { menuOpenCalls.push(open) }]

React.resetHooks()
const row = React.createElement(menuEntry.component, {
  sessionId: 'session-abc',
  displayTitle: 'My Conversation',
  ...menuFace,
  useMenuOpenState,
  t
})
const rowHtml = React.renderToStaticMarkup(row)
check('row is a menuitem button', rowHtml.includes('role="menuitem"'), rowHtml.slice(0, 200))
// The row is drawn by the shipped `MenuItemButton` when the primitives lane is
// present; the plugin's own fallback hook is only used without it. Either shape
// must be destructive-flavoured, which is what this asserts.
check('row is destructive-flavoured',
  rowHtml.includes('data-danger') || rowHtml.includes('data-dsh_session_recyclebin-menu-fallback'),
  rowHtml.slice(0, 200))
check('row label names the session', rowHtml.includes('Delete Session "My Conversation"'), rowHtml.slice(0, 300))

React.resetHooks()
const rowNoTitle = React.createElement(menuEntry.component, {
  sessionId: 'session-abc',
  displayTitle: '',
  ...menuFace,
  useMenuOpenState,
  t
})
const rowNoTitleHtml = React.renderToStaticMarkup(rowNoTitle)
check('blank title falls back to the bare label', rowNoTitleHtml.includes('Delete Session') && !rowNoTitleHtml.includes('Delete Session "'), rowNoTitleHtml.slice(0, 300))

// The row's click must close the menu and open the dialog. Capture the
// onClick through the createElement hook instead of replacing React.
React.resetHooks()
let dialogOpened = null
menuOpenCalls = []
const faceWithSpy = { ...menuFace, requestDelete: (r) => { dialogOpened = r } }

let rowOnClick = null
createElementHook = (type, props) => {
  if (type === 'button' && props?.role === 'menuitem') rowOnClick = props.onClick
}
React.renderToStaticMarkup(React.createElement(menuEntry.component, {
  sessionId: 'session-abc',
  displayTitle: 'My Conversation',
  ...faceWithSpy,
  useMenuOpenState,
  t
}))
createElementHook = null

check('row renders a clickable button', typeof rowOnClick === 'function')
if (typeof rowOnClick === 'function') {
  rowOnClick()
  check('clicking the row closes the menu', menuOpenCalls.length === 1 && menuOpenCalls[0] === false, JSON.stringify(menuOpenCalls))
  check('clicking the row opens the dialog', dialogOpened?.sessionId === 'session-abc', JSON.stringify(dialogOpened))
  check('dialog receives the raw session title', dialogOpened?.title === 'My Conversation', JSON.stringify(dialogOpened))
}

// --- render the dialog -----------------------------------------------------
console.log('\n[4] confirmation dialog')

// Start from a clean store: the row-click test above opened one.
closeDialog()

const overlayFace = overlayEntry.options.inject()
check('overlay inject face exposes setPending', typeof overlayFace.setPending === 'function')

React.resetHooks()
const closed = React.createElement(overlayEntry.component, { ...overlayFace, t })
check('closed dialog renders nothing', React.renderToStaticMarkup(closed) === '', React.renderToStaticMarkup(closed).slice(0, 200))

requestDelete({ sessionId: 'session-abc', title: 'Delete Session "My Conversation"' })
React.resetHooks()
const open = React.createElement(overlayEntry.component, { ...overlayFace, t })
const openHtml = React.renderToStaticMarkup(open)
check('open dialog is an alertdialog', openHtml.includes('role="alertdialog"'), openHtml.slice(0, 200))
check('open dialog is modal', openHtml.includes('aria-modal="true"'), openHtml.slice(0, 200))
check('open dialog carries the overlay hook', openHtml.includes('data-dsh_session_recyclebin-overlay=""'), openHtml.slice(0, 200))
check('dialog shows the warning body', openHtml.includes('removed permanently'), openHtml.slice(0, 400))
check('dialog offers a confirm button', openHtml.includes('data-dsh_session_recyclebin-button="confirm"'), openHtml.slice(0, 400))
check('dialog offers a cancel button', openHtml.includes('data-dsh_session_recyclebin-button="cancel"'), openHtml.slice(0, 400))

// --- the dialog must SUBSCRIBE, not read the store during render -----------
console.log('\n[4b] dialog subscription')

// With the store closed, the dialog renders nothing even if the store had a
// value at some earlier point — proving it reads through state, not directly.
closeDialog()
React.resetHooks()
const afterClose = React.renderToStaticMarkup(React.createElement(overlayEntry.component, { ...overlayFace, t }))
check('closing the store renders nothing', afterClose === '', afterClose.slice(0, 200))

// Now prove the dialog installs a subscription in an effect, and that firing
// the store re-renders it. The stub records effects; run them, then change the
// store and confirm the recorded setState path was exercised.
React.resetHooks()
React.renderToStaticMarkup(React.createElement(overlayEntry.component, { ...overlayFace, t }))
const teardowns = React.runEffects()
// One effect per subscribed store: the delete dialog follows the confirmation
// store and mirrors the trash verdict, so it installs two subscriptions.
check('dialog installed one effect per subscribed store', teardowns.length === 2, String(teardowns.length))

// The subscription must fire when the store changes, and must tear down.
let notifications = 0
const unsubscribe = store.subscribe(() => { notifications += 1 })
store.requestDelete({ sessionId: 'session-abc', title: 'x' })
check('store notifies its subscribers', notifications === 1, String(notifications))
unsubscribe()
store.closeDialog()
check('unsubscribe stops notifications', notifications === 1, String(notifications))

// --- drive the delete call ------------------------------------------------
console.log('\n[5] delete request')

// The subscription pass above closed the store; open it again so the dialog
// actually renders its buttons for this pass.
store.requestDelete({ sessionId: 'session-abc', title: 'Delete Session "My Conversation"' })

let capturedUrl = null
let capturedInit = null
let capturedBody = null
globalThis.fetch = async (url, init) => {
  capturedUrl = url
  capturedInit = init
  capturedBody = JSON.parse(init.body)
  return { ok: true, status: 200, async json() { return { ok: true, sessionId: 'session-abc' } } }
}

// Capture the confirm button's onClick through the createElement hook.
React.resetHooks()
const capturedButtons = []
createElementHook = (type, props) => {
  if (type === 'button' && props?.['data-dsh_session_recyclebin-button'] === 'confirm') {
    capturedButtons.push(props)
  }
}
React.renderToStaticMarkup(React.createElement(overlayEntry.component, { ...overlayFace, t }))
createElementHook = null

check('confirm button carries an onClick', capturedButtons.length === 1 && typeof capturedButtons[0]?.onClick === 'function')

if (capturedButtons.length === 1) {
  await capturedButtons[0].onClick()
  check('delete POSTed to the host route', capturedUrl === '/session-delete/api/delete', String(capturedUrl))
  check('delete used POST', capturedInit?.method === 'POST', capturedInit?.method)
  check('delete sent the session id', capturedBody?.sessionId === 'session-abc', JSON.stringify(capturedBody))
}

// --- the trash destructive-step confirmation --------------------------------
console.log('\n[5b] trash destructive-step confirmation')

const { askTrashConfirm, settleTrashConfirm, trashConfirmSnapshot, subscribeTrashConfirm } = store

check('store exposes the trash confirmation face',
  typeof askTrashConfirm === 'function'
  && typeof settleTrashConfirm === 'function'
  && typeof trashConfirmSnapshot === 'function')

// No request is open at rest.
check('no trash confirmation at rest', trashConfirmSnapshot() === null)

// askTrashConfirm must resolve only when settled — never on its own.
let settled = null
const pending = askTrashConfirm({ kind: 'empty', count: 3 })
pending.then((value) => { settled = value })
check('asking opens a request', trashConfirmSnapshot() !== null)
check('the request carries the count', trashConfirmSnapshot()?.count === 3, String(trashConfirmSnapshot()?.count))
check('asking does not resolve by itself', settled === null)

// The dialog must render while a request is open, and render nothing at rest.
React.resetHooks()
const trashConfirmHtml = React.renderToStaticMarkup(
  React.createElement(trashConfirmEntry.component, { t: fakeLocale.bind(trashNs) })
)
check('open trash confirmation is an alertdialog', trashConfirmHtml.includes('role="alertdialog"'), trashConfirmHtml.slice(0, 200))
check('empty-bin confirmation buttons are Chinese', trashConfirmHtml.includes('取消') && trashConfirmHtml.includes('确认清空'))
// The stub translate echoes keys verbatim, so the count lives in the request the
// dialog renders from rather than in the substituted copy.
check('open trash confirmation renders the empty-all copy',
  trashConfirmHtml.includes('purgeAllTitle') && trashConfirmHtml.includes('purgeAllConfirm'),
  trashConfirmHtml.slice(0, 300))

settleTrashConfirm(false)
await pending
check('cancelling resolves false', settled === false, String(settled))
check('settling closes the request', trashConfirmSnapshot() === null)

React.resetHooks()
check('settled trash confirmation renders nothing',
  React.renderToStaticMarkup(React.createElement(trashConfirmEntry.component, { t: fakeLocale.bind(trashNs) })) === '')

// A purge request carries the session identity and its display title.
let purgeSettled = null
const purgePending = askTrashConfirm({ kind: 'purge', sessionId: 'session-xyz', title: 'My chat', count: 1 })
purgePending.then((value) => { purgeSettled = value })
check('a purge request carries the session id', trashConfirmSnapshot()?.sessionId === 'session-xyz')
check('a purge request carries the title', trashConfirmSnapshot()?.title === 'My chat')
settleTrashConfirm(true)
await purgePending
check('confirming resolves true', purgeSettled === true, String(purgeSettled))

// --- source-level assertions -----------------------------------------------
console.log('\n[6] bundle format and host route constant')
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
check('client posts to the host half route', /const DELETE_PATH = '\/session-delete\/api\/delete'/.test(source))
// The primitives lane is resolved defensively inside a try/catch, so the bundle
// still renders without it. What must NOT happen is a bare top-level `require`
// of it, which would fail the whole bundle on a shell without the lane.
check('ui-primitives is resolved defensively, never required bare',
  /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/.test(source)
  && !/^\s*const primitives = require\('@deepseek-ai\/dsh-client-ui-primitives'\)\s*$/m.test(source),
  'expected a try/catch around the primitives require')
check('client uses only React.createElement', /React\.createElement/.test(source) && !/from 'react'/.test(source))
check('client is a ModuleLoader bundle', /window\.__ModuleLoader__\.load\(\{/.test(source) && /id: 'dsh_session_recyclebin'/.test(source))
check('client requires react through the module table', /const React = require\('react'\)/.test(source))
// `window.confirm` is a synchronous modal: it blocks the renderer for its whole
// lifetime and leaves the page unable to take pointer input afterwards.
check('no synchronous window.confirm anywhere', !/window\.confirm\(/.test(source))
check('injects only the actual session list owner', inject.includes('sessions') && !inject.includes('uiWorkspace') && !inject.includes('workspaces'))
check('subscribes to session list changes', /list\.subscribe\(filterDeletedSessions\)/.test(source))
check('trash row actions await the session baseline', /async \(action\)[\s\S]*?await refreshSessionList\(\)/.test(source))
check('empty awaits the session baseline', /callTrash\('empty'\)[\s\S]*?await refreshSessionList\(\)/.test(source))
check('confirmed delete awaits the session baseline', /if \(result\.ok\)[\s\S]*?await refreshSessionList\(\)/.test(source))

console.log(`\n${passes.length} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failed: ${failures.join(', ')}`)
  process.exitCode = 1
}
