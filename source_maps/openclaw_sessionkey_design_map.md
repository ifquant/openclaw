# OpenClaw 第三层地图：`sessionKey` 设计图

这份文档专门回答一个问题：

`sessionKey` 在 OpenClaw 里到底是什么，为什么它不是一个普通的会话 ID。

如果 [`source_maps/openclaw_attempt_call_map.md`](/Users/dev/workspace2/claw_research/source_maps/openclaw_attempt_call_map.md) 讲的是一次 run 的装配流程，那这份文档讲的是：

- OpenClaw 如何给“同一条会话生命线”命名
- 这个名字里为什么塞了 agent、channel、chat type、thread、subagent、ACP 等信息
- 为什么系统里这么多模块都依赖它

---

## 一句话定义

`sessionKey` 是 OpenClaw 的 **统一会话坐标**。

它不是单纯的数据库主键，也不是单纯的聊天窗口 ID。

它同时承担 5 个角色：

1. 标识这条会话属于哪个 agent
2. 标识这条会话来自哪个渠道/对象
3. 决定这条会话是否复用主会话，还是隔离成单独会话
4. 决定控制面、路由层、状态层如何找到这条会话
5. 决定某些策略是否生效，例如 subagent、ACP、cron、thread

所以你可以把它理解成：

```text
sessionKey = agent 作用域 + 会话路由语义 + 会话类型语义 + 特殊控制语义
```

---

## 为什么 OpenClaw 需要 `sessionKey`

因为 OpenClaw 不是单一聊天窗口程序。

它要处理这些情况：

- 同一个 agent 在 Telegram、iMessage、Discord 同时工作
- 同一个渠道里，私聊和群聊要不要共用上下文不一样
- 某些 direct message 要不要归并成主会话，有些则要 per-peer 隔离
- 一个 thread 要不要绑定到主会话，还是开子会话
- subagent / cron / ACP 这种“不是普通聊天回合”的流程，也要有自己的 session 空间

如果只有一个简单 `conversationId`，系统会立刻乱掉：

- session transcript 会串
- delivery target 会串
- queue 串行化范围会错
- send policy 会错
- ACP target session 无法解析

所以 `sessionKey` 是 OpenClaw 把所有会话语义统一收束的主轴。

---

## 代码入口：`sessionKey` 的核心实现在哪

你读 `sessionKey`，先抓这两个文件：

- [`openclaw/src/sessions/session-key-utils.ts`](/Users/dev/workspace2/claw_research/openclaw/src/sessions/session-key-utils.ts)
- [`openclaw/src/routing/session-key.ts`](/Users/dev/workspace2/claw_research/openclaw/src/routing/session-key.ts)

可以把它们分工记成：

```text
session-key-utils.ts
  = 解析 / 判断 / 派生语义

routing/session-key.ts
  = 构造 / 归一化 / 路由生成
```

也就是：

- `utils` 负责“看懂一个已有 sessionKey”
- `routing` 负责“生成一个新的 sessionKey”

---

## 规范形态：OpenClaw 想要的 canonical key 长什么样

最核心的规范形态是：

```text
agent:<agentId>:<rest>
```

比如：

```text
agent:main:main
agent:main:imessage:group:2
agent:main:telegram:channel:1234
agent:main:telegram:1234:thread:42
agent:worker1:direct:alice
agent:main:subagent:abc123
agent:main:acp:9fd8...
```

这里最重要的设计点是：

- `agent:<agentId>:` 是 agent 作用域前缀
- 后面的 `rest` 才是具体会话语义

这意味着 OpenClaw 从一开始就没有把“会话”和“agent”分开看。

它的默认设计是：

```text
同样一条聊天线程，在不同 agent 视角下，是不同 session
```

---

## `sessionKey` 不是一个字段，而是一套语义编码

你看到 `sessionKey` 最容易误解的点是：它看起来像字符串，所以以为它只是“值”。

实际上它是一种 **编码过的会话语义格式**。

它最常编码这几类信息：

### 1. Agent 作用域

示例：

```text
agent:main:...
agent:worker1:...
```

来源：

- `parseAgentSessionKey`
- `resolveAgentIdFromSessionKey`
- `buildAgentMainSessionKey`

意义：

- 不同 agent 的 transcript、状态文件、工具权限和控制面解析都可以隔离

### 2. 聊天对象类型

示例：

```text
...:direct:alice
...:group:123
...:channel:456
```

来源：

- `deriveSessionChatType`
- `buildAgentPeerSessionKey`

意义：

- send policy、routing、reply 策略会根据 direct/group/channel 不同而不同

### 3. 渠道身份

示例：

```text
agent:main:imessage:group:2
agent:main:telegram:channel:1234
agent:main:discord:group:dev
```

意义：

- 会话不仅属于“某个人/某个群”，还属于“某个渠道上下文”
- 这样不同渠道不会误共享 transcript

### 4. 线程语义

示例：

```text
agent:main:telegram:1234:thread:42
agent:main:...:topic:abc
```

来源：

- `resolveThreadSessionKeys`
- `resolveThreadParentSessionKey`

意义：

- thread / topic 可以派生出子会话
- 同时还保留 parent session 的关系

### 5. 特殊运行语义

示例：

```text
agent:main:subagent:abc
agent:main:acp:uuid
agent:main:cron:job-1:run:xyz
```

来源：

- `isSubagentSessionKey`
- `isAcpSessionKey`
- `isCronSessionKey`
- `isCronRunSessionKey`

意义：

- 某些 session 根本不是“普通聊天线程”
- 但仍然需要统一纳入会话体系和控制面

---

## 你最该理解的设计点：为什么要有 `agent:` 前缀

这是 `sessionKey` 设计最关键的点之一。

`sessionKey` 不做成：

```text
telegram:group:123
```

而做成：

```text
agent:main:telegram:group:123
```

是因为 OpenClaw 从设计上允许：

- 多个 agent 同时存在
- 同一个聊天对象被不同 agent 分别处理
- 某些 session 被 subagent 或 worker agent 接管

所以系统需要区分：

```text
谁的会话
```

而不仅仅是：

```text
哪条聊天线程
```

这使得 `sessionKey` 天生是 **agent-scoped** 的，而不是 channel-scoped 的。

---

## `session-key-utils.ts`：这层负责“读懂 key”

这个文件不是构造器，更像“判官”和“分析器”。

最值得记的函数有这些：

### `parseAgentSessionKey`

作用：

- 按 `agent:<agentId>:<rest>` 解析
- 统一小写、统一比较口径

为什么重要：

- 它是全系统认 canonical key 的入口
- 很多后续判断都先过它

### `deriveSessionChatType`

作用：

- 从 key 里猜出 `direct / group / channel / unknown`

为什么重要：

- send policy、状态展示、渠道逻辑要靠这个判断

### `isSubagentSessionKey`

作用：

- 判断这条会话是不是 subagent 会话

为什么重要：

- `runEmbeddedAttempt` 里 `resolvePromptModeForSession` 就依赖它
- subagent 会走更保守/更精简的 prompt 路径

### `getSubagentDepth`

作用：

- 判断嵌套 subagent 深度

为什么重要：

- 防止无限递归或过深嵌套

### `isAcpSessionKey`

作用：

- 判断是不是 ACP 控制/协调类会话

为什么重要：

- 这类会话不是普通聊天 thread，但要让 control-plane 能识别

### `resolveThreadParentSessionKey`

作用：

- 从 `...:thread:...` 或 `...:topic:...` 形式反推出父 key

为什么重要：

- thread 不只是新 key，还要保留 parent 语义

---

## `routing/session-key.ts`：这层负责“生成 key”

这个文件比 `utils` 更偏构造策略。

最值得记的函数：

### `normalizeAgentId`

作用：

- 保证 agentId path-safe、shell-friendly、稳定

为什么重要：

- `sessionKey` 不只是内存对象里的名字，它还会进文件路径、状态存储、日志、命令

### `buildAgentMainSessionKey`

作用：

- 构造主会话 key

示例：

```text
agent:main:main
```

意义：

- 这是最基础的“主生命线”

### `buildAgentPeerSessionKey`

作用：

- 按 channel / peerKind / dmScope / peerId 构造会话 key

这是最重要的构造器之一。

因为它决定：

- DM 是归并到 main
- 还是 per-peer
- 还是 per-channel-peer
- 还是 per-account-channel-peer

这说明 `sessionKey` 的设计不是纯技术性的，而是直接编码了产品策略。

### `resolveThreadSessionKeys`

作用：

- 在 base session 上派生 thread session

意义：

- OpenClaw 把 thread 看成主会话的派生形态，不是完全无关的独立对象

### `toAgentStoreSessionKey` / `toAgentRequestSessionKey`

作用：

- 在存储形态和请求形态之间转换

为什么重要：

- 系统内部并不总是用同一种 sessionKey 形态
- 有些边界层只看 `rest`
- 有些存储层必须保留 `agent:<id>:` 前缀

这也是你理解 OpenClaw 时容易糊涂的地方之一：

- `sessionKey` 有“外部请求视角”
- 也有“内部 store 视角”

---

## `sessionKey` 最核心的设计取舍

### 取舍 1：把会话语义编码进 key，而不是靠额外字段散落保存

好处：

- key 自带语义
- routing、policy、status、hooks、control-plane 都能快速判断

代价：

- key 变长
- 格式演进会更敏感

### 取舍 2：agent-scoped，而不是全局 channel-scoped

好处：

- 同一个外部聊天对象可以被不同 agent 独立拥有

代价：

- 你不能只看群号/用户 ID 判断是不是同一 session

### 取舍 3：兼容 legacy / alias 形态，但推动 canonical 形态

证据：

- `classifySessionKeyShape`
- `parseAgentSessionKey`

好处：

- 旧格式不会立刻全炸

代价：

- 需要额外归一化和形态判断

### 取舍 4：用 key 承载特殊控制语义

比如：

- `subagent`
- `acp`
- `cron`
- `thread`

好处：

- 统一纳入同一套 session 生态

代价：

- sessionKey 不再只是“聊天对象名”，而是系统级语义入口

---

## 它在系统里影响哪些模块

`sessionKey` 不是只在 `sessions/` 目录里用。

它至少影响这几层：

### 1. Agent 运行层

例子：

- `runEmbeddedAttempt`
- `resolvePromptModeForSession`

影响：

- subagent session 走不同 prompt mode
- workspace / agent scope / tool scope 会受它影响

### 2. 路由层

例子：

- `routing/session-key.ts`
- 渠道 message context 构造

影响：

- 不同消息最终落到哪个 session transcript

### 3. 会话存储层

例子：

- `channels/session.ts`
- `auto-reply/status.ts`

影响：

- session 状态文件怎么找
- transcript 对应哪个 store entry

### 4. 渠道层

例子：

- `telegram/bot-message-context.ts`
- `imessage/monitor/*`

影响：

- 入站消息是归主会话，还是归 thread / group / channel 独立会话

### 5. 策略层

例子：

- `sessions/send-policy.ts`

影响：

- 某条会话是否允许发送
- send policy 是否按 direct/group/channel 区分

### 6. ACP / 控制面

例子：

- `auto-reply/reply/commands-acp/*`
- `acp/*`

影响：

- 控制面怎么指定 target session
- ACP session 怎么被识别和生命周期管理

---

## 几个典型例子

### 例子 1：主会话

```text
agent:main:main
```

意思：

- `main` agent 的主会话
- 最基础的默认上下文生命线

### 例子 2：iMessage 群聊

```text
agent:main:imessage:group:2
```

意思：

- `main` agent
- iMessage 渠道
- group 类型
- 群对象 ID 是 `2`

### 例子 3：Telegram thread

```text
agent:main:telegram:1234:thread:42
```

意思：

- 基于 Telegram 某个 base session
- 再派生出 thread 级子会话

### 例子 4：subagent

```text
agent:main:subagent:abc123
```

意思：

- 这不是普通聊天 session
- 而是 `main` agent 派生出来的 subagent 会话

### 例子 5：ACP 会话

```text
agent:main:acp:9fd8...
```

意思：

- 这是控制/协调语义的会话
- control-plane 和 ACP 命令会特别识别它

---

## 你最容易混淆的三个点

### 1. `sessionId` 和 `sessionKey` 不是一回事

- `sessionId` 更像某次运行实例或底层 session 文件实例 ID
- `sessionKey` 更像稳定的逻辑会话坐标

简单说：

```text
sessionId = 这次跑的是谁
sessionKey = 这条生命线是谁
```

### 2. `sessionKey` 不等于某个平台 conversationId

因为它额外包含：

- agent 作用域
- chat type
- 特殊语义
- thread / subagent / ACP 派生关系

### 3. `sessionKey` 不是纯存储字段，也是控制字段

它会直接影响：

- prompt mode
- send policy
- routing
- ACP target resolution
- status / logging / hook events

---

## 读源码时该按什么顺序看

建议顺序：

1. [`openclaw/src/sessions/session-key-utils.ts`](/Users/dev/workspace2/claw_research/openclaw/src/sessions/session-key-utils.ts)
2. [`openclaw/src/routing/session-key.ts`](/Users/dev/workspace2/claw_research/openclaw/src/routing/session-key.ts)
3. [`openclaw/src/channels/session.ts`](/Users/dev/workspace2/claw_research/openclaw/src/channels/session.ts)
4. [`openclaw/src/sessions/send-policy.ts`](/Users/dev/workspace2/claw_research/openclaw/src/sessions/send-policy.ts)
5. [`openclaw/src/telegram/bot-message-context.ts`](/Users/dev/workspace2/claw_research/openclaw/src/telegram/bot-message-context.ts) 或 [`openclaw/src/imessage/monitor/inbound-processing.ts`](/Users/dev/workspace2/claw_research/openclaw/src/imessage/monitor/inbound-processing.ts)
6. 回到 [`openclaw/src/agents/pi-embedded-runner/run/attempt.ts`](/Users/dev/workspace2/claw_research/openclaw/src/agents/pi-embedded-runner/run/attempt.ts) 看 `isSubagentSessionKey`、`sessionKey` 参数如何参与 run

---

## 压缩版理解

如果你只想先记住最重要的结论，就记这 4 句：

1. `sessionKey` 不是普通 ID，而是会话语义坐标。
2. OpenClaw 的 canonical 形态是 `agent:<agentId>:<rest>`。
3. `sessionKey` 同时编码了 agent、channel、chat type、thread、subagent、ACP 等语义。
4. routing、storage、policy、control-plane、agent run 都依赖它。

---

## 下一步建议

如果你已经理解 `sessionKey` 的设计，下一步最值得继续拆的是两条线里的其中一条：

- `sessionKey` 是怎么在 Telegram / iMessage 入站消息里被构造出来的
- `sessionKey` 是怎么被 ACP / control-plane 当成 target session 来解析的

如果你愿意，我下一步可以继续给你做第四层：

- `sessionKey` 在某个具体渠道里的生成链
- 或 `sessionKey` 在 ACP 控制面里的解析链
