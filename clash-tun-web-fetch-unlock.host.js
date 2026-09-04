// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ClashTUNWithDSH — DSH 插件：解除 web_fetch 的非公网 IP 解析限制
// Copyright (C) 2025 ClashTUNWithDSH authors
//
// 本程序为自由软件：你可以在遵守 GNU Affero 通用公共许可证（自由软件基金会发布的
// 第 3 版或任意更高版本）的条款下重新分发或修改它。详见 LICENSE 文件或
// <https://www.gnu.org/licenses/>。本程序不提供任何担保。
//
// 用法：将本文件的函数体作为 cordis_define 的 code.host，然后 cordis_run 激活。
// 原理：就地替换 web-fetch-http provider 实例的 resolveAddresses ——
//   公网目的地保持原版行为；仅当抛出 WEB_BLOCKED_URL 且含 "non-public" 时，
//   用一次性 Node 子进程走系统 DNS（Clash TUN/fake-ip）重新解析并全部放行。
// 插件停止/更新时自动恢复原方法，不留残留。
var RESOLVE_SCRIPT = "var d=require('node:dns').promises;var h=process.argv[1];d.lookup(h,{all:true,order:'verbatim'}).then(function(r){process.stdout.write(JSON.stringify(r))}).catch(function(e){process.stderr.write(String((e&&e.code)||e));process.exit(1)})"
var CACHE_TTL_MS = 60000
var CACHE_MAX_ENTRIES = 400

return {
  apply(ctx) {
    var web = ctx.get('web')
    if (web === undefined) {
      console.error('[clash-tun-web] ctx.web service not found; plugin did nothing')
      return
    }
    var subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      console.error('[clash-tun-web] subprocess service not found; plugin did nothing')
      return
    }
    var fs = ctx.get('fs')

    // Locate the local HTTP fetch provider instance registered under id 'http'.
    // Targeted leaf read only: the provider map and the single provider entry.
    var store = web.fetchProviders
    if (!store || typeof store.get !== 'function') {
      console.error('[clash-tun-web] cannot read the fetch provider registry; plugin did nothing')
      return
    }
    var provider = store.get('http')
    if (!provider || typeof provider.resolveAddresses !== 'function' || typeof provider.fetch !== 'function') {
      console.error('[clash-tun-web] local http fetch provider not found; plugin did nothing')
      return
    }

    var original = provider.resolveAddresses
    var cache = new Map()
    var nodeExePromise = null
    var cwdPromise = null

    function stripBrackets(hostname) {
      return hostname.length > 1 && hostname.charAt(0) === '[' && hostname.charAt(hostname.length - 1) === ']'
        ? hostname.slice(1, -1)
        : hostname
    }

    // Match exactly the two non-public blocks the stock resolver raises, never
    // other WEB_BLOCKED_URL cases (credentials, invalid schemes, ...).
    function isNonPublicBlock(error) {
      return !!error && typeof error === 'object'
        && error.code === 'WEB_BLOCKED_URL'
        && typeof error.message === 'string'
        && error.message.indexOf('non-public') !== -1
    }

    function cacheGet(hostname) {
      var entry = cache.get(hostname)
      if (entry === undefined) return undefined
      if (entry.expires <= Date.now()) {
        cache.delete(hostname)
        return undefined
      }
      return entry.addresses
    }

    function cacheSet(hostname, addresses) {
      if (cache.size > CACHE_MAX_ENTRIES) cache.clear()
      cache.set(hostname, { expires: Date.now() + CACHE_TTL_MS, addresses: addresses })
    }

    function resolveNodeExe() {
      if (nodeExePromise === null) {
        nodeExePromise = subprocess.resolveExecutable('node').then(function (exe) {
          return typeof exe === 'string' && exe.length > 0 ? exe : 'node'
        }).catch(function () { return 'node' })
      }
      return nodeExePromise
    }

    function resolveCwd() {
      if (cwdPromise === null) {
        cwdPromise = (fs === undefined)
          ? Promise.resolve('.')
          : fs.resolve('.', {}).then(function (target) {
              var path = fs.processPath(target)
              return typeof path === 'string' && path.length > 0 ? path : '.'
            }).catch(function () { return '.' })
      }
      return cwdPromise
    }

    // One-shot child process performing a system-resolver lookup. It goes through
    // the OS DNS pipeline (Clash TUN / fake-IP included) and prints the full
    // verbatim answer set as JSON on stdout.
    function resolveViaSystemDns(hostname, signal) {
      return Promise.all([resolveNodeExe(), resolveCwd()]).then(function (both) {
        var handle = subprocess.spawn({
          argv: [both[0], '-e', RESOLVE_SCRIPT, hostname],
          cwd: both[1],
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 8192 } },
          graceMs: 1000,
          signal: signal,
        })
        return handle.done.then(function (outcome) {
          if (outcome.exitCode !== 0) {
            var stderr = ''
            try { stderr = handle.collected.stderr.readFrom(0).text.trim() } catch (e) {}
            throw new Error('resolver exited with code ' + String(outcome.exitCode) + (stderr !== '' ? ': ' + stderr : ''))
          }
          var page = handle.collected.stdout.readFrom(0)
          var parsed = JSON.parse(page.text)
          if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('resolver returned no addresses')
          }
          var addresses = []
          for (var i = 0; i < parsed.length; i++) {
            var entry = parsed[i]
            if (entry && typeof entry.address === 'string' && (entry.family === 4 || entry.family === 6)) {
              addresses.push({ address: entry.address, family: entry.family })
            }
          }
          if (addresses.length === 0) {
            throw new Error('resolver returned no usable addresses')
          }
          return addresses
        })
      })
    }

    // Drop-in replacement for HttpFetchProvider#resolveAddresses: public
    // destinations keep the untouched stock behavior (including NAT64 checks
    // and connection pinning); only a non-public block is retried through the
    // system resolver with every returned address allowed.
    function patched(hostname, signal) {
      return Promise.resolve().then(function () {
        return original.call(provider, hostname, signal)
      }).catch(function (error) {
        if (!isNonPublicBlock(error)) throw error
        var host = stripBrackets(hostname)
        var cached = cacheGet(host)
        if (cached !== undefined) return cached
        return resolveViaSystemDns(host, signal).then(function (addresses) {
          cacheSet(host, addresses)
          var shown = addresses.map(function (a) { return a.address }).join(', ')
          console.log('[clash-tun-web] allowed non-public destination: ' + host + ' -> ' + shown)
          return addresses
        }, function (resolverError) {
          var detail = resolverError && resolverError.message ? resolverError.message : String(resolverError)
          console.error('[clash-tun-web] system DNS resolve failed for ' + host + ': ' + detail)
          throw error
        })
      })
    }

    try {
      provider.resolveAddresses = patched
    } catch (assignError) {
      console.error('[clash-tun-web] cannot patch the provider: ' + String(assignError))
      return
    }

    ctx.effect(function* () {
      yield function () {
        if (provider.resolveAddresses === patched) {
          provider.resolveAddresses = original
          console.log('[clash-tun-web] original public-IP policy restored')
        }
      }
    }, 'clash-tun-web.restore')

    console.log('[clash-tun-web] non-public IP restriction lifted on the local http fetch provider (id=http); redirects, size caps and timeouts unchanged')
  },
}
