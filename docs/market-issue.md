## Plugin submission

| | |
| --- | --- |
| name | `dsh-storage-insight` |
| repo | https://github.com/superchen061220/dsh-storage-insight |
| install | `dsh plugin --profile web add github:superchen061220/dsh-storage-insight` |
| category | `dev` |
| license | MIT |
| capabilities | `shell`, `fs-write`, `fs-read` |

**中文**：为 DSH 增加「存储空间」设置页——环形图展示本机 dsh 占用（程序本体/会话/附件/运行时/插件/临时目录），可按工作区与类型下钻，列出已归档会话并删除（进系统回收站），清理只动可再生缓存。接口只接受本机回环连接、有 CSRF 防护、不联网。

**English**: A Settings → Storage page: donut of on-disk usage, three categories, archived-session drill-down with delete-to-Recycle-Bin, and a clean action limited to rebuildable caches. Host routes are loopback-only and CSRF-guarded; nothing leaves the machine.

Capability notes: `shell` is only used to send a deleted session folder to the Windows Recycle Bin (via PowerShell); `fs-write` covers that move plus a backup before editing `workspace.json`; `fs-read` covers directory sizing and session titles.

### Catalog entry

```json
{
  "name": "dsh-storage-insight",
  "owner": "superchen061220",
  "url": "https://github.com/superchen061220/dsh-storage-insight",
  "npm": null,
  "version": "0.1.0",
  "category": "dev",
  "description": {
    "en": "A Storage settings page for DeepSeek Harness: a donut of what dsh occupies on this machine (install, sessions, attachments, runtimes, plugins, temp), a drill-down that lists archived sessions and can delete them (to the system Recycle Bin), and a clean action that only touches rebuildable caches. Windows-only for the system Recycle Bin and Open folder; scanning works everywhere.",
    "zh": "为 DeepSeek Harness 增加「存储空间」设置页：环形图展示本机 dsh 占用（程序本体、会话、附件、运行时、插件、临时目录），可按工作区/类型下钻、列出已归档会话并删除（进系统回收站），清理只动可再生缓存。（系统回收站与打开目录仅 Windows，扫描与统计跨平台可用。）"
  },
  "capabilities": [
    "shell",
    "fs-write",
    "fs-read"
  ],
  "install": "dsh plugin --profile web add github:superchen061220/dsh-storage-insight",
  "icon": "https://raw.githubusercontent.com/superchen061220/dsh-storage-insight/main/assets/icon-180.png",
  "screenshots": [
    "https://raw.githubusercontent.com/superchen061220/dsh-storage-insight/main/assets/screenshot-light.png",
    "https://raw.githubusercontent.com/superchen061220/dsh-storage-insight/main/assets/screenshot-dark.png",
    "https://raw.githubusercontent.com/superchen061220/dsh-storage-insight/main/assets/screenshot-sessions.png"
  ]
}
```

Screenshots: https://raw.githubusercontent.com/superchen061220/dsh-storage-insight/main/assets/screenshot-light.png , https://raw.githubusercontent.com/superchen061220/dsh-storage-insight/main/assets/screenshot-dark.png , https://raw.githubusercontent.com/superchen061220/dsh-storage-insight/main/assets/screenshot-sessions.png
