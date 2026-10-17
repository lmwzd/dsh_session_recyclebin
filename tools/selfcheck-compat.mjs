import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'

// Version resilience is the contract here: the plugin must run on any DSH new
// enough to ship the two registration contracts it binds, and must not pin a
// kernel release, so a DSH upgrade never forces a plugin release.
const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const index = await readFile(new URL('lib/index.js', root), 'utf8')
const trash = await readFile(new URL('lib/trash.js', root), 'utf8')
const client = await readFile(new URL('lib/client.js', root), 'utf8')

assert.equal(manifest.version, '0.2.2')
assert.ok(/^>=0\.2\.0$/.test(manifest.engines.dsh), `engines.dsh must stay an open range, got ${manifest.engines.dsh}`)
assert.equal(Object.keys(manifest.peerDependencies).length, 1,
  'only the framework peer may be declared; every kernel package is read at runtime')
assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '~4.0.5')
assert.equal(manifest.dsh.client.inject, undefined,
  'client activation must not pin package versions or names')

// Host halves: no hard service dependency; late binding plus runtime reads.
assert.match(index, /export const inject = \[\]/)
assert.match(index, /ctx\.inject\(\['webServer'\], boot\)/)
assert.match(index, /typeof ctx\.inject !== 'function'/)
assert.match(index, /function boot\(ctx\)/)
assert.match(trash, /export const inject = \[\]/)
assert.match(trash, /ctx\.inject\(\['webServer', 'sessionPersistence', 'workspaceRegistry'\], boot\)/)
assert.match(trash, /typeof ctx\.inject !== 'function'/)
assert.match(trash, /function boot\(ctx\)/)

// Client half: only slots and locale are hard, sessions is bound late.
assert.match(client, /const inject = \['slots', 'locale'\]/)
assert.match(client, /ctx\.inject\(\['sessions'\]/)
assert.match(client, /async function retrySessions\(\)/)

// No kernel package name may appear as a required module anywhere in lib.
for (const [name, source] of [['index', index], ['trash', trash], ['client', client]]) {
  assert.doesNotMatch(source, /from '@deepseek-ai\/dsh-[a-z-]+'/, `${name} must not import a kernel package directly`)
  assert.doesNotMatch(source, /require\('@deepseek-ai\/dsh-(?!client-ui-primitives)[a-z-]+'\)/, `${name} may only soft-require ui-primitives`)
}

for (const entry of ['.', './client', './trash']) {
  await access(new URL(manifest.exports[entry].default, root))
}
const require = createRequire(import.meta.url)
assert.ok(/lib[\\/]index\.js$/.test(require.resolve('dsh_session_recyclebin')))
console.log('PASS: version-resilient manifest (open dsh range, no kernel peers), late-bound services, exports intact')
