# 发布清单 / Publishing checklist

本文件夹已经是可发布的 npm 包（`npm pack` 只含 9 个文件，26 KB）。

## 0. 前置（只需一次，在你的终端里跑）

```bash
gh auth login          # 登录 GitHub
npm login              # 登录 npm（用户名/密码/邮箱验证码）
```

然后在 GitHub 上新建一个空仓库，名字建议 `dsh-storage-insight`。

## 1. 替换占位符 superchen061220

```bash
node scripts/set-owner.mjs <你的GitHub用户名>
```

会把 `package.json` 的 `repository/homepage/bugs` 与 `README.md` 里的 `superchen061220` 全部替换掉。

## 2. 提交并推送

```bash
git init -b main
git add -A
git commit -m "feat: storage insight for DeepSeek Harness"
git remote add origin https://github.com/<你的用户名>/dsh-storage-insight.git
git push -u origin main
```

仓库设置里加上 topics，市场抓取会用到：

```
dsh-plugin  deepseek-harness  dsh  storage  disk-usage
```

## 3. 发布 npm 包

```bash
npm publish --access public
```

包名 `dsh-storage-insight` 在 npm 上是空闲的（2026-11-03 验证）。

## 4. 提交到插件市场

市场安装只认 curated registry（`awesome-dsh-plugin.com`，8489 条），它是自动从源仓库构建的。

到 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 开一个 issue / PR，标题：

```
Add plugin: dsh-storage-insight
```

正文贴 `docs/market-entry.json` 的内容（把 `superchen061220` 换成你的用户名）。若几天后仍未出现，再在同一个 issue 里催一次。

## 5. 发布后的自检（没有第二台设备也能做）

```bash
# 1) 用全新 profile 安装（等价于"别人第一次装"）
dsh plugin --profile smoke-test add dsh-storage-insight

# 2) 看它有没有被正确写进去
cat ~/.dsh/profiles/smoke-test/package.json

# 3) 清理
rm -rf ~/.dsh/profiles/smoke-test
```

再确认三件事：

- [ ] `npm view dsh-storage-insight` 能查到 0.1.0
- [ ] GitHub 仓库 topics 含 `dsh-plugin`
- [ ] 市场条目提交后，`https://awesome-dsh-plugin.com/plugins.json` 里能搜到 `dsh-storage-insight`

## 三种安装方式（发布后都可用）

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| npm | `dsh plugin --profile web add dsh-storage-insight` | 发布后 |
| GitHub | `dsh plugin --profile web add github:superchen061220/dsh-storage-insight` | 仓库公开后 |
| tar 包 | `dsh plugin --profile web add "C:\path\dsh-storage-insight-0.1.0.tgz"` | 不用发布，直接发给别人 |

装完**必须重启 dsh**：host 侧代码在启动时加载，只刷新页面不会生效。

## 已知限制（写进 issue / 告诉测试者）

- 系统回收站与"打开所在目录"仅 Windows；其他平台退到 `<.dsh>\.trash\sessions`
- 依赖 dsh 的 `workspace.json` 结构；dsh 改结构时归档列表会退化为"只按磁盘目录列"
- 会话标题需要 Node ≥ 22；更老的运行时显示短 id
- 卸载后会留下 `<.dsh>\.storage-insight\backup\workspace.json.bak`

## 5. 验收

```bash
dsh plugin --profile web add dsh-storage-insight
```

重启后打开 **设置 → 存储空间**，应看到环形图与三张卡。
