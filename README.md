# ClashTUNWithDSH

English | [中文](README_CN.md)

A DSH (DeepSeek Harness) plugin that **removes the `resolves to a non-public IP address` restriction so DSH works with Clash TUN**.

## License

This project is released under [GNU AGPL-3.0-or-later](./LICENSE): you are free to use, modify, and redistribute it; any redistribution (including offering it as a network service) must open-source the code under the same license. See the `LICENSE` file at the repository root.

## What is this

The built-in `web_fetch` tool in DSH carries an SSRF guard: before fetching, it resolves the hostname to IP addresses, and if any resolved address is a **non-public IP** (loopback, private, reserved ranges, etc.), it rejects the request outright:

```
URL hostname "example.com" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

Under **Clash TUN (fake-ip mode)**, however, system DNS is taken over by Clash: every domain resolves to a **fake-ip reserved-range address** such as `198.18.0.0/15` (or `fdfe:dcba:9876::/48`), and the real connection is intercepted by the TUN virtual adapter and handed to Clash for proxying per its rules. This is completely transparent to ordinary apps, yet it lands exactly on DSH's "non-public IP" tripwire — with Clash TUN enabled, nearly every `web_fetch` request is rejected.

This plugin removes that restriction: **any resolved IP is allowed**. The connection is still initiated directly and the TUN adapter takes it over unchanged, so DSH works normally under Clash TUN.

## How it works

DSH's fetch pipeline is: the `web_fetch` tool → `ctx.web` (the WebRuntime service) → the local HTTP fetch provider (`web-fetch-http`, id `http`). The IP check only happens inside the provider instance's `resolveAddresses` method (after DNS resolution, it verifies every answer is public unicast).

This plugin (a Cordis dynamic plugin, host side) **swaps that method in place** at runtime:

1. **Zero change for public destinations**: the original resolver runs first; when every resolved address is public, behavior is identical to stock (including NAT64 checks, address pinning, redirects, size/timeout caps).
2. **Only the "non-public" block is lifted**: if and only if the original logic throws `WEB_BLOCKED_URL` with a message containing `non-public`, the plugin spawns a one-shot Node child process through DSH's `subprocess` service and re-resolves via `dns.lookup(..., { all: true, order: 'verbatim' })` through the **system resolver** (which, under Clash TUN, returns the fake-ip), **allows every returned address**, and hands the address set to the stock address-pinned transport — the TUN adapter intercepts the connection and Clash proxies it as usual.
3. IP literals (e.g. `127.0.0.1`, `[::1]`) are allowed as well; resolved answers are cached for 60 seconds per process to avoid spawning a child process repeatedly.
4. **The original method is restored when the plugin stops or updates** — no residual side effects.

No DSH source modification, no deployment config change, no second provider registration (so provider selection is untouched); the patch follows the plugin lifecycle exactly.

## One-click install

The repository ships `install.ps1` (Windows PowerShell) and `install.sh` (macOS/Linux/Git Bash). One command installs everything:

```powershell
# Windows (PowerShell 5.1+)
.\install.ps1              # install
.\install.ps1 -Uninstall   # uninstall
```

```bash
# macOS / Linux / Git Bash
./install.sh               # install
./install.sh uninstall     # uninstall
```

**What gets installed** (into `$DSH_HOME`, i.e. `$env:DSH_HOME` or `~/.dsh`):

| File | Purpose |
| --- | --- |
| `clash-tun-web-fetch-unlock.cjs` | Host-plane plugin module (a copy of the file in `payload/`) |
| `cordis.patch.yml` | DSH's official home-directory user patch layer; the script idempotently appends a marked block (`# >>> classtunwithdsh`) with one `insert` row that mounts the plugin into the host composition |

**Highlights**:

- **Applies to every session of every profile** (mounted on the host plane) — no preset or DSH source edits;
- If the current profile has live patch reloading, it **takes effect immediately on save, no DSH restart needed**; otherwise it applies on the next DSH start;
- Idempotent: safe to run repeatedly; uninstall removes exactly the marked block and nothing else;
- The scripts include an uninstall path that restores DSH's original behavior at any time.

## Usage (in-session dynamic plugin, optional)

Besides the one-click install, you can alternatively define a dynamic plugin in a session: use the function body of [`clash-tun-web-fetch-unlock.host.js`](./clash-tun-web-fetch-unlock.host.js) as `cordis_define`'s `code.host` (`idPrefix: "clash"`), then activate it with `cordis_run` — same effect, but it only lives in the current DSH process and must be re-loaded after a restart. Either way works; enabling both at once is safe (the patch carries ref-counting and restore protection).

## Verification

Run each request once before and once after installing (the DSH Web GUI listens on `127.0.0.1:3080` by default):

| Request | Before | After |
| --- | --- | --- |
| `web_fetch http://127.0.0.1:3080/` | `URL hostname "127.0.0.1" resolves to a non-public IP address` | HTTP 401 (the GUI auth response — the connection actually happened) |
| `web_fetch http://localhost:3080/` | blocked the same way | HTTP 401 |
| `web_fetch https://example.com/` | HTTP 200 | HTTP 200 (public path, no regression) |

## Notes

- **This check is an SSRF guard.** Once lifted, `web_fetch` can reach local and intranet addresses. Use it only on personal devices and trusted networks such as Clash TUN, and never let untrusted model instructions steer fetches toward sensitive internal services.
- **Only the IP-resolution check is lifted**: the URL scheme whitelist, credential rejection, redirect limits, byte/char/timeout caps, address pinning, and every other transport-hygiene policy remain in force.
- The one-click install persists with the DSH process (host plane) and survives restarts; after uninstalling (or removing the patch row), restart DSH (or trigger a live reload) to restore the original behavior.
- Every allowed non-public destination is logged as `[clash-tun-web] allowed non-public destination: <host> -> <ip,...>` for observability.

## Repository contents

| File | Purpose |
| --- | --- |
| `README.md` | This document (English) |
| `README_CN.md` | Chinese documentation |
| `LICENSE` | GNU AGPL-3.0 license text |
| `install.ps1` / `install.sh` | One-click install / uninstall (Windows PowerShell / POSIX shell) |
| `payload/clash-tun-web-fetch-unlock.cjs` | Install payload: the host-plane plugin module (CJS, `module.exports = { apply }`) |
| `clash-tun-web-fetch-unlock.host.js` | In-session dynamic plugin source (`cordis_define`'s `code.host` body; same logic as the payload) |
