/**
 * 真正把组件跑一遍：迷你 hooks + 递归渲染，喂真实快照，
 * 断言渲染不抛错、关键文案与数字都出现。避免"装上去白屏"。
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

let captured = null
globalThis.window = { __ModuleLoader__: { load: (m) => (captured = m) } }
globalThis.document = {
  baseURI: 'http://127.0.0.1:64280/',
  head: { appendChild() {}, removeChild() {} },
  body: { hasAttribute: () => false, addEventListener() {} },
  addEventListener() {},
  removeEventListener() {},
  createElement: () => ({ dataset: {}, remove() {} }),
}
new Function('window', 'document', source)(globalThis.window, globalThis.document)

// ---- 迷你 hooks 运行时：每个组件函数一份独立槽位 ----
const stores = new Map()
let store = null
let cursor = 0
let globalDirty = false

function storeFor(fn) {
  let s = stores.get(fn)
  if (!s) {
    s = { values: [], effects: [], refs: [], dirty: false }
    stores.set(fn, s)
  }
  return s
}

class Component {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }
}
Component.prototype.isReactComponent = {}

const React = {
  Component,
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(initial) {
    const i = cursor++
    if (!(i in store.values)) store.values[i] = typeof initial === 'function' ? initial() : initial
    const owner = store
    const setter = (next) => {
      const value = typeof next === 'function' ? next(owner.values[i]) : next
      if (value !== owner.values[i]) {
        owner.values[i] = value
        owner.dirty = true
        globalDirty = true
      }
    }
    return [store.values[i], setter]
  },
  useEffect(fn) {
    const i = cursor++
    store.effects[i] = fn
  },
  useMemo(fn) {
    cursor++
    return fn()
  },
  useCallback(fn) {
    cursor++
    return fn
  },
  useRef(value) {
    const i = cursor++
    if (!(i in store.refs)) store.refs[i] = { current: value }
    return store.refs[i]
  },
}

const locale = {
  register: () => () => {},
  bind: () => (key) => key,
  subscribe: () => () => {},
}

let slotsReg = null
const mod = captured.factory((id) => (id === 'react' ? React : {}))
mod.apply({
  locale,
  slots: {
    inject: (key, cb) => {
      cb()
      return () => {}
    },
    register: (options, component) => {
      slotsReg = { options, component }
      return () => {}
    },
  },
  effect: (fn) => fn(),
})

if (!slotsReg) {
  console.error('FAIL no slot registration')
  process.exit(1)
}

// ---- 真实快照（从运行中的 Host 取）----
const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:64280'
const res = await fetch(baseUrl + '/storage-insight/api/snapshot', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-storage-insight': '1' },
  body: '{"force":true}',
})
const payload = await res.json()
const snapshot = payload.snapshot
if (!snapshot) {
  console.error('FAIL no snapshot from host')
  process.exit(1)
}
console.log(`host snapshot: ${(snapshot.app.totalBytes / 1024 ** 3).toFixed(2)} GB, ${snapshot.categories.length} categories`)

// fetch 桩：把 Host 真实数据喂给组件
const sessionsFixture = {
  ok: true,
  archivedCount: 1,
  dangling: 3,
  sessions: [
    {
      id: 'session-archived-1',
      archived: true,
      title: '被归档的对话',
      workspace: '--C-Users-demo--',
      path: 'C:\\\\fake\\\\session-archived-1',
      bytes: 524288,
      files: 1,
      mtimeMs: Date.now() - 86400000,
    },
  ],
}
globalThis.fetch = async (url) => {
  const target = String(url)
  const payload = target.includes('/sessions')
    ? sessionsFixture
    : target.includes('/snapshot')
      ? { ok: true, snapshot }
      : { ok: true }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(payload),
  }
}

// ---- 迷你渲染：函数组件递归展开 ----
const clickables = []
function flattenText(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  return (node.children || []).map(flattenText).join('')
}
function renderNode(node) {
  if (node == null || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderNode).filter(Boolean).join('')
  if (typeof node.type === 'function' && node.type.prototype && node.type.prototype.isReactComponent) {
    const childNodes = (node.children || []).filter((c) => c != null)
    const props = {
      ...node.props,
      children: childNodes.length === 1 ? childNodes[0] : childNodes,
    }
    const instance = new node.type(props)
    instance.props = props
    if (!instance.state) instance.state = {}
    return renderNode(instance.render())
  }
  if (typeof node.type === 'function') {
    const previousStore = store
    const previousCursor = cursor
    store = storeFor(node.type)
    cursor = 0
    const rendered = node.type({ ...node.props, children: node.children })
    const out = renderNode(rendered)
    store = previousStore
    cursor = previousCursor
    return out
  }
  if (node.props && typeof node.props.onClick === 'function') clickables.push(node)
  return (node.children || []).map(renderNode).join('')
}

let html = ''
try {
  for (let round = 0; round < 8; round++) {
    for (const s of stores.values()) s.dirty = false
    globalDirty = false
    store = null
    cursor = 0
    html = renderNode(slotsReg.component({ close() {} })) || ''
    for (const s of stores.values()) {
      for (const fn of s.effects) if (typeof fn === 'function') fn()
      s.effects = []
    }
    await new Promise((r) => setTimeout(r, 40))
    if (!globalDirty) break
  }
} catch (error) {
  console.error('FAIL render threw:', error && error.stack ? error.stack : error)
  process.exit(1)
}

const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const total = (snapshot.app.totalBytes / 1024 ** 3).toFixed(2) + ' GB'
const expect = [
  ['标题渲染', text.includes('title')],
  ['总量数字 = Host 总量', text.includes(total), total],
  ['三张卡片都在', ['cat.conversations', 'cat.cache', 'cat.runtime'].every((k) => text.includes(k))],
  ['图例三项都在', ['legend.app', 'legend.other', 'legend.free'].every((k) => text.includes(k))],
  ['磁盘占比文案在', text.includes('ratio')],
  ['刷新/清理按钮在', text.includes('rescan') && (text.includes('action.clean') || text.includes('action.nothing'))],
  ['没有落到错误态', !text.includes('loadFailed')],
]

// ---- 第二阶段：点「管理」，验证归档会话组真的渲染出来 ----
const manageBtn = clickables.find((b) => flattenText(b).includes('action.manage'))
if (!manageBtn) {
  console.error('FAIL 找不到「管理」按钮')
  process.exit(1)
}
manageBtn.props.onClick()

let html2 = ''
for (let round = 0; round < 8; round++) {
  for (const s of stores.values()) s.dirty = false
  globalDirty = false
  store = null
  cursor = 0
  clickables.length = 0
  html2 = renderNode(slotsReg.component({ close() {} })) || ''
  for (const s of stores.values()) {
    for (const fn of s.effects) if (typeof fn === 'function') fn()
    s.effects = []
  }
  await new Promise((r) => setTimeout(r, 40))
  if (!globalDirty) break
}
const text2 = html2.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
expect.push(
  ['管理页渲染成功', text2.includes('manage.conversations.intro')],
  ['归档分组出现', text2.includes('group.archived')],
  ['归档会话标题', text2.includes('被归档的对话')],
  ['删除按钮出现', text2.includes('action.delete')],
  ['失效记录提示', text2.includes('archived.dangling')],
)
// ---- 第三阶段：点「删除」，确认框必须出现 ----
const delBtn = clickables.find((b) => flattenText(b).includes('action.delete'))
if (!delBtn) {
  console.error('FAIL 找不到删除按钮')
  process.exit(1)
}
delBtn.props.onClick()

let html3 = ''
for (let round = 0; round < 8; round++) {
  for (const s of stores.values()) s.dirty = false
  globalDirty = false
  store = null
  cursor = 0
  clickables.length = 0
  html3 = renderNode(slotsReg.component({ close() {} })) || ''
  for (const s of stores.values()) {
    for (const fn of s.effects) if (typeof fn === 'function') fn()
    s.effects = []
  }
  await new Promise((r) => setTimeout(r, 40))
  if (!globalDirty) break
}
const text3 = html3.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
expect.push(
  ['点删除后出现确认框', text3.includes('delete.title')],
  ['确认框说明移入回收站', text3.includes('delete.confirm')],
  ['确认框可取消', text3.includes('clean.cancel')],
)
let ok = 0
for (const [name, pass, detail] of expect) {
  if (pass) ok++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
}
console.log(`\nrendered ${html.length} chars; ${ok}/${expect.length} checks passed`)
process.exit(ok === expect.length ? 0 : 1)
