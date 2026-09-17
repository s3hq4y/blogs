---
title: "Wibe 是怎么把网页版 AI 塞进 VS Code 的"
date: "2026-09-17T20:00:00+08:00"
updated: "2026-09-17T22:30:00+08:00"
category: 技术/架构
tags: [VS Code, Electron, FastAPI, 桥接, 架构, OpenAI]
summary: "Wibe 是一个 VS Code fork：它把自研扩展 incontrol 和一个驱动真实 Chrome 的 Python sidecar 缝进同一棵源码树，让 IDE 里的对话与网页版 AI 的对话保持同一条会话。本文拆解它的运行时拓扑、桥接协议，并逐字段分析：把一个「有状态的网页对话」伪装成「无状态的 OpenAI 接口」，到底改了 OpenAI 协议的哪些隐含假设。"
---

## 一、Wibe 是什么

Wibe 不是"又一个 AI 编辑器插件"，而是一个**改造过的 VS Code 本体**：

- 基线是上游 `code-oss`（v1.136.1）
- 产品名改为 `Wibe`，`product.json` 里 `win32MutexName` 等一整套标识同步替换
- 在一棵源码树里合并了三个项目：

```
vscode-1.136.1/
├── src/                          Code-OSS 本体 (TypeScript)
├── extensions/incontrol/         自研扩展 —— VS Code 扩展 (TypeScript)
└── resources/uwa-sidecar/        uwa —— Python 服务 (sidecar)
```

一句话概括它想干的事：**你在 IDE 里的对话，和你在网页版 AI（DeepSeek / Gemini / ChatGPT）里的对话，是同一条会话。** IDE 里压缩对话或切模型，网页端就开一个新会话，并把新会话地址记下来，后续消息全部续到新会话上。

## 二、运行时拓扑：为什么 sidecar 在 resources/ 而不是 extensions/

这是整个设计里最值得说的一处工程决策。

```
Electron 主进程
  └── extensions/incontrol          (扩展宿主, TypeScript)
        │  ① activate 时 spawn
        ▼
     python start.py  ──►  127.0.0.1:8199   (OpenAI 兼容 API)
        │  ② 自行拉起
        ▼
     chrome.exe :9222  ──►  网页版 AI
```

`uwa-sidecar` 是 Python 3.12 + FastAPI 服务，它驱动一个**独立的真实 Chrome**（`--remote-debugging-port=9222`）。它无法作为 Node 模块被 Electron 加载，只能以 **sidecar 子进程**形式运行，由 incontrol 扩展托管生命周期（启动、健康检查、优雅关闭时级联杀掉 Python + Chrome）。

那为什么不放 `extensions/`？因为 VS Code 的 `extensions/` 是"扩展"的位置，而 `resources/` 才是官方用于放置**随产品分发的非 JS 资产**的位置——`gulp` 打包时会整体复制到应用目录。把 Python 服务放这里，它能自动进入产物，不需要额外打包脚本。

## 三、接口层：一条请求要走两套协议

这是全文的重点。Wibe 的请求实际上穿越了**两种协议**：

```
IDE 的 LLM 客户端
   │  ① OpenAI 协议（带私有扩展字段）
   ▼
uwa-sidecar :8199            ← 这里把 OpenAI 协议"翻译"成浏览器操作
   │  ② 浏览器自动化（不是协议，是 DOM 操作）
   ▼
网页版 AI（DeepSeek 等）
```

有意思的是**回程也走两套**：网页 AI 返回的是渲染好的 DOM 文本，sidecar 把它重新包装成 OpenAI 的 `chat.completion` JSON / SSE，再额外塞一个私有 `x_uwa` 字段回来。

### 3.1 OpenAI 标准接口：无状态、全量重放

先看标准的 `POST /v1/chat/completions` 请求：

```json
{
  "model": "gpt-4o",
  "stream": true,
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "第一轮问题" },
    { "role": "assistant", "content": "第一轮回答" },
    { "role": "user", "content": "第二轮问题" }
  ]
}
```

它的流式响应是一串 SSE 帧：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

这里有一个**极其关键、却常被忽略的隐含约定**：

> **OpenAI 的 `/chat/completions` 是无状态的。** 服务端不持有任何"会话"概念。所谓"多轮对话"，是客户端每一轮都把**完整的 messages 历史**重新发一遍。`conversation` 这个对象在协议里根本不存在——只有 `messages` 数组。

这个约定是整个可行性的分析起点。

### 3.2 Wibe 桥接接口：有状态、显式会话

Wibe 在标准字段之外，往请求体根节点塞了一组私有字段。下面是**实测**的一次请求（`body keys` 来自抓包记录）：

```
POST body keys = force_new_conversation, history_mode, messages,
                 model, resume_conversation_url, stream, system_prompt_mode
```

按协议定义（`bridge/protocol.ts` ↔ `bridge/protocol.py`），完整形态是：

```jsonc
{
  "model": "chat.deepseek.com",
  "stream": true,
  "messages": [
    { "role": "system", "content": "……系统提示词……" },
    { "role": "user", "content": "……本轮增量……" }
  ],

  // ↓↓↓ 私有扩展字段（协议 v2）
  "history_mode": "ide",
  "force_new_conversation": false,
  "system_prompt_mode": "inject_once",
  "conversation_hint": { "reason": "compaction", "prev_conversation_url": "https://…" },
  "resume_conversation_url": "https://chat.deepseek.com/a/chat/s/<uuid>"
}
```

各字段的语义：

| 字段 | 类型 | 含义 |
|---|---|---|
| `history_mode` | `"auto" \| "full" \| "last" \| "ide"` | `"ide"` 表示"是否新对话"由 IDE 显式决定，不再让 sidecar 靠消息形状猜 |
| `force_new_conversation` | `bool` | 命令式开新对话（压缩迁移、切模型时置 `true`） |
| `system_prompt_mode` | `"inject_once" \| "always" \| "never"` | 系统提示词注入策略；`inject_once` 只在首轮注入 |
| `conversation_hint` | `{reason, prev_conversation_url}` | 迁移意图；`reason∈{compaction, model_switch, manual}` |
| `resume_conversation_url` | `string` | "本请求续聊这个网页对话"——压缩迁移后首条消息的关键 |

响应方向，sidecar 把会话状态塞进 `x_uwa` 根字段。**实测**的非流式响应原文：

```json
{
  "id": "chatcmpl-1788897091605",
  "object": "chat.completion",
  "created": 1788897091,
  "model": "chat.deepseek.com",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "It looks like you've sent a probe or token: `SYNTH_RESUME_PROBE_379560`. I don't have any prior context for this. Could you please clarify what you'd like me to do?",
        "media": []
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "media": []
}
```

注意：这段响应**没有** `x_uwa`——因为它是一次探针请求，网页侧没有产生真实会话。当会话产生后，`x_uwa` 长这样（文档原文）：

```jsonc
"x_uwa": {
  "conversation_url": "https://chat.deepseek.com/a/chat/s/<uuid>",
  "conversation_id":  "/a/chat/s/<uuid>",
  "tab_index": 1,
  "turn": 4,
  "history_mode": "ide"
}
```

流式场景下，这个 `x_uwa` 不是单独一个根字段，而是**插在 `[DONE]` 之前的一帧**：

```
data: {"choices":[{"delta":{"content":"…"}}]}

data: {"x_uwa":{"conversation_url":"https://chat.deepseek.com/a/chat/s/<uuid>","conversation_id":"/a/chat/s/<uuid>","tab_index":1,"turn":4,"history_mode":"ide"}}

data: [DONE]
```

为什么必须插在 `[DONE]` 之前？因为 OpenAI 客户端遇到 `[DONE]` 就停止读取，插在它后面的帧**永远读不到**。这个细节在 `api_patch.py` 里被反复强调，是个踩过的坑。

## 四、两者的根本差异：无状态 vs 有状态

把两种接口并排看，差异可以归成一张表：

| 维度 | OpenAI 标准接口 | Wibe 桥接接口 |
|---|---|---|
| 会话状态 | **无状态**，服务端不记得任何会话 | **有状态**，网页对话有真实 URL 和轮次 |
| 多轮如何实现 | 客户端每轮重发**全部** messages | 客户端只发**增量**，sidecar 往网页输入框"打字" |
| 会话标识 | 不存在（只有 messages） | `conversation_url` 是一等公民 |
| "开新对话" | 不存在这个概念 | `force_new_conversation` 显式命令 |
| 系统提示词 | 每轮都在 messages 里重发 | `inject_once` 只在首轮注入，续聊丢弃 |
| 响应附加信息 | 只有标准字段 | 额外带 `x_uwa` 回传会话地址 |
| 底层执行 | 模型推理 | DOM 填字 + 网络流监听 |

### 4.1 差异的根源：网页 AI 是"有状态"的

OpenAI 的接口设计假设：**服务端每次只处理一次独立的推理**。要"多轮"，客户端把历史拼好重发即可。会话是客户端的责任。

但网页版 AI 完全相反：

- 它有一个**真实的对话页**（`chat.deepseek.com/a/chat/s/<uuid>`）
- 它的多轮是靠**页面状态**维持的——你不必重发历史，直接在输入框打字，它就"记得"
- "开新对话"是一个**真实的 UI 动作**（点"新建"按钮）

于是 sidecar 面临一个翻译难题：**怎么把"无状态全量重放"的客户端，映射到"有状态增量打字"的网页上？**

它的答案是引入一个 OpenAI 协议里不存在的对象——**会话绑定（session binding）**：

```
IDE 会话  ──绑定──►  网页对话 URL
   │                      │
   │  首轮：全量打字       │
   │  续聊：只打增量       │
   │  迁移：开新对话+改绑  │
```

这张绑定表存在两个地方：扩展侧的内存槽（`uwaRequestContext.ts`），和 sidecar 侧的浏览器标签页会话（`session.conversation_url`）。两侧靠 `x_uwa` / `resume_conversation_url` 保持同步。

### 4.2 由此产生的两个"必须显式"的设计

一旦承认"会话是有状态的"，两件事就不能再靠推断：

**其一，是否开新对话。** 上游 uwa 的 `last` 模式靠 `session.turns > 0` 推断续聊。但 sidecar 的 session 是**按浏览器标签页复用**的——上一场对话跑完后 `turns` 不归零。此时 IDE 新开一个会话发首条消息（只有 system + 1 条 user），会被误判成旧对话的续聊，打进旧的网页对话。所以 ide 模式改为**由请求自身携带的历史**决定，并由 `resume_conversation_url` 显式声明绑定关系。

**其二，系统提示词注入几次。** 网页对话记得住之前的输入，所以 `inject_once` 是对的——首轮把 system 打进输入框，之后不必重发。这和 OpenAI 每轮重发 system 的惯例正好相反。

## 五、可行性评估：能把这套私有接口"翻译"成纯 OpenAI 接口吗？

现在回答那个最有意思的问题：**能不能把 Wibe 的内部接口，改造成一个完全符合 OpenAI 标准的接口——比如把 `conversation_url` 变成 OpenAI 协议的一部分？**

我的判断是：**能抹平一部分，但核心的那个不行。根因是 OpenAI 协议没有"会话"这个对象。**

逐字段评估：

### 5.1 可以完全抹掉的：`history_mode` / `system_prompt_mode`

这两个是**实现细节的泄漏**，不是语义需求。

- `history_mode: "ide"` 想表达的是"是否新对话由调用方决定"——但 OpenAI 协议里根本不存在"续聊/新对话"的区分，因为服务端无状态。如果 sidecar 也能做到无状态，这个字段直接消失。
- `system_prompt_mode` 同理，是"网页有状态"的副产品。在无状态模型下，system 每轮都在 messages 里，不需要策略。

**结论：可抹掉，但前提是先把 sidecar 改成无状态——而那正是最难的一步（见 5.5）。**

### 5.2 可以"藏"进标准字段的：`force_new_conversation` / `conversation_hint`

这两个本质是**带外的控制指令**。有两条标准化路径：

**路径 A：用 tools / function calling 表达。** 把"开新对话"定义成一个函数：

```json
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "start_new_conversation",
      "description": "放弃当前网页对话，开一个全新对话",
      "parameters": {
        "type": "object",
        "properties": { "reason": { "enum": ["compaction", "model_switch", "manual"] } }
      }
    }
  }]
}
```

但这很别扭——工具调用是**模型**的产出，而"开新对话"是**客户端**的指令。方向反了。

**路径 B：用请求头（HTTP header）。** 把带外控制放到 header 里：

```
X-Wibe-Force-New-Conversation: true
X-Wibe-Conversation-Hint: compaction
```

这样 body 保持 100% OpenAI 标准，扩展信息走 header。这是**我认为最干净的方案**——HTTP 本来就允许带外元数据，不污染 body 语义。

### 5.3 半可行的：`resume_conversation_url`

这个字段的内容（一个 URL）确实没法"变成 OpenAI 的一部分"，但它的**意图**可以：

> "本请求属于会话 X 的续聊。"

OpenAI 兼容生态里其实有类似表达——`user` 字段（用于区分终端用户）就可以承载一个**会话标识**：

```json
{ "user": "wibe-session-<fingerprint>" }
```

但注意：`user` 是"谁"，不是"哪条对话"。用它承载会话 URL 是**语义挪用**，可行但不够诚实。

更标准的做法是**把它消灭**——让 sidecar 自己维护"会话标识 → 网页 URL"的映射，客户端只说"我是会话 X 的续聊"，URL 由 sidecar 自己查。这正是 5.4 要说的。

### 5.4 核心问题：`conversation_url` 能不能进 OpenAI 接口？

**不能，而且不应该。** 理由是它**暴露了不该暴露的实现细节**。

`conversation_url = https://chat.deepseek.com/a/chat/s/<uuid>` 是**底层网页的地址**。把它放进 API 响应，等于把"我背后其实是 DeepSeek 网页版"这个实现细节泄露给了 API 消费者。任何一个标准 OpenAI 客户端看到这个字段都会困惑：我调的是 `gpt-4o`，为什么返回一个 DeepSeek 的 URL？

正确的抽象是**用不透明标识替代具体 URL**：

```jsonc
// 不要这样：
"x_uwa": { "conversation_url": "https://chat.deepseek.com/a/chat/s/<uuid>" }

// 应该这样：
"x_wibe_session": "sess_7f3a9c2e"     // 不透明句柄
```

客户端只拿一个**它无法解释、也不需要解释**的句柄，下一轮原样回传：

```json
{ "session": "sess_7f3a9c2e" }
```

sidecar 收到句柄后，**自己**去查它对应哪个网页 URL（映射表在 sidecar 内部）。这样：

- URL 不出 sidecar，实现细节不泄漏
- 客户端无需理解"网页对话"概念，只当是个会话 ID
- 未来换成别的后端（不再是 DeepSeek 网页），句柄语义不变

**这其实就是"为什么要存对话 URL"的答案**：URL 是 sidecar 维持"有状态会话"所必需的内部凭据，但它**不属于**对外接口。对外应该是不透明句柄。当前把它直接放进 `x_uwa` 返回，是一个**抽象泄漏**。

### 5.5 真正的拦路虎：让 sidecar 无状态是不可能的

上面所有"可抹掉"的前提都是：sidecar 能像真正的 LLM 一样**无状态**。但它不能，因为：

> **网页版 AI 的对话状态存在于浏览器里，sidecar 无法凭空重建。**

具体地说，sidecar 要做三件"必须记住"的事：

1. **续聊时不能重发历史**——网页输入框只接受增量。如果像 OpenAI 那样每轮全量重放，等于在输入框里把整个历史重打一遍，既慢又会污染网页对话。
2. **压缩迁移后要"接上"新对话**——新对话是真实开出来的新页面，必须记住它的 URL 才能续。
3. **多个 IDE 会话要隔离**——同一台 Chrome 上多个标签页，各自对应不同的 IDE 会话。

这些都是**有状态**的硬需求，无法通过"把历史全塞进 messages"消除。所以：

**最终结论：**

- 把 Wibe 私有接口**收敛**成"OpenAI body + 私有 header + 不透明会话句柄"，是**可行且推荐**的——body 保持标准，控制指令走 header，会话标识用不透明句柄替代裸 URL。
- 但想让它变成**完全无状态的纯 OpenAI 接口**，**不可行**——因为底层网页 AI 本身就是有状态的，状态无法凭空消除，只能**封装**。
- 当前 `x_uwa.conversation_url` 直接返回裸 URL，是抽象泄漏；长期应改为不透明句柄 + sidecar 内部映射。

一句话：**你不是在把有状态伪装成无状态，你是在给有状态的东西设计一个无状态的接口。** 前者是骗局，后者是封装——区别就在于状态有没有被封在边界之内。

## 六、一条硬边界：不要碰 app/core/

`resources/uwa-sidecar/` 有一个上游同步机制（`updater.py` / `update_preserve.py`）。所以项目定了一条铁律：

> **不要修改 `resources/uwa-sidecar/app/core/`。所有定制都必须走 `uwa-plugins/` 插件钩子。**

定制只在 `uwa-plugins/incon_bridge/` 里实现（`hooks.py` / `ide_mode.py` / `api_patch.py` 三件套），这样升级 uwa 时不会冲突。

## 七、一个反直觉的坑：别用 contextvars

sidecar 的钩子层需要跨任务读取"本请求的扩展字段"。最初想当然用了 `contextvars`，但 workflow 在独立任务/线程里执行，会读成 `None`——导致 `force_new` / `conversation_hint` / `resume_conversation_url` **全部失效**（日志里表现为迁移请求没有 `trigger=compaction`）。

最后改成**模块级全局 + `threading.Lock()`**：

```python
hooks.set_request_extension(...)
hooks.get_request_extension()
```

改回 `contextvar`，等于让压缩迁移静默失效。

## 八、小结

Wibe 的架构可以概括成四句话：

1. **宿主改造**：fork VS Code 本体，换来对产品名、打包、扩展加载的完全控制。
2. **进程分治**：TS 扩展管 IDE 侧与生命周期，Python sidecar 管浏览器侧的脏活。
3. **协议桥接**：一份镜像协议 + 一组扩展字段 + 一张会话绑定槽表，让"IDE 会话"和"网页对话"对上号。
4. **有状态封装**：OpenAI 协议是无状态的，网页 AI 是有状态的——桥接层的全部复杂度，都来自这个根本矛盾。

困难点在于**它们的接缝**：压缩迁移后的第一条消息能不能续到新会话、切模型时会不会串台、Reload 之后绑定还在不在。这些接缝，才是这类桥接项目里最该被文档写死的地方。