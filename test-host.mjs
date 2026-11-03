import { readFileSync } from 'node:fs'
/**
 * 不装插件也能验证 host 逻辑：用假 ctx / 假 req / 假 res 直接驱动 apply()。
 * 跑法：node storage-insight/test-host.mjs
 */
process.argv[1] = 'C:\\\\Users\\\\19155\\\\AppData\\\\Local\\\\Programs\\\\DeepSeek Harness\\\\resources\\\\app.asar\\\\dsh\\\\node_modules\\\\@deepseek-ai\\\\dsh\\\\index.js'
const { apply } = await import('./index.js')

const routes = []
const effects = []
const ctx = {
  get(key) {
    if (key === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => routes.splice(routes.indexOf(route), 1)
        },
      }
    }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
}

apply(ctx)

if (routes.length !== 1) {
  console.error('FAIL: route not registered', routes.length)
  process.exit(1)
}
console.log(`PASS route registered: ${routes[0].kind} ${routes[0].path}`)

function fakeRes() {
  const out = { statusCode: 0, headers: {}, body: '' }
  return {
    out,
    get statusCode() { return out.statusCode },
    set statusCode(v) { out.statusCode = v },
    setHeader(k, v) {
      out.headers[k] = v
    },
    end(chunk) {
      out.body = chunk || ''
    },
  }
}

async function call(sub) {
  const res = fakeRes()
  const req = { method: 'GET', url: '/storage-insight/api' + sub, on() {}, headers: { 'x-storage-insight': '1' } }
  await routes[0].handler(req, res)
  return { status: res.out.statusCode, json: JSON.parse(res.out.body) }
}

const t0 = Date.now()
const snap = await call('/snapshot')
if (snap.status !== 200 || !snap.json.ok) {
  console.error('FAIL snapshot', snap.status, snap.json)
  process.exit(1)
}

const s = snap.json.snapshot
const fmt = (b) => (b / 1024 ** 3).toFixed(2) + ' GB'
const sumCats = s.categories.reduce((acc, c) => acc + c.bytes, 0)

console.log('\n--- snapshot ---')
console.log(`roots.home    = ${s.roots.home}`)
console.log(`roots.install = ${s.roots.install}`)
console.log(`roots.temp    = ${s.roots.temp}`)
console.log(`roots.profile = ${s.roots.profile}`)
console.log(`disk          = ${s.disk ? fmt(s.disk.totalBytes) + ' total / ' + fmt(s.disk.freeBytes) + ' free' : 'unavailable'}`)
console.log(`app.total     = ${fmt(s.app.totalBytes)} (install ${fmt(s.app.installBytes)}, temp ${fmt(s.app.tempBytes)})`)
for (const c of s.categories) {
  console.log(`  ${c.id.padEnd(14)} ${fmt(c.bytes).padStart(9)}  items=${c.items.length} files=${c.files}`)
}
console.log(`duration      = ${s.durationMs} ms (round trip ${Date.now() - t0} ms)`)

const checks = [
  ['三类之和 = 总量', Math.abs(sumCats - s.app.totalBytes) < 1024, `${sumCats} vs ${s.app.totalBytes}`],
  ['安装根已定位', Boolean(s.roots.install), s.roots.install || 'null'],
  ['DSH_HOME 已定位', Boolean(s.roots.home), s.roots.home],
  ['磁盘信息可用', Boolean(s.disk), s.disk ? 'yes' : 'no'],
  ['有会话/缓存/运行时三类', s.categories.length === 3, s.categories.map((c) => c.id).join(',')],
  ['扫描耗时 < 8s', s.durationMs < 8000, `${s.durationMs} ms`],
]

const dry = await call('/clean')
const dryOk = dry.status === 200 && dry.json.ok && dry.json.result.targets.length >= 0
checks.push(['dry-run 可调用', dryOk, dryOk ? `${dry.json.result.targets.length} targets, ${fmt(dry.json.result.freedBytes)}` : 'failed'])

const nonLoopback = await (async () => {
  const res = fakeRes()
  const req = {
    method: 'GET',
    url: '/storage-insight/api/sessions',
    headers: {},
    on() {},
    socket: { remoteAddress: '10.0.0.5' },
  }
  await routes[0].handler(req, res)
  return { status: res.out.statusCode, json: JSON.parse(res.out.body) }
})()
checks.push([
  '非本机来源被拒',
  nonLoopback.status === 403 && nonLoopback.json.error === 'loopback-only',
  String(nonLoopback.status),
])

const badReveal = await (async () => {
  const res = fakeRes()
  const req = { method: 'GET', url: '/storage-insight/api/reveal', on() {}, headers: { 'x-storage-insight': '1' } }
  await routes[0].handler(req, res)
  return { status: res.out.statusCode, json: JSON.parse(res.out.body) }
})()
checks.push(['reveal 空路径被拒', badReveal.status === 400, String(badReveal.status)])

// 改名最容易漏的三处必须一致，否则 boot 时 row 解析不到模块
const pkgName = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
const patchText = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
const patchName = (patchText.match(/name:\s*'([^']+)'/) || [])[1]
const clientText = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const clientId = (clientText.match(/id:\s*'([^']+)'/) || [])[1]
checks.push(['patch 行名 = 包名', patchName === pkgName, `${patchName} vs ${pkgName}`])
checks.push(['client id = 包名', clientId === pkgName, `${clientId} vs ${pkgName}`])

console.log('')
let ok = 0
for (const [name, pass, detail] of checks) {
  if (pass) ok++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
}
console.log(`\n${ok}/${checks.length} checks passed`)

for (const d of effects) {
  if (typeof d === 'function') d()
}
process.exit(ok === checks.length ? 0 : 1)
