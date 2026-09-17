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
}

interface SitemapEntry {
  loc: string;
  pri: string;
  lastmod?: string;
}

// ---------- config ----------
const SITE: SiteConfig = {
  url: 'https://s3hq4y.github.io',
  base: '/blogs',
  title: 's9y · 博客',
  author: 's3hq4y',
  description: 's3hq4y 的技术笔记：前端、实时 3D 与代理基础设施。',
  lang: 'zh-CN',
  home: 'https://s3hq4y.github.io/',
};

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
function readPosts(): Post[] {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'));
  const posts: Post[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const { data, body } = parseFrontmatter(raw);
    if (data.draft === true) continue;
    const slug = slugify(typeof data.slug === 'string' ? data.slug : file.replace(/\.md$/, ''));
    const { html, headings } = renderMarkdown(body);
    const date = normalizeDate(data.date) || new Date(0).toISOString();
    posts.push({
      slug,
      file,
      html,
      headings,
      title: typeof data.title === 'string' ? data.title : slug,
      date,
      updated: normalizeDate(data.updated),
      category: typeof data.category === 'string' ? data.category : '未分类',
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      summary: typeof data.summary === 'string' ? data.summary : excerpt(body),
      cover: typeof data.cover === 'string' ? data.cover : null,
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
function layout({ title, description, canonical, body, jsonLd, active = '', ogType = 'website' }: LayoutOptions): string {
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
<script>(function(){try{var f=localStorage.getItem('blog-font');if(f==='sans'||f==='pixel')document.documentElement.setAttribute('data-font',f);}catch(e){}})();</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23060608'/%3E%3Crect x='8' y='8' width='16' height='16' fill='%23ff2d6f'/%3E%3C/svg%3E">
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
      <button class="font-toggle" id="fontToggle" type="button" title="切换字体 / Toggle font" aria-label="切换字体"><span class="ico-pixel">字</span><span class="ico-sans">Aa</span></button>
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
<script>(function(){var b=document.getElementById('fontToggle');if(!b)return;b.addEventListener('click',function(){var cur=document.documentElement.getAttribute('data-font')||'pixel';var next=cur==='sans'?'pixel':'sans';document.documentElement.setAttribute('data-font',next);try{localStorage.setItem('blog-font',next);}catch(e){}});})();</script>
</body>
</html>
`;
}

// ---------- pages ----------
function postCard(p: Post): string {
  return `<article class="post-card">
  <a class="post-card-link" href="${p.url}">
    <h2>${esc(p.title)}</h2>
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
</article>`;
}

function renderIndex(posts: Post[]): string {
  const body = `<section class="hero">
  <h1>${esc(SITE.title)}</h1>
  <p class="lede">${esc(SITE.description)}</p>
  <p class="count">共 ${posts.length} 篇文章</p>
</section>
<section class="post-list">
${posts.map(postCard).join('\n')}
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
  });
}

function renderPost(p: Post): string {
  const toc = p.headings.filter((h) => h.depth >= 2 && h.depth <= 3);
  const tocHtml = toc.length >= 3
    ? `<nav class="toc"><p class="toc-title">目录</p><ul>${toc.map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></nav>`
    : '';
  const updated = p.updated && new Date(p.updated).getTime() > new Date(p.date).getTime()
    ? `<span class="sep">·</span><span>更新于 ${fmtDate(p.updated)}</span>` : '';
  const body = `<article class="post">
  <header class="post-header">
    <h1>${esc(p.title)}</h1>
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

export function build(): void {
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

  console.log(`built ${posts.length} posts, ${tags.size} tags, ${cats.size} categories -> dist/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build();
}