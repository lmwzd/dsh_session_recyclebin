/**
 * Type mirrors for the two halves of dsh_session_recyclebin.
 *
 * These are documentation shapes, not compile-time imports: the plugin ships
 * plain JavaScript and resolves every host service through the restricted
 * Cordis context, so the shapes below describe what it reads and nothing more.
 */

/**
 * The host services the host half reads.
 *
 * @typedef {object} HostServices
 * @property {{ get(id: string): { cancel?: (cause: object, options: object) => void } | undefined } | undefined} agents - the live Agent registry.
 * @property {{ root?: string, stat?(id: string): Promise<{ header?: { cwd?: string, title?: string } } | undefined> } | undefined} persistence - the JSONL persistence backend.
 * @property {{ readTitle?(sessionId: string, signal?: AbortSignal): Promise<{ title: string, eventSeq: number, updatedAt: number } | undefined> } | undefined} query - the log-backed title fold; a title is a log event, never a header field.
 */

/**
 * The host plugin context.
 *
 * @typedef {object} HostContext
 * @property {{ register(route: object): () => void }} webServer - the HTTP carrier service.
 * @property {(name: string) => unknown} get - the restricted service reader.
 * @property {{ warn?(message: string): void }} logger - the tagged logger.
 * @property {(effect: () => (() => void) | void, label?: string) => void} effect - a scoped side effect.
 */

/**
 * The client plugin context.
 *
 * @typedef {object} ClientContext
 * @property {{ register(ns: string, locale: string, dict: Record<string, string>): () => void, bind(ns: string): (key: string, values?: Record<string, string>) => string }} locale - the dictionary registry.
 * @property {{ inject(key: string, callback: () => () => void): () => void, register(options: object, component: unknown): () => void }} slots - the slot system.
 * @property {(effect: () => (() => void) | void, label?: string) => void} effect - a scoped side effect.
 */

export {}
