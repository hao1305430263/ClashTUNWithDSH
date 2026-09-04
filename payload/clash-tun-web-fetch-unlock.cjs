'use strict'

// SPDX-License-Identifier: AGPL-3.0-or-later
//
/**
 * ClashTUNWithDSH — DSH host-plane plugin: 解除 web_fetch 的非公网 IP 解析限制，
 * 使 DSH 在 Clash TUN（fake-ip）环境下正常抓取网页。
 * Copyright (C) 2025 ClashTUNWithDSH authors
 *
 * 本程序为自由软件：你可以在遵守 GNU Affero 通用公共许可证（自由软件基金会发布的
 * 第 3 版或任意更高版本）的条款下重新分发或修改它。详见 LICENSE 文件或
 * <https://www.gnu.org/licenses/>。本程序不提供任何担保。
 *
 *
 * 机制：就地替换 web-fetch-http provider 实例的 resolveAddresses ——
 *   公网目的地保持原版行为（NAT64 检查、地址钉扎、重定向、大小/超时上限全部保留）；
 *   仅当抛出 WEB_BLOCKED_URL 且含 "non-public" 时，用一次性子进程走系统 DNS
 *   （即 Clash TUN 的 fake-ip 解析）重新解析并放行全部地址。
 * 停止/热重载时自动恢复原始方法；全局引用计数保证多挂载/重挂载安全。
 *
 * 由 install.ps1 / install.sh 安装到 $DSH_HOME，经 cordis.patch.yml 的
 * insert 行挂载到宿主组合（对所有 profile 生效）。
 */

var CACHE_TTL_MS = 60000
var CACHE_MAX_ENTRIES = 400

/** 一次性子进程脚本：系统解析器 verbatim 全量应答，JSON 输出。 */
var RESOLVE_SCRIPT = "var d=require('node:dns').promises;var h=process.argv[1];d.lookup(h,{all:true,order:'verbatim'}).then(function(r){process.stdout.write(JSON.stringify(r))}).catch(function(e){process.stderr.write(String((e&&e.code)||e));process.exit(1)})"

/** 全局状态：多挂载/热重载重挂载时补丁只装一份，引用计数归零才恢复原方法。 */
function sharedState() {
  var root = globalThis
  if (!root.__classtunWebFetchUnlock) {
    root.__classtunWebFetchUnlock = { count: 0, original: null, cache: new Map() }
  }
  return root.__classtunWebFetchUnlock
}

function stripBrackets(hostname) {
  return hostname.length > 1 && hostname.charAt(0) === '[' && hostname.charAt(hostname.length - 1) === ']'
    ? hostname.slice(1, -1)
    : hostname
}

/** 只匹配非公网拦截（两条消息），不动凭据/协议等其他 WEB_BLOCKED_URL 场景。 */
function isNonPublicBlock(error) {
  return !!error && typeof error === 'object'
    && error.code === 'WEB_BLOCKED_URL'
    && typeof error.message === 'string'
    && error.message.indexOf('non-public') !== -1
}

function cacheGet(state, hostname) {
  var entry = state.cache.get(hostname)
  if (entry === undefined) return undefined
  if (entry.expires <= Date.now()) {
    state.cache.delete(hostname)
    return undefined
  }
  return entry.addresses
}

function cacheSet(state, hostname, addresses) {
  if (state.cache.size > CACHE_MAX_ENTRIES) state.cache.clear()
  state.cache.set(hostname, { expires: Date.now() + CACHE_TTL_MS, addresses: addresses })
}

function resolveNodeExe(subprocess) {
  return subprocess.resolveExecutable('node').then(function (exe) {
    return typeof exe === 'string' && exe.length > 0 ? exe : 'node'
  }).catch(function () { return 'node' })
}

/** 一次性子进程走系统解析器（Clash TUN / fake-ip 包含在内），返回全量地址集。 */
function resolveViaSystemDns(subprocess, hostname, signal) {
  return resolveNodeExe(subprocess).then(function (exe) {
    var handle = subprocess.spawn({
      argv: [exe, '-e', RESOLVE_SCRIPT, hostname],
      cwd: process.cwd(),
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

function apply(ctx) {
  var state = sharedState()
  state.count += 1

  var subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    console.error('[clash-tun-web] subprocess service not found; plugin did nothing')
    return
  }
  var web = ctx.get('web')
  if (web === undefined) {
    console.error('[clash-tun-web] ctx.web service not found; plugin did nothing')
    return
  }

  // 定位本地 HTTP fetch provider（id 'http'）；只做针对性读取。
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

  if (state.count === 1) {
    state.original = provider.resolveAddresses
    state.provider = provider

    // 公网照走原逻辑；仅非公网拦截时经系统解析器重解析并放行全部地址。
    provider.resolveAddresses = function patched(hostname, signal) {
      return Promise.resolve().then(function () {
        return state.original.call(provider, hostname, signal)
      }).catch(function (error) {
        if (!isNonPublicBlock(error)) throw error
        var host = stripBrackets(hostname)
        var cached = cacheGet(state, host)
        if (cached !== undefined) return cached
        return resolveViaSystemDns(subprocess, host, signal).then(function (addresses) {
          cacheSet(state, host, addresses)
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
    console.log('[clash-tun-web] non-public IP restriction lifted on the local http fetch provider (id=http); redirects, size caps and timeouts unchanged')
  } else {
    console.log('[clash-tun-web] patch already installed (refcount=' + state.count + ')')
  }

  ctx.effect(function* () {
    yield function () {
      state.count -= 1
      if (state.count <= 0 && state.provider && state.provider.resolveAddresses !== state.original) {
        state.provider.resolveAddresses = state.original
        state.provider = null
        state.original = null
        state.cache.clear()
        console.log('[clash-tun-web] original public-IP policy restored')
      }
    }
  }, 'clash-tun-web.restore')
}

module.exports = {
  name: 'clash-tun-web-fetch-unlock',
  inject: ['web'],
  apply: apply,
}
