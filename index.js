/**
 * Host half of the Storage Insight bundle.
 *
 * 只扫描"当前运行的这个 DSH"自己的三个本地根，不联网、不读任意路径：
 *   1. DSH_HOME（会话 / 附件 / 缓存 / 运行时 / profile）
 *   2. 安装根（从运行进程结构探测，绝不写死）
 *   3. 系统临时目录下 dsh-* 前缀
 *
 * 任何探测失败都降级为"未知"，绝不用 0 或猜测值冒充数据。
 */
import { promises as fsp, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import zlib from 'node:zlib'

const ROUTE_PREFIX = '/storage-insight/api'

/** 一次扫描的绝对截止时刻（0 表示不限）。防止病态巨型目录把请求挂死。 */
let scanDeadline = 0
/** 本次扫描是否因为超时/数量上限而截断 */
let scanTruncated = false
const HOUR = 3600_000
const DAY = 24 * HOUR
const CY = 1024 ** 4

/** 找安装根：只认"目录里真的有 resources/app.asar"的结构特征。 */
function findInstallRoot() {
  const candidates = []
  try {
    if (process.execPath) candidates.push(path.dirname(process.execPath))
  } catch {}
  try {
    if (process.argv[1]) {
      let d = path.dirname(process.argv[1])
      for (let i = 0; i < 10; i++) {
        candidates.push(d)
        const up = path.dirname(d)
        if (up === d) break
        d = up
      }
    }
  } catch {}
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, 'resources', 'app.asar'))) return path.normalize(c)
      if (existsSync(path.join(c, 'Contents', 'Resources', 'app.asar'))) return path.normalize(c)
    } catch {}
  }
  return null
}

const PACKAGE_NAME = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
  } catch {
    return 'dsh-storage-insight'
  }
})()

/**
 * Host 进程里没有 DSH_PROFILE_DIR（实测），所以按"哪个 profile 的 package.json
 * 把本插件列进了 dsh.profile.bundles"反查当前 profile —— 只有装载本插件的
 * 那个 profile 会命中，比猜目录名可靠。
 */
function detectProfileDir(home) {
  const base = path.join(home, 'profiles')
  let dirs = []
  try {
    dirs = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }
  for (const name of dirs) {
    const dir = path.join(base, name)
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
      if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) return dir
    } catch {}
  }
  return null
}
/** 本机路径解析：每次扫描重新读，不缓存到模块常量（DSH 可能被换 profile 或搬迁）。 */
function resolvePaths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profileDir =
    process.env.DSH_PROFILE_DIR ||
    (process.env.DSH_PROFILE ? path.join(home, 'profiles', process.env.DSH_PROFILE) : null) ||
    detectProfileDir(home)
  return {
    home,
    profileDir,
    install: findInstallRoot(),
    temp: os.tmpdir(),
    platform: process.platform,
  }
}

const within = (parent, child) => {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (process.platform === 'win32') {
    const pl = p.toLowerCase()
    const cl = c.toLowerCase()
    return cl === pl || cl.startsWith(pl.endsWith(path.sep) ? pl : pl + path.sep)
  }
  return c === p || c.startsWith(p + path.sep)
}

const safeStat = async (p) => {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

/**
 * 迭代式体积统计：不递归调用（防爆栈）、不跟随符号链接（防环/重复计数），
 * 每遍历完一个目录让出一次事件循环（不阻塞 Host）。
 */
/**
 * Electron 把 .asar 伪装成目录（stat 报 size 0、isDir true），
 * 直接扫会把整包漏掉。这里同步关掉 asar 支持取真实文件大小，
 * 全程不起异步间隙，不会影响同时进行的其他读取。
 */
function asarFileSize(target) {
  const previous = process.noAsar
  process.noAsar = true
  try {
    const st = statSync(target)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  } finally {
    process.noAsar = previous
  }
}
async function measure(root, options = {}) {
  const { maxDepth = 12, maxEntries = 400_000, skipDirName, errors } = options
  const out = { bytes: 0, files: 0, truncated: false, denied: 0, byExt: Object.create(null) }
  if (!root) return out
  const stack = [[root, 0]]
  while (stack.length) {
    if (scanDeadline && Date.now() > scanDeadline) {
      out.truncated = true
      scanTruncated = true
      break
    }
    const [dir, depth] = stack.pop()
    let handle
    try {
      handle = await fsp.opendir(dir)
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      out.denied++
      if (errors && errors.length < 20) errors.push({ path: dir, code: (error && error.code) || 'EUNKNOWN' })
      continue
    }
    try {
      const files = []
      for await (const ent of handle) {
        if (ent.isSymbolicLink()) continue
        const full = path.join(dir, ent.name)
        // .asar 必须先判：Electron 下它的 Dirent 既可能报目录也可能报文件，size 都是 0
        if (ent.name.toLowerCase().endsWith('.asar')) {
          const size = asarFileSize(full)
          if (size > 0) {
            out.bytes += size
            out.files++
            out.byExt['.asar'] = (out.byExt['.asar'] || 0) + size
          } else {
            out.denied++
          }
          continue
        }
        if (ent.isDirectory()) {
          if (skipDirName && skipDirName(ent.name)) continue
          if (depth < maxDepth) stack.push([full, depth + 1])
          continue
        }
        if (ent.isFile()) files.push(full)
      }
      // 并发 stat：Windows 上逐个 await 是 3s 级的瓶颈，32 路后降到亚秒
      for (let i = 0; i < files.length; i += 32) {
        if (scanDeadline && Date.now() > scanDeadline) {
          out.truncated = true
          scanTruncated = true
          stack.length = 0
          break
        }
        const batch = files.slice(i, i + 32)
        const stats = await Promise.all(batch.map((f) => safeStat(f)))
        for (let j = 0; j < batch.length; j++) {
          const st = stats[j]
          if (!st) {
            out.denied++
            continue
          }
          out.bytes += st.size
          out.files++
          const ext = path.extname(batch[j]).toLowerCase() || '(none)'
          out.byExt[ext] = (out.byExt[ext] || 0) + st.size
        }
        if (out.files > maxEntries) {
          out.truncated = true
          scanTruncated = true
          stack.length = 0
          break
        }
        await new Promise((resolve) => setImmediate(resolve))
      }
    } catch (error) {
      out.denied++
      if (errors && errors.length < 20) errors.push({ path: dir, code: (error && error.code) || 'EUNKNOWN' })
    } finally {
      try {
        await handle.close()
      } catch {}
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return out
}

const item = (id, kind, label, p, m, extra = {}) => ({
  id,
  kind,
  label,
  path: p,
  bytes: m.bytes,
  files: m.files,
  ...extra,
})

/** 采样一个 dir 下的一级子目录（用于会话按工作区分组、临时目录逐项列出）。 */
async function listSubdirs(dir, options = {}) {
  const rows = []
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return rows
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (options.filter && !options.filter(ent.name)) continue
    const full = path.join(dir, ent.name)
    const st = await safeStat(full)
    rows.push({ name: ent.name, path: full, mtimeMs: st ? st.mtimeMs : 0 })
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return rows
}

async function diskUsage(anchor) {
  try {
    const st = await fsp.statfs(anchor)
    const total = Number(st.bsize) * Number(st.blocks)
    const free = Number(st.bsize) * Number(st.bavail)
    if (!Number.isFinite(total) || total <= 0) return null
    return { totalBytes: total, freeBytes: Math.max(0, free) }
  } catch {
    return null
  }
}

async function hasOsTrash() {
  return process.platform === 'win32'
}

async function buildSnapshot() {
  const t0 = Date.now()
  scanDeadline = t0 + 15_000
  scanTruncated = false
  try {
    const snapshot = await buildSnapshotInner(t0)
    snapshot.truncated = scanTruncated
    return snapshot
  } finally {
    scanDeadline = 0
  }
}

async function buildSnapshotInner(t0) {
  const p = resolvePaths()
  const errors = []
  const categories = []

  // ---- 会话与文件 ----
  const convItems = []
  const sessionsDir = path.join(p.home, 'sessions')
  const attachmentDir = path.join(p.home, 'attachments')

  const sessions = await measure(sessionsDir, { errors })
  convItems.push(item('sessions', 'sessions', 'sessions', sessionsDir, sessions))

  const workspaceRows = await listSubdirs(sessionsDir)
  for (const row of workspaceRows.slice(0, 12)) {
    const m = await measure(row.path, { errors })
    convItems.push(
      item(`session:${row.name}`, 'workspace', row.name, row.path, m, { mtimeMs: row.mtimeMs }),
    )
  }

  const attachments = await measure(attachmentDir, { errors })
  const byExt = Object.entries(attachments.byExt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, bytes]) => ({ ext, bytes }))
  convItems.push(
    item('attachments', 'attachments', 'attachments', attachmentDir, attachments, { byExt }),
  )

  categories.push({
    id: 'conversations',
    action: 'manage',
    bytes: sessions.bytes + attachments.bytes,
    files: sessions.files + attachments.files,
    items: convItems,
  })

  // ---- 缓存与临时 ----
  const cacheItems = []
  const projCacheDir = path.join(p.home, 'storages')
  const projCache = await measure(projCacheDir, { errors })
  cacheItems.push(
    item('storages', 'storages', 'storages', projCacheDir, projCache, { cleanable: false }),
  )

  const thumbCacheDir = path.join(p.home, 'cache')
  const thumbCache = await measure(thumbCacheDir, { errors })
  cacheItems.push(
    item('cache', 'cache', 'cache', thumbCacheDir, thumbCache, { cleanable: thumbCache.bytes > 0 }),
  )

  const logsDir = path.join(p.home, 'logs')
  const logs = await measure(logsDir, { errors })
  let oldLogBytes = 0
  let oldLogFiles = 0
  try {
    for (const e of await fsp.readdir(logsDir, { withFileTypes: true })) {
      if (!e.isFile()) continue
      const st = await safeStat(path.join(logsDir, e.name))
      if (st && st.mtimeMs < Date.now() - 7 * DAY) {
        oldLogBytes += st.size
        oldLogFiles++
      }
    }
  } catch {}
  cacheItems.push(
    item('logs', 'logs', 'logs', logsDir, logs, {
      cleanable: oldLogBytes > 0,
      cleanableBytes: oldLogBytes,
      cleanableFiles: oldLogFiles,
    }),
  )

  const tempRows = await listSubdirs(p.temp, { filter: (name) => name.startsWith('dsh-') })
  let tempBytes = 0
  let tempFiles = 0
  for (const row of tempRows) {
    const m = await measure(row.path, { errors })
    tempBytes += m.bytes
    tempFiles += m.files
    const age = Date.now() - (row.mtimeMs || 0)
    // 只有"没有任何会话引用"的临时目录才允许清理：
    //   dsh-spill-* / dsh-subprocess-* / dsh-workspace-changes-* 会被旧会话的
    //   "完整输出见 <路径>"、"变更差异"引用，删了会让回看旧会话时打不开。
    const disposable = /^dsh-acl-skill-|^dsh-plugin-(compat|inspect)$/.test(row.name)
    const referenced = /^dsh-spill-|^dsh-subprocess-|^dsh-workspace-changes-/.test(row.name)
    cacheItems.push(
      item(`temp:${row.name}`, 'temp', row.name, row.path, m, {
        mtimeMs: row.mtimeMs,
        cleanable: disposable && age > DAY,
        reason: referenced
          ? '可能被旧会话引用（完整输出/变更差异），已跳过'
          : disposable
            ? age > DAY
              ? undefined
              : '24 小时内改动过，已跳过'
            : '非可再生临时目录，已跳过',
      }),
    )
  }

  const cacheBytes = projCache.bytes + thumbCache.bytes + logs.bytes + tempBytes
  const cacheFiles = projCache.files + thumbCache.files + logs.files + tempFiles
  categories.push({
    id: 'cache',
    action: 'clean',
    bytes: cacheBytes,
    files: cacheFiles,
    items: cacheItems,
  })

  // ---- 运行时与插件 ----
  const runtimeItems = []
  const runtimesDir = path.join(p.home, 'dsh-runtimes')
  const runtimes = await measure(runtimesDir, { errors })
  runtimeItems.push(item('runtimes', 'runtimes', 'runtimes', runtimesDir, runtimes))

  const toolsDir = path.join(p.home, 'tools')
  const tools = await measure(toolsDir, { errors })
  runtimeItems.push(item('tools', 'tools', 'tools', toolsDir, tools))

  if (p.profileDir) {
    const modulesDir = path.join(p.profileDir, 'node_modules')
    const modules = await measure(modulesDir, { errors })
    runtimeItems.push(item('plugins', 'plugins', 'plugins', modulesDir, modules))
  }

  const backupsDir = path.join(p.home, 'backups')
  const backups = await measure(backupsDir, { errors })
  runtimeItems.push(item('backups', 'backups', 'backups', backupsDir, backups))

  let installBytes = 0
  let installFiles = 0
  if (p.install) {
    const install = await measure(p.install, { errors, maxDepth: 16 })
    installBytes = install.bytes
    installFiles = install.files
    runtimeItems.push(
      item('install', 'install', 'install', p.install, { bytes: installBytes, files: installFiles }),
    )
  }

  const pluginsItem = runtimeItems.find((i) => i.kind === 'plugins')
  const runtimeBytes = runtimes.bytes + tools.bytes + backups.bytes +
    (pluginsItem ? pluginsItem.bytes : 0) + installBytes
  const runtimeFiles = runtimes.files + tools.files + backups.files +
    (pluginsItem ? pluginsItem.files : 0) + installFiles

  categories.push({
    id: 'runtime',
    action: 'none',
    bytes: runtimeBytes,
    files: runtimeFiles,
    items: runtimeItems,
  })

  const appTotal = categories.reduce((s, c) => s + c.bytes, 0)
  const disk = await diskUsage(p.home)

  return {
    scannedAt: Date.now(),
    durationMs: Date.now() - t0,
    platform: p.platform,
    incomplete: errors.length > 0,
    errors: errors.slice(0, 20),
    truncated: false,
    disk,
    app: {
      totalBytes: appTotal,
      installBytes,
      homeBytes: appTotal - (installBytes + tempBytes),
      tempBytes,
    },
    roots: {
      home: p.home,
      install: p.install,
      temp: p.temp,
      profile: p.profileDir,
    },
    categories,
  }
}

/* ------------------------------------------------------------------ */
/* 清理：白名单 + 24h 宽限 + dry-run + 部分失败如实上报                */
/* ------------------------------------------------------------------ */

async function cleanTargets(snapshot) {
  const p = resolvePaths()
  const targets = []
  if (!snapshot || !p.home) return targets
  const cacheCat = snapshot.categories.find((c) => c.id === 'cache')
  if (!cacheCat) return targets

  for (const it of cacheCat.items) {
    if (!it.cleanable) continue
    // 三类白名单，逐一校验路径归属，避免被伪造的 id 带出根外
    if (it.kind === 'temp') {
      if (!it.path.startsWith(p.temp) || !path.basename(it.path).startsWith('dsh-')) continue
      if (!within(p.temp, it.path)) continue
      targets.push({ path: it.path, bytes: it.bytes, files: it.files, kind: 'temp' })
    } else if (it.kind === 'cache') {
      if (!within(p.home, it.path)) continue
      targets.push({ path: it.path, bytes: it.bytes, files: it.files, kind: 'cache' })
    } else if (it.kind === 'logs') {
      if (!within(p.home, it.path)) continue
      targets.push({
        path: it.path,
        bytes: it.cleanableBytes != null ? it.cleanableBytes : it.bytes,
        files: it.cleanableFiles != null ? it.cleanableFiles : it.files,
        kind: 'logs',
      })
    }
  }
  return targets
}

async function removePath(target) {
  if (target.kind === 'logs') {
    // 日志只删 7 天前的文件，保留目录
    const cutoff = Date.now() - 7 * DAY
    let freed = 0
    let files = 0
    const failed = []
    let entries = []
    try {
      entries = await fsp.readdir(target.path, { withFileTypes: true })
    } catch {
      return { freed, files, failed }
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue
      const full = path.join(target.path, ent.name)
      const st = await safeStat(full)
      if (!st || st.mtimeMs > cutoff) continue
      try {
        await fsp.rm(full, { force: true })
        freed += st.size
        files++
      } catch (error) {
        failed.push({ path: full, code: (error && error.code) || 'EUNKNOWN' })
      }
    }
    return { freed, files, failed }
  }
  try {
    if (target.kind === 'cache') {
      // 保留 <home>/cache 目录本身，只删内容
      for (const ent of await fsp.readdir(target.path)) {
        await fsp.rm(path.join(target.path, ent), { recursive: true, force: true })
      }
      return { freed: target.bytes, files: target.files, failed: [] }
    }
    await fsp.rm(target.path, { recursive: true, force: true })
    return { freed: target.bytes, files: target.files, failed: [] }
  } catch (error) {
    return {
      freed: 0,
      files: 0,
      failed: [{ path: target.path, code: (error && error.code) || 'EUNKNOWN' }],
    }
  }
}

async function runClean(snapshot, { dryRun }) {
  const targets = await cleanTargets(snapshot)
  const total = targets.reduce((s, x) => s + x.bytes, 0)
  const files = targets.reduce((s, x) => s + x.files, 0)
  const result = {
    dryRun: Boolean(dryRun),
    freedBytes: total,
    files,
    targets: targets.map((x) => ({ path: x.path, bytes: x.bytes, kind: x.kind })),
    removed: [],
    failed: [],
    skipped: [],
  }
  if (dryRun) return result

  let freed = 0
  let removedFiles = 0
  for (const target of targets) {
    const r = await removePath(target)
    freed += r.freed
    removedFiles += r.files
    if (r.failed.length === 0) result.removed.push({ path: target.path, bytes: r.freed })
    else result.failed.push(...r.failed)
  }
  result.freedBytes = freed
  result.files = removedFiles
  return result
}

/* ------------------------------------------------------------------ */
/* 会话：归档列表 + 删除（移入回收站）                                 */
/* ------------------------------------------------------------------ */

async function readWorkspaceState() {
  const file = path.join(resolvePaths().home, 'storages', 'workspace.json')
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return { file, data: JSON.parse(raw) }
  } catch {
    return { file, data: null }
  }
}

async function writeWorkspaceState(file, data) {
  try {
    const backupDir = path.join(path.dirname(file), '..', '.storage-insight', 'backup')
    await fsp.mkdir(backupDir, { recursive: true })
    await fsp.copyFile(file, path.join(backupDir, path.basename(file) + '.bak'))
  } catch {}
  const tmp = file + '.storage-insight.tmp'
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  // 应用可能正持有 workspace.json；Windows 下改名会 EPERM/EBUSY，重试几次
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (error) {
      lastError = error
      const code = String((error && error.code) || '')
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
  try {
    await fsp.rm(tmp, { force: true })
  } catch {}
  throw lastError
}

/** 枚举磁盘上的会话目录：<home>/sessions/<workspaceKey>/<sessionId>/session.v4.jsonl.zstd */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 会话日志是多帧 zstd 拼接（每次追加一个 frame），不能整包解。
 * 标题事件通常在前几十帧内，逐帧解、命中即停。
 */
async function readSessionTitle(file) {
  const decompress = zlib.zstdDecompressSync
  if (typeof decompress !== 'function') return null
  let raw
  try {
    const st = await fsp.stat(file)
    const limit = Math.min(st.size, 4 * 1024 * 1024)
    const handle = await fsp.open(file, 'r')
    try {
      const buf = Buffer.alloc(limit)
      await handle.read(buf, 0, limit, 0)
      raw = buf
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }

  let cursor = 0
  let pending = ''
  while (cursor < raw.length) {
    const start = raw.indexOf(ZSTD_MAGIC, cursor)
    if (start < 0) break
    const next = raw.indexOf(ZSTD_MAGIC, start + 4)
    const end = next < 0 ? raw.length : next
    let chunk = ''
    try {
      chunk = decompress(raw.subarray(start, end)).toString('utf8')
    } catch {
      break
    }
    pending += chunk
    let nl = pending.indexOf('\n')
    while (nl >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (line.indexOf('"session/title"') >= 0) {
        try {
          const parsed = JSON.parse(line)
          const title = parsed && parsed.data && parsed.data.title
          if (typeof title === 'string' && title.trim()) return title.trim()
        } catch {}
      }
      nl = pending.indexOf('\n')
    }
    if (next < 0) break
    cursor = next
  }
  return null
}

async function readCacheTitle(cacheDir, id) {
  try {
    const name = String(id).replace(/^session-/, '')
    const file = path.join(cacheDir, name + '.json')
    const raw = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    const candidates = [parsed.title, parsed.record && parsed.record.title, parsed.record && parsed.record.summary]
    for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim()
  } catch {}
  return null
}

/**
 * 会话列表有三个来源，必须合并，否则会和侧边栏对不上：
 *   1. 磁盘目录 sessions/<ws>/<id>/            —— 有日志，可移动
 *   2. workspace.json 的 tables.workspaces[].sessionIds —— 应用自己的会话清单
 *   3. global.archivedSessionIds               —— 归档标记
 * 只存在于 2/3 的条目没有日志文件，删它等于"从索引移除"。
 */
async function scanSessions() {
  // 会话扫描不共享全盘扫描的截止时间，否则并发时会互相截断
  const saved = scanDeadline
  scanDeadline = 0
  try {
    return await scanSessionsInner()
  } finally {
    scanDeadline = saved
  }
}

async function scanSessionsInner() {
  const p = resolvePaths()
  const root = path.join(p.home, 'sessions')
  const cacheDir = path.join(p.home, 'storages', 'session_projcache', 'sessions')
  const state = await readWorkspaceState()
  const g = (state.data && state.data.global) || {}
  const archived = new Set(g.archivedSessionIds || [])
  const pinned = new Set(g.pinnedSessionIds || [])
  const tables = (state.data && state.data.tables && state.data.tables.workspaces) || {}

  const inList = new Map()
  for (const [key, ws] of Object.entries(tables)) {
    for (const sid of (ws && ws.sessionIds) || []) {
      inList.set(sid, { workspaceKey: key, workspacePath: ws.path, workspaceTitle: ws.title })
    }
  }

  const diskRows = new Map()
  let wsDirs = []
  try {
    wsDirs = await fsp.readdir(root, { withFileTypes: true })
  } catch {}
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(root, ws.name)
    let sessions = []
    try {
      sessions = await fsp.readdir(wsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const dir = path.join(wsDir, s.name)
      const m = await measure(dir, { maxDepth: 4 })
      const st = await safeStat(dir)
      diskRows.set(s.name, {
        dir,
        workspaceKey: ws.name,
        bytes: m.bytes,
        files: m.files,
        mtimeMs: st ? st.mtimeMs : 0,
      })
    }
  }

  const ids = new Set([...diskRows.keys(), ...inList.keys(), ...archived])
  const rows = []
  for (const id of ids) {
    const disk = diskRows.get(id)
    const meta = inList.get(id)
    const variants = [id, 'session-' + id, id.replace(/^session-/, '')]
    const isArchived = variants.some((x) => archived.has(x))

    let title = null
    if (disk) {
      const logFile = path.join(disk.dir, 'session.v4.jsonl.zstd')
      if (existsSync(logFile)) title = await readSessionTitle(logFile)
    }
    if (!title) title = await readCacheTitle(cacheDir, id)

    rows.push({
      id,
      title: title || undefined,
      archived: isArchived,
      pinned: variants.some((x) => pinned.has(x)),
      workspace: disk ? disk.workspaceKey : meta ? meta.workspaceKey : undefined,
      workspacePath: meta ? meta.workspacePath : undefined,
      path: disk ? disk.dir : undefined,
      bytes: disk ? disk.bytes : 0,
      files: disk ? disk.files : 0,
      mtimeMs: disk ? disk.mtimeMs : 0,
      hasLog: Boolean(disk),
    })
  }
  rows.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))

  const archivedRows = rows.filter((r) => r.archived)
  return {
    rows,
    archivedCount: archived.size,
    dangling: archivedRows.filter((r) => !r.hasLog).length,
    root,
    cacheDir,
  }
}

async function enrichTitles(rows, sessionQuery) {
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return { titled: rows, shape: null }
  try {
    const records = await sessionQuery.listSessions()
    if (!Array.isArray(records)) return { titled: rows, shape: 'not-array' }
    const shape = records.length ? Object.keys(records[0]) : []
    const byId = new Map()
    for (const r of records) {
      const header = (r && r.header) || r || {}
      const key = header.id || header.sessionId
      if (key) byId.set(String(key), header)
    }
    const titled = rows.map((row) => {
      const rec = byId.get(row.id) || byId.get('session-' + row.id)
      if (!rec) return row
      const fromRecord = rec.title || rec.name
      return { ...row, ...(fromRecord ? { title: fromRecord } : {}), recordId: rec.id }
    })
    return { titled, shape }
  } catch (error) {
    return { titled: rows, shape: 'error:' + String((error && error.message) || error) }
  }
}

/**
 * 本 Host 跑在 ELECTRON_RUN_AS_NODE 下，没有 Electron shell API，
 * 所以用 Windows 自带的 .NET 接口把目录送进系统回收站：
 * 路径通过环境变量传入，不拼进命令文本（避免注入）。
 */
function trashViaOs(target) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false)
    const script =
      '$p=$env:SI_TRASH_TARGET; Add-Type -AssemblyName Microsoft.VisualBasic; ' +
      '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, ' +
      '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, ' +
      '[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)'
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, SI_TRASH_TARGET: target },
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      return resolve(false)
    }
    let settled = false
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      done(false)
    }, 20_000)
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.removeAllListeners()
      } catch {}
      resolve(ok && !existsSync(target))
    }
    child.once('exit', (code) => done(code === 0))
    child.once('error', () => done(false))
  })
}

/** 优先系统回收站；不可用时退回插件自己的 .dsh/.trash。 */
async function moveToTrash(target, home, id) {
  if (await trashViaOs(target)) return { where: 'os-recycle-bin' }
  const trashRoot = path.join(home, '.trash', 'sessions')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(trashRoot, `${stamp}-${id}`)
  await fsp.mkdir(trashRoot, { recursive: true })
  await fsp.rename(target, dest)
  return { where: 'plugin-trash', movedTo: dest }
}
async function deleteSession(agents, id) {
  const p = resolvePaths()
  const scan = await scanSessions()
  const row = scan.rows.find((r) => r.id === id)
  if (!row) return { ok: false, error: 'session-not-found' }
  if (!row.archived) return { ok: false, error: 'not-archived' }

  const result = { ok: true, movedLog: false, removedIndex: 0, removedCache: false }

  if (row.path) {
    if (!within(scan.root, row.path)) return { ok: false, error: 'path-not-allowed' }
    try {
      const trashed = await moveToTrash(row.path, p.home, row.id)
      Object.assign(result, trashed)
      result.movedLog = true
    } catch (error) {
      const code = String((error && error.code) || error)
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return { ok: false, error: 'session-in-use' }
      }
      return { ok: false, error: code }
    }
  }

  // 投影缓存
  try {
    const cacheFile = path.join(scan.cacheDir, String(row.id).replace(/^session-/, '') + '.json')
    if (existsSync(cacheFile)) {
      await fsp.rm(cacheFile, { force: true })
      result.removedCache = true
    }
  } catch {}

  // 索引：归档 / 置顶 / 工作区会话清单
  const state = await readWorkspaceState()
  if (state.data && state.data.global) {
    const g = state.data.global
    const ids = new Set([row.id, 'session-' + row.id, row.id.replace(/^session-/, '')])
    const before = (g.archivedSessionIds || []).length
    g.archivedSessionIds = (g.archivedSessionIds || []).filter((x) => !ids.has(x))
    g.pinnedSessionIds = (g.pinnedSessionIds || []).filter((x) => !ids.has(x))
    result.removedIndex = before - g.archivedSessionIds.length

    const tables = state.data.tables && state.data.tables.workspaces
    if (tables) {
      for (const ws of Object.values(tables)) {
        if (Array.isArray(ws.sessionIds)) {
          ws.sessionIds = ws.sessionIds.filter((x) => !ids.has(x))
        }
      }
    }
    try {
      await writeWorkspaceState(state.file, state.data)
    } catch {
      result.warning = 'index-update-failed'
    }
  }

  return result
}

/* ------------------------------------------------------------------ */
/* HTTP 接口                                                          */
/* ------------------------------------------------------------------ */

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        resolve({})
        req.destroy()
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

export const inject = ['webServer']

export function apply(ctx) {
  let disposeRoute = null
  try {
    const webServer = ctx.get('webServer')
    if (!webServer) {
      console.error('[storage-insight] webServer unavailable; routes not registered')
      return
    }

    let cache = null
    let scanPromise = null

    const handler = async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'

        // 隐私边界：接口会返回绝对路径与会话标题，因此只接受本机回环连接。
        // dsh 若被绑定到 0.0.0.0 或放在反代后，局域网/公网访问一律拒绝。
        const remote = (req.socket && req.socket.remoteAddress) || ''
        const peerLoopback =
          !remote ||
          remote === '127.0.0.1' ||
          remote === '::1' ||
          remote === '::ffff:127.0.0.1'
        if (!peerLoopback) {
          json(res, 403, { ok: false, error: 'loopback-only' })
          return
        }

        // CSRF 防线：只拦"跨站浏览器请求"。本机进程本来就能直接读写这些文件，
        // 拦它没有意义，而且会误伤桌面壳（dsh-app:// 转发时可能丢自定义头）。
        // 浏览器发出的跨站 POST 一定带 Origin 与 Sec-Fetch-Site: cross-site。
        const origin = req.headers.origin
        const hostHeader = req.headers.host
        const secFetch = req.headers['sec-fetch-site']
        const explicit = req.headers['x-storage-insight'] === '1'
        let sameOrigin = false
        if (origin && hostHeader) {
          try {
            sameOrigin = new URL(origin).host === hostHeader
          } catch {
            sameOrigin = false
          }
        }
        const fromBrowser = Boolean(origin) || Boolean(secFetch)
        const allowed =
          explicit || sameOrigin || secFetch === 'same-origin' || secFetch === 'none' || !fromBrowser
        if (!allowed) {
          json(res, 403, { ok: false, error: 'forbidden' })
          return
        }

        if (sub === '/snapshot') {
          const body = req.method === 'POST' ? await readBody(req) : {}
          const force = body && body.force === true
          if (!force && cache && Date.now() - cache.at < 60_000) {
            json(res, 200, { ok: true, snapshot: cache.value, cached: true })
            return
          }
          if (!scanPromise) {
            scanPromise = buildSnapshot().finally(() => {
              scanPromise = null
            })
          }
          const snapshot = await scanPromise
          cache = { at: Date.now(), value: snapshot }
          json(res, 200, { ok: true, snapshot, cached: false })
          return
        }

        if (sub === '/clean') {
          const body = req.method === 'POST' ? await readBody(req) : {}
          const dryRun = body.dryRun !== false
          let snapshot = cache ? cache.value : null
          if (!snapshot || Date.now() - cache.at > 60_000) {
            snapshot = await buildSnapshot()
            cache = { at: Date.now(), value: snapshot }
          }
          const result = await runClean(snapshot, { dryRun })
          if (!dryRun) cache = null
          json(res, 200, { ok: true, result })
          return
        }

        if (sub === '/reveal') {
          const body = req.method === 'POST' ? await readBody(req) : {}
          const target = typeof body.path === 'string' ? body.path : ''
          const p = resolvePaths()
          const allowed = [p.home, p.temp, p.install].filter(Boolean)
          if (!target || !allowed.some((root) => within(root, target))) {
            json(res, 400, { ok: false, error: 'path-not-allowed' })
            return
          }
          if (process.platform !== 'win32') {
            json(res, 400, { ok: false, error: 'unsupported-platform' })
            return
          }
          try {
            const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' })
            child.unref()
            json(res, 200, { ok: true })
          } catch (error) {
            json(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
          return
        }

        if (sub === '/sessions') {
          const scan = await scanSessions()
          const { titled, shape } = await enrichTitles(scan.rows, ctx.get('sessionQuery'))
          json(res, 200, {
            ok: true,
            sessions: titled,
            archivedCount: scan.archivedCount,
            dangling: scan.dangling,
            shape,
            caps: {
              node: process.versions.node,
              zstd: typeof zlib.zstdDecompressSync === 'function',
              osTrash: await hasOsTrash(),
            },
            root: scan.root,
          })
          return
        }

        if (sub === '/clean-dangling') {
          if (req.method !== 'POST') {
            res.setHeader('allow', 'POST')
            json(res, 405, { ok: false, error: 'post-required' })
            return
          }
          const scan = await scanSessions()
          const state = await readWorkspaceState()
          if (!state.data || !state.data.global) {
            json(res, 400, { ok: false, error: 'workspace-state-missing' })
            return
          }
          const onDisk = new Set(scan.rows.flatMap((r) => [r.id, 'session-' + r.id, r.id.replace(/^session-/, '')]))
          const g = state.data.global
          const before = (g.archivedSessionIds || []).length
          g.archivedSessionIds = (g.archivedSessionIds || []).filter((id) => onDisk.has(id))
          try {
            await writeWorkspaceState(state.file, state.data)
          } catch (error) {
            json(res, 500, { ok: false, error: String((error && error.code) || error) })
            return
          }
          json(res, 200, { ok: true, removed: before - g.archivedSessionIds.length })
          return
        }
        if (sub === '/delete-session') {
          if (req.method !== 'POST') {
            res.setHeader('allow', 'POST')
            json(res, 405, { ok: false, error: 'post-required' })
            return
          }
          const body = req.method === 'POST' ? await readBody(req) : {}
          const result = await deleteSession(ctx.get('agents'), String(body.id || ''))
          json(res, result.ok ? 200 : 400, result.ok ? { ok: true, ...result } : result)
          return
        }
        if (sub === '/delete-all-archived') {
          if (req.method !== 'POST') {
            res.setHeader('allow', 'POST')
            json(res, 405, { ok: false, error: 'post-required' })
            return
          }
          const p = resolvePaths()
          const scan = await scanSessions()
          let state = await readWorkspaceState()
          if (!state.data || !state.data.global) {
            json(res, 400, { ok: false, error: 'workspace-state-missing' })
            return
          }
          const archivedIds = new Set((state.data.global.archivedSessionIds) || [])
          const variants = new Set()
          for (const id of archivedIds) {
            variants.add(id)
            variants.add('session-' + id)
            variants.add(String(id).replace(/^session-/, ''))
          }

          let movedLogs = 0
          let movedBytes = 0
          let cacheRemoved = 0
          const failed = []
          for (const row of scan.rows.filter((r) => r.archived)) {
            if (row.path) {
              try {
                await moveToTrash(row.path, p.home, row.id)
                movedLogs++
                movedBytes += row.bytes || 0
              } catch (error) {
                failed.push({ id: row.id, code: String((error && error.code) || error) })
              }
            }
            try {
              const cf = path.join(scan.cacheDir, String(row.id).replace(/^session-/, '') + '.json')
              if (existsSync(cf)) {
                await fsp.rm(cf, { force: true })
                cacheRemoved++
              }
            } catch {}
          }

          const fresh = await readWorkspaceState()
          if (fresh.data && fresh.data.global) state = fresh
          const g = state.data.global
          g.archivedSessionIds = (g.archivedSessionIds || []).filter((x) => !variants.has(x))
          g.pinnedSessionIds = (g.pinnedSessionIds || []).filter((x) => !variants.has(x))
          const tables = state.data.tables && state.data.tables.workspaces
          if (tables) {
            for (const ws of Object.values(tables)) {
              if (Array.isArray(ws.sessionIds)) {
                ws.sessionIds = ws.sessionIds.filter((x) => !variants.has(x))
              }
            }
          }
          try {
            await writeWorkspaceState(state.file, state.data)
          } catch (error) {
            json(res, 500, { ok: false, error: 'index-write-failed' })
            return
          }

          json(res, 200, {
            ok: true,
            removed: archivedIds.size,
            movedLogs,
            movedBytes,
            cacheRemoved,
            failed,
          })
          return
        }

        json(res, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        json(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }

    disposeRoute = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    })
    ctx.effect(() => () => {
      if (disposeRoute) disposeRoute()
    }, 'storage-insight: http route')
  } catch (error) {
    // 绝不让注册失败冒泡成插件加载失败（保护 Host 启动）
    console.error('[storage-insight] apply failed:', error)
  }
}
