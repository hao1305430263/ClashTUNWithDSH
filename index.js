// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ClashTUNWithDSH — DSH host plugin: 解除 web_fetch 的“非公网 IP 解析”限制，
// 使 DSH 在 Clash TUN（fake-ip）环境下正常工作。
// Copyright (C) 2025 ClashTUNWithDSH authors
//
// 本程序为自由软件：你可以在遵守 GNU Affero 通用公共许可证（自由软件基金会发布的
// 第 3 版或任意更高版本）的条款下重新分发或修改它。详见 LICENSE 文件或
// <https://www.gnu.org/licenses/>。本程序不提供任何担保。
//
// 机制：就地替换 web-fetch-http provider 实例的 resolveAddresses ——
//   公网目的地保持原版行为（NAT64 检查、地址钉扎、重定向、大小/超时上限全部保留）；
//   仅当原逻辑抛出 WEB_BLOCKED_URL 且消息含 "non-public" 时，改用系统解析器
//   （即 Clash TUN 的 fake-ip 解析）重新解析，并放行全部返回地址。
// 插件停止/热重载时自动恢复原始方法；引用计数保证多挂载/重挂载安全。
//
// 挂载方式：本包是 DSH bundle，`cordis.patch.yml` 把本模块作为宿主插件行插入；
// 也可以被其它组合直接以 `name: 'clash-tun-with-dsh'` 引用。

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** 本地 HTTP fetch provider 的注册 id（见 @deepseek-ai/dsh-web-fetch-http）。 */
const DEFAULT_PROVIDER_ID = 'http'
/** 放行结果在进程内的默认缓存时长（毫秒）。 */
const DEFAULT_CACHE_TTL_MS = 60_000
/** 默认缓存条目上限；超过后整体清空，避免无界增长。 */
const DEFAULT_CACHE_MAX_ENTRIES = 400
/**
 * 进程级补丁状态。用 `Symbol.for` 而非模块变量，让多份模块实例
 * （HMR 代际、bundle 行与其它组合并存等）共享同一份引用计数与原始方法。
 */
const STATE_KEY = Symbol.for('clash-tun-with-dsh/state')

/** 插件名（Loader 与日志中可见）。 */
export const name = 'clash-tun-web-fetch-unlock'

/** 依赖的宿主服务：`ctx.web` 提供 fetch provider 注册表。 */
export const inject = ['web']

/** 读取（必要时创建）进程级补丁状态。 */
function sharedState() {
  globalThis[STATE_KEY] ??= {
    /** provider 实例 -> { original, patched, count }（WeakMap：provider 被 GC 后自动释放） */
    providers: new WeakMap(),
    /** web 服务实例 -> { original, wrapped, count } */
    registrars: new WeakMap(),
    /** provider 实例 -> Map(host -> { expires, addresses }) */
    caches: new WeakMap(),
  }
  return globalThis[STATE_KEY]
}

/** WHATWG URL 保留 IPv6 字面量的方括号，DNS 解析器不接受。 */
function stripBrackets(hostname) {
  return hostname.length > 1 && hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

/**
 * 只匹配原版解析器抛出的两种“非公网”拦截，
 * 绝不放宽凭据、非法协议等其它 WEB_BLOCKED_URL 场景。
 */
function isNonPublicBlock(error) {
  return error !== null
    && typeof error === 'object'
    && error.code === 'WEB_BLOCKED_URL'
    && typeof error.message === 'string'
    && error.message.includes('non-public')
}

/** 与请求取消信号竞速：系统解析不可中断，但调用方不必等它结束。 */
function raceWithSignal(promise, signal) {
  if (signal === undefined || signal === null) return promise
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * 走系统解析器（Clash TUN / fake-ip 即在此生效）取全量应答。
 * IP 字面量由 `lookup` 原样返回，因此回环/私网字面量同样能被放行。
 */
async function resolveThroughSystemDns(resolve, hostname, signal) {
  const host = stripBrackets(hostname)
  const answers = await raceWithSignal(resolve(host, { all: true, order: 'verbatim' }), signal)
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error(`the system resolver returned no address for ${host}`)
  }
  const addresses = []
  for (const answer of answers) {
    if (answer === null || typeof answer !== 'object') continue
    if (answer.family !== 4 && answer.family !== 6) continue
    if (typeof answer.address !== 'string' || isIP(answer.address) !== answer.family) continue
    addresses.push({ address: answer.address, family: answer.family })
  }
  if (addresses.length === 0) throw new Error(`the system resolver returned no usable address for ${host}`)
  return addresses
}

/** 读缓存；过期条目顺手删除。 */
function readCache(cache, host) {
  const entry = cache.get(host)
  if (entry === undefined) return undefined
  if (entry.expires <= Date.now()) {
    cache.delete(host)
    return undefined
  }
  return entry.addresses
}

/** 写缓存。 */
function writeCache(cache, maxEntries, ttlMs, host, addresses) {
  if (cache.size >= maxEntries) cache.clear()
  cache.set(host, { expires: Date.now() + ttlMs, addresses })
}

/**
 * 生成替代 `resolveAddresses` 的函数：公网照走原逻辑，仅“非公网”拦截时
 * 经系统解析器重新解析并放行全部地址（交给原有地址钉扎传输层直连，
 * 由 TUN 网卡按原样接管）。
 */
function createPatchedResolver(settings, provider, original, cache) {
  const { cacheTtlMs, cacheMaxEntries, resolve, log } = settings
  return function patchedResolveAddresses(hostname, signal) {
    return Promise.resolve()
      .then(() => original.call(provider, hostname, signal))
      .catch((error) => {
        if (!isNonPublicBlock(error)) throw error
        const host = stripBrackets(hostname)
        const cached = readCache(cache, host)
        if (cached !== undefined) return cached.map((address) => ({ ...address }))
        return resolveThroughSystemDns(resolve, host, signal).then((addresses) => {
          writeCache(cache, cacheMaxEntries, cacheTtlMs, host, addresses)
          log.info('allowed non-public destination %s -> %s', host, addresses.map((address) => address.address).join(', '))
          return addresses
        }, (failure) => {
          // 取消先于解析失败时保留取消语义，交给传输层翻译成 WEB_ABORTED。
          if (signal !== undefined && signal !== null && signal.aborted) throw failure
          const detail = failure !== null && typeof failure === 'object' && typeof failure.message === 'string'
            ? failure.message
            : String(failure)
          log.warn('system DNS resolution failed for %s: %s', host, detail)
          throw error
        })
      })
  }
}

/** 认领一个 provider：首次认领时打上补丁，之后只增加引用计数。 */
function claimProvider(state, settings, provider) {
  let entry = state.providers.get(provider)
  if (entry === undefined) {
    const original = provider.resolveAddresses
    if (typeof original !== 'function') return false
    let cache = state.caches.get(provider)
    if (cache === undefined) {
      cache = new Map()
      state.caches.set(provider, cache)
    }
    entry = {
      original,
      patched: createPatchedResolver(settings, provider, original, cache),
      count: 0,
    }
    state.providers.set(provider, entry)
    provider.resolveAddresses = entry.patched
    settings.log.info('lifted the non-public IP restriction on the local http fetch provider (id=%s); redirects, size caps and timeouts unchanged', settings.providerId)
  }
  entry.count += 1
  return true
}

/** 释放一个 provider 的引用：计数归零时恢复原始方法。 */
function releaseProvider(state, settings, provider) {
  const entry = state.providers.get(provider)
  if (entry === undefined) return
  entry.count -= 1
  if (entry.count > 0) return
  state.providers.delete(provider)
  if (provider.resolveAddresses === entry.patched) {
    provider.resolveAddresses = entry.original
    settings.log.info('original public-IP policy restored')
  }
  state.caches.delete(provider)
}

/** 注册表里已有的目标 provider 立即认领；未注册时静默等待（见 {@link wrapRegistrar}）。 */
function claimRegistered(state, settings, web) {
  const store = web.fetchProviders
  if (store === undefined || store === null || typeof store.get !== 'function') {
    settings.log.warn('cannot read the web fetch provider registry; nothing was changed')
    return undefined
  }
  const provider = store.get(settings.providerId)
  if (provider === undefined || provider === null) return undefined
  if (!claimProvider(state, settings, provider)) {
    settings.log.warn('the web fetch provider (id=%s) exposes no resolveAddresses; nothing was changed', settings.providerId)
    return undefined
  }
  return provider
}

/**
 * 包住 `web.registerFetchProvider`：provider 晚于本插件注册（例如
 * web-fetch-http 行被热重载或被后插入的行挂载）时同样会被认领。
 */
function wrapRegistrar(state, settings, web, owners) {
  let entry = state.registrars.get(web)
  if (entry === undefined) {
    const original = web.registerFetchProvider
    if (typeof original !== 'function') return
    const wrapped = function registerFetchProvider(provider) {
      const disposer = original.call(web, provider)
      try {
        if (provider !== null && typeof provider === 'object' && provider.id === settings.providerId) {
          claimProvider(state, settings, provider)
          owners.add(provider)
        }
      } catch (error) {
        settings.log.warn('cannot patch the newly registered web provider: %s', String(error))
      }
      return disposer
    }
    entry = { original, wrapped, count: 0 }
    state.registrars.set(web, entry)
    web.registerFetchProvider = wrapped
  }
  entry.count += 1
}

/** 释放被包住的注册方法。 */
function releaseRegistrar(state, web) {
  const entry = state.registrars.get(web)
  if (entry === undefined) return
  entry.count -= 1
  if (entry.count > 0) return
  state.registrars.delete(web)
  if (web.registerFetchProvider === entry.wrapped) web.registerFetchProvider = entry.original
}

/**
 * 挂载插件。
 * @param ctx - 宿主 Cordis 上下文（`inject: ['web']` 保证 `ctx.web` 存在）。
 * @param config - 可选配置：`providerId`、`cacheTtlMs`、`cacheMaxEntries`、
 *   `lookup`（替换系统解析器，仅供测试或特殊部署）。
 */
export function apply(ctx, config) {
  const options = config !== null && typeof config === 'object' ? config : {}
  const settings = {
    providerId: typeof options.providerId === 'string' && options.providerId !== ''
      ? options.providerId
      : DEFAULT_PROVIDER_ID,
    cacheTtlMs: Number.isFinite(options.cacheTtlMs) && options.cacheTtlMs >= 0
      ? options.cacheTtlMs
      : DEFAULT_CACHE_TTL_MS,
    cacheMaxEntries: Number.isInteger(options.cacheMaxEntries) && options.cacheMaxEntries > 0
      ? options.cacheMaxEntries
      : DEFAULT_CACHE_MAX_ENTRIES,
    resolve: typeof options.lookup === 'function' ? options.lookup : lookup,
    log: ctx.logger('clash-tun-web'),
  }

  const web = ctx.web
  if (web === undefined || web === null) {
    settings.log.warn('ctx.web service not found; nothing was changed')
    return
  }

  const state = sharedState()
  /** 本次挂载认领的资源；卸载只归还自己认领的那一份。 */
  const ownedProviders = new Set()

  const provider = claimRegistered(state, settings, web)
  if (provider !== undefined) ownedProviders.add(provider)
  wrapRegistrar(state, settings, web, ownedProviders)

  ctx.effect(function* restore() {
    yield function () {
      for (const owned of ownedProviders) releaseProvider(state, settings, owned)
      ownedProviders.clear()
      releaseRegistrar(state, web)
    }
  }, 'clash-tun-web.restore')
}
