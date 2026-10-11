# PLAN — 博客主页重构 + posts 目录结构改造

## 目标
1. 主页：加入简洁自我介绍区。
2. 支持置顶文章（frontmatter pinned: true）。
3. 保持暗色调（瑞士国际主义：黑/白/红）。
4. 文章支持头图（cover），并在主页卡片显示。
5. 主页大量采用网格布局。
6. posts 改为「一篇文章一个文件夹」，md 内用相对路径引用图片。

## 目录结构（改造后）
posts/
  <slug>/
    index.md          # 正文（frontmatter + markdown）
    cover.jpg         # 可选头图
    img/xxx.png       # 正文引用的图片（相对路径 img/xxx.png）

- 构建时扫描 posts/*/index.md，同时兼容旧的扁平 posts/*.md。
- 资源复制：把 posts/<slug>/ 下除 index.md 外的文件复制到 dist/p/<slug>/。
  页面输出在 dist/p/<slug>/index.html，md 中相对路径（如 img/x.png）天然正确。

## frontmatter 新增字段
- pinned: true — 置顶（默认 false）。
- cover: cover.jpg — 头图（相对文章文件夹）；缺省时自动探测 cover.{png,jpg,jpeg,webp,svg}。
- slug — 可选，覆盖文件夹名。

## 改动文件
- scripts/build.ts：Post 加 pinned/cover/dir；readPosts 支持文件夹；资源复制；postCard 显示头图；renderIndex 加自我介绍 + 网格 + 置顶分区；SITE 加 intro。
- theme/style.css：新增 intro 网格、post-grid、post-cover 样式。
- scripts/new.ts：创建 posts/<slug>/index.md 文件夹结构。
- scripts/publish.ts：适配文件夹（git add 整个目录）。
- 迁移现有 6 篇 md → 文件夹结构。

## 风险
- 迁移可能遗漏图片资源 → 现有文章暂无图片，低风险。
- publish.ts 依赖 git status 路径 → 需改为包含子目录。

## 回滚
- 全部改动集中在上述文件与 posts 目录，git checkout -- . 可整体回退（迁移前确认工作区干净）。
