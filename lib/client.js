window.__ModuleLoader__.load({
  id: 'dsh-remote-access',
  factory: (require) => {
    var module = { exports: {} };

    /** Stable client plugin name. */
    const name = 'dsh-remote-access-notifications'
    /** Session list supplies titles; uiSession supplies the live status facts. */
    const inject = ['remote', 'sessions', 'uiSession']
    /** Host-injected feature switch. */
    const CONFIG_GLOBAL = '__DSH_REMOTE_ACCESS_NOTIFY__'
    /** Notifications kept alive until the browser closes them. */
    const live = new Set()
    /** How long a Host agent error is paired with the following idle transition. */
    const ERROR_WINDOW_MS = 15000
    /** Wait for an idle session to stay idle before notifying; retries/continuations resume. */
    const SETTLE_MS = 3000

    /** Whether the deployment enabled the client half. */
    function enabled() {
      const config = globalThis[CONFIG_GLOBAL]
      return !(config !== null && typeof config === 'object' && config.enabled === false)
    }

    /** The browser Notification constructor, when the context exposes it. */
    function notificationApi() {
      return typeof globalThis.Notification === 'function' ? globalThis.Notification : undefined
    }

    /** Ask for notification permission on the first user gesture. */
    function armPermissionRequest(api) {
      if (api === undefined || api.permission !== 'default') return
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
      let asked = false
      const ask = () => {
        if (asked) return
        asked = true
        try {
          const result = api.requestPermission()
          if (result !== undefined && typeof result.catch === 'function') result.catch(() => {})
        } catch {
          /* the browser may reject the request outside a user gesture */
        }
      }
      document.addEventListener('pointerdown', ask, { capture: true, once: true })
      document.addEventListener('keydown', ask, { capture: true, once: true })
    }

    /** Only notify while the tab is hidden or the window lost focus. */
    function pageNeedsAttention() {
      if (typeof document === 'undefined') return false
      if (document.visibilityState !== undefined && document.visibilityState !== 'visible') return true
      if (typeof document.hasFocus === 'function') return !document.hasFocus()
      return false
    }

    function localized() {
      const language = globalThis.navigator === undefined ? '' : String(globalThis.navigator.language ?? '')
      return language.toLowerCase().startsWith('zh')
    }

    /** Resolve a notification label, or undefined for subagent/removed sessions. */
    function sessionLabel(sessions, sessionId) {
      let row
      try {
        // A subagent may be absent from the main list, so the catalog address is
        // the reliable filter; the row check below covers older service layouts.
        if (sessions?.subagentAddress?.(sessionId) !== undefined) return undefined
        row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
      } catch {
        row = undefined
      }
      if (row !== undefined && row !== null) {
        if (row.removed === true) return undefined
        if (row.parentSessionId !== undefined && row.parentSessionId !== null) return undefined
      }
      if (row !== undefined && row !== null) {
        if (typeof row.title === 'string' && row.title.trim() !== '') return row.title.trim()
        if (typeof row.cwd === 'string' && row.cwd.trim() !== '') {
          const base = row.cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop()
          if (base !== undefined && base !== '') return base
        }
      }
      return localized() ? '会话' : 'Session'
    }

    function completionMessage(label) {
      return localized()
        ? { title: `任务完成：${label}`, body: 'Agent 现在空闲，可以查看结果。' }
        : { title: `Task finished: ${label}`, body: 'The agent is idle again.' }
    }

    /** A failure notification, with the Host error's first line as detail. */
    function failureMessage(label, detail) {
      const text = detail === undefined || detail === null ? '' : String(detail).trim().split('\n')[0].slice(0, 180)
      if (localized()) {
        return {
          title: `任务失败：${label}`,
          body: text === '' ? 'Agent 因错误停止。' : text,
        }
      }
      return {
        title: `Task failed: ${label}`,
        body: text === '' ? 'The agent stopped with an error.' : text,
      }
    }

    /** Remember one Host agent error until the matching idle transition arrives. */
    function recordAgentError(errors, sessionId, message, now = Date.now()) {
      errors.set(sessionId, { message: String(message ?? ''), at: now })
    }

    /** Whether the page currently shows this session as its main view. */
    function isMainSession(sessions, sessionId) {
      try {
        const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
        return (row?.retainedBy?.mainView ?? 0) > 0
      } catch {
        return false
      }
    }

    /** Consume a recent agent error; stale records are dropped. */
    function recentAgentError(errors, sessionId, now = Date.now()) {
      const record = errors?.get(sessionId)
      if (record === undefined) return undefined
      if (!(now - record.at <= ERROR_WINDOW_MS)) {
        errors.delete(sessionId)
        return undefined
      }
      return record
    }

    function pendingMessage(label, pending) {
      const kind = pending === null || typeof pending !== 'object' ? undefined : pending.kind
      const toolName =
        pending !== null && typeof pending === 'object' && typeof pending.toolName === 'string'
          ? pending.toolName
          : undefined
      if (localized()) {
        if (kind === 'approval') {
          return {
            title: `需要批准：${label}`,
            body: toolName === undefined ? '有工具调用等待你的批准。' : `工具 ${toolName} 等待你的批准。`,
          }
        }
        if (kind === 'plan-review') {
          return { title: `需要确认计划：${label}`, body: '计划等待你的确认。' }
        }
        return { title: `需要你的输入：${label}`, body: 'Agent 正在等待你的回答。' }
      }
      if (kind === 'approval') {
        return {
          title: `Approval needed: ${label}`,
          body: toolName === undefined ? 'A tool call is waiting for approval.' : `Tool ${toolName} is waiting for approval.`,
        }
      }
      if (kind === 'plan-review') {
        return { title: `Plan review needed: ${label}`, body: 'A plan is waiting for your confirmation.' }
      }
      return { title: `Input needed: ${label}`, body: 'The agent is waiting for your answer.' }
    }

    /** Show one browser notification. */
    function announce(message) {
      const api = notificationApi()
      if (api === undefined || api.permission !== 'granted') return undefined
      if (!enabled() || !pageNeedsAttention()) return undefined
      try {
        const notification = new api(message.title, {
          body: message.body,
          tag: message.tag,
          requireInteraction: message.requireInteraction === true,
        })
        live.add(notification)
        const release = () => {
          live.delete(notification)
        }
        notification.onclose = release
        notification.onerror = release
        notification.onclick = () => {
          try {
            globalThis.focus?.()
          } catch {
            /* focus can be denied; the click still closes the notification */
          }
          try {
            notification.close()
          } catch {
            release()
          }
        }
        return notification
      } catch {
        return undefined
      }
    }

    /** Turn one status snapshot change into at most one notification per session. */
    function handleStatusChange(previous, next, ctx, emit = announce, errors, now = Date.now()) {
      if (!enabled() || next === undefined || next === null) return
      next.forEach((status, sessionId) => {
        const before = previous === undefined ? undefined : previous.get(sessionId)
        const label = sessionLabel(ctx?.sessions, sessionId)
        if (label === undefined) return
        const pending = status === undefined ? undefined : status.pendingInteraction
        if (pending !== undefined) {
          const beforeKey = before?.pendingInteraction?.key
          if (beforeKey === pending?.key) return
          emit({
            ...pendingMessage(label, pending),
            tag: `dsh-remote-access:${sessionId}:pending`,
            requireInteraction: true,
            immediate: true,
          }, sessionId)
          return
        }
        if (before?.running === true && status?.running === false) {
          // The main view is the session the user is already looking at; a
          // completion or failure there is visible without an OS notification.
          if (isMainSession(ctx?.sessions, sessionId)) return
          const failure = recentAgentError(errors, sessionId, now)
          if (failure !== undefined) {
            errors.delete(sessionId)
            emit({
              ...failureMessage(label, failure.message),
              tag: `dsh-remote-access:${sessionId}:error`,
              requireInteraction: true,
            }, sessionId)
            return
          }
          emit({
            ...completionMessage(label),
            tag: `dsh-remote-access:${sessionId}:complete`,
          }, sessionId)
        }
      })
    }

    /**
     * Subscribe to the unified Session status source and notify while the page
     * is in the background. Requires the `sessions` and `uiSession` services.
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      if (!enabled()) return
      const api = notificationApi()
      if (api === undefined) return
      armPermissionRequest(api)
      const source = ctx.uiSession?.sessionStatus
      if (source === undefined || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') return
      const errors = new Map()
      if (ctx.remote?.$on !== undefined) {
        ctx.effect(
          () =>
            ctx.remote.$on('api-session/error', (sessionId, message) => {
              recordAgentError(errors, sessionId, message)
            }),
          'dsh-remote-access: agent errors',
        )
      }
      let previous = source.getSnapshot()
      const timers = new Map()
      const cancel = (sessionId) => {
        const timer = timers.get(sessionId)
        if (timer === undefined) return
        clearTimeout(timer)
        timers.delete(sessionId)
      }
      const publish = (message, sessionId) => {
        if (message.immediate === true) {
          cancel(sessionId)
          announce(message)
          return
        }
        cancel(sessionId)
        timers.set(
          sessionId,
          setTimeout(() => {
            timers.delete(sessionId)
            const current = source.getSnapshot().get(sessionId)
            // A retry, queued continuation, or new pending input resumed the
            // session; only a settled idle session deserves a notification.
            if (current === undefined || current.running !== false || current.pendingInteraction !== undefined) return
            announce(message)
          }, SETTLE_MS),
        )
      }
      ctx.effect(() => {
        const dispose = source.subscribe(() => {
          const next = source.getSnapshot()
          next.forEach((status, sessionId) => {
            if (status?.running === true || status?.pendingInteraction !== undefined) cancel(sessionId)
          })
          handleStatusChange(previous, next, ctx, publish, errors)
          previous = next
        })
        return () => {
          dispose()
          for (const timer of timers.values()) clearTimeout(timer)
          timers.clear()
        }
      }, 'dsh-remote-access: settled browser notifications')
    }

    module.exports = {
      apply,
      inject,
      name,
      __test: {
        announce,
        armPermissionRequest,
        completionMessage,
        enabled,
        failureMessage,
        handleStatusChange,
        isMainSession,
        recordAgentError,
        recentAgentError,
        SETTLE_MS,
        pageNeedsAttention,
        pendingMessage,
        sessionLabel,
      },
    }
    return module.exports
  },
})
