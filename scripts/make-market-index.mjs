#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 生成 DSH 插件市场索引（format 1）：`market.json`。
//
// 市场索引里的 Git 版本必须固定到 40 位 commit，因此本脚本以当前仓库的
// HEAD 作为发布 commit。发布流程：
//
//   1. 提交并推送本次改动（索引指向的 commit 必须包含插件文件本身）；
//   2. node scripts/make-market-index.mjs
//   3. 提交 market.json 并推送 —— 之后即可在 DSH 的「插件 → 发现」中把
//      下面的索引 URL 加为市场来源：
//        https://raw.githubusercontent.com/<owner>/<repo>/<branch>/market.json
//
// 用法：
//   node scripts/make-market-index.mjs            # 写入 market.json
//   node scripts/make-market-index.mjs --check    # 只校验，不写文件
//   node scripts/make-market-index.mjs --stdout   # 打印到标准输出
//
// 校验：若同一目录能解析到 @deepseek-ai/dsh-plugin-market-index（例如在 DSH
// 安装目录内运行），脚本会用官方校验器验证产物；否则退回自检。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'market.json')
/** 索引里列出的、必须随发布 commit 一起存在的文件。 */
const REQUIRED_FILES = ['package.json', 'index.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']

/** 运行 git 并返回去掉首尾空白的标准输出。 */
function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

/** 把 `git@host:owner/repo.git` 形式的远端地址转成规范 https URL。 */
function normalizeRemote(remote) {
  const scp = /^git@([^:]+):(.+)$/.exec(remote)
  const url = scp === null ? remote : `https://${scp[1]}/${scp[2]}`
  const parsed = new URL(url.replace(/^git\+/, ''))
  const pathname = parsed.pathname.replace(/\.git$/, '').replace(/\/$/, '')
  if (pathname.split('/').filter((segment) => segment !== '').length < 2) {
    throw new Error(`remote ${JSON.stringify(remote)} does not name owner/repository`)
  }
  return `https://${parsed.host}${pathname}`
}

/** 读取包清单并做最小自检。 */
function readManifest() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('package.json must declare name and version')
  }
  if (manifest.dsh?.bundle?.patch === undefined) {
    throw new Error('package.json must declare dsh.bundle.patch to be installable as a bundle')
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`package.json version ${JSON.stringify(manifest.version)} is not an exact SemVer version`)
  }
  return manifest
}

/** 组装 format 1 的索引文档。 */
function buildIndex(manifest) {
  const dirty = git('status', '--porcelain') !== ''
  const commit = git('rev-parse', 'HEAD')
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected git HEAD ${JSON.stringify(commit)}`)
  const missing = REQUIRED_FILES.filter((file) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${commit}:${file}`], { cwd: ROOT, stdio: 'ignore' })
      return false
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    throw new Error(
      `commit ${commit} does not contain ${missing.join(', ')}; commit and push the plugin first, then regenerate the index`,
    )
  }
  const remote = normalizeRemote(git('remote', 'get-url', 'origin'))
  const publishTimestamp = Number(git('log', '-1', '--format=%ct'))

  const index = {
    format: 1,
    title: { en: 'ClashTUNWithDSH', zh: 'ClashTUNWithDSH' },
    description: {
      en: 'DSH plugins for running behind Clash TUN (fake-ip).',
      zh: '让 DSH 在 Clash TUN（fake-ip）下正常工作的插件。',
    },
    metadata: {
      categories: {
        network: { title: { en: 'Network', zh: '网络' } },
      },
    },
    plugins: [
      {
        name: manifest.name,
        title: { en: 'Clash TUN web fetch unlock', zh: 'Clash TUN 网页抓取解锁' },
        description: {
          en: 'Lets web_fetch reach destinations that resolve to non-public addresses, so fetching works behind Clash TUN fake-ip.',
          zh: '允许 web_fetch 访问解析到非公网地址的目标，使 Clash TUN（fake-ip）下的网页抓取正常工作。',
        },
        ...(typeof manifest.author === 'string' ? { author: manifest.author } : {}),
        ...(typeof manifest.homepage === 'string' ? { homepage: manifest.homepage } : {}),
        ...(typeof manifest.repository?.url === 'string'
          ? { repository: { url: manifest.homepage ?? manifest.repository.url.replace(/^git\+/, '') } }
          : {}),
        metadata: {
          category: 'network',
          keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
        },
        versions: [
          {
            version: manifest.version,
            publishTimestamp,
            source: { type: 'git', url: remote, commit },
            ...(typeof manifest.engines?.dsh === 'string' ? { engines: { dsh: manifest.engines.dsh } } : {}),
          },
        ],
      },
    ],
  }
  return { index, dirty, commit }
}

/** 用官方校验器验证（可解析时）；否则做本地结构自检。 */
async function validate(index) {
  try {
    const { parseMarketIndex, marketInstallTarget } = await import('@deepseek-ai/dsh-plugin-market-index')
    const parsed = parseMarketIndex(index, 'https://example.com/market.json')
    const plugin = parsed.plugins[0]
    const target = marketInstallTarget(plugin.name, plugin.versions[0])
    console.log(`validated by @deepseek-ai/dsh-plugin-market-index; install spec: ${target.spec}`)
    return
  } catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.path === 'string') throw error
  }
  // 本地自检：只覆盖 DSH 会在加载索引时立刻检查的硬性约束。
  if (index.format !== 1) throw new Error('format must be 1')
  if (!Array.isArray(index.plugins) || index.plugins.length === 0) throw new Error('plugins must be a non-empty array')
  for (const plugin of index.plugins) {
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(plugin.name)) {
      throw new Error(`plugin name ${JSON.stringify(plugin.name)} is not a valid npm package name`)
    }
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) throw new Error('versions must be a non-empty array')
    for (const version of plugin.versions) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version.version)) {
        throw new Error(`version ${JSON.stringify(version.version)} is not an exact SemVer version`)
      }
      if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0) {
        throw new Error('publishTimestamp must be a non-negative integer')
      }
      if (version.source?.type !== 'git' || !/^[0-9a-f]{40}$/.test(version.source.commit ?? '')) {
        throw new Error('a git source must pin a lowercase 40-hex-digit commit')
      }
      if (!/^https:\/\/[^/]+\/.+\/.+/.test(version.source.url ?? '')) {
        throw new Error(`git source url ${JSON.stringify(version.source.url)} must be a canonical https repository URL`)
      }
    }
  }
  console.log('validated locally (the official validator was not resolvable here)')
}

const args = new Set(process.argv.slice(2))
const { index, dirty, commit } = buildIndex(readManifest())
const text = `${JSON.stringify(index, undefined, 2)}\n`

if (args.has('--stdout')) process.stdout.write(text)
else if (!args.has('--check')) writeFileSync(OUTPUT, text, 'utf8')

await validate(index)
if (dirty) {
  console.error('warning: the working tree is dirty; the index points at HEAD, which excludes uncommitted changes')
} else if (!args.has('--stdout') && !args.has('--check')) {
  console.error(`wrote ${OUTPUT} for ${index.plugins[0].name}@${index.plugins[0].versions[0].version} (${commit})`)
}
if (args.has('--check')) console.error('check passed; no file was written')
