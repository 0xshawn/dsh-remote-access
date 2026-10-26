import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import {
  apply,
  Config,
  inject,
  loopbackIndexRow,
  name,
  pinLaunchToken,
  resolveLaunchToken,
} from '../lib/index.js'

/** Minimal Cordis context: one event emitter plus a `get` service lookup. */
function fakeContext(connection) {
  const listeners = new Map()
  return {
    get: (service) => (service === 'connection' ? connection : undefined),
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
    },
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}

function fakeConnection() {
  return { browserAuth: { launchToken: 'random-process-token' } }
}

test('plugin metadata follows the Cordis plugin shape', () => {
  assert.equal(name, 'dsh-remote-access')
  assert.deepEqual(inject, ['connection'])
})

test('Config defaults keep the patch behaviour', () => {
  assert.deepEqual(Config({}), { loopback: true, launchToken: '' })
  assert.deepEqual(Config({ loopback: false, launchToken: 'fixed' }), {
    loopback: false,
    launchToken: 'fixed',
  })
  assert.throws(() => Config({ loopback: 'yes' }), /expected boolean/u)
})

test('resolveLaunchToken prefers config, then DSH_WEB_TOKEN, then the random token', () => {
  assert.equal(resolveLaunchToken({ launchToken: 'from-config' }, { DSH_WEB_TOKEN: 'from-env' }), 'from-config')
  assert.equal(resolveLaunchToken({ launchToken: '' }, { DSH_WEB_TOKEN: 'from-env' }), 'from-env')
  assert.equal(resolveLaunchToken({ launchToken: '' }, {}), '')
  assert.equal(resolveLaunchToken(undefined, undefined), '')
})

test('loopbackIndexRow uses the client transport hook with a guard', () => {
  const row = loopbackIndexRow()
  assert.equal(row.kind, 'script')
  assert.equal(row.placement, 'head')
  assert.match(row.text, /__DSH_TRANSPORT__ === void 0/u)
  assert.match(row.text, /ownsHost: true/u)
})

test('apply injects one loopback row into the served index', () => {
  const ctx = fakeContext(fakeConnection())
  apply(ctx, { loopback: true, launchToken: '' })
  assert.equal(ctx.listenerCount('webserver/index-inject'), 1)
  const table = []
  ctx.emit('webserver/index-inject', table, { principal: { kind: 'owner' } })
  assert.deepEqual(table, [loopbackIndexRow()])
})

test('apply with loopback=false leaves the page authority alone', () => {
  const ctx = fakeContext(fakeConnection())
  apply(ctx, { loopback: false, launchToken: '' })
  assert.equal(ctx.listenerCount('webserver/index-inject'), 0)
})

test('apply does not touch the launch token when none is configured', () => {
  const connection = fakeConnection()
  apply(fakeContext(connection), { loopback: false, launchToken: '' })
  assert.equal(connection.browserAuth.launchToken, 'random-process-token')
})

test('apply pins the configured launch token', () => {
  const connection = fakeConnection()
  apply(fakeContext(connection), { loopback: false, launchToken: 'pinned-token' })
  assert.equal(connection.browserAuth.launchToken, 'pinned-token')
})

test('apply falls back to DSH_WEB_TOKEN', () => {
  const previous = process.env.DSH_WEB_TOKEN
  process.env.DSH_WEB_TOKEN = 'env-token'
  try {
    const connection = fakeConnection()
    apply(fakeContext(connection), { loopback: false, launchToken: '' })
    assert.equal(connection.browserAuth.launchToken, 'env-token')
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_TOKEN
    else process.env.DSH_WEB_TOKEN = previous
  }
})

test('pinLaunchToken fails loudly on an unsupported dsh version', () => {
  assert.throws(() => pinLaunchToken(undefined, 'token'), /does not expose the Connection launch token/u)
  assert.throws(() => pinLaunchToken({}, 'token'), /does not expose the Connection launch token/u)
  assert.throws(
    () => pinLaunchToken({ browserAuth: { launchToken: 42 } }, 'token'),
    /does not expose the Connection launch token/u,
  )
})

test('pinLaunchToken surfaces a read-only token field', () => {
  const connection = {
    browserAuth: Object.freeze({ launchToken: 'random-process-token' }),
  }
  assert.throws(() => pinLaunchToken(connection, 'token'), /read-only in this dsh version/u)
})

test('bundle patch declares deployment authorities for the /api fence', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: connection/u)
  assert.match(patch, /DSH_REMOTE_ACCESS_TRUSTED_HOSTS/u)
  assert.match(patch, /ctx\.get\('webStartup'\)/u)
  assert.match(patch, /ctx\.get\('webRuntime'\)/u)
  assert.match(patch, /name: dsh-remote-access/u)
})

/** Read the `trustedHosts` expression from the shipped bundle patch. */
async function patchTrustedHostsExpression() {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const match = /trustedHosts: !!js "(?<expression>.+)"/u.exec(patch)
  assert.ok(match?.groups?.expression, 'trustedHosts expression missing from cordis.patch.yml')
  return match.groups.expression
}

/** Evaluate the patch expression the loader would evaluate. */
function evaluatePatch(expression, services, env) {
  const ctx = { get: (name) => services[name] }
  return new Function('ctx', 'process', `return (${expression})`)(ctx, { env })
}

test('bundle patch keeps 0.2.0 bind-derived LAN authorities when both services exist', async () => {
  const expression = await patchTrustedHostsExpression()
  const startup = { trustedHosts: ['cli.example.test'] }
  const runtime = { trustedHosts: ['192.168.1.202', 'cli.example.test'] }

  // dsh 0.2.0 provides webStartup AND webRuntime; webRuntime carries the LAN
  // literals the wildcard bind derived and already includes the CLI extras.
  assert.deepEqual(evaluatePatch(expression, { webStartup: startup, webRuntime: runtime }, {}), [
    '192.168.1.202',
    'cli.example.test',
  ])
})

test('bundle patch keeps 0.2.1 invocation authorities', async () => {
  const expression = await patchTrustedHostsExpression()
  const startup = { trustedHosts: ['cli.example.test'] }
  assert.deepEqual(evaluatePatch(expression, { webStartup: startup }, {}), ['cli.example.test'])
})

test('bundle patch appends trimmed environment authorities and ignores empties', async () => {
  const expression = await patchTrustedHostsExpression()
  assert.deepEqual(
    evaluatePatch(expression, {}, {
      DSH_REMOTE_ACCESS_TRUSTED_HOSTS: ' env.example.test , env2.example.test:8443 , ',
    }),
    ['env.example.test', 'env2.example.test:8443'],
  )
  assert.deepEqual(evaluatePatch(expression, {}, { DSH_REMOTE_ACCESS_TRUSTED_HOSTS: '' }), [])
})
