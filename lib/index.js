/**
 * dsh-remote-access — host half of a dsh web bundle that serves the GUI through
 * a non-localhost authority (reverse proxy, SSH tunnel, or LAN address).
 *
 * Upstream `dsh web` is built for a browser on the same machine:
 *
 *  - the `/api` Host/Origin fence trusts loopback, the listener's bind address,
 *    and every `--trusted-host` authority — never the address a proxy exposes;
 *  - the browser derives `connection.isLoopback` from `location.hostname`
 *    alone, so a page opened through a proxy keeps the non-loopback view (on
 *    dsh 0.2.0 that means process-local settings and the model page reports
 *    "settings are unavailable in this browser"; on 0.2.1 it hides the
 *    host-document action);
 *  - every dsh process mints a random launch token, so the authenticated URL
 *    in the service log changes on every restart.
 *
 * The bundle patch declares the fence authorities. This module closes the
 * other two gaps without patching the installed dsh:
 *
 *  - it injects `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` into the
 *    served index. That global is the client transport hook upstream itself
 *    sets for a shell that owns its Host (the desktop carrier); the served page
 *    then reports the loopback view while `dsh-client-connection` still uses
 *    its normal HTTP + WebSocket carrier;
 *  - it pins the launch token from plugin config or `DSH_WEB_TOKEN`.
 *
 * Neither change weakens authentication: the launch token still has to be
 * exchanged for the signed, authority-bound session cookie, and the Host /
 * Origin fence still runs before admission.
 */
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'dsh-remote-access'

/** The Connection service owns the launch token this plugin pins. */
export const inject = ['connection']

export const Config = z.object({
  /**
   * Inject the host-owned transport hook so every authenticated page reports
   * the loopback view. Set false to keep the stock per-authority view.
   */
  loopback: z.boolean().default(true).description(
    'Present every authenticated page as the loopback view (host-backed settings on dsh 0.2.0 and the host-document action on 0.2.1).',
  ),
  /**
   * Fixed launch token. Empty falls back to `DSH_WEB_TOKEN`, then to the
   * stock per-process random token. Prefer the environment variable: plugin
   * configuration is stored in plain text in the profile.
   */
  launchToken: z.string().default('').description(
    'Fixed launch token; empty falls back to DSH_WEB_TOKEN, then to a random per-process token.',
  ),
})

/**
 * Inline classic script rendered at the top of `<head>`, before the deferred
 * shell entry and every client plugin. `ownsHost` is the documented
 * `ClientTransportHooks` flag for "this page owns the Host"; the served page
 * otherwise has no `__DSH_TRANSPORT__` global, so the guard leaves any real
 * shell-provided transport untouched.
 */
const LOOPBACK_SCRIPT =
  'if (globalThis.__DSH_TRANSPORT__ === void 0) globalThis.__DSH_TRANSPORT__ = { ownsHost: true };'

/**
 * Resolve the launch token to pin.
 * @param config - validated plugin config.
 * @param env - environment bag, normally `process.env`.
 * @returns the configured token, the DSH_WEB_TOKEN value, or '' for "keep the
 * random per-process token".
 */
export function resolveLaunchToken(config, env) {
  const configured = config?.launchToken ?? ''
  if (configured !== '') return configured
  return env?.DSH_WEB_TOKEN ?? ''
}

/**
 * Build the index injection row that flips the page to the loopback view.
 * @returns a `webserver/index-inject` script row.
 */
export function loopbackIndexRow() {
  return { kind: 'script', placement: 'head', text: LOOPBACK_SCRIPT }
}

/**
 * Pin the launch token on the live Connection service. The token is a plain
 * field of the browser-auth owner; mutating it before the loader settles makes
 * both the printed authenticated URL and token validation use it.
 *
 * The pin is startup-only: upstream caches the token it minted per process, so
 * a Connection-only reload rebuilds the service from that cached value and the
 * startup URL is not reprinted. Restart `dsh web` instead of relying on
 * host-plugin HMR after changing the token.
 * @param connection - `ctx.connection` from the Host Connection service.
 * @param token - non-empty launch token.
 */
export function pinLaunchToken(connection, token) {
  const auth = connection?.browserAuth
  if (auth === null || typeof auth !== 'object' || typeof auth.launchToken !== 'string') {
    throw new Error(
      'dsh-remote-access: this dsh version does not expose the Connection launch token; unset launchToken/DSH_WEB_TOKEN or update the plugin',
    )
  }
  try {
    auth.launchToken = token
  } catch (error) {
    throw new Error('dsh-remote-access: the Connection launch token is read-only in this dsh version', {
      cause: error,
    })
  }
}

/**
 * Mount the plugin contributions.
 * @param ctx - Host Cordis context carrying the Connection service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  const launchToken = resolveLaunchToken(config, process.env)
  if (config?.loopback ?? true) {
    ctx.on('webserver/index-inject', (table) => {
      table.push(loopbackIndexRow())
    })
  }
  if (launchToken !== '') {
    pinLaunchToken(ctx.get('connection'), launchToken)
  }
}
