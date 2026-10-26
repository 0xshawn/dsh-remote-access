# Changelog

## 0.1.0 — 2026-10-26

Initial release.

- Bundle patch appends `DSH_REMOTE_ACCESS_TRUSTED_HOSTS` authorities to the
  `/api` Host/Origin fence, keeping the invocation's `--trusted-host` values.
  One expression covers the dsh 0.2.0 `webRuntime` and 0.2.1 `webStartup`
  service layouts; `webRuntime` is preferred so a 0.2.0 wildcard bind keeps its
  bind-derived LAN authorities.
- Host plugin injects the host-owned transport hook into the served index so an
  authenticated non-loopback page reports the loopback view (`loopback`,
  default on).
- Host plugin pins the launch token from plugin config or `DSH_WEB_TOKEN`, so
  the authenticated URL survives restarts.
- Unit tests for config defaults, token resolution, index injection, and patch
  shape. Verified end to end on dsh 0.2.1-rc.2, 0.2.1-rc.3, and 0.2.0-rc.2.
