---
title: "关于实时 3D 与性能的一点笔记"
date: "2026-09-10T09:15:00+08:00"
updated: "2026-09-12T20:00:00+08:00"
category: 技术
tags: [WebGL, Babylon.js, 性能]
summary: "在浏览器里跑实时 3D，瓶颈往往不在 GPU，而在主线程的调度与状态同步。"
---

## 主线程才是瓶颈

Babylon.js 把渲染丢给 GPU，但每一帧的**场景图遍历、矩阵计算、材质更新**仍在主线程。当帧预算只有 16.7ms 时，任何一次同步的 `JSON.parse` 或 DOM 写入都可能造成掉帧。

## 三条实践

1. **避免每帧分配对象** —— 复用 `Vector3`、`Matrix`，别在 `render loop` 里 `new`
2. **批量更新** —— 把分散的状态变更合并到一帧内提交
3. **按需渲染** —— 静态场景用 `scene.render()` 手动驱动，而不是常驻 `runRenderLoop`

```js
// 不推荐：每帧新建
engine.runRenderLoop(() => {
  const pos = new BABYLON.Vector3(x, y, z);
  mesh.position = pos;
});

// 推荐：复用
const tmp = new BABYLON.Vector3();
engine.runRenderLoop(() => {
  tmp.set(x, y, z);
  mesh.position.copyFrom(tmp);
});
```

## 结论

性能优化不是"换更快的库"，而是**理解每一帧里发生了什么**。
