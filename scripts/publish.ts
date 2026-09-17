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

function titleOf(file: string): string {
  try {
    const raw = fs.readFileSync(path.join(POSTS, file), 'utf8').replace(/^\uFEFF/, '');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      const data = yaml.load(m[1]) as Record<string, unknown> | null;
      if (data && typeof data.title === 'string') return data.title;
    }
  } catch { /* ignore */ }
  return file.replace(/\.md$/, '');
}

function changedPosts(): string[] {
  // -z: NUL 分隔且不转义路径，避免中文文件名被 quote
  const out = git(['status', '--porcelain', '-z', '--', 'posts']);
  return out
    .split('\u0000')
    .map((l) => l.slice(3))
    .filter((p) => p.endsWith('.md'))
    .map((p) => path.basename(p))
    .filter((v, i, a) => a.indexOf(v) === i);
}

const args = process.argv.slice(2);
const explicit = args.filter((a) => !a.startsWith('-'));

let targets: string[];
if (explicit.length === 1 && explicit[0] === 'all') {
  targets = fs.readdirSync(POSTS).filter((f) => f.endsWith('.md'));
} else if (explicit.length) {
  targets = explicit.map((s) => (s.endsWith('.md') ? s : `${s}.md`));
} else {
  targets = changedPosts();
}

if (!targets.length) {
  console.error('没有要发布的文章。用法: npm run publish -- <slug> | npm run publish -- all');
  process.exit(1);
}

for (const t of targets) {
  if (!fs.existsSync(path.join(POSTS, t))) {
    console.error(`找不到 posts/${t}`);
    process.exit(1);
  }
}

const titles = targets.map(titleOf);
const msg = targets.length === 1
  ? `post: ${titles[0]}`
  : `posts: ${titles.join(' / ')}`;

git(['add', '--', ...targets.map((t) => `posts/${t}`)]);
try {
  git(['commit', '-m', msg]);
} catch (e) {
  console.error('提交失败（可能没有改动）:', (e as Error).message);
  process.exit(1);
}
git(['push']);
console.log(`已发布 ${targets.length} 篇 → ${msg}`);
console.log('GitHub Actions 将在大约 1 分钟后完成构建部署。');