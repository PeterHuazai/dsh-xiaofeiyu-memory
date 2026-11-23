/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 @deepseek-ai/*（拿不到就退到本地等价实现）
 * 桌面版 profile 永远不装 optional peer，裸 import 会让整条插件不激活，所以这里逐个探测。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
  } catch { /* 没有就算了 */ }
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports && pkg.exports['.']
    const rel = typeof dot === 'string' ? dot : (dot && (dot.import || dot.default)) || pkg.module || pkg.main
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name, log) {
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(name + '：从宿主树取到')
      return mod
    } catch { /* 换下一个 */ }
  }
  return null
}

function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error('defineTool(' + options.name + '): ' + where + ' 是 object 却没写 additionalProperties')
    }
    for (const k of Object.keys(schema.properties || {})) check(schema.properties[k], where + '.properties.' + k)
  }
  check(options.parameters, 'parameters')
  check(options.output && options.output.schema, 'output.schema')
  if (log) log('dsh-tools 拿不到 —— 用本地等价实现顶上（工具 ' + options.name + '）')
  return options
}

export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)
  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery') } catch (e) { log('schemastery 拿不到：设置页降级为默认值') }
  }
  const z = (zMod && zMod.default) || zMod || null
  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools') } catch (e) { dtMod = null }
  }
  const defineTool = (dtMod && dtMod.defineTool) || ((options) => localDefineTool(options, log))
  return { z, defineTool, notes }
}
