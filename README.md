# dsh-remote-access

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](./package.json)

Serve the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) Web UI through a **non-localhost authority** — a reverse proxy, SSH tunnel, or LAN address — without patching the installed dsh.

[中文文档](./README.zh-CN.md)

## What this fixes

Stock `dsh web` is built for a browser on the same machine. Three things break when the browser reaches it through any other authority:

| Problem | Stock dsh | This plugin |
|---|---|---|
| `/api` Host/Origin fence | accepts loopback, the listener's bind literal, and `--trusted-host` only; every RPC answers `403` for a proxy authority | appends `DSH_REMOTE_ACCESS_TRUSTED_HOSTS` authorities to the same list (`--trusted-host` keeps working) |
| Page view (`connection.isLoopback`) | derived from `location.hostname`; a proxied page is treated as non-loopback, so on dsh 0.2.0 settings stay in process-local memory (`settings are unavailable in this browser` on the Models page) and on every version the host-document action is hidden | injects `__DSH_TRANSPORT__ = { ownsHost: true }`, the host-owned transport hook dsh already uses for its desktop shell, so authenticated pages report the loopback view |
| Launch token | random per process; the only way to find the login URL after a restart is the service log | pins `DSH_WEB_TOKEN` (or plugin config) across restarts |

Authentication is unchanged: the browser still has to exchange the launch token for the signed, authority-bound session cookie, and the Host/Origin fence still runs before every `/api` request. This plugin removes deployment friction; it does not bypass access control.

## Install

```sh
# from GitHub (public repository, no build step)
dsh plugin --profile web add git+https://github.com/0xshawn/dsh-remote-access.git

# from a local checkout
dsh plugin --profile web add /path/to/dsh-remote-access
```

Restart `dsh web` afterwards — dsh loads bundles at boot. Verify the row is active:

```sh
dsh --profile web --dump-config | grep -A6 'dsh-remote-access'
```

Remove with `dsh plugin --profile web remove dsh-remote-access`; the stock behaviour returns on the next restart.

## Configure

### Environment

| Variable | Value | Effect |
|---|---|---|
| `DSH_REMOTE_ACCESS_TRUSTED_HOSTS` | comma-separated bare authorities, e.g. `dsh.example.com,dsh.example.com:8443` | appended to `--trusted-host`; a port-less entry matches any port |
| `DSH_WEB_TOKEN` | non-empty launch token | pins the login token; empty/unset keeps the random per-process token |

Both work in systemd `Environment=`/`EnvironmentFile=`, launchd `EnvironmentVariables`, Docker env, or a shell profile. Keep `--trusted-host` if you prefer flags; the patch concatenates, it does not replace:

```sh
DSH_WEB_TOKEN="$(cat /etc/dsh/web-token)" \
DSH_REMOTE_ACCESS_TRUSTED_HOSTS="dsh.example.com" \
dsh web --host 127.0.0.1 --port 3080 --no-open
```

### Plugin config

Override the `dsh-remote-access` row in the profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`) for per-profile values:

```yaml
- id: dsh-remote-access
  config:
    # false keeps the stock per-authority page view.
    loopback: true
    # Fixed token; empty falls back to DSH_WEB_TOKEN, then the random token.
    # Prefer DSH_WEB_TOKEN: profile configuration is plain text.
    launchToken: ''
```

### Behind a reverse proxy

`--public-url https://dsh.example.com/` advertises the address browsers use (printed URL, `DSH_WEB_URL`, runtime context); this plugin does not change that. The proxy must still:

- preserve the browser-facing `Host` header (the fence compares it verbatim);
- strip any mount prefix before forwarding to the listener;
- forward WebSocket upgrades with `Upgrade`/`Connection` intact;
- rewrite cookie `Path` to the mount, and add `Secure` on the HTTPS leg.

See upstream [Publish the Web UI behind a reverse proxy](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/public-deployments.md) for the full checklist. TLS termination, network isolation, and who may reach the port remain the operator's job.

## How it works

The package is a dsh **bundle**: `cordis.patch.yml` is a patch layer over `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`, and two seams are used.

1. **Trusted hosts — patch layer.** The `connection` row's `trustedHosts` gets the environment list concatenated onto the invocation list. The expression reads `ctx.get('webStartup')` (dsh 0.2.1) or `ctx.get('webRuntime')` (dsh 0.2.0), so one patch covers both layouts. The Host/Origin fence and the `allowsRemoteAuthorities` classification are then upstream's own.
2. **Loopback view — index injection.** The host plugin listens to `webserver/index-inject` and adds one inline classic script to the served index:

   ```js
   if (globalThis.__DSH_TRANSPORT__ === void 0) globalThis.__DSH_TRANSPORT__ = { ownsHost: true };
   ```

   `ClientTransportHooks.ownsHost` is upstream's documented flag for "this page owns the Host"; `dsh-client-connection` reports the loopback view without changing the page's HTTP + WebSocket carrier. The guard leaves any real shell-provided transport untouched, and the script runs before the shell entry and every client plugin.
3. **Launch token — service field.** The plugin waits for `ctx.connection` and sets `connection.browserAuth.launchToken` before the loader settles, so both the printed authenticated URL and token validation use the pinned value. If a future dsh version hides that field, the plugin fails loudly instead of silently printing a random URL.

## Security

- **The launch token is the credential.** Anyone holding the printed `?token=` URL can obtain a session cookie and full owner access. Share it deliberately; rotate by changing `DSH_WEB_TOKEN` and restarting. A pinned token is long-lived — never commit it.
- **Trusted hosts are not authentication.** They only admit the authority to the Host/Origin fence; the signed session cookie still gates every RPC. Never expose the listener port to an untrusted network without TLS and a proxy you control.
- **Loopback parity is a privilege decision.** On dsh 0.2.0 it makes settings host-backed for authenticated remote browsers; on every version it exposes local-only UI affordances such as **Open configuration file**, which opens the settings document in the *host's* editor. Remote browsers already hold owner credentials, but operators who want the stock least-privilege view can set `loopback: false`.
- **Plain HTTP leaks the token.** Terminate TLS at the proxy or with `--tls-cert/--tls-key`; the upstream guide covers cookie `Secure` behaviour.

## Compatibility

- Tested against dsh `0.2.1-rc.2` and `0.2.0-rc.2` (Web profile).
- Declared range: `engines.dsh >=0.2.0-0 <0.3.0`. dsh 0.1.x has no compatible bundle/transport seams.
- The plugin row is Web-profile only; headless/SDK profiles have no `connection` service and reject the row.
- `npm install -g @deepseek-ai/dsh@<version>` replaces the dsh install but not the profile: the plugin keeps working after a dsh upgrade. Restart `dsh web` to load a new dsh version.
- The token seam reads `connection.browserAuth.launchToken`. If dsh changes that shape, the plugin throws at boot when a token is configured; unset the token or update the plugin.

## Development

```sh
npm install
npm test        # node:test unit tests for config, token resolution, index injection
```

End-to-end check on an isolated home (no effect on your real profile):

```sh
export DSH_HOME=$(mktemp -d)
dsh plugin --profile web add "$PWD"
DSH_WEB_TOKEN=dev-token DSH_REMOTE_ACCESS_TRUSTED_HOSTS=dsh.test \
  dsh --profile web --host 127.0.0.1 --port 3199 --no-open
# then open http://<non-localhost>:3199/?token=dev-token through your proxy
```

## License

[MIT](./LICENSE) © 2026 shawn
