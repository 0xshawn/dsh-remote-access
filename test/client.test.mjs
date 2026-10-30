import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const CLIENT_URL = new URL('../lib/client.js', import.meta.url)

/** Load the hand-written client bundle through a fake module loader. */
async function loadClientBundle() {
  const source = await readFile(CLIENT_URL, 'utf8')
  let exports
  const window = {
    __ModuleLoader__: {
      load(registration) {
        assert.equal(registration.id, 'dsh-remote-access')
        exports = registration.factory((name) => {
          throw new Error(`unexpected require(${name})`)
        })
      },
    },
  }
  new Function('window', source)(window)
  return exports
}

class FakeNotification {
  static permission = 'granted'
  static requests = 0
  static sent = []

  constructor(title, options) {
    this.title = title
    this.options = options
    this.closed = false
    FakeNotification.sent.push(this)
  }

  close() {
    this.closed = true
    this.onclose?.()
  }

  static requestPermission() {
    FakeNotification.requests += 1
    return Promise.resolve(FakeNotification.permission)
  }

  static reset(permission = 'granted') {
    FakeNotification.permission = permission
    FakeNotification.requests = 0
    FakeNotification.sent = []
  }
}

function installBrowser(overrides = {}) {
  const previous = {
    Notification: globalThis.Notification,
    document: globalThis.document,
    config: globalThis.__DSH_REMOTE_ACCESS_NOTIFY__,
  }
  const listeners = new Map()
  const document = {
    visibilityState: overrides.visibilityState ?? 'hidden',
    hasFocus: () => overrides.focused ?? false,
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
  }
  globalThis.Notification = FakeNotification
  globalThis.document = document
  delete globalThis.__DSH_REMOTE_ACCESS_NOTIFY__
  if (overrides.config !== undefined) globalThis.__DSH_REMOTE_ACCESS_NOTIFY__ = overrides.config
  return {
    document,
    listeners,
    restore() {
      globalThis.Notification = previous.Notification
      globalThis.document = previous.document
      if (previous.config === undefined) delete globalThis.__DSH_REMOTE_ACCESS_NOTIFY__
      else globalThis.__DSH_REMOTE_ACCESS_NOTIFY__ = previous.config
    },
  }
}

function fakeContext(sessions = {}) {
  const listeners = []
  let snapshot = new Map()
  const source = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
  }
  const remoteHandlers = new Map()
  return {
    ctx: {
      uiSession: { sessionStatus: source },
      sessions: {
        list: {
          getSnapshot: () => ({ byId: sessions }),
        },
      },
      remote: {
        $on(key, listener) {
          remoteHandlers.set(key, listener)
          return () => {
            remoteHandlers.delete(key)
          }
        },
      },
      effect(callback) {
        const disposer = callback()
        this.disposers.push(disposer)
      },
      disposers: [],
    },
    push(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    listeners,
    remoteHandlers,
  }
}

function row(title, extra = {}) {
  return { title, ...extra }
}

function sessionContext(rows, subagentIds = []) {
  return {
    sessions: {
      list: {
        getSnapshot: () => ({ byId: rows }),
      },
      subagentAddress: (sessionId) => (subagentIds.includes(sessionId) ? { kind: 'subagent', sessionId } : undefined),
    },
  }
}

test('client bundle exports the Cordis plugin shape', async () => {
  const client = await loadClientBundle()
  assert.equal(client.name, 'dsh-remote-access-notifications')
  assert.deepEqual(client.inject, ['remote', 'sessions', 'uiSession'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(typeof client.__test.handleStatusChange, 'function')
})

test('notifications can be disabled by the host-injected config', async () => {
  const client = await loadClientBundle()
  const browser = installBrowser({ config: { enabled: false } })
  try {
    assert.equal(client.__test.enabled(), false)
  } finally {
    browser.restore()
  }
})

test('a finished non-subagent session emits one completion notification', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Fix the deploy') }
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task finished: Fix the deploy/u)
  assert.match(sent[0].tag, /s1:complete/u)
})

test('an agent error replaces the completion notification and keeps the detail', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Broken model') }
  const errors = new Map()
  client.__test.recordAgentError(errors, 's1', 'DeepSeek request failed: 401 Unauthorized', 1000)
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message), errors, 1000)
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task failed: Broken model/u)
  assert.match(sent[0].body, /401 Unauthorized/u)
  assert.match(sent[0].tag, /s1:error/u)
  assert.equal(errors.size, 0)
})

test('a stale agent error falls back to a completion notification', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Old failure') }
  const errors = new Map()
  client.__test.recordAgentError(errors, 's1', 'old failure', 1000)
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message), errors, 30000)
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task finished: Old failure/u)
  assert.equal(errors.size, 0)
})

test('the main session does not notify completion or failure', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Current task', { retainedBy: { mainView: 1 } }) }
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  const errors = new Map()
  client.__test.recordAgentError(errors, 's1', 'boom', 1000)
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message), errors, 1000)
  assert.deepEqual(sent, [])
})

test('a subagent absent from the session list is still skipped', async () => {
  const client = await loadClientBundle()
  const sent = []
  const previous = new Map([['child', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['child', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(
    previous,
    next,
    sessionContext({}, ['child']),
    (message) => sent.push(message),
  )
  assert.deepEqual(sent, [])
})

test('listed subagent and removed sessions are skipped', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = {
    child: row('Child', { parentSessionId: 's1' }),
    gone: row('Gone', { removed: true }),
  }
  const previous = new Map()
  const next = new Map([
    ['child', { running: false, pendingInteraction: undefined }],
    ['gone', { running: false, pendingInteraction: undefined }],
  ])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.deepEqual(sent, [])
})

test('a new pending question emits an input notification', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Review plan') }
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', {
    running: true,
    pendingInteraction: { key: 'question-1', kind: 'question', sessionId: 's1' },
  }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Input needed: Review plan/u)
  assert.equal(sent[0].requireInteraction, true)
})

test('an approval notification names the tool and is not repeated for the same request', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Ship it') }
  const pending = { key: 'approval-1', kind: 'approval', toolName: 'bash', sessionId: 's1' }
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: true, pendingInteraction: pending }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.match(sent[0].title, /Approval needed: Ship it/u)
  assert.match(sent[0].body, /bash/u)

  const repeated = []
  client.__test.handleStatusChange(next, next, sessionContext(sessions), (message) => repeated.push(message))
  assert.deepEqual(repeated, [])
})

test('a session that finishes after answering does notify completion', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Demo') }
  const pending = new Map([['s1', {
    running: true,
    pendingInteraction: { key: 'q', kind: 'question', sessionId: 's1' },
  }]])
  const done = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(pending, done, sessionContext(sessions), (message) => sent.push(message))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task finished: Demo/u)
})

test('nothing is announced while the page is visible and focused', async () => {
  const client = await loadClientBundle()
  const browser = installBrowser({ visibilityState: 'visible', focused: true })
  try {
    assert.equal(client.__test.announce({ title: 'Hidden', body: 'Body' }), undefined)
    assert.equal(FakeNotification.sent.length, 0)
  } finally {
    browser.restore()
  }
})

test('announce respects the browser permission', async () => {
  const client = await loadClientBundle()
  FakeNotification.reset('denied')
  const browser = installBrowser()
  try {
    assert.equal(client.__test.announce({ title: 'Blocked', body: 'Body' }), undefined)
    FakeNotification.reset('granted')
    const notification = client.__test.announce({ title: 'Shown', body: 'Body' })
    assert.equal(notification.title, 'Shown')
    assert.equal(FakeNotification.sent.length, 1)
  } finally {
    browser.restore()
  }
})

test('apply subscribes to sessionStatus and notifies after the idle settle delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = await loadClientBundle()
  FakeNotification.reset('granted')
  const browser = installBrowser()
  try {
    const fixture = fakeContext({ s1: row('Background task') })
    client.apply(fixture.ctx)
    fixture.push(new Map([['s1', { running: true, pendingInteraction: undefined }]]))
    fixture.push(new Map([['s1', { running: false, pendingInteraction: undefined }]]))
    assert.equal(FakeNotification.sent.length, 0)
    t.mock.timers.tick(client.__test.SETTLE_MS)
    assert.equal(FakeNotification.sent.length, 1)
    assert.match(FakeNotification.sent[0].title, /Task finished: Background task/u)
    assert.equal(fixture.ctx.disposers.length, 2)
    fixture.ctx.disposers.forEach((dispose) => dispose?.())
  } finally {
    browser.restore()
  }
})

test('permission is requested once on the first gesture', async () => {
  const client = await loadClientBundle()
  FakeNotification.reset('default')
  const browser = installBrowser()
  try {
    client.__test.armPermissionRequest(FakeNotification)
    assert.equal(typeof browser.listeners.get('pointerdown'), 'function')
    browser.listeners.get('pointerdown')()
    browser.listeners.get('keydown')?.()
    assert.equal(FakeNotification.requests, 1)
  } finally {
    browser.restore()
  }
})

test('apply forwards api-session/error into a failure notification', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = await loadClientBundle()
  FakeNotification.reset('granted')
  const browser = installBrowser()
  try {
    const fixture = fakeContext({ s1: row('Broken task') })
    client.apply(fixture.ctx)
    const onError = fixture.remoteHandlers.get('api-session/error')
    assert.equal(typeof onError, 'function')
    fixture.push(new Map([['s1', { running: true, pendingInteraction: undefined }]]))
    onError('s1', 'connection reset by peer')
    fixture.push(new Map([['s1', { running: false, pendingInteraction: undefined }]]))
    t.mock.timers.tick(client.__test.SETTLE_MS)
    assert.equal(FakeNotification.sent.length, 1)
    assert.match(FakeNotification.sent[0].title, /Task failed: Broken task/u)
    assert.match(FakeNotification.sent[0].options.body, /connection reset by peer/u)
    fixture.ctx.disposers.forEach((dispose) => dispose?.())
  } finally {
    browser.restore()
  }
})

test('a quick retry cancels the pending notification', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = await loadClientBundle()
  FakeNotification.reset('granted')
  const browser = installBrowser()
  try {
    const fixture = fakeContext({ s1: row('Retrying task') })
    client.apply(fixture.ctx)
    fixture.push(new Map([['s1', { running: true, pendingInteraction: undefined }]]))
    fixture.push(new Map([['s1', { running: false, pendingInteraction: undefined }]]))
    fixture.push(new Map([['s1', { running: true, pendingInteraction: undefined }]]))
    t.mock.timers.tick(client.__test.SETTLE_MS)
    assert.equal(FakeNotification.sent.length, 0)
    fixture.ctx.disposers.forEach((dispose) => dispose?.())
  } finally {
    browser.restore()
  }
})

test('apply is a no-op when the browser has no Notification API', async () => {
  const client = await loadClientBundle()
  const previous = globalThis.Notification
  delete globalThis.Notification
  try {
    const fixture = fakeContext()
    client.apply(fixture.ctx)
    assert.equal(fixture.ctx.disposers.length, 0)
  } finally {
    globalThis.Notification = previous
  }
})
