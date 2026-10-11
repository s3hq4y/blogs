# blogs

s3hq4y 的博客。**把 Markdown 文件丢进 `posts/`，push 一下，自动发布。**

线上地址：<https://s3hq4y.github.io/blogs/>

由 GitHub Actions 在构建时预生成静态 HTML —— 每篇文章都有独立 URL、独立 SEO 元数据，搜索引擎可以正常抓取和索引。

---

## 快速开始

### 写一篇新文章

```bash
npm run new -- "我的文章标题"
```

这会在 `posts/<slug>/` 下生成一个文件夹，内含带 frontmatter 的 `index.md`，`draft: true`（草稿状态，不会被发布）。编辑它，写完把 `draft` 改成 `false` 或删掉这一行：

```bash
git add -A
git commit -m "post: 我的文章标题"
git push
```

推送后 GitHub Actions 自动构建部署，约 1 分钟上线。

> 也可以直接在 GitHub 网页上往 `posts/` 拖入 `.md` 文件（扁平结构仍兼容），同样触发部署。

### 本地预览

```bash
npm install     # 首次
npm run dev     # 构建 + 起本地服务器
```

打开 <http://127.0.0.1:8090/>。`npm run dev` 会在启动时构建一次；改完文章重新跑一遍即可看到最新内容。

> 本地预览使用空 base（资源从根路径加载），线上部署仍带 `/blogs/` 前缀，互不影响。

### 构建

```bash
npm run build       # 生成 dist/
npm run typecheck   # 类型检查（CI 会跑，类型错误会让部署失败）
```

---

## 文章格式

**每篇文章是一个文件夹**：`posts/<slug>/index.md`，图片等资源放在同目录下，用**相对路径**引用。

```
posts/
  hello-blog/
    index.md          # 正文（frontmatter + markdown）
    cover.png         # 头图（可选，放本目录）
    img/diagram.png   # 正文引用的图片
```

`index.md` 开头用 YAML frontmatter 声明元数据：

```markdown
---
title: "文章标题"
date: "2026-09-17T14:30:00+08:00"
updated: "2026-09-20T09:00:00+08:00"
category: 技术/前端
tags: [JavaScript, 前端, GitHub Pages]
summary: "显示在列表页和搜索结果里的一句话摘要。"
pinned: false
cover: cover.png
draft: false
---

正文从这里开始，正常写 Markdown。图片用相对路径引用：

![示意图](img/diagram.png)
```

> 构建时会自动把文章文件夹内除 `index.md` 外的文件复制到 `dist/p/<slug>/`，因此相对路径在线上同样有效。
> 旧的扁平写法 `posts/<slug>.md` 仍然兼容。

### 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 否 | 文章标题。缺省时用文件名。 |
| `date` | 建议 | 发布时间，决定排序。**必须加引号**（见下方注意事项）。 |
| `updated` | 否 | 最后更新时间。晚于 `date` 时文章页会显示"更新于"。 |
| `category` | 否 | 分类，单个。缺省为「未分类」。支持 `父/子` 层级写法。 |
| `tags` | 否 | 标签，数组。可多个。 |
| `summary` | 否 | 摘要。缺省时自动从正文截取前 140 字。 |
| `cover` | 否 | 头图，相对文章文件夹的文件名（如 `cover.png`）。缺省时会自动探测文件夹内的 `cover.{png,jpg,jpeg,webp,svg,gif}`。会显示在主页卡片和文章页顶部。 |
| `pinned` | 否 | `true` 时置顶，主页单独成区显示。 |
| `draft` | 否 | `true` 时不发布，构建时直接跳过。 |
| `slug` | 否 | URL 标识。缺省时用文件夹名。 |

文件夹名就是默认的 URL 标识：`posts/hello-blog/index.md` → `/blogs/p/hello-blog/`。

---

## 主页配置

主页行为集中在 `scripts/build.ts` 顶部的几个常量，改完重新构建即可。

### 额外分区（在「全部文章」之前展示）

`HOME_SECTIONS` 可按顺序声明多个区块，每个区块展示某个分类或某个标签下的文章：

```ts
const HOME_SECTIONS: Array<{ title: string; type: 'category' | 'tag'; value: string }> = [
  { title: '前端', type: 'category', value: '技术/前端' },
  { title: '架构', type: 'tag', value: '架构' },
];
```

- `type: 'category'`：`value` 为分类路径；写父级（如 `技术`）会包含其所有子分类。
- `type: 'tag'`：`value` 为标签名，精确匹配。
- 数组顺序即页面顺序；无匹配文章的分区会自动跳过。
- 留空数组 `[]` 则不显示任何额外分区。

### 浮动导航停靠侧

```ts
const FLOAT_NAV_SIDE: 'left' | 'right' = 'left';
```

主页左侧（或右侧）有一个默认收缩的浮动导航，点击展开后列出「置顶 / 各额外分区 / 全部文章」，点击跳转对应区块；滚动时自动高亮当前区块。展开状态会记忆到 localStorage。

### 搜索

「全部文章」区块带标题搜索框，仅按标题过滤（前端即时，无需后端）。

### 网格自适应

文章网格使用 `repeat(auto-fill, minmax(var(--grid-min), 1fr))`：窗口越宽每行放越多，窗口窄则自动减少列数。列宽阈值由 CSS 变量 `--grid-min` 控制（默认 300px，窄屏 220px）。

---

## 分类与标签的区别

这是两个不同维度，别混用：

**分类**回答"这是什么"，是文章的**唯一归属**，用于主导航。

```yaml
category: 技术          # 扁平：一个顶层分类
category: 技术/前端      # 层级：自动建树，技术 › 前端
```

两种写法**可以共存**——`技术` 本身是一个可点击的分类页，`技术/前端` 是它的子节点。你写文章时想扁平就扁平、想分层就分层，**不用改任何配置**。

**标签**回答"这涉及什么"，是**交叉维度**，可多个：

```yaml
tags: [React, Cloudflare, 部署]
```

一篇讲"用 Cloudflare 部署 React"的文章，分类只能是 `技术`，但标签可以横跨多个主题。

> 需要一篇文章归入多个分类时 —— 用标签，不要硬塞多个分类。多分类会让导航退化成第二个标签云。

---

## 目录结构

```
blogs/
├── posts/              ← 你只需要动这里
│   ├── hello-blog/
│   │   ├── index.md
│   │   └── cover.png
│   └── realtime-3d/
│       └── index.md
├── theme/
│   └── style.css       ← 站点样式
├── scripts/
│   ├── build.ts        ← 构建：扫描 posts/，生成整个站点
│   ├── serve.ts        ← 本地预览服务器
│   └── new.ts          ← 生成新文章模板
├── dist/               ← 构建产物（git 忽略，勿手改）
└── .github/workflows/
    └── deploy.yml      ← 自动构建 + 部署
```

---

## 构建产物

`npm run build` 生成 `dist/`：

| 路径 | 内容 |
| --- | --- |
| `index.html` | 首页（自我介绍 + 置顶区 + 可配置分区 + 搜索 + 自适应网格 + 浮动导航） |
| `p/<slug>/index.html` | 每篇文章的独立页面 |
| `categories/` | 分类索引 + 每个分类的页面 |
| `tags/` | 标签索引 + 每个标签的页面 |
| `archive/` | 按年份归档 |
| `sitemap.xml` | 给搜索引擎的站点地图 |
| `feed.xml` | RSS 订阅源 |
| `robots.txt` | 爬虫规则，指向 sitemap |
| `posts.json` | 所有文章的元数据（供程序化消费） |
| `404.html` | 404 页面 |

每篇文章的 HTML 都注入了完整的 SEO 元数据：`title`、`meta description`、`canonical`、Open Graph、`BlogPosting` JSON-LD。

---

## 部署

推送到 `main` 分支触发 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)：

1. 安装依赖（`npm ci`）
2. 类型检查（`npm run typecheck`）
3. 构建（`npm run build`）
4. 部署到 GitHub Pages

只有 `posts/`、`theme/`、`scripts/`、`tsconfig.json`、`package.json`、工作流文件变更时才会触发（纯文档改动如改这个 README 不会触发部署）。也可以在 Actions 页面手动触发（workflow_dispatch）。

---

## 注意事项

### `date` 一定要加引号

```yaml
date: "2026-09-17T14:30:00+08:00"   # 正确
date: 2026-09-17 14:30:00            # 错误
```

不加引号时，YAML 会把它解析成 `Date` 对象，序列化时区会偏移，导致东八区的文章日期整体错位 8 小时甚至跨天。**永远用带时区的 ISO 8601 字符串并加引号。**

### 不要让项目仓库名和用户站文件夹同名

本站路径是 `/blogs/`。如果你的用户站仓库（`s3hq4y.github.io`）根目录下恰好有一个叫 `blogs` 的文件夹，会发生路径冲突——此时 GitHub 优先显示项目站点（也就是本站），用户站里的那个文件夹会被忽略。目前没有这个问题，但日后往用户站加文件夹时留意一下。

### 草稿不会发布

`draft: true` 的文章在构建时被跳过，不进列表、不生成页面、不进 sitemap。写完记得改成 `false`。

---

## 技术栈

- [marked](https://github.com/markedjs/marked) — Markdown 渲染
- [highlight.js](https://highlightjs.org/) — 代码高亮（构建时完成，前端零负担）
- [js-yaml](https://github.com/nodeca/js-yaml) — frontmatter 解析
- [tsx](https://github.com/privatenumber/tsx) — 直接运行 TypeScript，无需编译步骤
- [github-markdown-css](https://github.com/sindresorhus/github-markdown-css) — Markdown 排版样式

没有框架，没有运行时依赖 —— 构建产物是纯静态 HTML + CSS。

## 发布文章

```bash
npm run new -- "文章标题"     # 生成 posts/<slug>/index.md（draft: true）
# 编辑文章，把 draft 改成 false
npm run publish -- <slug>     # 提交并推送，触发 Actions 构建部署
npm run publish -- all        # 发布全部
```

不带参数时 `npm run publish` 会自动检测 `posts/` 下所有改动。