/**
 * Minimal React stand-in for the client self-check.
 *
 * The real React lives in the Web bundle's frozen module table and is not
 * importable from Node here, so this file supplies exactly the surface the
 * client half uses: createElement, useState, useEffect. Elements are plain
 * tagged objects, and a tiny renderer walks them into static markup — enough
 * to assert the row's role/label and the dialog's affordances without pulling
 * a 100 MB bundle apart.
 */

/** One element: a type, its props, and its children. */
class Element {
  constructor(type, props, children) {
    this.type = type
    this.props = props ?? {}
    this.children = children
  }
}

/**
 * createElement(type, props, ...children)
 *
 * Mirrors React's signature closely enough for the client half: `key` and
 * `ref` are dropped from props, children are flattened.
 */
export function createElement(type, props, ...children) {
  const rest = {}
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'key' || key === 'ref') continue
    rest[key] = value
  }
  return new Element(type, rest, children.flat())
}

/** Per-component hook state, keyed by the component function. */
const hookStatesRef = { value: new WeakMap() }

/**
 * useState(initial) — returns [value, setValue] for the current render.
 *
 * Mirrors React's lazy-initializer contract: a function `initial` is called
 * once, on the first render only, and its result becomes the state value.
 */
export function useState(initial) {
  const component = currentComponent
  let state = hookStatesRef.value.get(component)
  if (state === undefined) {
    state = { values: [], index: 0 }
    hookStatesRef.value.set(component, state)
  }
  const i = state.index
  if (!(i in state.values)) {
    state.values[i] = typeof initial === 'function' ? initial() : initial
  }
  state.index += 1
  const value = state.values[i]
  const setValue = (next) => {
    const resolved = typeof next === 'function' ? next(state.values[i]) : next
    state.values[i] = resolved
  }
  return [value, setValue]
}

/** useEffect(effect, deps) — records the effect for the test to run. */
const pendingEffects = []
export function useEffect(effect, deps) {
  pendingEffects.push({ component: currentComponent, effect, deps })
}

/**
 * Run the effects recorded during the last render pass, once per component.
 *
 * The real React runs effects after commit; this stub runs them when the test
 * says so, which is enough to exercise a subscription installed in an effect.
 *
 * @returns {Array<() => void>} the teardown functions the effects returned.
 */
export function runEffects() {
  const teardowns = []
  for (const entry of pendingEffects) {
    const teardown = entry.effect()
    if (typeof teardown === 'function') teardowns.push(teardown)
  }
  pendingEffects.length = 0
  return teardowns
}

/** The component currently being rendered. */
let currentComponent = null

/** Effects recorded during the last render pass. */
export const effects = pendingEffects

/** Reset the hook state so a fresh render starts clean. */
export function resetHooks() {
  hookStatesRef.value = new WeakMap()
  pendingEffects.length = 0
}
const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'input'])

/**
 * Render one element tree to static markup.
 *
 * @param {Element | string | null} node - the root to render.
 * @returns {string} the HTML string.
 */
export function renderToStaticMarkup(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string') return escapeHtml(node)
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderToStaticMarkup).join('')
  if (!(node instanceof Element)) return ''

  const previous = currentComponent
  if (typeof node.type === 'function') {
    currentComponent = node.type
    const state = hookStatesRef.value.get(node.type)
    if (state !== undefined) state.index = 0
    const produced = node.type({ ...node.props, children: node.children })
    currentComponent = previous
    return renderToStaticMarkup(produced)
  }
  currentComponent = previous

  const tag = node.type
  const attrs = []
  for (const [key, value] of Object.entries(node.props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'children' || key === 'dangerouslySetInnerHTML') continue
    if (key === 'className') {
      attrs.push(` class="${escapeAttr(String(value))}"`)
      continue
    }
    if (key.startsWith('on') && typeof value === 'function') continue
    if (value === true) {
      attrs.push(` ${key}=""`)
      continue
    }
    attrs.push(` ${key}="${escapeAttr(String(value))}"`)
  }
  const open = `<${tag}${attrs.join('')}>`
  if (VOID_ELEMENTS.has(tag)) return open
  const inner = node.children.map(renderToStaticMarkup).join('')
  return `${open}${inner}</${tag}>`
}

/** Escape text content for HTML. */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Escape an attribute value for HTML. */
function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;')
}
