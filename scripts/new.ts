import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS = path.resolve(__dirname, '..', 'posts');

const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  console.error('usage: npm run new -- "文章标题"');
  process.exit(1);
}

const slug = title.trim().toLowerCase()
  .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'untitled';

const now = new Date();
const tz = -now.getTimezoneOffset();
const sign = tz >= 0 ? '+' : '-';
const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0');
const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(tz / 60)}:${pad(tz % 60)}`;

const file = path.join(POSTS, `${slug}.md`);
if (fs.existsSync(file)) { console.error('already exists:', file); process.exit(1); }
fs.mkdirSync(POSTS, { recursive: true });
fs.writeFileSync(file, `---
title: "${title}"
date: "${iso}"
category: 未分类
tags: []
summary: ""
draft: true
---

在这里写正文。
`);

console.log(`created posts/${slug}.md (draft: true)`);