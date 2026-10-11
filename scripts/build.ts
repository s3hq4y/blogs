import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { Marked, type Renderer, type RendererObject, type Tokens } from 'marked';
import hljs from 'highlight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'posts');
const DIST = path.join(ROOT, 'dist');
const BUILT_AT = new Date().toISOString();

// ---------- types ----------
interface SiteConfig {
  url: string;
  base: string;
  title: string;
  author: string;
  description: string;
  intro: string[];
  lang: string;
  home: string;
}

type Frontmatter = Record<string, unknown>;

interface Heading {
  depth: number;
  text: string;
  id: string;
}

interface Post {
  slug: string;
  file: string;
  html: string;
  headings: Heading[];
  title: string;
  date: string;
  updated: string | null;
  category: string;
  tags: string[];
  summary: string;
  cover: string | null;
  pinned: boolean;
  dir: string | null; // 文章文件夹（相对 posts/），扁平 md 为 null
  minutes: number;
  words: number;
  url: string;
  absUrl: string;
}

interface Category {
  name: string;
  path: string;
  slugPath: string[];
  posts: Post[];
}

interface LayoutOptions {
  title: string;
  description?: string;
  canonical: string;
  body: string;
  jsonLd?: unknown;
  active?: string;
  ogType?: string;
  script?: string;
}

interface SitemapEntry {
  loc: string;
  pri: string;
  lastmod?: string;
}

// ---------- config ----------
// 部署到 GitHub Pages 时的子路径前缀；本地预览可通过 SITE_BASE='' 覆盖。
const DEFAULT_BASE = process.env.SITE_BASE ?? '/blogs';

const SITE: SiteConfig = {
  url: 'https://s3hq4y.github.io',
  base: DEFAULT_BASE,
  title: 's9y · 博客',
  author: 's3hq4y',
  description: 's3hq4y 的技术笔记：前端、实时 3D 与代理基础设施。',
  intro: [
    '我是 s3hq4y（s9y），前端与创意工程师。',
    '用 TypeScript 与实时 3D 打造网页系统、交互工具与代理基础设施。',
    '这里记录构建过程中的技术笔记与思考。',
  ],
  lang: 'zh-CN',
  home: 'https://s3hq4y.github.io/',
};

// 主页「全部文章」之前额外展示的区块，可配置多个，按数组顺序渲染。
// type='category'：按分类匹配（含子分类）；type='tag'：按标签匹配。
// 示例：
//   { title: '前端笔记', type: 'category', value: '技术/前端' },
//   { title: '架构',     type: 'tag',      value: '架构' },
const HOME_SECTIONS: Array<{ title: string; type: 'category' | 'tag'; value: string }> = [
  { title: '能工智人', type: 'tag', value: '能工智人' },
  // { title: '前端', type: 'category', value: '技术/前端' },
  // { title: '架构', type: 'tag', value: '架构' },
];

// 浮动区块导航默认停靠侧：'left' | 'right'。
const FLOAT_NAV_SIDE: 'left' | 'right' = 'left';

// ---------- utils ----------
const esc = (s: unknown = ''): string => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const slugify = (s: unknown = ''): string => String(s).trim().toLowerCase()
  .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'item';

const abs = (p = '/'): string => SITE.url + SITE.base + (p.startsWith('/') ? p : '/' + p);
const link = (p = '/'): string => SITE.base + (p.startsWith('/') ? p : '/' + p);

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const readingTime = (md: string): number => {
  const words = (md.match(/[\u4e00-\u9fa5]|[A-Za-z0-9]+/g) || []).length;
  return Math.max(1, Math.round(words / 300));
};

function parseFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, ''); // strip UTF-8 BOM
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

function normalizeDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function excerpt(md: string, len = 140): string {
  const text = String(md)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[>*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > len ? text.slice(0, len) + '…' : text;
}

// ---------- markdown ----------
function renderMarkdown(md: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
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
  const html = engine.parse(md) as string;
  return { html, headings };
}

// ---------- load ----------
// 探测文章文件夹内的头图（cover.<ext>），返回相对文章文件夹的文件名。
const COVER_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'];
function detectCover(dirAbs: string): string | null {
  for (const ext of COVER_EXTS) {
    const name = `cover.${ext}`;
    if (fs.existsSync(path.join(dirAbs, name))) return name;
  }
  return null;
}

interface PostSource {
  slug: string;         // 文件夹名 / 文件名（未 slug 化前的原始标识，用于排序回退）
  mdPath: string;       // index.md 绝对路径
  dir: string | null;   // 相对 posts/ 的文件夹名；扁平 md 为 null
}

// 收集所有文章源：优先「文件夹/index.md」，同时兼容扁平「*.md」。
function collectSources(): PostSource[] {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const entries = fs.readdirSync(POSTS_DIR, { withFileTypes: true });
  const sources: PostSource[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      const md = path.join(POSTS_DIR, e.name, 'index.md');
      if (fs.existsSync(md)) sources.push({ slug: e.name, mdPath: md, dir: e.name });
    } else if (e.isFile() && e.name.endsWith('.md')) {
      sources.push({ slug: e.name.replace(/\.md$/, ''), mdPath: path.join(POSTS_DIR, e.name), dir: null });
    }
  }
  return sources;
}

function readPosts(): Post[] {
  const posts: Post[] = [];
  for (const src of collectSources()) {
    const raw = fs.readFileSync(src.mdPath, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    if (data.draft === true) continue;
    const slug = slugify(typeof data.slug === 'string' ? data.slug : src.slug);
    const { html, headings } = renderMarkdown(body);
    const date = normalizeDate(data.date) || new Date(0).toISOString();
    // 头图：显式 cover 优先，否则在文件夹内自动探测 cover.<ext>。
    const cover = typeof data.cover === 'string'
      ? data.cover
      : (src.dir ? detectCover(path.join(POSTS_DIR, src.dir)) : null);
    posts.push({
      slug,
      file: src.dir ? `${src.dir}/index.md` : src.slug + '.md',
      html,
      headings,
      title: typeof data.title === 'string' ? data.title : slug,
      date,
      updated: normalizeDate(data.updated),
      category: typeof data.category === 'string' ? data.category : '未分类',
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      summary: typeof data.summary === 'string' ? data.summary : excerpt(body),
      cover,
      pinned: data.pinned === true,
      dir: src.dir,
      minutes: readingTime(body),
      words: (body.match(/[\u4e00-\u9fa5]|[A-Za-z0-9]+/g) || []).length,
      url: link(`/p/${slug}/`),
      absUrl: abs(`/p/${slug}/`),
    });
  }
  posts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return posts;
}

function tagMap(posts: Post[]): Map<string, Post[]> {
  const m = new Map<string, Post[]>();
  for (const p of posts) for (const t of p.tags) {
    if (!m.has(t)) m.set(t, []);
    m.get(t)!.push(p);
  }
  return m;
}

function categoryMap(posts: Post[]): Map<string, Category> {
  const m = new Map<string, Category>();
  for (const p of posts) {
    const parts = String(p.category).split('/').map((s) => s.trim()).filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!m.has(acc)) m.set(acc, { name: part, path: acc, slugPath: acc.split('/').map(slugify), posts: [] });
      m.get(acc)!.posts.push(p);
    }
  }
  return m;
}

// ---------- layout ----------
function layout({ title, description, canonical, body, jsonLd, active = '', ogType = 'website', script = '' }: LayoutOptions): string {
  const full = title ? `${title} · ${SITE.title}` : SITE.title;
  return `<!doctype html>
<html lang="${SITE.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description || SITE.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="author" content="${esc(SITE.author)}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description || SITE.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="${esc(SITE.title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(full)}">
<meta name="twitter:description" content="${esc(description || SITE.description)}">
<link rel="alternate" type="application/atom+xml" title="${esc(SITE.title)}" href="${link('/feed.xml')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%230a0a0b'/%3E%3Crect x='8' y='8' width='16' height='16' fill='%23e4002b'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${link('/assets/github-markdown.css')}">
<link rel="stylesheet" href="${link('/assets/highlight.css')}">
<link rel="stylesheet" href="${link('/assets/style.css')}">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
<div class="noise" aria-hidden="true"></div>
<div class="glow" aria-hidden="true"></div>
<header class="site-header">
  <div class="wrap">
    <a class="site-brand" href="${link('/')}"><span class="dot"></span>${esc(SITE.title)}</a>
    <nav class="site-nav">
      <a class="${active === 'posts' ? 'on' : ''}" href="${link('/')}">文章</a>
      <a class="${active === 'archive' ? 'on' : ''}" href="${link('/archive/')}">归档</a>
      <a class="${active === 'categories' ? 'on' : ''}" href="${link('/categories/')}">分类</a>
      <a class="${active === 'tags' ? 'on' : ''}" href="${link('/tags/')}">标签</a>
      <a class="back" href="${SITE.home}">← 主站</a>
    </nav>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <span>© ${new Date().getFullYear()} ${esc(SITE.author)}</span>
    <span class="sep">·</span>
    <a href="${SITE.home}">主站</a>
    <span class="sep">·</span>
    <a href="${link('/feed.xml')}">RSS</a>
  </div>
</footer>
${script}
</body>
</html>
`;
}

// ---------- pages ----------
// 文章卡片：带可选头图（cover），在网格中显示。
function postCard(p: Post): string {
  const cover = p.cover
    ? `<a class="post-card-cover" href="${p.url}"><img src="${link(`/p/${p.slug}/${p.cover}`)}" alt="${esc(p.title)}" loading="lazy"></a>`
    : '';
  const pin = p.pinned ? `<span class="pin" title="置顶">置顶</span>` : '';
  return `<article class="post-card${p.cover ? ' has-cover' : ''}" data-title="${esc(p.title.toLowerCase())}">
  ${cover}
  <div class="post-card-body">
    <a class="post-card-link" href="${p.url}">
      <h2>${pin}${esc(p.title)}</h2>
      <p class="post-card-summary">${esc(p.summary)}</p>
    </a>
    <div class="post-meta">
      <time datetime="${esc(p.date)}">${fmtDate(p.date)}</time>
      <span class="sep">·</span>
      <span>${p.minutes} 分钟</span>
      <span class="sep">·</span>
      <a class="cat" href="${link(`/categories/${p.category.split('/').map(slugify).join('/')}/`)}">${esc(p.category)}</a>
      ${p.tags.map((t) => `<a class="tag" href="${link(`/tags/${slugify(t)}/`)}">#${esc(t)}</a>`).join('')}
    </div>
  </div>
</article>`;
}

// 匹配某篇文章是否属于给定分类（含其子分类）或标签。
function matchSection(p: Post, s: { type: 'category' | 'tag'; value: string }): boolean {
  if (s.type === 'tag') return p.tags.includes(s.value);
  // 分类：精确匹配，或落在该分类的子路径下（value 为父级时包含子级）。
  const cat = String(p.category);
  return cat === s.value || cat.startsWith(s.value + '/');
}

interface NavItem { id: string; label: string; }

function renderIndex(posts: Post[]): string {
  const pinned = posts.filter((p) => p.pinned);
  const rest = posts.filter((p) => !p.pinned);
  const introHtml = SITE.intro.map((t) => `<p>${esc(t)}</p>`).join('\n    ');

  const navItems: NavItem[] = [];
  let extraSections = '';

  if (pinned.length) {
    navItems.push({ id: 'sec-pinned', label: '置顶' });
    extraSections += `<section class="section" id="sec-pinned">
  <h2 class="section-label">置顶</h2>
  <div class="post-grid">${pinned.map(postCard).join('\n')}</div>
</section>\n`;
  }

  // 可配置的额外区块（按配置顺序）。
  HOME_SECTIONS.forEach((s, i) => {
    const matched = posts.filter((p) => matchSection(p, s));
    if (!matched.length) return;
    const id = `sec-${i}-${slugify(s.title)}`;
    navItems.push({ id, label: s.title });
    extraSections += `<section class="section" id="${id}">
  <h2 class="section-label">${esc(s.title)}</h2>
  <div class="post-grid">${matched.map(postCard).join('\n')}</div>
</section>\n`;
  });

  navItems.push({ id: 'sec-all', label: '全部文章' });

  const navHtml = `<nav class="float-nav" data-side="${FLOAT_NAV_SIDE}" id="floatNav" aria-label="区块导航">
  <button class="float-nav-toggle" id="floatNavToggle" type="button" aria-label="展开/收起导航" aria-expanded="false">
    <span class="float-nav-icon"></span>
  </button>
  <ul class="float-nav-list">
    ${navItems.map((n) => `<li><a href="#${n.id}" data-target="${n.id}">${esc(n.label)}</a></li>`).join('\n    ')}
  </ul>
</nav>`;

  const body = `${navHtml}
<section class="intro">
  <div class="intro-lead">
    <h1>${esc(SITE.title)}</h1>
    <div class="intro-text">
    ${introHtml}
    </div>
  </div>
  <div class="intro-meta">
    <span class="count">共 ${posts.length} 篇文章</span>
    ${pinned.length ? `<span class="count">${pinned.length} 篇置顶</span>` : ''}
  </div>
</section>
${extraSections}<section class="section" id="sec-all">
  <div class="section-head">
    <h2 class="section-label">全部文章</h2>
    <div class="search">
      <input type="search" id="postSearch" class="search-input" placeholder="搜索标题…" aria-label="按标题搜索文章" autocomplete="off">
      <span class="search-count" id="searchCount" aria-live="polite"></span>
    </div>
  </div>
  <div class="post-grid" id="allGrid">
${rest.map(postCard).join('\n')}
  </div>
  <p class="search-empty" id="searchEmpty" hidden>没有匹配的文章。</p>
</section>`;
  return layout({
    title: '',
    description: SITE.description,
    canonical: abs('/'),
    body,
    active: 'posts',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: SITE.title,
      description: SITE.description,
      url: abs('/'),
      author: { '@type': 'Person', name: SITE.author },
    },
    script: INDEX_SCRIPT,
  });
}

// 首页交互：标题搜索过滤 + 浮动导航展开/收起 + 滚动高亮当前区块。
const INDEX_SCRIPT = `<script>(function(){
  // ---- 标题搜索 ----
  var input = document.getElementById('postSearch');
  var grid = document.getElementById('allGrid');
  var empty = document.getElementById('searchEmpty');
  var countEl = document.getElementById('searchCount');
  if (input && grid) {
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.post-card'));
    var apply = function(){
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      cards.forEach(function(c){
        var t = c.getAttribute('data-title') || '';
        var hit = !q || t.indexOf(q) !== -1;
        c.hidden = !hit;
        if (hit) shown++;
      });
      if (empty) empty.hidden = shown !== 0;
      if (countEl) countEl.textContent = q ? (shown + ' / ' + cards.length) : '';
    };
    input.addEventListener('input', apply);
  }
  // ---- 浮动导航 ----
  var nav = document.getElementById('floatNav');
  var toggle = document.getElementById('floatNavToggle');
  if (nav && toggle) {
    var setOpen = function(open){
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      try { localStorage.setItem('blog-nav-open', open ? '1' : '0'); } catch(e) {}
    };
    toggle.addEventListener('click', function(){ setOpen(!nav.classList.contains('open')); });
    try { if (localStorage.getItem('blog-nav-open') === '1') setOpen(true); } catch(e) {}
    // 点击链接后自动收起（小屏）
    nav.querySelectorAll('.float-nav-list a').forEach(function(a){
      a.addEventListener('click', function(){ if (window.innerWidth < 900) setOpen(false); });
    });
  }
  // ---- 滚动高亮 ----
  var links = Array.prototype.slice.call(document.querySelectorAll('.float-nav-list a'));
  var sections = links.map(function(a){ return document.getElementById(a.getAttribute('data-target')); }).filter(Boolean);
  if (sections.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) return;
        var id = en.target.id;
        links.forEach(function(a){ a.classList.toggle('on', a.getAttribute('data-target') === id); });
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    sections.forEach(function(s){ io.observe(s); });
  }
})();</script>`;

function renderPost(p: Post): string {
  const toc = p.headings.filter((h) => h.depth >= 2 && h.depth <= 3);
  const tocHtml = toc.length >= 3
    ? `<nav class="toc"><p class="toc-title">目录</p><ul>${toc.map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></nav>`
    : '';
  const updated = p.updated && new Date(p.updated).getTime() > new Date(p.date).getTime()
    ? `<span class="sep">·</span><span>更新于 ${fmtDate(p.updated)}</span>` : '';
  const cover = p.cover
    ? `<figure class="post-cover"><img src="${link(`/p/${p.slug}/${p.cover}`)}" alt="${esc(p.title)}"></figure>`
    : '';
  const body = `<article class="post">
  <header class="post-header">
    <h1>${esc(p.title)}</h1>${cover}
    <div class="post-meta">
      <time datetime="${esc(p.date)}">${fmtDate(p.date)}</time>
      ${updated}
      <span class="sep">·</span><span>${p.minutes} 分钟</span>
      <span class="sep">·</span>
      <a class="cat" href="${link(`/categories/${p.category.split('/').map(slugify).join('/')}/`)}">${esc(p.category)}</a>
    </div>
    <div class="post-tags">${p.tags.map((t) => `<a class="tag" href="${link(`/tags/${slugify(t)}/`)}">#${esc(t)}</a>`).join('')}</div>
  </header>
  ${tocHtml}
  <div class="markdown-body">
${p.html}
  </div>
</article>`;
  return layout({
    title: p.title,
    description: p.summary,
    canonical: p.absUrl,
    body,
    active: '',
    ogType: 'article',
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
    },
  });
}

function renderTagIndex(tags: Map<string, Post[]>): string {
  const body = `<section class="hero"><h1>标签</h1><p class="count">共 ${tags.size} 个标签</p></section>
<section class="term-cloud">${[...tags.entries()].sort((a, b) => b[1].length - a[1].length)
    .map(([t, ps]) => `<a class="term" href="${link(`/tags/${slugify(t)}/`)}">#${esc(t)}<span class="n">${ps.length}</span></a>`).join('')}</section>`;
  return layout({ title: '标签', description: '按标签浏览全部文章。', canonical: abs('/tags/'), body, active: 'tags' });
}

function renderTagPage(tag: string, posts: Post[]): string {
  const body = `<section class="hero"><h1>#${esc(tag)}</h1><p class="count">${posts.length} 篇文章</p></section>
<section class="post-list">${posts.map(postCard).join('\n')}</section>`;
  return layout({
    title: `#${tag}`, description: `标签 ${tag} 下的全部文章。`,
    canonical: abs(`/tags/${slugify(tag)}/`), body, active: 'tags',
  });
}

function renderCategoryIndex(cats: Map<string, Category>): string {
  const roots = [...cats.values()].filter((c) => !c.path.includes('/'));
  const render = (c: Category): string => {
    const children = [...cats.values()].filter((x) => x.path.startsWith(c.path + '/') && x.path.split('/').length === c.path.split('/').length + 1);
    return `<li><a href="${link(`/categories/${c.slugPath.join('/')}/`)}">${esc(c.name)}<span class="n">${c.posts.length}</span></a>${children.length ? `<ul>${children.map(render).join('')}</ul>` : ''}</li>`;
  };
  const body = `<section class="hero"><h1>分类</h1><p class="count">共 ${cats.size} 个分类</p></section>
<section class="term-tree"><ul>${roots.map(render).join('')}</ul></section>`;
  return layout({ title: '分类', description: '按分类浏览全部文章。', canonical: abs('/categories/'), body, active: 'categories' });
}

function renderCategoryPage(cat: Category): string {
  const crumbs = cat.path.split('/');
  const body = `<section class="hero"><h1>${esc(cat.name)}</h1>
  <p class="crumbs">${crumbs.map((c, i) => {
    const sub = crumbs.slice(0, i + 1).map(slugify).join('/');
    return i === crumbs.length - 1 ? esc(c) : `<a href="${link(`/categories/${sub}/`)}">${esc(c)}</a>`;
  }).join(' / ')}</p>
  <p class="count">${cat.posts.length} 篇文章</p></section>
<section class="post-list">${cat.posts.map(postCard).join('\n')}</section>`;
  return layout({
    title: cat.name, description: `分类 ${cat.name} 下的全部文章。`,
    canonical: abs(`/categories/${cat.slugPath.join('/')}/`), body, active: 'categories',
  });
}

function renderArchive(posts: Post[]): string {
  const byYear = new Map<number, Post[]>();
  for (const p of posts) {
    const y = new Date(p.date).getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(p);
  }
  const body = `<section class="hero"><h1>归档</h1><p class="count">共 ${posts.length} 篇文章</p></section>
${[...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([y, ps]) => `<section class="archive-year">
  <h2>${y}<span class="n">${ps.length}</span></h2>
  <ul class="archive-list">${ps.map((p) => `<li><time datetime="${esc(p.date)}">${fmtDate(p.date).slice(5)}</time><a href="${p.url}">${esc(p.title)}</a></li>`).join('')}</ul>
</section>`).join('\n')}`;
  return layout({ title: '归档', description: '按时间归档的全部文章。', canonical: abs('/archive/'), body, active: 'archive' });
}

function render404(): string {
  const body = `<section class="hero"><h1>404</h1><p class="lede">页面不存在。</p><p><a href="${link('/')}">返回文章列表</a></p></section>`;
  return layout({ title: '404', description: '页面不存在。', canonical: abs('/404.html'), body });
}

// ---------- feeds ----------
function renderFeed(posts: Post[]): string {
  const updated = posts[0] ? posts[0].date : BUILT_AT;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(SITE.title)}</title>
  <subtitle>${esc(SITE.description)}</subtitle>
  <link href="${abs('/feed.xml')}" rel="self"/>
  <link href="${abs('/')}"/>
  <updated>${updated}</updated>
  <id>${abs('/')}</id>
  <author><name>${esc(SITE.author)}</name></author>
${posts.slice(0, 20).map((p) => `  <entry>
    <title>${esc(p.title)}</title>
    <link href="${p.absUrl}"/>
    <id>${p.absUrl}</id>
    <updated>${p.updated || p.date}</updated>
    <published>${p.date}</published>
    <summary>${esc(p.summary)}</summary>
  </entry>`).join('\n')}
</feed>
`;
}

function renderSitemap(posts: Post[], cats: Map<string, Category>, tags: Map<string, Post[]>): string {
  const urls: SitemapEntry[] = [
    { loc: abs('/'), pri: '1.0' },
    { loc: abs('/archive/'), pri: '0.6' },
    { loc: abs('/categories/'), pri: '0.6' },
    { loc: abs('/tags/'), pri: '0.6' },
    ...posts.map((p) => ({ loc: p.absUrl, lastmod: p.updated || p.date, pri: '0.8' })),
    ...[...cats.values()].map((c) => ({ loc: abs(`/categories/${c.slugPath.join('/')}/`), pri: '0.5' })),
    ...[...tags.keys()].map((t) => ({ loc: abs(`/tags/${slugify(t)}/`), pri: '0.5' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}<priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`;
}

// ---------- write ----------
function write(relPath: string, content: string): void {
  const target = path.join(DIST, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function copyAssets(): void {
  const assets = path.join(DIST, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const copies: Array<[string, string]> = [
    ['node_modules/github-markdown-css/github-markdown.css', 'assets/github-markdown.css'],
    ['node_modules/highlight.js/styles/github-dark.css', 'assets/highlight.css'],
    ['theme/style.css', 'assets/style.css'],
  ];
  for (const [from, to] of copies) {
    const src = path.join(ROOT, from);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, to));
    else console.warn('missing asset:', from);
  }
  // fonts
  const fontsDir = path.join(ROOT, 'theme', 'fonts');
  if (fs.existsSync(fontsDir)) {
    const outDir = path.join(DIST, 'assets', 'fonts');
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(fontsDir)) {
      fs.copyFileSync(path.join(fontsDir, f), path.join(outDir, f));
    }
  }
}

// 递归复制目录内容（保留相对结构）。
function copyDirInto(srcDir: string, outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, e.name);
    const to = path.join(outDir, e.name);
    if (e.isDirectory()) copyDirInto(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

// 把每篇文章文件夹里的非 md 资源复制到 dist/p/<slug>/，
// 使 md 中的相对路径（如 img/x.png）在输出页面里指向正确位置。
function copyPostAssets(posts: Post[]): void {
  for (const p of posts) {
    if (!p.dir) continue;
    const srcDir = path.join(POSTS_DIR, p.dir);
    const outDir = path.join(DIST, 'p', p.slug);
    fs.mkdirSync(outDir, { recursive: true });
    for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (e.name === 'index.md') continue;
      const from = path.join(srcDir, e.name);
      const to = path.join(outDir, e.name);
      if (e.isDirectory()) copyDirInto(from, to);
      else if (e.isFile()) fs.copyFileSync(from, to);
    }
  }
}

export function build(opts: { base?: string } = {}): void {
  // 允许调用方覆盖 base（例如本地预览用空字符串，使资源从根路径加载）。
  SITE.base = opts.base ?? DEFAULT_BASE;
  fs.rmSync(DIST, { recursive: true, force: true });
  const posts = readPosts();
  const tags = tagMap(posts);
  const cats = categoryMap(posts);

  write('index.html', renderIndex(posts));
  for (const p of posts) write(`p/${p.slug}/index.html`, renderPost(p));
  write('archive/index.html', renderArchive(posts));
  write('tags/index.html', renderTagIndex(tags));
  for (const [t, ps] of tags) write(`tags/${slugify(t)}/index.html`, renderTagPage(t, ps));
  write('categories/index.html', renderCategoryIndex(cats));
  for (const c of cats.values()) write(`categories/${c.slugPath.join('/')}/index.html`, renderCategoryPage(c));
  write('404.html', render404());
  write('feed.xml', renderFeed(posts));
  write('sitemap.xml', renderSitemap(posts, cats, tags));
  write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${abs('/sitemap.xml')}\n`);
  write('posts.json', JSON.stringify({
    generated: BUILT_AT,
    site: { title: SITE.title, url: abs('/') },
    posts: posts.map(({ html, headings, ...rest }) => rest),
  }, null, 2));
  write('.nojekyll', '');
  copyAssets();
  copyPostAssets(posts);

  console.log(`built ${posts.length} posts, ${tags.size} tags, ${cats.size} categories -> dist/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build();
}