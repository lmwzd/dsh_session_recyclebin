/**
 * Client half of dsh_session_recyclebin — a hand-written ModuleLoader bundle.
 *
 * The DSH web shell loads client halves through `window.__ModuleLoader__.load`
 * (a `require` bound to the shell's module table), and `dsh.client` is a
 * PER-PACKAGE declaration: the optional Session Trash sub-plugin contributes
 * NO second client bundle. This one bundle owns every surface — the menu row,
 * the confirmation dialog, the sidebar-foot trash button, and the trash panel
 * — and gates the trash UI on a runtime probe of the trash host routes, which
 * only exist while the `dsh_session_recyclebin-trash` loader row is enabled.
 *
 * Surfaces:
 *
 *   1. "Delete Session" row in the Session "..." menu of the left sidebar,
 *      through `sidebar.workspaces.session.menu.item` (the list slot Workspace
 *      Browser declares). Order 500 places it after the shipped Archive (400).
 *      Rendered with the shipped `MenuItemButton` — the implicit ui-primitives
 *      baseline for Loader packages — plus `IconTrashOutlineRegular`, so the
 *      row matches the shipped rows exactly: host padding, host hairline, host
 *      icon slot, host destructive color.
 *   2. The confirmation dialog, a `shell.overlay` entry. Its copy adapts to
 *      the trash probe: with the trash enabled the session is moved to the
 *      trash for N days and stays restorable; otherwise the permanent-delete
 *      warning stands.
 *   3. With the trash enabled: a small trash button in `sidebar.footer.action`
 *      (the official foot seat beside Settings), badged with the parked count,
 *      opening the trash panel (another `shell.overlay` entry) that lists the
 *      trashed sessions with restore / delete-forever / empty-all (each
 *      destructive step confirmed) and the retention control clamped to 3–30
 *      days by the host.
 *
 * The trash UI re-probes on mount and whenever the window regains focus, so
 * toggling the sub-plugin in the plugin settings takes effect when the user
 * clicks back into the app — no page reload needed.
 *
 * The deletion itself is one POST to the host half's route; the host owns the
 * filesystem, the registry un-listing, the running-work stop, and the trash.
 */
window.__ModuleLoader__.load({
  id: 'dsh_session_recyclebin',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    // The implicit baseline external the slot contract guarantees to a Loader
    // package. Resolved defensively so a shell without the primitives still
    // renders usable (plainly styled) surfaces instead of failing the bundle.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    const MenuItemButton = primitives?.MenuItemButton
    const IconTrash = primitives?.IconTrashOutlineRegular
    const Tooltip = primitives?.Tooltip

    const PLUGIN_NAME = 'dsh_session_recyclebin'
    const LOCALE_NS = `${PLUGIN_NAME}/session-row`
    const TRASH_NS = `${PLUGIN_NAME}/trash`

    /** HTTP route of the host half's delete method. */
    const DELETE_PATH = '/session-delete/api/delete'

    /** HTTP route prefix of the trash host half (present only while enabled). */
    const TRASH_API = '/session-delete/api/trash'

    /** Slot this plugin contributes a menu row to. */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'

    /** Slot the confirmation dialog and the trash panel are registered into. */
    const OVERLAY_SLOT = 'shell.overlay'

    /** Seat of the sidebar-foot trash button. */
    const FOOTER_SLOT = 'sidebar.footer.action'

    /** Order of the menu row: after the shipped Archive (400). */
    const MENU_ORDER = 500

    /** Order of the confirmation overlay. */
    const OVERLAY_ORDER = 100

    /** Order of the trash panel overlay. */
    const PANEL_ORDER = 110

    /**
     * Order of the trash destructive-step confirmation: above the panel it
     * confirms for, so the step under review is dimmed behind it.
     */
    const CONFIRM_OVERLAY_ORDER = 120

    /** Order inside the sidebar foot: after the shipped settings trigger. */
    const FOOTER_ORDER = 100

    /** Same bounds the host clamps to; the input mirrors them. */
    const RETENTION_MIN = 3
    const RETENTION_MAX = 30

    const en = {
      menu: 'Delete Session',
      menuWithTitle: 'Delete Session "{title}"',
      confirmTitle: 'Delete this session?',
      confirmBody: 'The conversation log, its projection cache, and every attachment it owns are removed permanently. This cannot be undone.',
      confirmTitleTrash: 'Move this session to the trash?',
      confirmBodyTrash: 'The session leaves the sidebar right away and waits in the Session Trash for {days} days, where you can restore it — or delete it forever.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      working: 'Deleting…',
      failed: 'Delete failed: {message}',
      deleted: 'Session deleted'
    }

    const zh = {
      menu: '删除会话',
      menuWithTitle: '删除会话「{title}」',
      confirmTitle: '删除此会话？',
      confirmBody: '将永久删除该会话的对话记录、投影缓存及其拥有的全部附件，且无法恢复。',
      confirmTitleTrash: '将会话移入回收站？',
      confirmBodyTrash: '会话会立即从侧栏消失，并在回收站中保留 {days} 天，期间可随时恢复，也可彻底删除。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      working: '正在删除…',
      failed: '删除失败：{message}',
      deleted: '会话已删除'
    }

    const trashEn = {
      button: 'Session Trash',
      badgeOne: '{count} session in the trash',
      badgeMany: '{count} sessions in the trash',
      title: 'Session Trash',
      empty: 'The trash is empty.',
      purgeAll: 'Empty Trash',
      purgeAllTitle: 'Empty the trash?',
      purgeAllConfirm: 'Permanently delete all {count} trashed sessions? This cannot be undone.',
      purgeTitle: 'Delete forever?',
      retainedFor: 'Keep sessions for',
      retentionHint: '3–30 days.',
      save: 'Save',
      saved: 'Saved',
      remaining: '{days} days left',
      remainingToday: 'expires today',
      restore: 'Restore',
      purge: 'Delete forever',
      purgeConfirm: 'Permanently delete "{title}"? This cannot be undone.',
      loading: 'Loading…',
      failed: 'Trash request failed: {message}',
      refresh: 'Refresh',
      daysUnit: 'days'
    }

    const trashZh = {
      button: '会话回收站',
      badgeOne: '回收站内有 {count} 个会话',
      badgeMany: '回收站内有 {count} 个会话',
      title: '会话回收站',
      empty: '回收站是空的。',
      purgeAll: '清空回收站',
      purgeAllTitle: '清空回收站？',
      purgeAllConfirm: '将 {count} 个回收站会话永久删除？此操作无法恢复。',
      purgeTitle: '彻底删除？',
      retainedFor: '会话保留',
      retentionHint: '可设置 3–30 天。',
      save: '保存',
      saved: '已保存',
      remaining: '剩余 {days} 天',
      remainingToday: '今天到期',
      restore: '恢复',
      purge: '彻底删除',
      purgeConfirm: '永久删除「{title}」？此操作无法恢复。',
      loading: '加载中…',
      failed: '回收站请求失败：{message}',
      refresh: '刷新',
      daysUnit: '天'
    }

    /**
     * Install every dictionary (main + trash) into the locale registry.
     *
     * @param {object} ctx - the client context.
     * @returns {() => void} a disposer unregistering all four dictionaries.
     */
    function attachLocale(ctx) {
      return ctx.effect(() => {
        const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
        const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
        const offTrashEn = ctx.locale.register(TRASH_NS, 'en', trashEn)
        const offTrashZh = ctx.locale.register(TRASH_NS, 'zh', trashZh)
        return () => {
          offEn()
          offZh()
          offTrashEn()
          offTrashZh()
        }
      }, `${PLUGIN_NAME}: dictionaries`)
    }

    /** Styles the host primitives do not cover. */
    const CSS = `
[data-${PLUGIN_NAME}-overlay] {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--dsw-alias-overlay-scrim, #101828) 55%, transparent);
}

[data-${PLUGIN_NAME}-dialog] {
  width: min(420px, calc(100vw - 48px));
  padding: 20px 24px 16px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-overlay-scrim, #101828) 24%, transparent);
  color: var(--dsw-alias-label-primary, #101828);
  font-size: 14px;
  line-height: 1.5;
}

[data-${PLUGIN_NAME}-dialog] h2 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}

[data-${PLUGIN_NAME}-dialog] p {
  margin: 0 0 20px;
  color: var(--dsw-alias-label-secondary, #475467);
}

[data-${PLUGIN_NAME}-actions] {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

[data-${PLUGIN_NAME}-button] {
  min-width: 72px;
  padding: 7px 14px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

[data-${PLUGIN_NAME}-button='cancel'] {
  background: var(--dsw-alias-bg-layer-2, #f2f4f7);
  color: var(--dsw-alias-label-primary, #101828);
}

[data-${PLUGIN_NAME}-button='confirm'] {
  background: var(--dsw-alias-state-error-primary, #d92d20);
  color: #ffffff;
}

[data-${PLUGIN_NAME}-button]:disabled {
  cursor: default;
  opacity: 0.6;
}

[data-${PLUGIN_NAME}-notice] {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--dsw-alias-state-error-primary, #d92d20);
}

[data-${PLUGIN_NAME}-menu-fallback] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-state-error-primary, #d92d20);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

[data-${PLUGIN_NAME}-menu-fallback]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(16, 24, 40, 0.05));
}

[data-${PLUGIN_NAME}-separator] {
  height: 1px;
  margin: 4px 0;
  background: var(--dsw-alias-border-l1, rgba(16, 24, 40, 0.1));
}

[data-${PLUGIN_NAME}-trash-button] {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
}

[data-${PLUGIN_NAME}-trash-button]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(16, 24, 40, 0.06));
  color: var(--dsw-alias-label-primary, inherit);
}

[data-${PLUGIN_NAME}-trash-badge] {
  position: absolute;
  top: 0;
  right: 0;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--dsw-alias-state-error-primary, #d92d20);
  color: #ffffff;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
}

[data-${PLUGIN_NAME}-trash-panel] {
  width: min(560px, calc(100vw - 48px));
  max-height: min(70vh, 640px);
  display: flex;
  flex-direction: column;
  padding: 18px 20px 14px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-overlay-scrim, #101828) 24%, transparent);
  color: var(--dsw-alias-label-primary, #101828);
  font-size: 14px;
}

[data-${PLUGIN_NAME}-trash-panel] h2 {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
}

[data-${PLUGIN_NAME}-trash-retention] {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, inherit);
}

[data-${PLUGIN_NAME}-trash-retention] input {
  width: 56px;
  padding: 4px 6px;
  border: 1px solid var(--dsw-alias-border-l2, #d0d5dd);
  border-radius: 6px;
  font: inherit;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: inherit;
}

[data-${PLUGIN_NAME}-trash-list] {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

[data-${PLUGIN_NAME}-trash-row] {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 6px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(16, 24, 40, 0.03));
}

[data-${PLUGIN_NAME}-trash-row-main] {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

[data-${PLUGIN_NAME}-trash-row-title] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

[data-${PLUGIN_NAME}-trash-row-meta] {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
}

[data-${PLUGIN_NAME}-trash-act] {
  border: 1px solid var(--dsw-alias-border-l2, #d0d5dd);
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 6px;
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

[data-${PLUGIN_NAME}-trash-act]:hover {
  border-color: var(--dsw-alias-label-secondary, inherit);
}

[data-${PLUGIN_NAME}-trash-act='purge'] {
  color: var(--dsw-alias-state-error-primary, #d92d20);
}

[data-${PLUGIN_NAME}-trash-act]:disabled {
  opacity: 0.55;
  cursor: default;
}

[data-${PLUGIN_NAME}-trash-foot] {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

[data-${PLUGIN_NAME}-trash-empty] {
  color: var(--dsw-alias-label-secondary, inherit);
  text-align: center;
  padding: 24px 0;
}

[data-${PLUGIN_NAME}-trash-error] {
  color: var(--dsw-alias-state-error-primary, #d92d20);
  font-size: 13px;
  margin: 0 0 10px;
}
`

    /**
     * Insert the plugin's stylesheet, once per page.
     *
     * @returns {() => void} a disposer removing the style element.
     */
    function attachStyles() {
      if (typeof document === 'undefined') return () => {}
      const tagId = `${PLUGIN_NAME}/session-row.css`
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) {
        return () => {}
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_NAME
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    // -------------------------------------------------------------------------
    // Confirmation store (menu row → dialog). Deliberately outside React: the
    // row that opens the dialog lives in a different slot occurrence from the
    // dialog, so the two cannot share a useState owner; the explicit
    // subscription is what re-renders the dialog when the row fires.
    // -------------------------------------------------------------------------

    /**
     * @typedef {object} PendingDelete
     * @property {string} sessionId - the session to delete.
     * @property {string} title - the row's display title, for the dialog.
     */

    /** Live confirmation request, or `null` when the dialog is closed. */
    let pending = null

    /** Subscribers notified when {@link pending} changes. */
    const listeners = new Set()

    /**
     * @param {() => void} listener - called on every change.
     * @returns {() => void} an unsubscribe function.
     */
    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    /** Notify every subscriber that the confirmation state changed. */
    function emit() {
      for (const listener of listeners) listener()
    }

    /** @returns {PendingDelete | null} the live request. */
    function current() {
      return pending
    }

    /**
     * Open the confirmation dialog for one session.
     *
     * @param {PendingDelete} request - the session awaiting confirmation.
     * @returns {void}
     */
    function requestDelete(request) {
      pending = request
      emit()
    }

    /** Close the confirmation dialog. */
    function closeDialog() {
      pending = null
      emit()
    }

    // -------------------------------------------------------------------------
    // Trash store: the probe verdict, the parked list, panel visibility. One
    // module-level store every trash surface subscribes to.
    // -------------------------------------------------------------------------

    /**
     * @typedef {object} TrashState
     * @property {boolean | null} enabled - null until the first probe settles.
     * @property {boolean} open - whether the panel is showing.
     * @property {boolean} loading
     * @property {string | null} error
     * @property {Array<object>} entries - the host's list payload.
     * @property {number} retentionDays
     */

    /** @type {TrashState} */
    let trashState = {
      enabled: null,
      open: false,
      loading: false,
      error: null,
      entries: [],
      retentionDays: RETENTION_MIN + 4
    }

    const trashListeners = new Set()

    /**
     * Patch the trash state and notify subscribers.
     *
     * @param {Partial<TrashState>} patch
     * @returns {void}
     */
    function setTrash(patch) {
      trashState = { ...trashState, ...patch }
      for (const listener of trashListeners) listener()
    }

    /**
     * @param {() => void} listener
     * @returns {() => void} an unsubscribe function.
     */
    function subscribeTrash(listener) {
      trashListeners.add(listener)
      return () => {
        trashListeners.delete(listener)
      }
    }

    /** @returns {TrashState} the live snapshot. */
    function trashSnapshot() {
      return trashState
    }

    // -------------------------------------------------------------------------
    // Destructive-confirmation store: the trash panel's purge / empty steps.
    //
    // Deliberately NOT `window.confirm`: that call is synchronous and modal, so
    // it blocks the renderer's event loop for its whole lifetime and leaves the
    // page unable to take pointer input afterwards — the exact "can't click
    // anything any more" failure. A plugin-owned dialog is asynchronous, themed
    // by the same stylesheet as the rest of these surfaces, and dismissible.
    // -------------------------------------------------------------------------

    /**
     * @typedef {object} TrashConfirm
     * @property {'purge' | 'empty'} kind - which destructive step is awaiting.
     * @property {string | undefined} sessionId - the target of a purge.
     * @property {string | undefined} title - its display title, for the copy.
     * @property {number} count - the number of entries an empty would remove.
     * @property {(confirmed: boolean) => void} resolve - settles the request.
     */

    /** Live destructive-confirmation request, or `null` when none is open. */
    let trashConfirm = null

    /** Subscribers notified when {@link trashConfirm} changes. */
    const trashConfirmListeners = new Set()

    /**
     * @param {() => void} listener
     * @returns {() => void} an unsubscribe function.
     */
    function subscribeTrashConfirm(listener) {
      trashConfirmListeners.add(listener)
      return () => {
        trashConfirmListeners.delete(listener)
      }
    }

    /** @returns {TrashConfirm | null} the live request. */
    function trashConfirmSnapshot() {
      return trashConfirm
    }

    /**
     * Ask the user to confirm one destructive trash step.
     *
     * @param {Omit<TrashConfirm, 'resolve'>} request - the step to confirm.
     * @returns {Promise<boolean>} true when the user confirmed.
     */
    function askTrashConfirm(request) {
      return new Promise((resolve) => {
        trashConfirm = { ...request, resolve }
        for (const listener of trashConfirmListeners) listener()
      })
    }

    /**
     * Settle the open request and close the dialog.
     *
     * @param {boolean} confirmed - the user's answer.
     * @returns {void}
     */
    function settleTrashConfirm(confirmed) {
      const request = trashConfirm
      trashConfirm = null
      for (const listener of trashConfirmListeners) listener()
      request?.resolve(confirmed)
    }

    /**
     * POST one JSON body to a trash route.
     *
     * @param {string} method - list / restore / purge / empty / settings.
     * @param {Record<string, unknown>} [body]
     * @returns {Promise<any>} the payload on 2xx + ok.
     * @throws {Error} the host's message (with `code`) on any failure.
     */
    async function callTrash(method, body) {
      const response = await fetch(`${TRASH_API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {})
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || payload?.ok !== true) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`)
        Object.defineProperty(error, 'code', { value: payload?.error?.code })
        Object.defineProperty(error, 'status', { value: response.status })
        throw error
      }
      return payload
    }

    /**
     * Probe the trash through the shared list route.
     *
     * An `ok` list means the trash host routes are live (the sub-plugin is
     * enabled); a 404 means its row is absent from the composition (disabled).
     * Any other failure leaves the previous verdict alone — a carrier fault is
     * not evidence the user turned the feature off, and the dialog keeps its
     * last wording rather than flicker.
     */
    async function probeTrash() {
      try {
        const payload = await callTrash('list')
        acceptTrashList(payload)
        setTrash({
          enabled: true,
          entries: Array.isArray(payload.entries) ? payload.entries : [],
          retentionDays: typeof payload.retentionDays === 'number'
            ? payload.retentionDays
            : trashState.retentionDays
        })
      } catch (error) {
        const missing = error?.status === 404 || /HTTP 404/.test(String(error?.message ?? ''))
        if (missing) setTrash({ enabled: false })
      }
    }

    /**
     * Toggle the trash panel's open state.
     *
     * @param {boolean} open - the new panel visibility.
     * @returns {void}
     */
    function setPanelOpen(open) {
      setTrash({ open })
    }

    /**
     * Re-fetch the trash list and refresh the badge, panel rows, and retention
     * copy after any mutation (move / restore / purge / empty / settings).
     *
     * @returns {Promise<void>}
     */
    async function refreshTrashList() {
      setTrash({ loading: true, error: null })
      try {
        const payload = await callTrash('list')
        acceptTrashList(payload)
        setTrash({
          enabled: true,
          loading: false,
          entries: Array.isArray(payload.entries) ? payload.entries : [],
          retentionDays: typeof payload.retentionDays === 'number'
            ? payload.retentionDays
            : trashState.retentionDays
        })
      } catch (error) {
        setTrash({ loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    // -------------------------------------------------------------------------
    // The delete request.
    // -------------------------------------------------------------------------

    /**
     * POST one session to the host half's delete route.
     *
     * @param {string} sessionId - the session to delete.
     * @returns {Promise<{ ok: boolean, message?: string, trashed?: boolean }>} the host's report.
     */
    async function callDelete(sessionId) {
      try {
        const response = await fetch(DELETE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId })
        })
        const payload = await response.json().catch(() => undefined)
        if (!response.ok || payload?.ok !== true) {
          const message = payload?.error?.message ?? `HTTP ${response.status}`
          return { ok: false, message }
        }
        return { ok: true, trashed: payload.trashed === true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    // -------------------------------------------------------------------------
    // Keeping the sidebar in step with the host.
    // -------------------------------------------------------------------------

    /**
     * The client context, captured when the bundle applies.
     *
     * The delete confirmation dialog lives in a different slot occurrence from
     * `apply`, so it cannot close over the context; the module-level handle is
     * what lets a completed delete reach the workspace service.
     *
     * @type {object | null}
     */
    let clientCtx = null

    // Verified against the shipped Session Controller: list is a writable
    // SnapshotStore { ids, byId, phase, projectionsBySession }. refresh() merges
    // old rows into the new baseline; deletion needs a separate presentation
    // filter, independent of the user's archivedFilter.
    // Preserve browser state across the package rename.
    const TOMBSTONES_KEY = 'dsh-session-delete/hidden-session-ids'
    let hiddenSessionIds = new Set()
    let permanentSessionIds = new Set()
    let filteringList = false

    function filterDeletedSessions() {
      let list
      try { list = clientCtx?.get('sessions')?.list } catch { return }
      if (filteringList || typeof list?.set !== 'function') return
      const snapshot = list.getSnapshot()
      if (!Array.isArray(snapshot.ids) || !snapshot.byId) return
      const ids = snapshot.ids.filter((id) => !hiddenSessionIds.has(id))
      const removed = Object.keys(snapshot.byId).filter((id) => hiddenSessionIds.has(id))
      if (ids.length === snapshot.ids.length && removed.length === 0) return
      const byId = { ...snapshot.byId }
      for (const id of removed) delete byId[id]
      filteringList = true
      try { list.set({ ...snapshot, ids, byId }) } finally { filteringList = false }
    }

    function hideSessions(ids) {
      for (const id of ids) if (typeof id === 'string' && id !== '') hiddenSessionIds.add(id)
      try { localStorage.setItem(TOMBSTONES_KEY, JSON.stringify({ hidden: [...hiddenSessionIds], permanent: [...permanentSessionIds] })) } catch {}
      filterDeletedSessions()
    }

    function acceptTrashList(payload) {
      // Host authority includes purged ids and removes restored ids.
      if (Array.isArray(payload.hiddenSessionIds)) {
        hiddenSessionIds = new Set([...payload.hiddenSessionIds.filter((id) => typeof id === 'string' && id !== ''), ...permanentSessionIds])
      }
      hideSessions((Array.isArray(payload.entries) ? payload.entries : []).map((entry) => entry.sessionId))
    }

    function attachSessionFilter() {
      try {
        const saved = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) ?? '[]')
        if (Array.isArray(saved)) hiddenSessionIds = new Set(saved.filter((id) => typeof id === 'string'))
        else if (saved && Array.isArray(saved.hidden)) {
          permanentSessionIds = new Set((Array.isArray(saved.permanent) ? saved.permanent : []).filter((id) => typeof id === 'string'))
          hiddenSessionIds = new Set([...saved.hidden.filter((id) => typeof id === 'string'), ...permanentSessionIds])
        }
      } catch {}
      const sessions = clientCtx.get('sessions')
      const list = sessions?.list
      if (typeof list?.subscribe !== 'function' || typeof list?.set !== 'function') {
        console.warn('[dsh_session_recyclebin] Session list filtering unavailable')
        return () => {}
      }
      const unsubscribe = list.subscribe(filterDeletedSessions)
      filterDeletedSessions()
      return () => {
        unsubscribe()
        // Verified implementation hook: restore current manager presentation on
        // unload without patching service methods or restoring a stale snapshot.
        if (typeof sessions.projectList === 'function') sessions.projectList()
      }
    }

    /** Pull the real controller baseline, then reapply deletion tombstones. */
    async function refreshSessionList() {
      const ctx = clientCtx
      if (ctx === null) return
      const sessions = ctx.get('sessions')
      if (typeof sessions?.refresh !== 'function') throw new Error('Session list refresh unavailable')
      await sessions.refresh()
      filterDeletedSessions()
    }

    // -------------------------------------------------------------------------
    // The menu row.
    // -------------------------------------------------------------------------

    /**
     * The "Delete Session" menu row.
     *
     * Rendered through the shipped `MenuItemButton` — the exact component the
     * WorkspaceBrowser's own rows use — so padding, hairline, icon slot, hover,
     * and the destructive row color all come from the host stylesheet instead
     * of plugin CSS. Without a primitives lane the row degrades to a plain
     * `role="menuitem"` button with the plugin's fallback styling.
     *
     * A list-slot entry receives only the row identity, so the row carries its
     * own behavior through the registration's `inject` face and dismisses the
     * menu through the slot-level `useMenuOpenState` hook the menu passes down
     * as a prop — the same hook the shipped rows use.
     *
     * @param {object} props - the slot's projected props.
     * @param {string} props.sessionId - the session this row belongs to.
     * @param {string} props.displayTitle - the session's display title.
     * @param {() => [boolean, (open: boolean) => void]} props.useMenuOpenState - the menu's own open state.
     * @param {(request: PendingDelete) => void} props.requestDelete - open the dialog.
     * @param {(key: string, values?: Record<string, string>) => string} props.t - the translate function.
     * @returns {object} the menu row.
     */
    function DeleteSessionRow({ sessionId, displayTitle, useMenuOpenState, requestDelete: ask, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const label = typeof displayTitle === 'string' && displayTitle !== ''
        ? t('menuWithTitle', { title: displayTitle })
        : t('menu')
      const onSelect = () => {
        setMenuOpen(false)
        ask({ sessionId, title: typeof displayTitle === 'string' ? displayTitle : sessionId })
      }

      const icon = typeof IconTrash === 'function'
        ? React.createElement(IconTrash, { size: 14 })
        : null

      if (typeof MenuItemButton === 'function') {
        return React.createElement(MenuItemButton, {
          icon,
          danger: true,
          separatorBefore: true,
          onSelect
        }, label)
      }

      return React.createElement(React.Fragment, null,
        React.createElement('div', { role: 'separator', [`data-${PLUGIN_NAME}-separator`]: '' }),
        React.createElement('button', {
          type: 'button',
          role: 'menuitem',
          [`data-${PLUGIN_NAME}-menu-fallback`]: '',
          onClick: onSelect
        }, icon, label)
      )
    }

    // -------------------------------------------------------------------------
    // The confirmation dialog.
    // -------------------------------------------------------------------------

    /**
     * The confirmation dialog, a `shell.overlay` entry.
     *
     * Subscribes to the confirmation store (installed in an effect, torn down
     * with the entry) and mirrors the trash verdict so the copy can say
     * "move to trash for N days" instead of "gone forever" when the optional
     * sub-plugin is enabled.
     *
     * @param {object} props - the slot's projected props.
     * @param {(request: PendingDelete | null) => void} props.setPending - replace the pending request.
     * @param {(key: string, values?: Record<string, string | number>) => string} props.t - the translate function.
     * @returns {object | null} the dialog, or null when closed.
     */
    function ConfirmDialog({ setPending, t }) {
      const [request, setRequest] = React.useState(current)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [trashNow, setTrashNow] = React.useState(trashState.enabled === true)
      const [retention, setRetention] = React.useState(trashState.retentionDays)

      React.useEffect(() => subscribe(() => {
        setRequest(current())
        setBusy(false)
        setError(null)
      }), [])
      React.useEffect(() => subscribeTrash(() => {
        setTrashNow(trashState.enabled === true)
        setRetention(trashState.retentionDays)
      }), [])

      if (request === null) return null

      const confirm = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        const result = await callDelete(request.sessionId)
        setBusy(false)
        if (result.ok) {
          if (result.trashed !== true) permanentSessionIds.add(request.sessionId)
          hideSessions([request.sessionId])
          setPending(null)
          try {
            if (result.trashed === true || trashState.enabled === true) await refreshTrashList()
            await refreshSessionList()
          } catch (error) {
            setTrash({ error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        setError(result.message ?? t('failed', { message: 'unknown' }))
      }

      const cancel = () => {
        if (busy) return
        setPending(null)
      }

      return React.createElement('div', {
        'data-plugin': PLUGIN_NAME,
        [`data-${PLUGIN_NAME}-overlay`]: '',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) cancel()
        }
      },
        React.createElement('div', {
          [`data-${PLUGIN_NAME}-dialog`]: '',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-label': trashNow ? t('confirmTitleTrash') : t('confirmTitle')
        },
          React.createElement('h2', null, trashNow ? t('confirmTitleTrash') : t('confirmTitle')),
          error === null
            ? null
            : React.createElement('p', { [`data-${PLUGIN_NAME}-notice`]: '', role: 'alert' }, error),
          React.createElement('p', null, trashNow
            ? t('confirmBodyTrash', { days: String(retention) })
            : t('confirmBody')),
          React.createElement('div', { [`data-${PLUGIN_NAME}-actions`]: '' },
            React.createElement('button', {
              type: 'button',
              [`data-${PLUGIN_NAME}-button`]: 'cancel',
              onClick: cancel,
              disabled: busy
            }, t('cancelLabel')),
            React.createElement('button', {
              type: 'button',
              [`data-${PLUGIN_NAME}-button`]: 'confirm',
              onClick: confirm,
              disabled: busy
            }, busy ? t('working') : t('confirmLabel'))
          )
        )
      )
    }

    // -------------------------------------------------------------------------
    // The trash surfaces.
    // -------------------------------------------------------------------------

    /**
     * The sidebar-foot trash button.
     *
     * @param {object} props - the slot's projected props.
     * @param {(key: string, values?: Record<string, string>) => string} props.t - the translate function.
     * @returns {object | null} the button, or null while the trash is off.
     */
    function TrashButton({ t }) {
      const [state, setState] = React.useState(trashSnapshot)
      React.useEffect(() => subscribeTrash(() => setState(trashSnapshot())), [])
      if (state.enabled !== true) return null

      const icon = typeof IconTrash === 'function'
        ? React.createElement(IconTrash, { size: 16 })
        : React.createElement('span', { 'aria-hidden': 'true' }, '🗑')
      const count = state.entries.length
      const badge = count > 0
        ? React.createElement('span', {
          [`data-${PLUGIN_NAME}-trash-badge`]: '',
          'aria-label': t(count === 1 ? 'badgeOne' : 'badgeMany', { count: String(count) })
        }, String(count))
        : null
      const label = t('button')

      const button = React.createElement('button', {
        type: 'button',
        [`data-${PLUGIN_NAME}-trash-button`]: '',
        'aria-label': label,
        title: label,
        onClick: () => setPanelOpen(!state.open)
      }, icon, badge)

      if (typeof Tooltip === 'function') {
        return React.createElement(Tooltip, { label, side: 'top', delayMs: 500 }, button)
      }
      return button
    }

    /**
     * The display title of one trash entry.
     *
     * @param {{ title?: string, sessionId: string, cwd?: string }} entry
     * @returns {string} the session name, else the directory basename, else the id.
     */
    function trashEntryTitle(entry) {
      const title = typeof entry.title === 'string' ? entry.title.trim() : ''
      if (title !== '') return title
      const cwd = typeof entry.cwd === 'string' ? entry.cwd.replace(/[/\\]+$/, '') : ''
      const cut = Math.max(cwd.lastIndexOf('/'), cwd.lastIndexOf('\\'))
      const base = cut === -1 ? cwd : cwd.slice(cut + 1)
      return base !== '' ? base : entry.sessionId
    }

    /**
     * One session row inside the trash panel.
     *
     * The host resolves the display title from the session log, so `entry.title`
     * is the session name. The fallbacks exist only for an entry written before
     * that fold existed: a readable directory basename beats a raw session id,
     * which reads as a file name rather than a conversation.
     *
     * @param {object} props - the row's props.
     * @param {object} props.entry - one host list entry.
     * @param {(key: string, values?: Record<string, string>) => string} props.t - the translate function.
     * @returns {object} the row.
     */
    function TrashRow({ entry, t }) {
      const [busy, setBusy] = React.useState(false)
      const title = trashEntryTitle(entry)

      const run = async (action) => {
        if (busy) return
        setBusy(true)
        try {
          await callTrash(action, { sessionId: entry.sessionId })
          if (action === 'restore') hiddenSessionIds.delete(entry.sessionId)
          else hideSessions([entry.sessionId])
          hideSessions([])
          setTrash({ entries: trashState.entries.filter((item) => item.sessionId !== entry.sessionId), error: null })
          await refreshTrashList()
          await refreshSessionList()
        } catch (error) {
          setTrash({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      const onPurge = async () => {
        if (busy) return
        const confirmed = await askTrashConfirm({
          kind: 'purge',
          sessionId: entry.sessionId,
          title,
          count: 1
        })
        if (!confirmed) return
        await run('purge')
      }

      const remaining = entry.remainingDays > 0
        ? t('remaining', { days: String(entry.remainingDays) })
        : t('remainingToday')

      return React.createElement('li', { [`data-${PLUGIN_NAME}-trash-row`]: '' },
        React.createElement('div', { [`data-${PLUGIN_NAME}-trash-row-main`]: '' },
          React.createElement('span', { [`data-${PLUGIN_NAME}-trash-row-title`]: '', title }, title),
          React.createElement('span', { [`data-${PLUGIN_NAME}-trash-row-meta`]: '' }, remaining)
        ),
        React.createElement('button', {
          type: 'button',
          [`data-${PLUGIN_NAME}-trash-act`]: 'restore',
          disabled: busy,
          onClick: () => void run('restore')
        }, t('restore')),
        React.createElement('button', {
          type: 'button',
          [`data-${PLUGIN_NAME}-trash-act`]: 'purge',
          disabled: busy,
          onClick: onPurge
        }, t('purge'))
      )
    }

    /**
     * The trash panel overlay.
     *
     * @param {object} props - the slot's projected props.
     * @param {(key: string, values?: Record<string, string>) => string} props.t - the translate function.
     * @returns {object | null} the panel, or null while closed / disabled.
     */
    function TrashPanel({ t }) {
      const [state, setState] = React.useState(trashSnapshot)
      React.useEffect(() => subscribeTrash(() => {
        setState(trashSnapshot())
        setDays(String(trashSnapshot().retentionDays))
      }), [])
      const [days, setDays] = React.useState(String(trashState.retentionDays))
      const [savedFlash, setSavedFlash] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      if (state.enabled !== true || !state.open) return null

      const close = () => setPanelOpen(false)

      const saveRetention = async () => {
        setBusy(true)
        try {
          const payload = await callTrash('settings', { retentionDays: Number(days) })
          // The host clamps and reports the effective value; show that, not
          // whatever was typed.
          setDays(String(payload.retentionDays))
          setSavedFlash(true)
          setTimeout(() => setSavedFlash(false), 1500)
          await refreshTrashList()
        } catch (error) {
          setTrash({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      const emptyAll = async () => {
        if (state.entries.length === 0) return
        const confirmed = await askTrashConfirm({
          kind: 'empty',
          count: state.entries.length
        })
        if (!confirmed) return
        setBusy(true)
        try {
          const report = await callTrash('empty')
          // Empty can partially succeed. Keep failed rows, hide every attempted
          // trashed identity from the sidebar, and display the host's failures.
          const entries = trashState.entries
          hideSessions(entries.map((entry) => entry.sessionId))
          const failed = Array.isArray(report.failures) ? report.failures : Array.isArray(report.failed) ? report.failed : []
          const failedIds = new Set(failed.map((item) => item.sessionId))
          setTrash({ entries: entries.filter((entry) => failedIds.has(entry.sessionId)), error: null })
          await refreshTrashList()
          await refreshSessionList()
          if (failed.length > 0) {
            setTrash({ error: failed.map((item) => `${item.sessionId ?? ''}: ${item.error?.message ?? item.message ?? String(item.error ?? 'Delete failed')}`).join('\n') })
          } else if (typeof report.failed === 'number' && report.failed > 0) {
            setTrash({ error: `Failed: ${report.failed}` })
          }
        } catch (error) {
          setTrash({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      return React.createElement('div', {
        'data-plugin': PLUGIN_NAME,
        [`data-${PLUGIN_NAME}-overlay`]: '',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close()
        }
      },
        React.createElement('div', {
          [`data-${PLUGIN_NAME}-trash-panel`]: '',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('title')
        },
          React.createElement('h2', null, t('title')),
          state.error === null
            ? null
            : React.createElement('p', { [`data-${PLUGIN_NAME}-trash-error`]: '', role: 'alert' },
              t('failed', { message: state.error })),
          React.createElement('div', { [`data-${PLUGIN_NAME}-trash-retention`]: '' },
            React.createElement('span', null, t('retainedFor')),
            React.createElement('input', {
              type: 'number',
              min: String(RETENTION_MIN),
              max: String(RETENTION_MAX),
              step: '1',
              value: days,
              disabled: busy,
              'aria-label': t('retainedFor'),
              onChange: (event) => setDays(event.target.value)
            }),
            React.createElement('span', null, t('daysUnit')),
            React.createElement('button', {
              type: 'button',
              [`data-${PLUGIN_NAME}-trash-act`]: 'save',
              disabled: busy,
              onClick: () => void saveRetention()
            }, savedFlash ? t('saved') : t('save')),
            React.createElement('span', null, t('retentionHint'))
          ),
          state.loading && state.entries.length === 0
            ? React.createElement('p', { [`data-${PLUGIN_NAME}-trash-empty`]: '' }, t('loading'))
            : state.entries.length === 0
              ? React.createElement('p', { [`data-${PLUGIN_NAME}-trash-empty`]: '' }, t('empty'))
              : React.createElement('ul', { [`data-${PLUGIN_NAME}-trash-list`]: '' },
                state.entries.map((entry) =>
                  React.createElement(TrashRow, { key: entry.sessionId, entry, t }))),
          React.createElement('div', { [`data-${PLUGIN_NAME}-trash-foot`]: '' },
            React.createElement('button', {
              type: 'button',
              [`data-${PLUGIN_NAME}-trash-act`]: 'empty',
              disabled: busy || state.entries.length === 0,
              onClick: () => void emptyAll()
            }, t('purgeAll')),
            React.createElement('button', {
              type: 'button',
              [`data-${PLUGIN_NAME}-trash-act`]: 'refresh',
              disabled: busy,
              onClick: () => void refreshTrashList()
            }, t('refresh'))
          )
        )
      )
    }

    /**
     * The destructive-step confirmation for the trash panel.
     *
     * A `shell.overlay` entry like the delete dialog, sharing its stylesheet and
     * its button shapes, so a purge or an empty reads as the same kind of
     * decision the delete already is. It exists because `window.confirm` blocks
     * the renderer for its whole lifetime and leaves the page unable to take
     * pointer input afterwards.
     *
     * @param {object} props - the slot's projected props.
     * @param {(key: string, values?: Record<string, string>) => string} props.t - the translate function.
     * @returns {object | null} the dialog, or null when nothing awaits.
     */
    function TrashConfirmDialog({ t }) {
      const [request, setRequest] = React.useState(trashConfirmSnapshot)
      React.useEffect(() => subscribeTrashConfirm(() => setRequest(trashConfirmSnapshot())), [])

      if (request === null) return null

      const cancel = () => settleTrashConfirm(false)
      const confirm = () => settleTrashConfirm(true)
      const title = request.kind === 'empty'
        ? t('purgeAllConfirm', { count: String(request.count) })
        : t('purgeConfirm', { title: request.title ?? '' })

      return React.createElement('div', {
        'data-plugin': PLUGIN_NAME,
        [`data-${PLUGIN_NAME}-overlay`]: '',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) cancel()
        }
      },
        React.createElement('div', {
          [`data-${PLUGIN_NAME}-dialog`]: '',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-label': title
        },
          React.createElement('h2', null, request.kind === 'empty' ? t('purgeAllTitle') : t('purgeTitle')),
          React.createElement('p', null, title),
          React.createElement('div', { [`data-${PLUGIN_NAME}-actions`]: '' },
            React.createElement('button', {
              type: 'button',
              [`data-${PLUGIN_NAME}-button`]: 'cancel',
              onClick: cancel
            }, request.kind === 'empty' ? '取消' : t('cancelLabel')),
            React.createElement('button', {
              type: 'button',
              [`data-${PLUGIN_NAME}-button`]: 'confirm',
              onClick: confirm
            }, request.kind === 'empty' ? '确认清空' : t('confirmLabel'))
          )
        )
      )
    }

    /**
     * Client plugin body.
     *
     * @param {object} ctx - the client context (`slots` + `locale`).
     * @returns {void}
     */
    function apply(ctx) {
      clientCtx = ctx
      ctx.effect(attachSessionFilter, `${PLUGIN_NAME}: deleted session list filter`)
      attachLocale(ctx)
      ctx.effect(attachStyles, `${PLUGIN_NAME}: stylesheet`)

      const t = ctx.locale.bind(LOCALE_NS)
      const tt = ctx.locale.bind(TRASH_NS)

      ctx.effect(() => ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
        name: MENU_SLOT,
        id: `${PLUGIN_NAME}.delete-session`,
        order: MENU_ORDER,
        locale: LOCALE_NS,
        inject: () => ({ requestDelete })
      }, DeleteSessionRow)), `${PLUGIN_NAME}: session menu row`)

      ctx.effect(() => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: `${PLUGIN_NAME}.confirm`,
        order: OVERLAY_ORDER,
        inject: () => ({
          setPending: (next) => {
            if (next === null) closeDialog()
            else requestDelete(next)
          },
          t
        })
      }, ConfirmDialog)), `${PLUGIN_NAME}: confirmation overlay`)

      ctx.effect(() => ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
        name: FOOTER_SLOT,
        id: `${PLUGIN_NAME}.trash-button`,
        order: FOOTER_ORDER,
        locale: TRASH_NS
      }, () => React.createElement(TrashButton, { t: tt }))), `${PLUGIN_NAME}: trash footer button`)

      ctx.effect(() => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: `${PLUGIN_NAME}.trash-panel`,
        order: PANEL_ORDER,
        locale: TRASH_NS
      }, () => React.createElement(TrashPanel, { t: tt }))), `${PLUGIN_NAME}: trash panel overlay`)

      // The destructive-step confirmation for the trash panel. It renders ABOVE
      // the panel (a higher order), so an empty or a purge is confirmed over the
      // list it is about to remove.
      ctx.effect(() => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: `${PLUGIN_NAME}.trash-confirm`,
        order: CONFIRM_OVERLAY_ORDER,
        locale: TRASH_NS
      }, () => React.createElement(TrashConfirmDialog, { t: tt }))), `${PLUGIN_NAME}: trash confirm overlay`)

      // Trash probe: once on mount, and again whenever the window regains
      // focus — so toggling the sub-plugin in the plugin settings shows up
      // when the user clicks back into the app, without a page reload.
      ctx.effect(() => {
        void probeTrash()
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
          return () => {}
        }
        const onFocus = () => void probeTrash()
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, `${PLUGIN_NAME}: trash probe`)
    }

    /** Only the actual list owner is needed; archive preferences stay untouched. */
    const inject = ['slots', 'locale', 'sessions']

    /** The stores and calls, exported for the self-check. */
    const store = {
      subscribe,
      current,
      requestDelete,
      closeDialog,
      subscribeTrash,
      trashSnapshot,
      setTrash,
      setPanelOpen,
      probeTrash,
      refreshTrashList,
      refreshSessionList,
      callTrash,
      callDelete,
      subscribeTrashConfirm,
      trashConfirmSnapshot,
      askTrashConfirm,
      settleTrashConfirm
    }

    exports.apply = apply
    exports.inject = inject
    exports.store = store
    return module.exports
  }
})
