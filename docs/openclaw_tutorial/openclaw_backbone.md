# OpenClaw 主干流程教程

> **读法建议**：先把这篇文档读完一遍，建立全局地图。之后再去读原有的 Chapter 1-11，你会发现它们每一章都只是在这张地图的某个局部"放大"。

---

## 第一节：用一张图理解整个系统

OpenClaw 可以拆成 5 个核心概念，它们首尾相接构成一条管道：

```
  外部世界 (WhatsApp / Telegram / Discord / Web ...)
      ↓
  ① Channel 层   ← 协议接入、防抖、归一化
      ↓
  ② Router 层    ← 决定哪个 Agent + 哪个 Session 处理
      ↓
  ③ Command Queue ← 串行化，避免同一个 session 并发执行
      ↓
  ④ Agent Loop   ← ReAct：调用 LLM → 执行工具 → 循环
      ↓
  ⑤ 回复投递     ← 分块、限流、精准投递回原频道
```

这 5 个概念就是整个系统的骨架。所有你在代码里看到的复杂逻辑，都属于这 5 个环节之一。

---

## 第二节：什么是 Gateway

在你能理解任何代码之前，先搞清楚一个最关键的概念：**Gateway**。

Gateway 是一个长期运行的 Node.js 守护进程（daemon）。你启动它之后，它就一直运行在后台，接受所有频道的消息、管理所有 Agent 的会话、对外暴露 WebSocket/HTTP 接口供移动端或 Web UI 连接。

它不是一个"处理单条请求"的 HTTP 服务器，而是一个**持续运行的系统**，更像操作系统内核。

**启动链路：**

```
openclaw gateway run          ← CLI 命令
  src/entry.ts                ← 进程启动、env 初始化
  src/cli/program.ts          ← 注册所有子命令
  src/cli/gateway-cli.ts      ← gateway 子命令处理
  src/gateway/server.ts       ← 核心 Gateway 类
  src/gateway/server.impl.ts  ← 完整实现（最重要的文件之一）
  src/gateway/server-startup.ts ← 启动 sidecars：channel、browser、gmail watcher
```

**`server.impl.ts` 在启动时做了什么：**

1. 加载 config（`loadConfig`）
2. 加载插件（`loadGatewayPlugins`）
3. 启动各个 Channel 的监听（`startChannels()`）
4. 启动 Cron 服务（`buildGatewayCronService`）
5. 启动 WebSocket 服务，对外提供 API
6. 启动网络发现（mDNS/Tailscale）
7. 监听 config 变化热重载

---

## 第三节：① Channel 层 — 消息如何进入系统

每个通讯平台（WhatsApp、Telegram、Discord 等）都有独立的 Channel 目录：

```
src/whatsapp/     ← WhatsApp Web（基于 Baileys 库）
src/telegram/     ← Telegram Bot API
src/discord/      ← Discord Bot
src/slack/        ← Slack App
src/signal/       ← Signal（借助 signal-cli）
src/imessage/     ← iMessage（macOS 专用）
extensions/       ← 第三方扩展（Matrix、Zalo 等）
```

**一条 WhatsApp 消息经过 Channel 层发生了什么：**

```
原始 WebSocket 事件 (Protobuf 加密包)
    ↓
Baileys 库解包解密
    ↓
createInboundDebouncer()    ← 等待 5 秒，把碎片消息合并成完整一句话
    ↓
幂等去重 (Message ID 哈希) ← 同一条消息只处理一次，防止网络重试导致重复
    ↓
Mention 门控               ← 只有 @了机器人 的消息才继续
    ↓
归一化为 InboundMessage    ← 统一的内部结构体，抹掉平台差异
```

关键代码搜索点：

- `grep -r "createInboundDebouncer" src/` → 防抖逻辑
- `grep -r "InboundMessage" src/` → 统一消息结构

---

## 第四节：② Router 层 — 谁来处理这条消息

消息归一化后，需要决定：**用哪个 Agent 来回答，存到哪个 Session？**

这由 Router 层负责：

```
src/routing/resolve-route.ts   ← 核心路由逻辑
src/routing/session-key.ts     ← 生成 sessionKey（唯一标识一个对话）
src/routing/bindings.ts        ← 显式绑定（某个群 → 某个 Agent）
```

**路由决策逻辑（按优先级）：**

```
输入：channel + accountId + peer(群组/私聊 ID)
输出：agentId + sessionKey

优先级顺序：
1. binding.peer       ← 有没有显式绑定这个具体群/用户？
2. binding.guild      ← 有没有绑定这个 Discord server？
3. binding.channel    ← 有没有绑定整个频道（比如整个 Telegram）？
4. default            ← 使用默认 agentId + 计算出的 sessionKey
```

**sessionKey 的作用：**
`sessionKey` 是一个字符串，它唯一标识"这个 Agent 与这个用户/群组"的对话。同一个 sessionKey 的所有消息共享历史记录，并且保证串行执行（不会并发）。

---

## 第五节：③ Command Queue — 串行化保证

拿到 `(agentId, sessionKey)` 之后，不能直接就开始调用 LLM。必须先**排队**。

```
src/process/command-queue.ts   ← 队列实现
src/process/lanes.ts           ← 4 种车道定义
```

**为什么需要排队？**

想象 Alice 在一个群里快速发了两条消息。如果两条消息同时跑 Agent Loop，它们会同时读写同一个 `transcripts.jsonl` 文件，导致历史记录损坏，甚至执行相互冲突的 bash 命令。

**4 种 Lane（车道）：**

```typescript
// src/process/lanes.ts
export const enum CommandLane {
  Main = "main", // 用户触发的正常对话消息
  Cron = "cron", // 定时任务（Cron Job）
  Subagent = "subagent", // 父 Agent 派生的子 Agent
  Nested = "nested", // 嵌套调用
}
```

**双层队列设计：**

```
每条消息进来都要过两层队列：

enqueueCommandInLane(sessionLane, ...)   ← 第一层：同 sessionKey 串行
  └─ enqueueCommandInLane(globalLane, ...) ← 第二层：全局资源限流（防止同时跑太多 Agent）
       └─ 真正开始执行 Agent Loop
```

代码位置：`src/agents/pi-embedded-runner/run.ts:runEmbeddedPiAgent()` 第 224 行附近。

---

## 第六节：④ Agent Loop — 核心循环

**这是整个系统最重要的部分。**

入口函数是 `runEmbeddedPiAgent()`，它位于：

```
src/agents/pi-embedded-runner/run.ts       ← 外层调度：排队、解析 model/auth、决策重试
src/agents/pi-embedded-runner/run/attempt.ts ← 内层：一次真正的 LLM 调用尝试
src/agents/pi-embedded-subscribe.ts        ← 流式响应解析
```

**Agent Loop 的完整逻辑（伪代码）：**

```
runEmbeddedPiAgent(params):
  1. 进队列（sessionLane + globalLane）
  2. 解析 workspaceDir（工作目录）
  3. 解析 provider/model（哪家 LLM，哪个模型）
  4. 解析 API Key（auth profile 轮转机制）
  5. 进入重试外层循环（最多 32~160 次迭代）:
     a. buildEmbeddedRunPayloads()  ← 组装完整的 messages 数组
        - 加载 transcripts.jsonl 历史
        - 加载 AGENTS.md / CLAUDE.md 系统提示
        - 加载扩展插件的 Tool 定义
        - 如果历史太长，先做 Compaction（压缩历史）
     b. runEmbeddedAttempt()        ← 一次 LLM 调用
        - 发起流式 API 请求
        - subscribeEmbeddedPiSession() 解析 SSE/stream 事件
        - 遇到 tool_use 事件：
            → beforeToolCall() 安全审查
            → 执行工具（bash/read/write/browser/...）
            → 把 tool_result 追加到 messages
            → 继续读取 stream（LLM 接着思考）
        - 遇到 stop_reason=end_turn 或 stop_reason=stop_sequence：
            → 结束本次尝试
     c. 根据 attempt 结果决定：
        - 成功 → 跳出循环，准备回复
        - 认证失败 → 切换 auth profile 重试
        - 上下文超限 → 触发 Compaction 后重试
        - 超时/网络错误 → 按 backoff 重试
  6. 把最终文本回复发送回 Channel
```

**ReAct 循环的核心本质：**

```
Human 消息
  → LLM 思考 → 输出 tool_use
    → 系统执行工具 → 追加 tool_result
      → LLM 继续思考 → 输出 tool_use
        → ... (重复直到 LLM 决定不再调用工具)
          → LLM 输出最终文本回复 (stop_reason=end_turn)
```

这个循环在 LLM 内部是无状态的，每次调用都要把**完整的历史记录**（用户消息 + 所有工具调用 + 所有工具结果）重新发给 LLM。

---

## 第七节：工具系统 — Agent 能做什么

Agent Loop 里提到的"工具执行"，工具定义在：

```
src/agents/pi-tools.ts              ← 工具注册中心（bash/read/write/browser等）
src/agents/bash-tools.exec.ts       ← bash 命令执行
src/agents/bash-tools.exec-types.ts ← 执行类型定义
src/agents/pi-tools.before-tool-call.ts ← 工具执行前的安全检查（CRITICAL）
src/agents/bash-tools.ts            ← 核心 bash 工具逻辑
```

**工具执行流程：**

```
LLM 输出 tool_use { name: "bash", input: { command: "cat README.md" } }
  ↓
beforeToolCall()             ← 安全检查
  ├─ splitShellPipeline()   ← 词法分析器，拆解命令
  ├─ Safe Bin 白名单检查    ← cat/ls/grep 等只读命令自动放行
  ├─ 检查管道注入/通配符    ← 阻止 "; rm -rf /" 这类攻击
  └─ 如果危险 → 向用户发送审批请求（Human-in-the-Loop）
       ↓
bash-tools.exec.ts           ← 实际执行
  ├─ node-pty 打开伪终端（PTY）
  ├─ 执行命令，收集输出
  ├─ 截断过大输出（防止几百MB的输出淹没 token 预算）
  └─ 清洗 ANSI 控制码
       ↓
返回 tool_result { content: "README.md 内容..." }
```

---

## 第八节：⑤ 回复投递 — 如何把结果送回用户

Agent Loop 结束后，有了最终回复文本，最后一步是送达：

```
src/auto-reply/reply/         ← 回复调度器
src/gateway/server-chat.ts    ← createAgentEventHandler（连接 agent 事件与 channel 回复）
```

**回复投递的主要挑战：**

```
原始文本 (可能几千字)
  ↓
Chunker（分块器）
  ├─ 按 Markdown 段落/标题边界切割
  └─ 保证每块不超过平台消息长度限制
  ↓
节流发送器
  ├─ 不一个字一个字地发（否则用户手机推送通知炸裂）
  └─ 控制发送速率（每秒最多 N 个包）
  ↓
resolveSessionDeliveryTarget()
  └─ 线索锚定：确保回复精准投递到触发此请求的那个频道/线程
     （防止并发消息来自不同频道时，回复误投）
```

---

## 第九节：完整调用链（代码级）

把前面所有内容串成一条完整的调用链：

```
[用户在 WhatsApp 发消息]
  ↓
src/whatsapp/channel.ts
  createInboundDebouncer()        // 防抖合并
  去重检查 (Message ID)           // 幂等
  Mention 解析                    // 门控
  → InboundMessage               // 归一化

  ↓
src/routing/resolve-route.ts
  resolveAgentRoute()             // channel + peer → agentId + sessionKey

  ↓
src/gateway/server-chat.ts
  createAgentEventHandler()       // 把路由结果交给 agent 执行层

  ↓
src/agents/pi-embedded-runner/run.ts
  runEmbeddedPiAgent()            // 排队 + 外层调度
    enqueueCommandInLane(session) // 同 session 串行锁
    enqueueCommandInLane(global)  // 全局资源限流

    ↓ 进入执行
    resolveModel()                // 确定 provider/model
    resolveApiKey()               // auth profile 轮转

    ↓
    src/agents/pi-embedded-runner/run/payloads.ts
    buildEmbeddedRunPayloads()    // 加载历史 + 组装 messages

    ↓
    src/agents/pi-embedded-runner/run/attempt.ts
    runEmbeddedAttempt()          // 一次 LLM API 调用

      ↓ 流式响应
      src/agents/pi-embedded-subscribe.ts
      subscribeEmbeddedPiSession()  // 解析 SSE stream

        ↓ 遇到 tool_use
        src/agents/pi-tools.before-tool-call.ts
        beforeToolCall()           // 安全检查

        src/agents/bash-tools.exec.ts
        执行工具（bash/read/write）

        追加 tool_result 到 messages
        → 继续 stream 循环

        ↓ 遇到 end_turn
        返回最终文本

  ↓ 回复
  src/auto-reply/reply/
  分块 → 节流 → resolveSessionDeliveryTarget() → 发回 WhatsApp
```

---

## 第十节：关键文件速查表

| 概念          | 最重要的文件                                   | 核心函数                       |
| ------------- | ---------------------------------------------- | ------------------------------ |
| 系统入口      | `src/entry.ts`                                 | -                              |
| Gateway 主体  | `src/gateway/server.impl.ts`                   | `createGatewayServer()`        |
| Gateway 启动  | `src/gateway/server-startup.ts`                | `startGatewaySidecars()`       |
| WhatsApp 接入 | `src/whatsapp/`                                | `createInboundDebouncer()`     |
| 路由决策      | `src/routing/resolve-route.ts`                 | `resolveAgentRoute()`          |
| Session Key   | `src/routing/session-key.ts`                   | `buildAgentMainSessionKey()`   |
| 命令队列      | `src/process/command-queue.ts`                 | `enqueueCommandInLane()`       |
| Agent 调度层  | `src/agents/pi-embedded-runner/run.ts`         | `runEmbeddedPiAgent()`         |
| Agent 执行层  | `src/agents/pi-embedded-runner/run/attempt.ts` | `runEmbeddedAttempt()`         |
| 流式响应解析  | `src/agents/pi-embedded-subscribe.ts`          | `subscribeEmbeddedPiSession()` |
| 工具注册      | `src/agents/pi-tools.ts`                       | `createOpenClawCodingTools()`  |
| 工具安全      | `src/agents/pi-tools.before-tool-call.ts`      | `beforeToolCall()`             |
| Bash 执行     | `src/agents/bash-tools.exec.ts`                | PTY 相关                       |
| 历史压缩      | `src/agents/compaction.ts`                     | `compactEmbeddedPiSession()`   |
| 回复投递      | `src/gateway/server-chat.ts`                   | `createAgentEventHandler()`    |

---

## 第十一节：三个最重要的设计决策

理解了主干之后，你需要理解这 3 个设计决策，它们解释了很多"为什么这么做"：

**决策 1：Gateway 是长运行的 daemon，不是短命的 HTTP handler**

这意味着：

- Channel 连接（WebSocket/长轮询）一直保持，消息实时推送进来
- Session 状态（历史记录）存在磁盘，不在内存
- 配置变化可以热重载，不需要重启

**决策 2：每条消息都要序列化（同一 sessionKey 不并发）**

这意味着：

- Agent Loop 可以安全地读写磁盘（transcripts.jsonl）
- 工具执行不会出现竞态（两个 bash 命令同时运行互相干扰）
- 代价是延迟：如果当前 session 有任务在跑，新消息必须等待

**决策 3：LLM 调用是无状态的，状态全在 messages 数组里**

这意味着：

- 每次 LLM 调用都要重新传送完整历史（token 消耗随对话变长线性增长）
- Compaction（历史压缩）是必须的工程组件，不是可选的优化
- 换模型时，历史消息需要格式转换（`thinkingSignature` 等模型特有字段要剥离）

---

## 第十二节：快速定位问题的方法

当你读代码时迷路了，用这个方法快速定位：

```
1. 问自己：这段代码属于哪一层？
   Channel 层？Router？Queue？Agent Loop？投递？

2. 找到该层的"入口函数"（见速查表）

3. 只读这一层的逻辑，忽略其他层的细节

4. 如果需要跨层理解，找两层之间的"交接点"
   Channel → Router 交接点：InboundMessage 结构
   Router → Queue 交接点：(agentId, sessionKey) 元组
   Queue → AgentLoop 交接点：runEmbeddedPiAgent() 的参数
   AgentLoop → 投递 交接点：EmbeddedPiRunResult（最终回复文本）
```

---

## 与原有章节的对应关系

| 原章节                | 对应本文哪一节                                           |
| --------------------- | -------------------------------------------------------- |
| 第 2 章（消息漂流）   | 本文第九节（完整调用链）的叙事版本                       |
| 第 3 章（LLM 适配）   | 本文第六节 Agent Loop 中的"buildEmbeddedRunPayloads"部分 |
| 第 4 章（Agent 循环） | 本文第六节（Agent Loop）                                 |
| 第 5 章（Shell 安全） | 本文第七节（工具系统）中的 beforeToolCall()              |
| 第 7 章（进程管理）   | 本文第七节（工具系统）中的 bash-tools.exec.ts            |
| 第 8 章（多渠道路由） | 本文第三节（Channel 层）+ 第四节（Router 层）            |
| 第 9 章（存储状态）   | 本文第六节中的"加载历史"+ "Compaction"                   |

**建议阅读顺序：**

1. 先把本文读完（建立骨架）
2. 对照"完整调用链"（第九节），在 IDE 里跳转一遍实际代码
3. 然后按需深入原有章节（每章只是某一环节的细节放大）
