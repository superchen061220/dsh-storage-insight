/**
 * 不装插件也能验证 client 半边：伪造 window.__ModuleLoader__ + React + ctx，
 * 确认模块能被加载、apply 能完成注册、文案字典齐全。
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      captured = module
    },
  },
}
globalThis.document = {
  baseURI: 'http://127.0.0.1:64280/',
  head: { appendChild() {}, removeChild() {} },
  body: { hasAttribute: () => false },
  createElement: () => ({ dataset: {}, remove() {} }),
}

// 以 <script> 方式执行（client.js 是浏览器模块格式，不是 ESM 导入）
new Function('window', 'document', source)(globalThis.window, globalThis.document)

if (!captured) {
  console.error('FAIL module loader was not called')
  process.exit(1)
}
console.log(`PASS loader id: ${captured.id}`)

const calls = { localeRegister: [], slotRegister: [], effects: 0, injections: [] }
const fakeLocale = {
  register(ns, locale, dict) {
    calls.localeRegister.push({ ns, locale, keys: Object.keys(dict).length })
    return () => {}
  },
  bind() {
    return (key) => key
  },
  subscribe() {
    return () => {}
  },
}
const fakeSlots = {
  inject(key, callback) {
    calls.injections.push(key)
    callback()
    return () => {}
  },
  register(options) {
    calls.slotRegister.push(options)
    return () => {}
  },
}
const ctx = {
  locale: fakeLocale,
  slots: fakeSlots,
  effect(fn) {
    calls.effects++
    const dispose = fn()
    return dispose
  },
}

class FakeComponent {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }
}
FakeComponent.prototype.isReactComponent = {}

const fakeReact = {
  Component: FakeComponent,
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

const mod = captured.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error('unexpected require: ' + id)
})

if (!mod || typeof mod.apply !== 'function') {
  console.error('FAIL factory did not return { apply }')
  process.exit(1)
}
console.log(`PASS factory exports: inject=[${mod.inject.join(', ')}]`)

mod.apply(ctx)

const reg = calls.slotRegister[0]
const zh = calls.localeRegister.find((r) => r.locale === 'zh')
const en = calls.localeRegister.find((r) => r.locale === 'en')

const checks = [
  ['注册了一个 settings.section', calls.slotRegister.length === 1, calls.slotRegister.length],
  ['slot 名正确', reg && reg.name === 'settings.section', reg && reg.name],
  ['id 唯一且为 storage-insight', reg && reg.id === 'storage-insight', reg && reg.id],
  ['order = 30', reg && reg.order === 30, reg && reg.order],
  ['label 是 thunk', reg && typeof reg.label === 'function', reg && typeof reg.label],
  ['先 wait 再声明 settings.section', calls.injections[0] === 'settings.section', calls.injections.join(',')],
  ['zh / en 字典都注册了', Boolean(zh && en), `${zh && zh.keys} / ${en && en.keys}`],
  ['中英条目数一致', Boolean(zh && en && zh.keys === en.keys), `${zh && zh.keys} vs ${en && en.keys}`],
  ['effect 注册了 3 处资源（字典×2 + 样式）', calls.effects === 3, calls.effects],
]

let ok = 0
for (const [name, pass, detail] of checks) {
  if (pass) ok++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
}
console.log(`\n${ok}/${checks.length} checks passed`)
process.exit(ok === checks.length ? 0 : 1)
