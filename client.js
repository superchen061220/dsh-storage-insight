/**
 * Client half of the Storage Insight bundle.
 *
 * 只做三件事：
 *  1. 往 settings.section 注册一页「存储空间」
 *  2. 读 Host 的 /storage-insight/api/* 拿本机真实数字
 *  3. 用 DSH 的 token 渲染环图 / 三卡 / 明细 / 清理确认
 *
 * 所有可见文案走 ctx.locale；所有颜色走 --dsw-alias-*（环图三段除外）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-storage-insight',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const NS = 'storageInsight'

    const DICT = {
      zh: {
        nav: '存储空间',
        title: '存储空间',
        intro: '查看 DeepSeek Harness 在本机占用的磁盘空间，并安全回收可重建的临时数据。',
        rescan: '刷新',
        scanned: '上次扫描 {time}',
        scanning: '正在扫描…',
        'cat.conversations': '会话与文件',
        'cat.conversations.desc': '会话日志、附件与下载的文件。',
        'cat.cache': '缓存与临时数据',
        'cat.cache.desc': '扫描、缩略图与会话重建产生的临时数据，清理不影响正常使用。',
        'cat.runtime': '运行时与插件',
        'cat.runtime.desc': '内置运行时、工具链与已安装插件；程序本体另计入总量。',
        'legend.app': 'Harness 已用',
        'legend.other': '其他程序',
        'legend.free': '可用空间',
        ratio: '占电脑存储 {pct}',
        'action.manage': '管理',
        'action.clean': '清理',
        'action.view': '查看',
        'action.open': '打开',
        'action.back': '存储空间',
        'clean.title': '清理缓存与临时数据',
        'clean.desc': '将释放 {size}（{count} 个文件）。会话、附件与已安装插件不受影响；24 小时内改动过的临时目录会跳过。',
        'clean.cancel': '取消',
        'clean.confirm': '确认清理',
        'clean.done': '已释放 {size}',
        'clean.none': '没有可清理的项目',
        'action.nothing': '无可清理',
        cleaned: '已清理',
        incomplete: '部分目录无法读取，数值可能偏小',
        unknown: '未知',
        empty: '暂无可列出的明细',
        loadFailed: '读取失败：{msg}',
        revealFailed: '无法打开目录',
        'manage.conversations.intro': '会话内容是唯一事实来源，这里只提供查看与打开目录。',
        'manage.runtime.intro': '这部分是运行必需的组件，清理不会释放空间；如需回收请在插件页卸载。',
        'group.sessions': '会话日志',
        'group.workspace': '按工作区',
        'group.attachments': '附件',
        'group.runtimes': '内置运行时',
        'group.tools': '工具链',
        'group.plugins': '已安装插件',
        'group.backups': '安装回滚备份',
        'group.install': '程序本体',
        'group.storages': '会话投影缓存（可重建，不清理）',
        'group.cache': '缩略图缓存',
        'group.logs': '日志（仅清 7 天前）',
        'group.temp': '临时目录（仅清 24 小时前）',
        'disk.na': '磁盘信息不可用',
        'unit.items': '{n} 个文件',
        'cat.cleanable': '可释放 {size}',
        'group.archived': '已归档会话',
        'action.delete': '删除',
        'archived.dangling': '其中 {n} 条没有本地日志文件，删除只清理索引。',
        'archived.indexOnly': '无本地文件 · 仅索引',
        'action.cleanRecords': '清理失效记录',
        'delete.title': '删除这个会话？',
        'delete.body': '会话「{name}」会移入系统回收站，可从 Windows 回收站还原；系统回收站不可用时落到 .dsh/.trash/sessions。',
        'delete.body.other': '会话「{name}」会移入 .dsh/.trash/sessions（当前系统没有可用的系统回收站），可手动找回。',
        'delete.confirm': '移入回收站',
        'delete.done': '已移入回收站',
        'delete.failed': '删除失败：{msg}',
        'delete.errNotFound': '会话已不存在（可能刚被删除）',
        'delete.errInUse': '会话正在被使用，暂不能删除',
        'delete.errPath': '路径不在允许范围内',
        'records.cleaned': '已清理 {n} 条失效记录',
      },
      en: {
        nav: 'Storage',
        title: 'Storage',
        intro: "See how much disk space DeepSeek Harness uses on this machine, and reclaim rebuildable temporary data safely.",
        rescan: 'Rescan',
        scanned: 'Scanned {time}',
        scanning: 'Scanning…',
        'cat.conversations': 'Conversations & files',
        'cat.conversations.desc': 'Session logs, attachments and downloaded files.',
        'cat.cache': 'Cache & temporary data',
        'cat.cache.desc': 'Temporary data from scanning, thumbnails and replay; safe to remove.',
        'cat.runtime': 'Runtime & plugins',
        'cat.runtime.desc': 'Bundled runtimes, toolchain and installed plugins; app files count into the total.',
        'legend.app': 'Harness',
        'legend.other': 'Other apps',
        'legend.free': 'Free',
        ratio: '{pct} of this disk',
        'action.manage': 'Manage',
        'action.clean': 'Clean',
        'action.view': 'View',
        'action.open': 'Open',
        'action.back': 'Storage',
        'clean.title': 'Clean cache and temporary data',
        'clean.desc': 'Frees {size} ({count} files). Sessions, attachments and plugins are untouched; temp folders changed within 24 hours are skipped.',
        'clean.cancel': 'Cancel',
        'clean.confirm': 'Clean now',
        'clean.done': 'Freed {size}',
        'clean.none': 'Nothing to clean',
        'action.nothing': 'Nothing to clean',
        cleaned: 'Cleaned',
        incomplete: 'Some folders were unreadable; totals may be low',
        unknown: 'Unknown',
        empty: 'No details to show',
        loadFailed: 'Could not load: {msg}',
        revealFailed: 'Could not open the folder',
        'manage.conversations.intro': 'Session logs are the only source of truth; this page only shows them and opens folders.',
        'manage.runtime.intro': 'These are required to run; cleaning will not free them. Uninstall unused plugins instead.',
        'group.sessions': 'Session logs',
        'group.workspace': 'By workspace',
        'group.attachments': 'Attachments',
        'group.runtimes': 'Bundled runtimes',
        'group.tools': 'Toolchain',
        'group.plugins': 'Installed plugins',
        'group.backups': 'Rollback backups',
        'group.install': 'Application files',
        'group.storages': 'Replay cache (rebuildable, kept)',
        'group.cache': 'Thumbnail cache',
        'group.logs': 'Logs (older than 7 days)',
        'group.temp': 'Temp folders (older than 24 hours)',
        'disk.na': 'Disk information unavailable',
        'unit.items': '{n} files',
        'cat.cleanable': '{size} reclaimable',
        'group.archived': 'Archived sessions',
        'action.delete': 'Delete',
        'archived.dangling': '{n} of them have no local log file; deleting only clears the index.',
        'archived.indexOnly': 'Index only (no local file)',
        'action.cleanRecords': 'Clean stale records',
        'delete.title': 'Delete this session?',
        'delete.body': 'Session {name} goes to the system Recycle Bin (restorable); if unavailable it falls back to .dsh/.trash/sessions.',
        'delete.body.other': 'Session {name} moves to .dsh/.trash/sessions (no system recycle bin here); you can restore it manually.',
        'delete.confirm': 'Move to trash',
        'delete.done': 'Moved to trash',
        'delete.failed': 'Delete failed: {msg}',
        'delete.errNotFound': 'Session no longer exists',
        'delete.errInUse': 'Session is currently in use',
        'delete.errPath': 'Path is outside the allowed roots',
        'records.cleaned': 'Removed {n} stale records',
      },
    }

    const CSS = `
.si-section{max-width:760px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}
.si-head{display:flex;align-items:center;gap:8px}
.si-head h2{margin:0;font-size:18px;font-weight:600;line-height:26px}
.si-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.si-spacer{flex:1}
.si-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.si-warn{display:flex;gap:6px;align-items:flex-start;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
.si-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer;white-space:nowrap;font-family:inherit}
.si-btn.si-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.si-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.si-btn:disabled{opacity:.4;cursor:not-allowed}
.si-btn.si-outline{border:.5px solid var(--dsw-alias-border-l3)}
.si-btn.si-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.si-btn.si-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.si-btn:focus-visible,.si-navbtn:focus-visible,.si-rowbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.si-donut-block{display:flex;flex-direction:column;align-items:center;gap:14px;padding:6px 0 2px}
.si-donut-wrap{position:relative;width:200px;height:200px}
.si-donut{display:block;width:100%;height:100%;transform:rotate(-90deg)}
.si-donut circle{fill:none;stroke-width:20;stroke-linecap:butt}
.si-donut .si-track{stroke:var(--si-arc-free)}
.si-donut .si-app{stroke:var(--si-arc-app)}
.si-donut .si-other{stroke:var(--si-arc-other)}
.si-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center}
.si-value{font-size:26px;font-weight:600;line-height:32px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.si-value.si-scanning{font-size:15px;font-weight:400;letter-spacing:0;color:var(--dsw-alias-label-tertiary)}
.si-caption{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.si-legend{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 18px;margin:0;padding:0;list-style:none}
.si-legend li{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.si-legend .si-num{font-variant-numeric:tabular-nums}
.si-dot{width:7px;height:7px;border-radius:50%;flex:none}
.si-dot.si-app{background:var(--si-arc-app)}
.si-dot.si-other{background:var(--si-arc-other)}
.si-dot.si-free{background:var(--si-arc-free);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}
.si-cards{display:flex;flex-direction:column;gap:10px}
.si-card{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l4)}
.si-card-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.si-card-title{font-size:14px;line-height:22px;font-weight:500}
.si-card-value{font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.si-card-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.si-card-actions{flex:none;display:flex;gap:8px}
.si-rows{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.si-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.si-row:last-child{border-bottom:0}
.si-row-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.si-row-name{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.si-row-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.si-row-size{flex:none;min-width:78px;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.si-rowbtn{height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer;font-family:inherit}
.si-rowbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.si-rowbtn.si-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l3)}
.si-rowbtn.si-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.si-note{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-top:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.si-group{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
.si-back{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px 0 4px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary);font-family:inherit;margin-left:-6px}
.si-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.si-dialog-layer{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px}
.si-dialog-mask{position:absolute;inset:0;background:#00000033}
.si-dialog{position:relative;width:420px;max-width:100%;padding:20px;border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent,0 3px 8px #00000014);display:flex;flex-direction:column;gap:10px}
.si-dialog h3{margin:0;font-size:16px;line-height:24px;font-weight:600}
.si-dialog p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.si-breakdown{margin:2px 0 0;padding:10px 12px;list-style:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto}
.si-breakdown li{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.si-breakdown .si-v{font-variant-numeric:tabular-nums;flex:none}
.si-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.si-toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,12px);z-index:80;padding:9px 14px;border-radius:999px;background:var(--dsw-alias-toast-bg,#0f1115);color:var(--dsw-alias-toast-label,#fff);font-size:12px;line-height:18px;box-shadow:0 3px 8px #0000001a;opacity:0;pointer-events:none;transition:opacity .15s ease,transform .15s ease}
.si-toast.si-show{opacity:1;transform:translate(-50%,0)}
@media (prefers-reduced-motion:reduce){.si-toast{transition:none}}
`

    const ARC = {
      light: { app: '#4176e6', other: '#b9bec6', free: '#e6e8ec' },
      dark: { app: '#7aaaff', other: '#55585e', free: '#3a3c41' },
    }

    const fmt = (bytes) => {
      const b = Number(bytes) || 0
      if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB'
      if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB'
      if (b >= 1024) return Math.round(b / 1024) + ' KB'
      return Math.round(b) + ' B'
    }
    const pct = (part, whole) => {
      if (!whole || !Number.isFinite(whole) || whole <= 0) return '<0.1%'
      const v = (part / whole) * 100
      return v < 0.1 ? '<0.1%' : v.toFixed(2) + '%'
    }
    const fill = (text, vars) =>
      String(text).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m))
    const timeText = (ms) => {
      try {
        const d = new Date(ms)
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    const DELETE_ERRORS = {
      'session-not-found': 'delete.errNotFound',
      'session-in-use': 'delete.errInUse',
      'path-not-allowed': 'delete.errPath',
    }

    const KIND_GROUP = {
      sessions: 'group.sessions',
      workspace: 'group.workspace',
      attachments: 'group.attachments',
      runtimes: 'group.runtimes',
      tools: 'group.tools',
      plugins: 'group.plugins',
      backups: 'group.backups',
      install: 'group.install',
      storages: 'group.storages',
      cache: 'group.cache',
      logs: 'group.logs',
      temp: 'group.temp',
      archived: 'group.archived',
    }

    const KIND_LABEL = {
      sessions: 'sessions',
      attachments: 'attachments',
      storages: 'storages',
      cache: 'cache',
      logs: 'logs',
      runtimes: 'runtimes',
      tools: 'tools',
      plugins: 'plugins',
      backups: 'backups',
      install: 'install',
    }

    function useDarkTheme() {
      const [dark, setDark] = useState(
        () => typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme'),
      )
      useEffect(() => {
        if (typeof MutationObserver === 'undefined') return undefined
        const obs = new MutationObserver(() =>
          setDark(document.body.hasAttribute('data-ds-dark-theme')),
        )
        obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => obs.disconnect()
      }, [])
      return dark
    }

    function api(path, body) {
      const url = new URL(path, document.baseURI).href
      return fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-storage-insight': '1' },
        body: JSON.stringify(body || {}),
      }).then(async (res) => {
        const text = await res.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = null
        }
        if (!res.ok || !data || data.ok === false) {
          const msg = (data && data.error) || res.status + ' ' + res.statusText
          throw new Error(msg)
        }
        return data
      })
    }

    function Donut({ total, disk, scanning, t, dark }) {
      const arc = dark ? ARC.dark : ARC.light
      const geo = useMemo(() => {
        const r = 86
        const c = 2 * Math.PI * r
        const appShare = disk && disk.totalBytes > 0 ? total / disk.totalBytes : 0.022
        const drawnApp = Math.max(appShare, 0.022)
        const freeBytes = disk ? disk.freeBytes : 0
        const otherBytes = disk ? Math.max(0, disk.totalBytes - freeBytes - total) : 0
        const otherShare = disk ? otherBytes / disk.totalBytes : 0.179
        return { r, c, drawnApp, otherShare, otherBytes, freeBytes, appShare }
      }, [total, disk])

      const styleVars = {
        '--si-arc-app': arc.app,
        '--si-arc-other': arc.other,
        '--si-arc-free': arc.free,
      }
      const appLen = geo.drawnApp * geo.c
      const otherLen = geo.otherShare * geo.c

      return h(
        'div',
        { className: 'si-donut-block' },
        h(
          'div',
          { className: 'si-donut-wrap', style: styleVars },
          h(
            'svg',
            { className: 'si-donut', viewBox: '0 0 220 220', role: 'img', 'aria-label': t('title') },
            h('circle', { className: 'si-track', cx: 110, cy: 110, r: 86 }),
            h('circle', {
              className: 'si-other',
              cx: 110,
              cy: 110,
              r: 86,
              strokeDasharray: `${otherLen} ${geo.c - otherLen}`,
              strokeDashoffset: `${-appLen}`,
            }),
            h('circle', {
              className: 'si-app',
              cx: 110,
              cy: 110,
              r: 86,
              strokeDasharray: `${appLen} ${geo.c - appLen}`,
            }),
          ),
          h(
            'div',
            { className: 'si-center' },
            h('div', { className: 'si-value' + (scanning ? ' si-scanning' : '') }, scanning ? t('scanning') : fmt(total)),
            scanning
              ? null
              : h(
                  'div',
                  { className: 'si-caption' },
                  disk ? fill(t('ratio'), { pct: pct(total, disk.totalBytes) }) : t('disk.na'),
                ),
          ),
        ),
        h(
          'ul',
          { className: 'si-legend', style: styleVars },
          h('li', null, h('span', { className: 'si-dot si-app' }), t('legend.app'), ' ',
            h('span', { className: 'si-num' }, fmt(total))),
          h('li', null, h('span', { className: 'si-dot si-other' }), t('legend.other'), ' ',
            h('span', { className: 'si-num' }, disk ? fmt(geo.otherBytes) : '—')),
          h('li', null, h('span', { className: 'si-dot si-free' }), t('legend.free'), ' ',
            h('span', { className: 'si-num' }, disk ? fmt(geo.freeBytes) : '—')),
        ),
      )
    }

    function Card({ cat, t, onManage, onClean, empty }) {
      const isCache = cat.id === 'cache'
      const isRuntime = cat.id === 'runtime'
      const cleanable = useMemo(() => {
        if (!isCache) return 0
        return (cat.items || []).filter((i) => i.cleanable).reduce((s, i) => s + i.bytes, 0)
      }, [cat, isCache])

      const action = isCache
        ? empty
          ? h('button', { className: 'si-btn si-sm si-outline', type: 'button', disabled: true }, t('action.nothing'))
          : h('button', { className: 'si-btn si-sm si-primary', type: 'button', onClick: onClean }, t('action.clean'))
        : isRuntime
          ? h('button', { className: 'si-btn si-sm si-outline', type: 'button', onClick: onManage }, t('action.view'))
          : h('button', { className: 'si-btn si-sm si-outline', type: 'button', onClick: onManage }, t('action.manage'))

      return h(
        'div',
        { className: 'si-card' },
        h(
          'div',
          { className: 'si-card-body' },
          h('div', { className: 'si-card-title' }, t('cat.' + cat.id)),
          h('div', { className: 'si-card-value' }, fmt(cat.bytes)),
          h(
            'div',
            { className: 'si-card-desc' },
            isCache && cleanable > 0
              ? t('cat.cache.desc') + ' ' + fill(t('cat.cleanable'), { size: fmt(cleanable) })
              : isCache
                ? t('cat.cache.desc') + ' ' + t('clean.none')
                : t('cat.' + cat.id + '.desc'),
          ),
        ),
        h('div', { className: 'si-card-actions' }, action),
      )
    }

    function Detail({ cat, t, onBack, onReveal, onDelete, footer }) {
      const groups = useMemo(() => {
        const map = new Map()
        for (const it of cat.items || []) {
          const key = KIND_GROUP[it.kind] || it.kind
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(it)
        }
        return [...map.entries()]
      }, [cat])

      const name = (it) => {
        if (it.kind === 'workspace' || it.kind === 'temp' || it.kind === 'archived') return it.label
        return t(KIND_LABEL[it.kind] || it.kind)
      }

      return h(
        'div',
        { className: 'si-section' },
        h('div', null,
          h('button', { className: 'si-back', type: 'button', onClick: onBack },
            h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M9.5 3.5L5 8l4.5 4.5' })),
            t('action.back'))),
        h('div', { className: 'si-head' },
          h('h2', null, t('cat.' + cat.id)),
          h('span', { className: 'si-spacer' }),
          h('span', { className: 'si-meta' }, fmt(cat.bytes) + ' · ' + fill(t('unit.items'), { n: cat.files }))),
        h('p', { className: 'si-intro' }, t('manage.' + cat.id + '.intro')),
        ...groups.flatMap(([label, rows]) => [
          h('div', { className: 'si-group', key: 'g:' + label }, t(label)),
          h(
            'div',
            { className: 'si-rows', key: 'r:' + label },
            rows.map((it) =>
              h(
                'div',
                { className: 'si-row', key: it.id },
                h(
                  'div',
                  { className: 'si-row-body' },
                  h('div', { className: 'si-row-name', title: it.path }, name(it)),
                  h(
                    'div',
                    { className: 'si-row-meta' },
                    it.kind === 'archived'
                      ? it.hasLog === false
                        ? [t('archived.indexOnly'), it.workspaceLabel].filter(Boolean).join(' · ')
                        : [it.workspaceLabel, it.mtimeMs ? timeText(it.mtimeMs) : ''].filter(Boolean).join(' · ')
                      : it.reason || (it.mtimeMs ? timeText(it.mtimeMs) : it.path),
                  ),
                ),
                h('div', { className: 'si-row-size' }, it.kind === 'archived' && it.hasLog === false ? '—' : fmt(it.bytes)),
                it.kind === 'archived'
                  ? h('button', { className: 'si-rowbtn si-danger', type: 'button', onClick: () => onDelete(it) }, t('action.delete'))
                  : null,
                h('button', { className: 'si-rowbtn', type: 'button', onClick: () => onReveal(it.path) }, t('action.open')),
              ),
            ),
          ),
        ]),
        footer || null,
      )
    }

    function ConfirmDialog({ title, body, confirmText, t, onCancel, onConfirm, busy }) {
      return h(
        'div',
        { className: 'si-dialog-layer' },
        h('div', { className: 'si-dialog-mask', onClick: busy ? undefined : onCancel }),
        h(
          'div',
          { className: 'si-dialog', role: 'alertdialog', 'aria-modal': 'true' },
          h('h3', null, title),
          h('p', null, body),
          h('div', { className: 'si-dialog-actions' },
            h('button', { className: 'si-btn', type: 'button', onClick: onCancel, disabled: busy }, t('clean.cancel')),
            h('button', { className: 'si-btn si-primary', type: 'button', onClick: onConfirm, disabled: busy }, confirmText)),
        ),
      )
    }
    function Dialog({ items, t, onCancel, onConfirm, busy }) {
      const total = items.reduce((s, i) => s + i.bytes, 0)
      return h(
        'div',
        { className: 'si-dialog-layer' },
        h('div', { className: 'si-dialog-mask', onClick: onCancel }),
        h(
          'div',
          { className: 'si-dialog', role: 'alertdialog', 'aria-modal': 'true' },
          h('h3', null, t('clean.title')),
          h('p', null, fill(t('clean.desc'), { size: fmt(total), count: items.reduce((s, i) => s + i.files, 0) })),
          h('ul', { className: 'si-breakdown' },
            items.map((i) =>
              h('li', { key: i.id },
                h('span', null, KIND_LABEL[i.kind] && i.kind !== 'temp' ? t(KIND_LABEL[i.kind]) : i.label),
                h('span', { className: 'si-v' }, fmt(i.bytes))))),
          h('div', { className: 'si-dialog-actions' },
            h('button', { className: 'si-btn', type: 'button', onClick: onCancel, disabled: busy }, t('clean.cancel')),
            h('button', { className: 'si-btn si-primary', type: 'button', onClick: onConfirm, disabled: busy }, t('clean.confirm'))),
        ),
      )
    }

    class SectionBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false, message: '' }
      }

      static getDerivedStateFromError(error) {
        return { failed: true, message: String((error && error.message) || error) }
      }

      render() {
        if (this.state.failed) {
          return h(
            'div',
            { className: 'si-section' },
            h('h2', null, 'Storage'),
            h('p', { className: 'si-intro' }, 'Storage Insight failed to render: ' + this.state.message),
          )
        }
        return this.props.children
      }
    }

    function StorageSection(props) {
      const { t, locale, close } = props
      const dark = useDarkTheme()
      const [snap, setSnap] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [view, setView] = useState({ name: 'home' })
      const [dialogItems, setDialogItems] = useState(null)
      const [sessions, setSessions] = useState(null)
      const [deleteTarget, setDeleteTarget] = useState(null)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [, bumpLocale] = useState(0)
      const toastTimer = useRef(null)

      useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => bumpLocale((x) => x + 1))
      }, [locale])

      useEffect(() => {
        if (!deleteTarget && !dialogItems) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setDeleteTarget(null)
            setDialogItems(null)
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [deleteTarget, dialogItems])

      const load = useCallback(async (force) => {
        setLoading(true)
        setError(null)
        try {
          const data = await api('storage-insight/api/snapshot', { force: Boolean(force) })
          setSnap(data.snapshot)
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load(false)
      }, [load])

      useEffect(() => {
        if (view.name !== 'manage' || view.id !== 'conversations') return undefined
        let cancelled = false
        api('storage-insight/api/sessions')
          .then((data) => {
            if (!cancelled) setSessions(data)
          })
          .catch(() => {
            if (!cancelled) setSessions(null)
          })
        return () => {
          cancelled = true
        }
      }, [view])

      const showToast = useCallback((text) => {
        setToast(text)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 2600)
      }, [])

      useEffect(
        () => () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        },
        [],
      )

      const cat = (id) => (snap ? snap.categories.find((c) => c.id === id) : null)
      const total = snap ? snap.app.totalBytes : 0
      const cleanables = useMemo(() => {
        const c = cat('cache')
        return c ? (c.items || []).filter((i) => i.cleanable) : []
      }, [snap])

      const onReveal = useCallback(
        async (p) => {
          try {
            await api('storage-insight/api/reveal', { path: p })
          } catch (err) {
            showToast(t('revealFailed'))
          }
        },
        [showToast, t],
      )

      const confirmClean = useCallback(async () => {
        setBusy(true)
        try {
          const data = await api('storage-insight/api/clean', { dryRun: false })
          setDialogItems(null)
          showToast(fill(t('clean.done'), { size: fmt(data.result.freedBytes) }))
          await load(true)
        } catch (err) {
          showToast(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }, [load, showToast, t])

      const doDelete = useCallback(async () => {
        if (!deleteTarget) return
        setBusy(true)
        try {
          await api('storage-insight/api/delete-session', { id: deleteTarget.sessionId })
          setDeleteTarget(null)
          showToast(t('delete.done'))
          await load(true)
          const data = await api('storage-insight/api/sessions')
          setSessions(data)
        } catch (err) {
          const code = String((err && err.message) || err)
          showToast(fill(t('delete.failed'), { msg: t(DELETE_ERRORS[code] || code) }))
        } finally {
          setBusy(false)
        }
      }, [deleteTarget, load, showToast, t])

      const cleanDangling = useCallback(async () => {
        setBusy(true)
        try {
          const data = await api('storage-insight/api/clean-dangling', {})
          showToast(fill(t('records.cleaned'), { n: data.removed }))
          const next = await api('storage-insight/api/sessions')
          setSessions(next)
        } catch (err) {
          showToast(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }, [showToast, t])

      if (error) {
        return h(
          'div',
          { className: 'si-section' },
          h('h2', null, t('title')),
          h('p', { className: 'si-intro' }, fill(t('loadFailed'), { msg: error })),
          h('div', null, h('button', { className: 'si-btn si-outline', type: 'button', onClick: () => load(true) }, t('rescan'))),
        )
      }

      const overlays = []
      if (deleteTarget) {
        overlays.push(
          h(ConfirmDialog, {
            key: 'confirm-delete',
            title: t('delete.title'),
            body: fill(t(snap && snap.platform === 'win32' ? 'delete.body' : 'delete.body.other'), {
              name: deleteTarget.label,
            }),
            confirmText: t('delete.confirm'),
            t,
            busy,
            onCancel: () => setDeleteTarget(null),
            onConfirm: doDelete,
          }),
        )
      }
      if (dialogItems) {
        overlays.push(
          h(Dialog, {
            key: 'confirm-clean',
            items: dialogItems,
            t,
            busy,
            onCancel: () => setDialogItems(null),
            onConfirm: confirmClean,
          }),
        )
      }
      overlays.push(h('div', { key: 'toast', className: 'si-toast' + (toast ? ' si-show' : '') }, toast || ''))
      if (view.name === 'manage') {
        const base = cat(view.id)
        if (base) {
          const merged =
            view.id === 'conversations' && sessions && Array.isArray(sessions.sessions)
              ? {
                  ...base,
                  items: [
                    ...sessions.sessions
                      .filter((s) => s.archived)
                      .map((s) => ({
                        id: 'archived:' + s.id,
                        kind: 'archived',
                        label: s.title || s.id.slice(0, 20) + '…',
                        workspaceLabel: s.workspace,
                        path: s.path,
                        bytes: s.bytes,
                        files: s.files,
                        mtimeMs: s.mtimeMs,
                        sessionId: s.id,
                        hasLog: s.hasLog !== false,
                      })),
                    ...(base.items || []),
                  ],
                }
              : base

          const footer =
            view.id === 'conversations' && sessions && sessions.dangling > 0
              ? h(
                  'div',
                  { className: 'si-note' },
                  h('span', null, fill(t('archived.dangling'), { n: sessions.dangling })),
                )
              : null

          return h(
            'div',
            null,
            h(Detail, {
              cat: merged,
              t,
              onBack: () => setView({ name: 'home' }),
              onReveal,
              onDelete: (it) => setDeleteTarget(it),
              footer,
            }),
            ...overlays,
          )
        }
      }

      return h(
        'div',
        { className: 'si-section' },
        h(
          'div',
          { className: 'si-head' },
          h('h2', null, t('title')),
          h('span', { className: 'si-spacer' }),
          snap ? h('span', { className: 'si-meta' }, fill(t('scanned'), { time: timeText(snap.scannedAt) })) : null,
          h(
            'button',
            { className: 'si-btn si-sm', type: 'button', onClick: () => load(true), disabled: loading },
            h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
              h('path', { d: 'M13.4 8a5.4 5.4 0 11-1.7-3.9' }),
              h('path', { d: 'M13.6 2.6v3.2h-3.2' })),
            t('rescan'),
          ),
        ),
        h('p', { className: 'si-intro' }, t('intro')),
        snap && snap.incomplete ? h('div', { className: 'si-warn' }, '⚠ ', t('incomplete')) : null,
        h(Donut, { total, disk: snap ? snap.disk : null, scanning: loading, t, dark }),
        h(
          'div',
          { className: 'si-cards' },
          ['conversations', 'cache', 'runtime'].map((id) => {
            const c = cat(id)
            if (!c) return null
            return h(Card, {
              key: id,
              cat: c,
              t,
              empty: cleanables.length === 0,
              onManage: () => setView({ name: 'manage', id }),
              onClean: () => (cleanables.length ? setDialogItems(cleanables) : showToast(t('clean.none'))),
            })
          }),
        ),
        ...overlays,

      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICT.zh), 'storage-insight: zh dict')
        ctx.effect(() => ctx.locale.register(NS, 'en', DICT.en), 'storage-insight: en dict')

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.pluginCss = 'dsh-storage-insight/section.css'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'storage-insight: styles')

        const t = ctx.locale.bind(NS)

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'storage-insight',
              order: 30,
              label: () => t('nav'),
            },
            (props) => h(SectionBoundary, null, h(StorageSection, { ...props, t, locale: ctx.locale })),
          ),
        )
      },
    }
  },
})
