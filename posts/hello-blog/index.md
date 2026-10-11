---
title: "把 Markdown-Viewer 改造成静态博客"
date: "2026-09-17T14:30:00+08:00"
category: 技术/前端
tags: [Markdown, GitHub Pages, SEO]
summary: "从 Markdown-Viewer 抽出渲染管线，用 Node 预生成静态 HTML，做一个只传 md 就能发布的博客。"
---

## 为什么要预生成 HTML

Markdown-Viewer 是纯前端渲染：加载 1.3 MB 的 `script.js`，在浏览器里把 md 转成 HTML。这对一个"查看器"没问题，但对博客是致命的——**搜索引擎的爬虫不会执行 JavaScript**，它看到的永远是一个空壳。

所以核心思路是：**把渲染从浏览器搬到构建时**。

## 渲染管线

核心只有三行：

```js
const engine = new Marked({ gfm: true });
const html = engine.parse(markdown);
```

真正的价值在于围绕它的两件事：

1. **Frontmatter 解析** —— 用 `js-yaml` 读 `---` 包裹的元数据
2. **代码高亮** —— 用 `highlight.js` 在构建时把代码块染色，前端零负担

> 构建时多做一秒，运行时少加载一兆。

## 目录

文章按 `posts/<slug>.md` 存放，构建脚本扫描目录、排序、生成：

- 首页列表
- 每篇文章的独立 HTML
- 分类页 / 标签页 / 归档页
- `sitemap.xml` / `feed.xml` / `robots.txt`

| 产物 | 作用 |
| --- | --- |
| `p/<slug>/index.html` | 可被搜索引擎索引的文章页 |
| `sitemap.xml` | 主动提交给 Search Console |
| `feed.xml` | RSS 订阅 |
