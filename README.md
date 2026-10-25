# ClashTUNWithDSH

English | [中文](README_CN.md)

A DSH (DeepSeek Harness) **bundle plugin** that removes the `resolves to a non-public IP address` restriction so DSH works with Clash TUN.

## License

This project is released under [GNU AGPL-3.0-or-later](./LICENSE): you are free to use, modify, and redistribute it; any redistribution (including offering it as a network service) must open-source the code under the same license. See the `LICENSE` file at the repository root.

## What is this

The built-in `web_fetch` tool in DSH carries an SSRF guard: before fetching, it resolves the hostname to IP addresses, and if any resolved address is a **non-public IP** (loopback, private, reserved ranges, etc.), it rejects the request outright:

```
URL hostname "example.com" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

Under **Clash TUN (fake-ip mode)**, however, system DNS is taken over by Clash: every domain resolves to a **fake-ip reserved-range address** such as `198.18.0.0/15` (or `fdfe:dcba:9876::/48`), and the real connection is intercepted by the TUN virtual adapter and handed to Clash for proxying per its rules. This is completely transparent to ordinary apps, yet it lands exactly on DSH's "non-public IP" tripwire — with Clash TUN enabled, nearly every `web_fetch` request is rejected.

This plugin removes that restriction: **any resolved IP is allowed**. The connection is still initiated directly and the TUN adapter takes it over unchanged, so DSH works normally under Clash TUN.

## Install as a DSH plugin

This repository **is** a DSH bundle package: `package.json` declares `dsh.bundle.patch`, and [`cordis.patch.yml`](./cordis.patch.yml) inserts the host plugin row. Any of the three DSH install paths below pulls it straight from this repository or the npm registry — no manual file copying, no patch-file editing.

### The package

| Item | Value |
| --- | --- |
| Package name | `clash-tun-with-dsh` |
| Bundle patch | `cordis.patch.yml` → row `clash-tun-web-fetch-unlock` |
| Host entry | [`index.js`](./index.js) (ESM, zero dependencies) |
| Display metadata | `locale/en.json`, `locale/zh.json`, `icon.svg` |
| Plugin row id | `clash-tun-web-fetch-unlock` |

`engines.dsh` is `>=0.2.0 <1.0.0`; DSH refuses to install or activate the bundle on an incompatible runtime unless you grant an explicit version exemption.

### 1. Web UI (Plugins page) — recommended

Add this repository's market index as a Discover source, then install the plugin from the Discover tab:

```text
https://raw.githubusercontent.com/ffdnm/ClashTUNWithDSH/main/market.json
```

Or skip the index and paste the package spec straight into the Plugins page install field (DSH forwards it to `plugin_manager`):

```text
git+https://github.com/ffdnm/ClashTUNWithDSH.git
```

The bundle installs, joins `dsh.profile.bundles`, and its row mounts. With HMR enabled it takes effect immediately; otherwise it applies on the next DSH start.

### 2. Agent tool `plugin_manager`

In a session with the Creator preset (or any session where `plugin_manager` is enabled):

```jsonc
// install_bundle
{ "action": "install_bundle", "target": "git+https://github.com/ffdnm/ClashTUNWithDSH.git" }
```

```jsonc
// afterwards: list what is installed
{ "action": "list_bundles" }
```

Restart-required results mean the profile runs without HMR; restart DSH to activate.

### 3. CLI

```bash
# Git (pin a commit or tag for reproducibility with #<ref>)
dsh plugin --profile web add git+https://github.com/ffdnm/ClashTUNWithDSH.git

# after publishing to npm
dsh plugin --profile web add clash-tun-with-dsh
```

`dedicated <profile>` selects the profile to change (`desktop` for the Electron app, `web` for `dsh --profile web`). Installed bundles are appended to `dsh.profile.bundles`, so their patch layer is composed on every start.

### Uninstall

Use **Plugins → Remove** in the Web UI, `plugin_manager` with `{ "action": "remove_bundle", "target": "clash-tun-with-dsh" }`, or:

```bash
dsh plugin --profile web remove clash-tun-with-dsh
```

The patch and the original resolver are removed with the plugin; restart DSH (or let HMR recompose) to get the stock behavior back.

### 4. Market index (repository-maintained)

`market.json` is a plugin-market index (format 1) listing this package with its Git source pinned to a commit, so a Discover source only needs the raw file URL above. It is generated from the repository, not hand-written — run the script after the commit that introduces a change, so the pinned commit already contains the plugin files:

```bash
node scripts/make-market-index.mjs           # rewrites market.json for the current HEAD
node scripts/make-market-index.mjs --check   # validate only
```

The script reads `origin`, requires the pinned commit to already contain the plugin files, and validates the document with `@deepseek-ai/dsh-plugin-market-index` when that package is resolvable (otherwise it runs the same structural checks locally). `market.json` is therefore committed *after* the commit that ships the plugin code; until it is generated and pushed, use the direct Git spec instead of the Discover source. The generated install spec looks like:

```text
git+https://github.com/ffdnm/ClashTUNWithDSH.git#<40-hex-commit>
```

### Configuration (optional)

All fields are optional and commented out in [`cordis.patch.yml`](./cordis.patch.yml); uncomment the ones you need:

| Field | Default | Meaning |
| --- | --- | --- |
| `providerId` | `http` | Fetch provider id to patch. The shipped local HTTP provider registers as `http`. |
| `cacheTtlMs` | `60000` | Lifetime of an allowed answer set; `0` disables caching. |
| `cacheMaxEntries` | `400` | Cached hostnames before the cache is cleared wholesale. |

## How it works

DSH's fetch pipeline is: the `web_fetch` tool → `ctx.web` (the WebRuntime service) → the local HTTP fetch provider (`web-fetch-http`, id `http`). The IP check only happens inside the provider instance's `resolveAddresses` method (after DNS resolution, it verifies every answer is public unicast).

The plugin **swaps that method in place** at runtime:

1. **Zero change for public destinations**: the original resolver runs first; when every resolved address is public, behavior is identical to stock (including NAT64 checks, address pinning, redirects, size/timeout caps).
2. **Only the "non-public" block is lifted**: if and only if the original logic throws `WEB_BLOCKED_URL` with a message containing `non-public`, the plugin re-resolves through the **system resolver** (`dns.lookup(..., { all: true, order: 'verbatim' })` — the fake-ip answer under Clash TUN), **allows every returned address**, and hands the set to the stock address-pinned transport. The TUN adapter intercepts the connection and Clash proxies it as usual.
3. IP literals (e.g. `127.0.0.1`, `[::1]`) are allowed as well; answers are cached for 60 seconds per process by default.
4. **Late registration is covered**: the plugin also wraps `web.registerFetchProvider`, so a provider mounted after it — or a provider row that hot-reloads — is patched the moment it registers.
5. **The original method is restored when the plugin stops or updates**; a reference count keeps overlapping mounts safe.

No DSH source modification, no deployment config change, no second provider registration (so provider selection is untouched); the patch follows the plugin lifecycle exactly.

Every allowed non-public destination is logged as `[clash-tun-web] allowed non-public destination: <host> -> <ip,...>` through the Cordis logger, so it shows up in the DSH log stream.

## Verify

Run each request once before and once after installing (the DSH Web GUI listens on `127.0.0.1:3080` by default):

| Request | Before | After |
| --- | --- | --- |
| `web_fetch http://127.0.0.1:3080/` | `URL hostname "127.0.0.1" resolves to a non-public IP address` | HTTP 401 (the GUI auth response — the connection actually happened) |
| `web_fetch http://localhost:3080/` | blocked the same way | HTTP 401 |
| `web_fetch https://example.com/` | HTTP 200 | HTTP 200 (public path, no regression) |

The repository also ships a dependency-free test suite and integration harness:

```bash
node --test          # unit tests over index.js with a fake Cordis context
```

## Notes

- **This check is an SSRF guard.** Once lifted, `web_fetch` can reach local and intranet addresses. Use it only on personal devices and trusted networks such as Clash TUN, and never let untrusted model instructions steer fetches toward sensitive internal services.
- **Only the IP-resolution check is lifted**: the URL scheme whitelist, credential rejection, redirect limits, byte/char/timeout caps, address pinning, and every other transport-hygiene policy remain in force.
- The plugin mounts on the host plane, so it applies to every session of the profile; other profiles need the bundle selected as well.
- Under DSH's Windows desktop app, `--profile desktop` owns that profile; install through the in-app Plugins page instead of the CLI.

## Repository contents

| File | Purpose |
| --- | --- |
| `package.json` | Bundle manifest: `dsh.bundle.patch`, `engines.dsh`, display resources |
| `cordis.patch.yml` | Bundle patch layer that inserts the `clash-tun-web-fetch-unlock` row |
| `index.js` | The host plugin (ESM, zero dependencies) |
| `locale/en.json`, `locale/zh.json` | Plugin Manager / Settings title and description |
| `icon.svg` | Plugin icon |
| `test/index.test.js` | Dependency-free unit tests (`node --test`) |
| `test/integration.test.js` | Real-runtime tests over `dsh-web`/`dsh-web-fetch-http`, skipped when those packages are not resolvable |
| `scripts/make-market-index.mjs` | Regenerates `market.json` (plugin market index, format 1) |
| `market.json` | Generated plugin market index for the Discover tab (committed at release time) |
| `README.md` | This document (English) |
| `README_CN.md` | Chinese documentation |
| `LICENSE` | GNU AGPL-3.0 license text |
