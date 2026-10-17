/**
 * Host half of dsh_session_recyclebin — main entry.
 *
 * DSH ships no "delete session" affordance in the Web UI: the sidebar's "..."
 * menu offers pin / rename / fork / archive, and archive only hides a session
 * from the default list. This plugin adds a real delete, and its optional
 * Session Trash sub-plugin turns that delete into a restorable move.
 *
 * The deletion logic itself lives in `lib/shared.js`, which the trash reuses,
 * so there is exactly one implementation of "remove a session from the world".
 * The live registry path there (archive-stop → detach → unarchive → unpin,
 * each a durable `domain/changed` write pushed to every client) is what makes
 * the sidebar row disappear WITHOUT a restart.
 *
 * Delete flow, one POST:
 *
 *  1. When the optional Session Trash sub-plugin is ENABLED, it provides the
 *     `sessionDeleteTrash` service at composition time, and this route hands
 *     the session to it: the row vanishes, the files park intact, and the
 *     trash panel owns restore / purge from then on. The probe is per request
 *     (`ctx.get` answers `undefined` for an absent service), so toggling the
 *     sub-plugin in the Plugins page takes effect on the next delete without
 *     remounting this entry — which is why the service is deliberately NOT
 *     declared in `inject` below: a hard dependency would fail the main
 *     plugin's boot every time the trash is off.
 *  2. Without the trash — disabled or absent — this route purges directly:
 *     un-list through the registry, then remove the durable artifacts.
 */

import {
  PLUGIN_NAME,
  deleteSession,
  readJsonBody,
  writeJson,
  writeError
} from './shared.js'

/** HTTP prefix this plugin's routes live under. */
const API_PREFIX = '/session-delete/api'

/** HTTP sub-path of the delete route under {@link API_PREFIX}. */
const DELETE_METHOD = 'delete'

/**
 * Service name the Session Trash sub-plugin provides while it is enabled.
 * Both halves agree on this exact string.
 */
export const TRASH_SERVICE = 'sessionDeleteTrash'

/**
 * Host plugin body: mount the delete route.
 *
 * The route is deliberately narrow: POST only, one JSON body field, and no
 * listing surface. The client half is the only caller in this composition.
 *
 * Version resilience: only the HTTP carrier is a real prerequisite, and it is
 * bound late through Cordis' deferred `inject` when available (immediately
 * otherwise). The persistence and workspace services are read per request, so a
 * renamed, replaced, or later-mounted kernel package degrades one delete rather
 * than the plugin's boot.
 *
 * @param {import('./context-types').HostContext} ctx - the host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  if (typeof ctx.inject !== 'function') {
    boot(ctx)
    return
  }
  ctx.inject(['webServer'], boot)
}

/**
 * Mount the delete route on the activated context.
 *
 * @param {import('./context-types').HostContext} ctx - the activated context.
 * @returns {void}
 */
function boot(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${API_PREFIX}/`)
        ? pathname.slice(API_PREFIX.length + 1)
        : undefined

      if (method !== DELETE_METHOD) {
        writeError(res, 404, 'not-found', 'unknown session-delete API method')
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-error', 'method not allowed')
        return
      }

      try {
        const payload = await readJsonBody(req)
        const sessionId = payload?.sessionId
        if (typeof sessionId !== 'string' || sessionId.trim() === '') {
          throw new Error('sessionId is required')
        }

        // Trash handoff probe, per request: an enabled trash owns the outcome
        // of a delete; a disabled or absent one leaves this route purging.
        const trash = ctx.get(TRASH_SERVICE)
        if (trash !== undefined && typeof trash.moveToTrash === 'function') {
          const entry = await trash.moveToTrash(sessionId)
          writeJson(res, 200, { ok: true, trashed: true, sessionId, entry })
          return
        }

        const result = await deleteSession({
          services: {
            persistence: ctx.get('sessionPersistence'),
            registry: ctx.get('workspaceRegistry')
          },
          sessionId,
          logger: ctx.logger
        })
        writeJson(res, 200, { ...result, trashed: false })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`${PLUGIN_NAME}: delete failed: ${message}`)
        writeError(res, 400, 'delete-failed', message)
      }
    }
  }), `${PLUGIN_NAME}: ${API_PREFIX} routes`)
}

/**
 * Version resilience: the HTTP carrier is the one real prerequisite and is
 * deferred through {@link apply}; `sessionPersistence` / `workspaceRegistry`
 * are read through `ctx.get` per request, and `sessionDeleteTrash` is provided
 * by the optional sub-plugin (deliberately not declared — see the file header).
 */
export const inject = []
