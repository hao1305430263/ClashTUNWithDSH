// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 可选集成测试：在真实 DSH 运行时下驱动 @deepseek-ai/dsh-web 与
// @deepseek-ai/dsh-web-fetch-http，验证“bundle 补丁可解析、安装前被拦、
// 安装后放行、热重载后仍生效、卸载后还原、公网策略无回归”。
// 这些包只存在于 DSH 安装目录，因此解析不到时整组测试自动跳过，
// 让纯仓库环境下的 `node --test` 依然通过。
//
// 在包含 DSH 依赖的环境下运行（例如解包后的 app.asar）：
//   cd "<dsh>/resources/app.asar.unpacked/dsh" \
//     && node --test "<本仓库>/test/"

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as plugin from '../index.js'

const PACKAGE_DIR = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/** 依次尝试导入 DSH 运行时包；任一缺失则返回 undefined。 */
async function loadDsh() {
  try {
    const [{ Context }, { default: WebRuntime }, fetchHttp, appBoot] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-web'),
      import('@deepseek-ai/dsh-web-fetch-http'),
      import('@deepseek-ai/dsh-app-boot'),
    ])
    return { Context, WebRuntime, fetchHttp, appBoot }
  } catch {
    return undefined
  }
}

const dsh = await loadDsh()
/** 运行时包缺失时整组跳过（`node:test` 的 options 形式，skip 为 false 时不跳过）。 */
const SKIP = { skip: dsh === undefined ? 'DSH runtime packages are not resolvable here' : false }

/** 组装最小宿主组合：web 服务 + 本地 http fetch provider（+ 可选本插件）。 */
async function compose({ withPlugin }) {
  const { Context, WebRuntime, fetchHttp } = dsh
  const ctx = new Context()
  ctx.plugin(WebRuntime, {})
  const providerFiber = ctx.plugin(fetchHttp, {})
  const pluginFiber = withPlugin ? ctx.plugin(plugin, {}) : undefined
  await new Promise((resolve) => setTimeout(resolve, 300))
  return { ctx, web: ctx.get('web'), providerFiber, pluginFiber }
}

/** 起一个本地回环 HTTP 服务。 */
async function localServer() {
  const server = createServer((request, response) => {
    void request
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('local ok\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://localhost:${port}/`, close: () => server.close() }
}

test('bundle 清单与补丁层符合 DSH 约定', SKIP, () => {
  const { readProfileManifest, bundlePatchPaths, loadOverlayPatches, evaluatePluginCompatibility } = dsh.appBoot
  const manifest = readProfileManifest('dsh', PACKAGE_DIR)
  assert.equal(manifest.name, 'clash-tun-with-dsh')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  // engines.dsh 与运行时不冲突（否则 DSH 会拒绝安装/启用该 bundle）。
  assert.equal(evaluatePluginCompatibility(manifest), undefined)

  const rows = bundlePatchPaths(PACKAGE_DIR, manifest.dsh.bundle)
    .flatMap((patchPath) => loadOverlayPatches('dsh', patchPath))
    .flatMap((patch) => patch.insert ?? [])
  assert.deepEqual(
    rows.map((row) => ({ id: row.id, name: row.name })),
    [{ id: 'clash-tun-web-fetch-unlock', name: 'clash-tun-with-dsh' }],
  )
})

test('展示元数据（标题/描述/图标）可被 DSH 读取', SKIP, () => {
  const meta = dsh.appBoot.readPluginMeta('clash-tun-with-dsh', new URL(`file:///${PACKAGE_DIR.replaceAll('\\', '/')}/package.json`).href)
  assert.ok(meta !== undefined, 'metadata must be readable')
  assert.equal(meta.error, undefined)
  assert.equal(meta.title.en, 'Clash TUN web fetch unlock')
  assert.equal(meta.title.zh, 'Clash TUN 网页抓取解锁')
  assert.match(meta.icon ?? '', /^data:image\/svg\+xml;base64,/)
})

test('未安装插件时回环目的地被 SSRF 防护拦下', SKIP, async () => {
  const server = await localServer()
  try {
    const { web } = await compose({ withPlugin: false })
    await assert.rejects(web.fetch({ url: server.url }), (error) => {
      assert.equal(error.code, 'WEB_BLOCKED_URL')
      assert.match(error.message, /non-public/)
      return true
    })
  } finally {
    server.close()
  }
})

test('安装插件后回环目的地可抓取，其它传输策略仍然保留', SKIP, async () => {
  const server = await localServer()
  try {
    const { web } = await compose({ withPlugin: true })

    const page = await web.fetch({ url: server.url })
    assert.equal(page.statusCode, 200)
    assert.match(page.body.content, /local ok/)

    // 协议白名单与凭据拒绝属于另外的错误场景，不应被放宽。
    await assert.rejects(web.fetch({ url: 'file:///etc/passwd' }), { code: 'WEB_INVALID_URL' })
    await assert.rejects(web.fetch({ url: 'http://user:pw@example.com/' }), { code: 'WEB_BLOCKED_URL' })
  } finally {
    server.close()
  }
})

test('provider 热重载后新实例同样被补丁', SKIP, async () => {
  const { Context, WebRuntime, fetchHttp } = dsh
  const server = await localServer()
  try {
    const ctx = new Context()
    ctx.plugin(WebRuntime, {})
    const firstProvider = ctx.plugin(fetchHttp, {})
    ctx.plugin(plugin, {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    const web = ctx.get('web')

    await firstProvider.dispose()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(web.fetchProviders.size, 0)

    ctx.plugin(fetchHttp, {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    const page = await web.fetch({ url: server.url })
    assert.equal(page.statusCode, 200)
  } finally {
    server.close()
  }
})

test('卸载插件后恢复原版行为', SKIP, async () => {
  const server = await localServer()
  try {
    const { web, ctx, pluginFiber } = await compose({ withPlugin: true })
    const provider = web.fetchProviders.get('http')
    assert.equal(web.fetchProviders.size, 1)

    await pluginFiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(provider.resolveAddresses.name, 'resolvePublicAddresses')
    await assert.rejects(web.fetch({ url: server.url }), { code: 'WEB_BLOCKED_URL' })
    void ctx
  } finally {
    server.close()
  }
})
