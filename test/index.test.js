// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ClashTUNWithDSH 的零依赖自测：用最小假的 Cordis 上下文驱动 index.js，
// 覆盖“公网放行不受影响”“非公网经系统解析放行”“非相关错误照旧抛出”
// “provider 晚注册也生效”“卸载还原”等关键行为。
//
// 运行：node --test test/

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, inject, name as pluginName } from '../index.js'

/**
 * 最小 Cordis 上下文替身：`logger()` 返回记录型 logger，`effect()` 收集清理函数，
 * `dispose()` 模拟插件卸载（逆序执行清理）。
 */
function fakeContext(web) {
  const lines = []
  const logger = new Proxy({}, {
    get: (_target, level) => (...args) => lines.push({ level: String(level), args }),
  })
  const disposers = []
  return {
    web,
    lines,
    logger: () => logger,
    effect(execute) {
      const iterator = execute()
      const first = iterator.next()
      if (typeof first.value === 'function') disposers.push(first.value)
      return disposers[disposers.length - 1]
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

/** 与 web-fetch-http 一致的拦截错误。 */
function nonPublicBlock(hostname) {
  const error = new Error(`URL hostname "${hostname}" resolves to a non-public IP address`)
  error.code = 'WEB_BLOCKED_URL'
  return error
}

/** 造一个行为与 dsh-web-fetch-http provider 相仿的假 provider。 */
function fakeProvider({ answers = [], block }) {
  const provider = {
    id: 'http',
    calls: 0,
    /** 原版解析器：命中 block 时抛 WEB_BLOCKED_URL。 */
    async resolveAddresses(hostname) {
      provider.calls += 1
      if (block !== undefined) throw block(hostname)
      return answers
    },
    async fetch() {
      return { statusCode: 200 }
    },
  }
  return provider
}

/** 造一个与 dsh-web 相仿的假 web 服务。 */
function fakeWeb(provider) {
  const providers = new Map()
  if (provider !== undefined) providers.set(provider.id, provider)
  return {
    fetchProviders: providers,
    registerFetchProvider(target) {
      providers.set(target.id, target)
      return () => providers.delete(target.id)
    },
  }
}

test('导出的元数据符合 Cordis 插件形态', () => {
  assert.equal(typeof apply, 'function')
  assert.deepEqual(inject, ['web'])
  assert.equal(pluginName, 'clash-tun-web-fetch-unlock')
})

test('公网目的地完全走原逻辑', async () => {
  const answers = [{ address: '93.184.215.14', family: 4 }]
  const provider = fakeProvider({ answers })
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {})

  assert.deepEqual(await provider.resolveAddresses('example.com', undefined), answers)
  assert.equal(provider.calls, 1)
})

test('非公网拦截时经系统解析放行全部地址', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  const lookups = []
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {
    lookup: async (host, options) => {
      lookups.push([host, options])
      return [{ address: '198.18.0.7', family: 4 }]
    },
  })

  assert.deepEqual(
    await provider.resolveAddresses('example.com', undefined),
    [{ address: '198.18.0.7', family: 4 }],
  )
  assert.deepEqual(lookups, [['example.com', { all: true, order: 'verbatim' }]])
})

test('IPv6 字面量去括号后再解析', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {
    lookup: async (host) => [{ address: host === '::1' ? '::1' : '198.18.0.9', family: 6 }],
  })

  assert.deepEqual(
    await provider.resolveAddresses('[::1]', undefined),
    [{ address: '::1', family: 6 }],
  )
})

test('放行结果按主机名缓存，重复抓取不重复解析', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  let lookups = 0
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {
    cacheTtlMs: 60_000,
    lookup: async () => {
      lookups += 1
      return [{ address: '198.18.0.7', family: 4 }]
    },
  })

  await provider.resolveAddresses('example.com', undefined)
  await provider.resolveAddresses('example.com', undefined)
  assert.equal(lookups, 1)

  await provider.resolveAddresses('other.example', undefined)
  assert.equal(lookups, 2)
})

test('cacheTtlMs 为 0 时关闭缓存', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  let lookups = 0
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {
    cacheTtlMs: 0,
    lookup: async () => {
      lookups += 1
      return [{ address: '198.18.0.7', family: 4 }]
    },
  })

  await provider.resolveAddresses('example.com', undefined)
  await provider.resolveAddresses('example.com', undefined)
  assert.equal(lookups, 2)
})

test('其它 WEB_BLOCKED_URL（如凭据/协议拒绝）照旧抛出', async () => {
  const blocked = new Error('URL must not contain credentials')
  blocked.code = 'WEB_BLOCKED_URL'
  const provider = fakeProvider({ block: () => blocked })
  let lookups = 0
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {
    lookup: async () => {
      lookups += 1
      return [{ address: '198.18.0.7', family: 4 }]
    },
  })

  await assert.rejects(provider.resolveAddresses('example.com', undefined), (error) => error === blocked)
  assert.equal(lookups, 0)
})

test('系统解析失败时抛出原拦截错误（不改变失败语义）', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {
    lookup: async () => {
      throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })
    },
  })

  await assert.rejects(provider.resolveAddresses('example.com', undefined), (error) => {
    assert.equal(error.code, 'WEB_BLOCKED_URL')
    assert.match(error.message, /non-public/)
    return true
  })
})

test('请求取消时不等待系统解析', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {
    lookup: () => new Promise(() => {}),
  })

  const controller = new AbortController()
  const pending = provider.resolveAddresses('example.com', controller.signal)
  controller.abort(new Error('user cancelled'))
  await assert.rejects(pending, /aborted during hostname resolution/)
})

test('provider 晚于插件注册时同样被补丁', async () => {
  const web = fakeWeb(undefined)
  const ctx = fakeContext(web)
  apply(ctx, {
    lookup: async () => [{ address: '198.18.0.7', family: 4 }],
  })

  const provider = fakeProvider({ block: nonPublicBlock })
  web.registerFetchProvider(provider)

  assert.deepEqual(
    await provider.resolveAddresses('example.com', undefined),
    [{ address: '198.18.0.7', family: 4 }],
  )
})

test('卸载后恢复原始方法，且不动注册表', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  const original = provider.resolveAddresses
  const web = fakeWeb(provider)
  const registrar = web.registerFetchProvider
  const ctx = fakeContext(web)
  apply(ctx, {})

  assert.notEqual(provider.resolveAddresses, original)
  ctx.dispose()
  assert.equal(provider.resolveAddresses, original)
  assert.equal(web.registerFetchProvider, registrar)
})

test('两次挂载再逐个卸载，只有全部卸载后才还原', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  const original = provider.resolveAddresses
  const web = fakeWeb(provider)
  const first = fakeContext(web)
  const second = fakeContext(web)
  apply(first, {})
  apply(second, {})

  first.dispose()
  assert.notEqual(provider.resolveAddresses, original)
  second.dispose()
  assert.equal(provider.resolveAddresses, original)
})

test('未挂载目标 provider 时不报错、不改变任何东西', async () => {
  const provider = fakeProvider({ answers: [] })
  provider.id = 'other'
  const web = fakeWeb(provider)
  const ctx = fakeContext(web)
  apply(ctx, {})
  assert.equal(provider.resolveAddresses.name, 'resolveAddresses')
  assert.equal(web.registerFetchProvider.length, 1)
})

test('放行时写入可观测日志', async () => {
  const provider = fakeProvider({ block: nonPublicBlock })
  const ctx = fakeContext(fakeWeb(provider))
  apply(ctx, {
    lookup: async () => [{ address: '198.18.0.7', family: 4 }],
  })

  await provider.resolveAddresses('example.com', undefined)
  const entries = ctx.lines.filter((line) => line.level === 'info')
  assert.ok(
    entries.some((line) => line.args[0] === 'allowed non-public destination %s -> %s'
      && line.args[1] === 'example.com'
      && line.args[2] === '198.18.0.7'),
    JSON.stringify(ctx.lines),
  )
})
