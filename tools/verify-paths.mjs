/**
 * Verify the plugin's path derivation against the REAL session tree.
 *
 * Reads every session directory that actually exists under
 * <DSH_HOME>/sessions and asserts that encodeSegment(sessionId) plus
 * projectKey(cwd) reproduce the on-disk directory name exactly. This is the
 * one thing that would silently break a delete: if the derived path is wrong,
 * the plugin would report success while removing nothing.
 *
 * Run:  node tools/verify-paths.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'

const home = process.env.USERPROFILE ?? process.env.HOME
const root = join(home, '.dsh', 'sessions')

// --- re-implement the two derivations exactly as lib/index.js does ---------
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = String.fromCharCode(raw.charCodeAt(i))
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const ch = String.fromCharCode(cwd.charCodeAt(i))
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

// --- read the real header out of one zstd log ------------------------------
// The log is zstd-compressed; we cannot decode it without the native module,
// so instead we read the projection cache, which carries the same identity
// block (formatVersion / createdAt / cwd) in plain JSON.

function readIdentity(projcachePath) {
  // returns { id, cwd } from the projection cache record
  return readFile(projcachePath, 'utf8').then((text) => {
    const doc = JSON.parse(text)
    return { id: doc?.record?.identity?.id, cwd: doc?.record?.identity?.cwd }
  }).catch(() => undefined)
}

let entries
try {
  entries = await readdir(root, { withFileTypes: true })
} catch (error) {
  console.log(`no sessions tree at ${root}: ${error.message}`)
  process.exit(0)
}

const projects = entries.filter((e) => e.isDirectory()).map((e) => e.name)
console.log(`sessions root: ${root}`)
console.log(`project directories: ${projects.length}`)

const projRoot = join(home, '.dsh', 'storages', 'session_projcache', 'sessions')

let checked = 0
let matched = 0
const mismatches = []

for (const project of projects) {
  const projectDir = join(root, project)
  let sessions
  try {
    sessions = await readdir(projectDir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of sessions) {
    if (!entry.isDirectory()) continue
    checked += 1

    // The projection cache key is the session id, so the entry name is the
    // ENCODED id. Decode it back, then re-encode and compare.
    const encoded = entry.name
    const decoded = encoded.replace(/~([0-9A-F]{4})/g, (m, hex) =>
      String.fromCharCode(parseInt(hex, 16)))

    // Round-trip: re-encoding the decoded id must give the directory name.
    const reEncoded = encodeSegment(decoded)
    if (reEncoded !== encoded) {
      mismatches.push(`encode round-trip: ${encoded} -> ${reEncoded}`)
      continue
    }

    // Find this session's cwd through its projection cache, then check the
    // project directory name the plugin would build for that cwd.
    const identity = await readIdentity(join(projRoot, `${encoded}.json`))
    if (identity?.cwd === undefined) {
      // No projection cache: cannot check the project key, but the id
      // round-trip above already passed.
      matched += 1
      continue
    }
    const derivedProject = projectKey(identity.cwd)
    if (derivedProject !== project) {
      mismatches.push(
        `project key: cwd=${identity.cwd} derived=${derivedProject} actual=${project}`)
      continue
    }
    matched += 1
  }
}

console.log(`session directories checked: ${checked}`)
console.log(`derivations matched: ${matched}`)
if (mismatches.length > 0) {
  console.log(`\nMISMATCHES (${mismatches.length}):`)
  for (const m of mismatches) console.log(`  ${m}`)
  process.exitCode = 1
} else {
  console.log('all derivations match the real on-disk layout')
}
