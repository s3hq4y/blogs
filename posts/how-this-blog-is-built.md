---
title: "这个博客是怎么构建的：静态站生成器的技术原理"
date: "2026-09-17T23:04:53+08:00"
category: 技术/前端
tags: [TypeScript, Node.js, 静态站点, 构建, SEO]
summary: "没有框架、没有运行时依赖，只有四个 TypeScript 脚本。拆解这个博客的静态站生成器：frontmatter 解析、Markdown 渲染与代码高亮、分类树的自动建树、SEO 元数据注入，以及从 Markdown 到 GitHub Pages 的完整流水线。"
draft: false
---

## 一、核心命题：把渲染搬到构建时

这个博客最根本的设计决策只有一句话：**把 Markdown 到 HTML 的渲染，从浏览器搬到构建时**。

纯前端渲染的博客会加载一个几百 KB 到几 MB 的 JS 包，在浏览器里把 md 转成 HTML。对「查看器」这没问题，但对博客是致命的——搜索引擎爬虫不执行 JavaScript，它抓到的永远是一个空壳。

预生成解决了三件事：

1. **每篇文章有独立 URL 和完整 HTML**，爬虫直接读到内容
2. **每篇文章有独立的 SEO 元数据**（title、description、canonical、Open Graph、JSON-LD）
3. **前端零负担**——构建时做完的工作，运行时就不用做

整个系统没有框架，没有运行时依赖。构建产物是纯静态 HTML + CSS，一共四个 TypeScript 脚本：

```
scripts/
├── build.ts     ← 扫描 posts/，生成整个站点
├── serve.ts     ← 本地预览服务器
├── new.ts       ← 生成新文章模板
└── publish.ts   ← git commit + push
```

## 二、构建管线总览

`build.ts` 的入口是一个同步的 `build()` 函数，流程非常线性：

```ts
export function build(): void {
  fs.rmSync(DIST, { recursive: true, force: true }); // 1. 清空 dist
  const posts = readPosts();                         // 2. 读取并解析文章
  const tags = tagMap(posts);                        // 3. 建标签索引
  const cats = categoryMap(posts);                   // 4. 建分类树

  write('index.html', renderIndex(posts));           // 5. 首页
  for (const p of posts) write(`p/${p.slug}/index.html`, renderPost(p));
  write('archive/index.html', renderArchive(posts)); // 6. 归档
  write('tags/index.html', renderTagIndex(tags));    // 7. 标签
  write('categories/index.html', renderCategoryIndex(cats));
  write('404.html', render404());
  write('feed.xml', renderFeed(posts));              // 8. RSS
  write('sitemap.xml', renderSitemap(posts, cats, tags)); // 9. 站点地图
  write('robots.txt', `...`);
  write('posts.json', JSON.stringify({ ... }));      // 10. 元数据
  write('.nojekyll', '');                            // 11. 关掉 Jekyll
  copyAssets();                                      // 12. 拷贝 CSS / 字体
}
```

注意第 11 步：`.nojekyll` 是 GitHub Pages 的开关。Pages 默认会跑 Jekyll 处理你的站点，而 Jekyll 会忽略以 `_` 开头的文件、对某些路径做特殊处理。放一个空的 `.nojekyll` 就是告诉 Pages「别动，原样发布」——对预生成站点这是必须的。

## 三、Frontmatter 解析

每篇文章开头的 `---` 包裹块是 YAML frontmatter。解析逻辑很直接，但有几个容易踩的坑：

```ts
function parseFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, ''); // 去掉 UTF-8 BOM
  if (!text.startsWith('---')) return { data: {}, body: text };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  let data: Frontmatter = {};
  try {
    const loaded = yaml.load(m[1]);
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      data = loaded as Frontmatter;
    }
  } catch (e) {
    console.warn('frontmatter error:', (e as Error).message);
  }
  return { data, body: text.slice(m[0].length) };
}
```

三个细节：

- **BOM 剥离**：Windows 编辑器常给文件加 UTF-8 BOM，不处理的话 `text.startsWith('---')` 会失败，整篇文章被当成没有 frontmatter。
- **容错**：YAML 解析失败不抛异常，只 warn，文章正文仍会渲染。写作流程不该被一个错字卡死。
- **类型守卫**：只接受纯对象，数组或标量会被丢弃，避免 `data.tags` 这类访问炸掉。

### 日期为什么必须加引号

README 里反复强调的一条规则，值得在这里说清原理：

```yaml
date: "2026-09-17T14:30:00+08:00"   # 正确
date: 2026-09-17 14:30:00            # 错误
```

不加引号时，YAML 规范会把这种形状的字符串**解析成 `Date` 对象**。`Date` 对象在序列化时会转换时区，东八区的文章日期会整体偏移 8 小时，甚至跨天——一篇文章会从 9 月 17 日掉到 9 月 16 日。加引号强制它是字符串，时区信息原样保留。

代码里也做了防御：`normalizeDate` 遇到 `Date` 对象会转回 ISO 字符串，但这是兜底，不是推荐用法。

## 四、Markdown 渲染：三个自定义钩子

渲染用 `marked`，但默认渲染器不够用，于是覆盖了两个 renderer：

```ts
const renderer = {
  code(token: Tokens.Code): string {
    const lang = token.lang;
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    const html = hljs.highlight(token.text, { language }).value;
    return `<pre><code class="hljs language-${language}">${html}</code></pre>\n`;
  },
  heading(this: Renderer, token: Tokens.Heading): string {
    const raw = token.tokens.map((t) => t.raw || '').join('').trim();
    const text = this.parser.parseInline(token.tokens);
    const base = slugify(raw);
    let id = base;
    let i = 1;
    while (headings.some((h) => h.id === id)) id = `${base}-${i++}`;
    headings.push({ depth: token.depth, text: raw, id });
    return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`;
  },
};
const engine = new Marked({ gfm: true, breaks: false, renderer: renderer as RendererObject });
```

### 代码高亮：构建时完成

`code` 钩子调用 `highlight.js` 把代码染好色，直接输出带 `hljs` class 的 HTML。**前端不加载任何高亮 JS**——高亮是一次性的、确定的，没有理由丢给每个访客的浏览器重复计算。

这里有个小守卫：`hljs.getLanguage(lang)` 先检查语言是否支持，不认识的语言降级为 `plaintext`，避免 highlight.js 抛异常。

### 标题锚点：为目录和分享链接服务

`heading` 钩子做了两件默认渲染器不做的事：

1. **生成锚点 id**，让 `#some-heading` 可以直接跳转
2. **收集 headings 数组**，供文章页生成目录（TOC）

锚点冲突时追加序号（`foo`、`foo-1`、`foo-2`），保证同一篇文章内 id 唯一。`slugify` 对中文友好——它保留了 `\u4e00-\u9fa5` 范围，所以中文标题也能生成可读的锚点。

文章页只在标题数量 ≥ 3 时才渲染 TOC，太少不值得占位置：

```ts
const toc = p.headings.filter((h) => h.depth >= 2 && h.depth <= 3);
const tocHtml = toc.length >= 3 ? `<nav class="toc">...</nav>` : '';
```

## 五、分类树：路径即层级

分类是这套系统里设计得最巧的一块。一个 `category: 技术/前端` 的字符串，构建时会自动建出层级树。

```ts
function categoryMap(posts: Post[]): Map<string, Category> {
  const m = new Map<string, Category>();
  for (const p of posts) {
    const parts = String(p.category).split('/').map((s) => s.trim()).filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!m.has(acc)) {
        m.set(acc, { name: part, path: acc, slugPath: acc.split('/').map(slugify), posts: [] });
      }
      m.get(acc)!.posts.push(p);
    }
  }
  return m;
}
```

关键在于 `acc` 的累积：

- 文章 `category: 技术/前端` → 同时注册 `技术` 和 `技术/前端` 两个分类
- 父分类 `技术` 会自动包含所有子分类下的文章
- **你写文章时想扁平就扁平、想分层就分层，不用改任何配置**

这是一个「约定优于配置」的典型例子：`/` 就是层级分隔符，不需要额外的树结构定义。

分类索引页再从这个 Map 里还原树形结构渲染（只取没有 `/` 的作为根，向下找直接子节点）：

```ts
const roots = [...cats.values()].filter((c) => !c.path.includes('/'));
const children = [...cats.values()].filter((x) =>
  x.path.startsWith(c.path + '/') &&
  x.path.split('/').length === c.path.split('/').length + 1
);
```

### 分类和标签的分工

这是两个**正交维度**，README 里专门强调过：

- **分类**回答「这是什么」，是文章的唯一归属，用于主导航
- **标签**回答「这涉及什么」，是交叉维度，可多个

一篇「用 Cloudflare 部署 React」的文章，分类只能是 `技术`，但标签可以横跨 `React`、`Cloudflare`、`部署`。需要多归属时用标签，不要硬塞多个分类——多分类会让导航退化成第二个标签云。

## 六、SEO：让爬虫读懂每一页

`layout()` 是所有页面的公共外壳，它注入的 SEO 元数据是预生成价值的直接体现：

```html
<meta name="description" content="...">
<link rel="canonical" href="...">
<meta property="og:type" content="article">
<meta property="og:title" content="...">
<meta property="og:description" content="...">
<meta property="og:url" content="...">
<meta name="twitter:card" content="summary_large_image">
```

而真正的重头戏是 JSON-LD 结构化数据。首页注入 `Blog`，文章页注入 `BlogPosting`：

```ts
jsonLd: {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  headline: p.title,
  description: p.summary,
  datePublished: p.date,
  dateModified: p.updated || p.date,
  url: p.absUrl,
  mainEntityOfPage: p.absUrl,
  author: { '@type': 'Person', name: SITE.author },
  keywords: p.tags.join(', '),
  articleSection: p.category,
}
```

这些字段不是装饰：搜索引擎用它生成富摘要（rich snippet），社交平台用它生成卡片。手工维护这些元数据容易出错，从文章元数据自动派生才是可靠的做法。

所有输出都经过 `esc()` 转义，防止标题里的 `&`、`<` 破坏 HTML：

```ts
const esc = (s: unknown = ''): string => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
```

## 七、摘要与阅读时长：都是算出来的

如果文章没写 `summary`，就自动从正文截前 140 字。但直接截 Markdown 会把语法符号也截进去，所以先做一轮清洗：

```ts
function excerpt(md: string, len = 140): string {
  const text = String(md)
    .replace(/```[\s\S]*?```/g, ' ')  // 去代码块
    .replace(/`[^`]*`/g, ' ')          // 去行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 去图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')  // 去标题符号
    .replace(/[>*_~]/g, ' ')           // 去强调符号
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > len ? text.slice(0, len) + '…' : text;
}
```

阅读时长则按「中文按字、英文按词」统计，每分钟 300 单位：

```ts
const readingTime = (md: string): number => {
  const words = (md.match(/[\u4e00-\u9fa5]|[A-Za-z0-9]+/g) || []).length;
  return Math.max(1, Math.round(words / 300));
};
```

这个正则同时匹配单个汉字和英文单词，是一个处理中英混排的常用技巧——中文字符间距没有空格，不能简单按空白切分。

## 八、订阅与站点地图

`feed.xml` 是 Atom 格式的 RSS，取最新 20 篇：

```xml
<updated>...</updated>
<entry>
  <title>...</title>
  <link href="..."/>
  <id>...</id>
  <updated>...</updated>
  <published>...</published>
  <summary>...</summary>
</entry>
```

`sitemap.xml` 列出所有页面并标注优先级：

| 页面 | priority |
| --- | --- |
| 首页 | 1.0 |
| 文章页 | 0.8 |
| 归档 / 标签 / 分类索引 | 0.6 |
| 单个分类 / 标签页 | 0.5 |

文章页还带 `lastmod`（`updated || date`），让爬虫知道内容新鲜度。`robots.txt` 则指向 sitemap：

```txt
User-agent: *
Allow: /

Sitemap: https://s3hq4y.github.io/blogs/sitemap.xml
```

## 九、本地开发：构建 + 静态服务器

`serve.ts` 只做两件事：启动时跑一次 `build()`，然后起一个静态文件服务器：

```ts
console.log('building...');
build();

http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(DIST, urlPath);
  if (urlPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
  else if (!path.extname(filePath) && fs.existsSync(path.join(filePath, 'index.html'))) {
    filePath = path.join(filePath, 'index.html');
  }
  // ...
}).listen(PORT, '127.0.0.1');
```

这里有一条**目录穿越防护**，虽然本地开发风险不大，但值得保留：

```ts
if (!filePath.startsWith(DIST)) { res.writeHead(403).end('forbidden'); return; }
```

它保证请求解析后的路径必须落在 `dist/` 内，`../../etc/passwd` 这类请求会被 403 拒绝。同时，路径以 `/` 结尾或对应目录存在 `index.html` 时自动补全，这让 `/blogs/p/hello-blog/` 这种「干净 URL」在本地也能正常访问。

## 十、发布流水线

### new.ts：从标题生成模板

`npm run new -- "标题"` 做三件事：把标题 slugify 成文件名、算出带时区的 ISO 时间戳、写一个 `draft: true` 的模板。

时间戳的时区计算值得一提：

```ts
const tz = -now.getTimezoneOffset();
const sign = tz >= 0 ? '+' : '-';
const iso = `${...}${sign}${pad(tz / 60)}:${pad(tz % 60)}`;
```

`getTimezoneOffset()` 返回的是「UTC 减本地」的分钟数（东八区是 -480），取反后得到 `+08:00` 这样的偏移。**从生成那一刻就带正确时区**，避免前面说的日期漂移问题。

### publish.ts：自动检测改动

不带参数运行时，它用 `git status` 检测 `posts/` 下的改动。这里有个中文文件名的坑：

```ts
// -z: NUL 分隔且不转义路径，避免中文文件名被 quote
const out = git(['status', '--porcelain', '-z', '--', 'posts']);
return out.split('\u0000').map((l) => l.slice(3)).filter(...);
```

默认的 `git status --porcelain` 对含非 ASCII 的文件名会加引号并转义，解析起来很痛苦。加 `-z` 后输出用 NUL 分隔且不转义路径，直接 `split('\u0000')` 就行。

然后根据文章标题生成提交信息，`git add` → `git commit` → `git push`。

## 十一、CI/CD：三条守卫线

`.github/workflows/deploy.yml` 在推送到 `main` 时触发，但只监听相关路径：

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'posts/**'
      - 'theme/**'
      - 'scripts/**'
      - 'tsconfig.json'
      - 'package.json'
      - 'package-lock.json'
      - '.github/workflows/deploy.yml'
  workflow_dispatch:
```

这个 `paths` 过滤器意味着改 README 不会触发部署——省下无谓的构建。

构建 job 有三条守卫线，任何一条失败都不会上线：

```yaml
- run: npm ci                # 1. 用 lockfile 精确安装依赖
- run: npm run typecheck     # 2. tsc --noEmit 类型检查
- run: npm run build         # 3. 构建
```

**类型检查放在构建之前**是刻意的：`tsconfig.json` 开了 `strict`、`noUnusedLocals`、`noUnusedParameters`，一个未使用的变量就会让部署失败。严格的类型门禁让「构建通过」意味着更高置信度的正确性。

最后的部署交给 GitHub 官方的 Pages actions：`configure-pages` → `upload-pages-artifact`（上传 `dist/`）→ `deploy-pages`。权限用 OIDC（`id-token: write`），不需要在仓库里存任何 token。

## 十二、设计复盘

回看整个系统，有几个值得记住的取舍：

1. **用 tsx 直接跑 TypeScript，不设编译步骤**。`npm run build` 就是 `tsx scripts/build.ts`，省掉了一层构建产物和 source map 的复杂度。构建脚本本身不需要被优化。
2. **没有框架，没有运行时依赖**。产物是纯 HTML + CSS，加载快、托管便宜、十年后还能跑。
3. **约定优于配置**。`category` 里的 `/` 自动建树，文件名自动变 URL，缺省值自动填充——配置项越少，出错面越小。
4. **构建时做尽一切**。代码高亮、摘要、阅读时长、SEO 元数据、sitemap、RSS 全部在构建时算好。访客的浏览器只负责显示。

一句话总结：**把复杂留在构建时，把简单留给运行时。** 这也是静态站生成器相对于动态站和 SPA 最本质的价值。
