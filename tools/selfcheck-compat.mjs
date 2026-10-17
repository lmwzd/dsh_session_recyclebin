import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
assert.equal(manifest.version, '0.2.1')
assert.equal(manifest.engines.dsh, '0.2.1-rc.1')
assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '~4.0.5')
assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-slots'], undefined,
  'slots is bundled into ui-renderer, not an installed runtime package')
for (const name of ['dsh-client-locale', 'dsh-client-ui-renderer', 'dsh-api-session-controller']) {
  const id = `@deepseek-ai/${name}`
  assert.equal(manifest.peerDependencies[id], '0.2.1-rc.1')
  assert.ok(manifest.dsh.client.inject.includes(id), `client load order requires ${id}`)
}
for (const name of ['dsh-session-persistence', 'dsh-session-query', 'dsh-workspace', 'dsh-host-webserver']) {
  assert.equal(manifest.peerDependencies[`@deepseek-ai/${name}`], '0.2.1-rc.1')
}
for (const entry of ['.', './client', './trash']) {
  await access(new URL(manifest.exports[entry].default, root))
}
const require = createRequire(import.meta.url)
assert.ok(require.resolve('dsh_session_recyclebin').endsWith('lib\\index.js') || require.resolve('dsh_session_recyclebin').endsWith('lib/index.js'))
console.log('PASS: DSH 0.2.1-rc.1 manifest, runtime peers, client activation order and package exports')
