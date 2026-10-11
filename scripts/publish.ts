import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSTS = path.join(ROOT, 'posts');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

// 读取文章标题。slug 对应 posts/<slug>/index.md（兼容 posts/<slug>.md）。
function titleOf(slug: string): string {
  const candidates = [
    path.join(POSTS, slug, 'index.md'),
    path.join(POSTS, `${slug}.md`),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (m) {
        const data = yaml.load(m[1]) as Record<string, unknown> | null;
        if (data && typeof data.title === 'string') return data.title;
      }
    } catch { /* ignore */ }
  }
  return slug;
}

// 返回改动文章的 slug 列表。文章现为 posts/<slug>/index.md（也兼容旧的 posts/<slug>.md）。
function changedPosts(): string[] {
  // -z: NUL 分隔且不转义路径，避免中文文件名被 quote
  const out = git(['status', '--porcelain', '-z', '--', 'posts']);
  const slugs = out
    .split('\u0000')
    .map((l) => l.slice(3))
    .filter(Boolean)
    .map((p) => {
      const norm = p.replace(/\\/g, '/');
      // posts/<slug>/index.md -> <slug>
      let m = norm.match(/^posts\/([^/]+)\/index\.md$/);
      if (m) return m[1];
      // posts/<slug>.md -> <slug>
      m = norm.match(/^posts\/([^/]+)\.md$/);
      if (m) return m[1];
      // 文章文件夹内的其它改动（如新增图片）：posts/<slug>/... -> <slug>
      m = norm.match(/^posts\/([^/]+)\//);
      if (m) return m[1];
      return '';
    })
    .filter((v) => v)
    .filter((v, i, a) => a.indexOf(v) === i);
  return slugs;
}

const args = process.argv.slice(2);
const explicit = args.filter((a) => !a.startsWith('-'));

// 列出所有文章 slug（文件夹优先，兼容扁平 md）。
function allSlugs(): string[] {
  if (!fs.existsSync(POSTS)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(POSTS, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(POSTS, e.name, 'index.md'))) out.push(e.name);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(e.name.replace(/\.md$/, ''));
  }
  return out;
}

// slug -> 用于 git add 的相对路径（文件夹则整个加入）。
function postPath(slug: string): string {
  const dir = path.join(POSTS, slug);
  if (fs.existsSync(path.join(dir, 'index.md'))) return `posts/${slug}`;
  return `posts/${slug}.md`;
}

let targets: string[];
if (explicit.length === 1 && explicit[0] === 'all') {
  targets = allSlugs();
} else if (explicit.length) {
  targets = explicit.map((s) => s.replace(/\.md$/, ''));
} else {
  targets = changedPosts();
}

if (!targets.length) {
  console.error('没有要发布的文章。用法: npm run publish -- <slug> | npm run publish -- all');
  process.exit(1);
}

for (const t of targets) {
  if (!fs.existsSync(postPath(t))) {
    console.error(`找不到文章 ${t}`);
    process.exit(1);
  }
}

const titles = targets.map(titleOf);
const msg = targets.length === 1
  ? `post: ${titles[0]}`
  : `posts: ${titles.join(' / ')}`;

git(['add', '--', ...targets.map(postPath)]);
try {
  git(['commit', '-m', msg]);
} catch (e) {
  console.error('提交失败（可能没有改动）:', (e as Error).message);
  process.exit(1);
}
git(['push']);
console.log(`已发布 ${targets.length} 篇 → ${msg}`);
console.log('GitHub Actions 将在大约 1 分钟后完成构建部署。');