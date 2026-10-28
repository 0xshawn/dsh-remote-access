window.__ModuleLoader__.load({
  id: 'dsh-remote-access',
  factory: (require) => {
    var module = { exports: {} };

    /** Stable client plugin name. */
    const name = 'dsh-remote-access-notifications'
    /** Session list supplies titles; uiSession supplies the live status facts. */
    const inject = ['sessions', 'uiSession']
    /** Host-injected feature switch. */
    const CONFIG_GLOBAL = '__DSH_REMOTE_ACCESS_NOTIFY__'
    /** Notifications kept alive until the browser closes them. */
    const live = new Set()

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
    function handleStatusChange(previous, next, ctx, emit = announce) {
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
          })
          return
        }
        if (before?.running === true && status?.running === false) {
          emit({
            ...completionMessage(label),
            tag: `dsh-remote-access:${sessionId}:complete`,
          })
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
      let previous = source.getSnapshot()
      ctx.effect(
        () =>
          source.subscribe(() => {
            const next = source.getSnapshot()
            handleStatusChange(previous, next, ctx)
            previous = next
          }),
        'dsh-remote-access: browser notifications',
      )
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
        handleStatusChange,
        pageNeedsAttention,
        pendingMessage,
        sessionLabel,
      },
    }
    return module.exports
  },
})
