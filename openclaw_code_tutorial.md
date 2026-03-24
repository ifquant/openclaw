# OpenClaw 源码详解教程

## 1. 教程目标

这份文档的目标不是只做“目录介绍”，而是尽量把 OpenClaw 的**业务骨架、核心模块、主调用链、关键函数职责、运行时设计**讲清楚，让你拿到源码后知道：

- 这个项目本质上是什么系统
- 主入口从哪里开始
- Gateway 是怎么装起来的
- 渠道消息是怎么进入统一处理流水线的
- Agent 是怎么执行一轮推理的
- CLI Agent 和 Embedded Pi Agent 有什么差别
- 哪些文件和函数最值得优先阅读
- 下一步如果要继续深挖，应该沿哪条链往下走

---

## 2. 先给结论：OpenClaw 到底是什么

OpenClaw 不是“某一个聊天平台机器人”，也不是“单一模型调用脚本”。

它更像一个：

**以 Gateway 为控制平面、以统一消息上下文为总线、以 Auto Reply Pipeline 为编排中心、以 Agent Runtime 为执行内核、以 Plugin / Channel 为扩展边界的个人 AI 助手平台。**

换句话说，它真正的业务主线是：

**多入口消息接入 → 统一消息上下文整理 → 回复编排 → Agent 执行 → 工具/流式结果处理 → 回复写回不同渠道**

你可以把它看成一个带有这些特性的系统：

- 有 CLI 入口
- 有 Gateway 服务
- 有多种聊天渠道扩展
- 有 Agent 执行运行时
- 有插件系统
- 有 Web / App / Canvas / Browser 等宿主能力
- 有统一的消息处理主干

---

## 3. 顶层业务骨架

把整个项目抽象成一张逻辑图，大概是这样：

```text
用户输入 / 渠道消息 / Web Chat / Gateway RPC / App
                │
                ▼
        统一 MsgContext 构造
                │
                ▼
     Auto Reply Pipeline（编排层）
                │
                ├─ 判重 / 会话解析 / 路由
                ├─ typing / TTS / hook
                ├─ model / provider / auth profile 决策
                ├─ skill snapshot / media / history 注入
                │
                ▼
          Agent Runtime（执行层）
                │
                ├─ CLI Agent 路径
                └─ Embedded Pi Agent 路径
                │
                ▼
      流式输出 / 工具结果 / usage / transcript
                │
                ▼
      回复回写到对应渠道 / Web / Session Store
```

这个骨架非常关键，因为后面很多目录和函数都只是这条链上的不同环节。

---

## 4. 目录级别理解：每层在干什么

## 4.1 CLI / 启动层

典型文件：

- `src/entry.ts`
- `src/cli/run-main.ts`
- `src/cli/program/build-program.ts`
- `src/cli/program/command-registry.ts`
- `src/cli/program/register.subclis.ts`

职责：

- 处理 `openclaw ...` 命令
- 初始化运行环境
- 注册所有一级/二级子命令
- 根据命令把流程导向 gateway、channels、plugins、models、cron 等模块

这一层本质是“程序壳”和“命令调度器”。

---

## 4.2 Gateway 层

典型文件：

- `src/cli/gateway-cli/run.ts`
- `src/gateway/server.ts`
- `src/gateway/server.impl.ts`
- `src/gateway/server-http.ts`
- `src/gateway/server-ws-runtime.ts`
- `src/gateway/server-methods/*.ts`

职责：

- 启动 HTTP / WS 服务
- 装载配置、插件、渠道、模型目录
- 提供 RPC 方法
- 管理连接客户端、广播、会话、后台任务
- 作为整个系统的控制平面

这层是整个系统的**控制中枢**。

---

## 4.3 Channel / 渠道插件层

典型文件：

- `src/channels/plugins/index.ts`
- `src/channels/plugins/types.core.ts`
- `src/gateway/server-channels.ts`
- `extensions/*`

职责：

- 定义渠道插件接口
- 每个聊天平台做成一个 plugin/extension
- 管理账号启动、断线重连、状态跟踪
- 入站消息统一包装后送入 auto-reply pipeline
- 出站消息通过 adapter 发回平台

这层是“对外连接不同消息世界”的 docking 层。

---

## 4.4 Auto Reply / 编排层

典型文件：

- `src/auto-reply/dispatch.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/auto-reply/reply/get-reply.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/auto-reply/reply/agent-runner.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`

职责：

- 统一处理所有入站消息
- 判重、会话恢复、路由、typing、TTS、hook
- 解析命令和模型策略
- 构造 agent run 所需的完整上下文
- 驱动 agent 执行，并处理流式回传

这层是 OpenClaw 的**业务流程编排器**。

---

## 4.5 Agent Runtime 层

典型文件：

- `src/agents/cli-runner.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/model-auth.ts`
- `src/agents/model-selection.ts`
- `src/agents/models-config.ts`
- `src/agents/skills/*`

职责：

- 选择 provider / model / auth profile
- 控制 session lane / queue / concurrency
- 管理上下文窗口、compaction、fallback、retry
- 真正执行一次 agent turn
- 输出 usage / tool result / partial text / final reply

这层是**AI 执行内核**。

---

## 4.6 Plugin 系统

典型文件：

- `src/plugins/loader.ts`
- `src/plugins/runtime.ts`
- `src/plugins/registry.ts`
- `src/gateway/server-plugins.ts`

职责：

- 动态扫描和装载插件
- 注册 hook、gateway method、channel、service
- 在 Gateway 启动时把这些扩展并入主系统

说明 OpenClaw 是一个平台架构，不是死板的单体程序。

---

## 4.7 UI / App / Canvas / Browser

目录：

- `apps/android`
- `apps/ios`
- `apps/macos`
- `ui`
- `src/canvas-host`
- `src/browser`

职责：

- 提供 Companion App、控制 UI、Live Canvas、浏览器能力
- 这些更多是宿主能力和用户体验层
- 核心业务主线依然在 Gateway + Auto Reply + Agent Runtime

---

## 5. 最重要的一条链：从启动到 Gateway 运行

下面开始按“主调用链”展开。

## 5.1 进程入口：`src/entry.ts`

这是程序级顶层入口。

高层职责：

1. 准备运行环境
2. 处理进程级初始化
3. 调用 CLI 主入口

最终会走到类似：

```ts
runCli(process.argv);
```

所以 `entry.ts` 不负责业务逻辑，只负责把程序带入 CLI 主调度器。

---

## 5.2 CLI 主入口：`src/cli/run-main.ts -> runCli()`

`runCli()` 是命令行总入口，职责通常包括：

1. 加载 `.env`
2. 标准化运行环境
3. 检查运行时兼容性
4. 处理 PATH / profile / bootstrap 逻辑
5. 构建 commander program
6. 按命令懒加载子命令
7. `parseAsync()`

可以把它理解为：

**CLI 世界里的总调度函数**

它不直接做 gateway 业务，但所有 gateway 命令都是从这里分流下去的。

---

## 5.3 Commander 组装：`src/cli/program/build-program.ts -> buildProgram()`

这一步主要做：

- 创建 `Command`
- 创建 program context
- 配置帮助信息
- 注册 preAction hooks
- 注册子命令

这里相当于把命令树拼起来，让后续 `openclaw gateway run` 能正确落到 gateway 逻辑。

---

## 5.4 子命令注册：`src/cli/program/register.subclis.ts`

这里会注册不同主命令，例如：

- `gateway`
- `daemon`
- `channels`
- `plugins`
- `cron`
- `models`
- `pairing`
- `tui`

所以你在命令行里运行的不同命令，本质上是走不同子系统的入口。

---

## 5.5 Gateway 命令执行：`src/cli/gateway-cli/run.ts -> runGatewayCommand()`

这是 Gateway 启动路径的真正 CLI 入口。

职责通常包括：

- 解析 gateway 运行参数（端口、bind、token、auth、dev 等）
- 加载 gateway 相关配置
- 解析运行模式
- 决定使用哪个端口/host
- 调用真正的 gateway 服务启动函数

最终核心转发到：

```ts
startGatewayServer(port, opts);
```

这一步进入系统装配阶段。

---

## 5.6 核心装配：`src/gateway/server.impl.ts -> startGatewayServer()`

这是全项目最关键的函数之一。

它不是简单“启动个 HTTP 服务”，而是整个 OpenClaw 运行时的装配工厂。

### 这函数做的大事可以拆成 7 组

### （1）启动准备

- 读取配置
- 处理迁移 / snapshot
- 解析 gateway runtime config
- 准备 auth / bind host / UI 资源

### （2）插件和模型准备

- 加载 Gateway plugins
- 加载模型目录
- 初始化 subagent registry
- 注册技能变更监听器

### （3）创建运行时状态

- 创建 Gateway runtime state
- 构建 client 集合、广播器、subscription 状态、dedupe 状态等

### （4）HTTP / WS 服务

- 建立 HTTP server
- 建立 WebSocket runtime
- 注册 server methods
- 附加 auth / rate limit / browser 相关控制

### （5）渠道管理

- 构造 channel manager
- 启动各类 channel account
- 把外部聊天渠道接入主系统

### （6）后台服务

- cron
- discovery
- health monitor
- heartbeat
- tailscale exposure
- sidecars
- maintenance timers

### （7）热重载与关闭

- config reload handlers
- graceful close handler
- 资源回收

### 一句话理解

`startGatewayServer()` 不是单函数，而是**整个系统启动阶段的总装配中心**。

---

## 6. 第二条主链：渠道消息如何进入统一流程

这条链是项目业务骨架的核心。

---

## 6.1 渠道由谁管理：`src/gateway/server-channels.ts -> createChannelManager()`

Gateway 启动时会创建一个 channel manager，用来：

- 加载渠道插件
- 启动账号
- 跟踪运行状态
- 管理停止/重启/backoff
- 接收消息并交给统一处理链

最关键的动作之一是：

### `startChannelInternal(channelId, accountId?)`

它做的事通常包括：

1. 找到对应的 channel plugin
2. 读取账号配置
3. 检查 enabled / configured
4. 构建 account runtime state
5. 调用插件自己的启动逻辑

也就是类似：

```ts
plugin.gateway.startAccount(...)
```

注意这点非常重要：

**核心系统并不知道 Telegram/Slack/别的平台具体怎么连接。它只知道“调用渠道插件接口”。**

这就是插件化架构的边界。

---

## 6.2 渠道拿到消息后发生什么

无论哪个渠道，只要拿到一条入站消息，最终都要被整理成统一格式，然后进入：

`src/auto-reply/dispatch.ts -> dispatchInboundMessage()`

这意味着不同入口虽然协议不同、事件模型不同，但在进入主业务链前，会被压成统一的 `MsgContext`。

这是 OpenClaw 架构最漂亮的设计之一：

**统一入口上下文**

---

## 6.3 统一入站调度：`dispatchInboundMessage()`

这个函数负责把“原始入站事件”送进统一回复流水线。

高层职责：

1. 整理入站上下文
2. 做最后的上下文补全
3. 将执行权交给 reply dispatcher
4. 调用配置驱动的回复逻辑

最终进入：

```ts
dispatchReplyFromConfig(...)
```

---

## 7. 第三条主链：Auto Reply Pipeline 细化

这是最值得精读的部分。

---

## 7.1 配置驱动调度：`src/auto-reply/reply/dispatch-from-config.ts -> dispatchReplyFromConfig()`

这个函数是“消息编排层”的核心之一。

它主要做的事包括：

### （1）判重

避免同一条消息多次触发回复。

### （2）恢复或解析会话

根据渠道、thread、sender 等信息解析 session store entry。

### （3）触发 plugin hooks

例如 `message_received` 这种 hook。

### （4）内部逻辑路由

判断是不是要 route 到 originating channel 或特殊模式。

### （5）准备交互体验

例如 typing、TTS、reply mode、dispatcher 策略。

### （6）进入真正的“生成回复准备阶段”

即：

```ts
getReplyFromConfig(...)
```

所以 `dispatchReplyFromConfig()` 更像“业务决策层”，还没真正开始跑模型。

---

## 7.2 回复准备：`src/auto-reply/reply/get-reply.ts -> getReplyFromConfig()`

这一步开始从“有一条消息”转向“准备好一轮 agent run”。

它一般负责：

- 解析 session / workspace / agentId
- 解析用户命令
- 处理 link understanding / media understanding
- 应用 channel 的 model override
- 解析 `/new`、`/reset`、`/think` 等控制命令
- 决定 provider / model / timeout / skillFilter
- 准备交给 `runPreparedReply(...)`

这一步本质上是在**构造一份“可执行的本轮任务”**。

---

## 7.3 本轮执行参数拼装：`src/auto-reply/reply/get-reply-run.ts -> runPreparedReply()`

这个函数极其关键。

它是在把“已经解析好的业务意图”真正装配成 agent 执行时所需的一切信息。

### 主要工作可以拆成几组

### （1）会话上下文

- 当前是 direct 还是 group
- group intro
- thread starter / thread history
- inbound user context
- 系统事件注入

### （2）消息体整理

- bare reset 检测
- media-only 场景处理
- append untrusted context
- prepend system events

### （3）模型策略

- `/think`
- 默认 thinking level
- 是否允许高等级 reasoning
- reset notice

### （4）会话文件/持久化信息

- resolve session file path

### （5）并发 / 队列 / followup

- queue settings
- embedded session lane
- clear command lane
- abort old run（必要时）

### （6）auth profile override

- 读取 session 级别覆盖设置

### （7）构造 followupRun / agent run input

这一步会把以下信息装进去：

- sessionId / sessionKey
- provider / model
- authProfileId
- skill snapshot
- timeout
- extraSystemPrompt
- sender/group/channel meta

### （8）调用真正的 agent runner

最终进入：

```ts
runReplyAgent(...)
```

### 对它的理解

`runPreparedReply()` 是从“回复配置”过渡到“执行上下文”的桥梁函数。

---

## 8. 第四条主链：Agent Runner 怎么驱动执行

---

## 8.1 `src/auto-reply/reply/agent-runner.ts -> runReplyAgent()`

`runReplyAgent()` 的作用不是直接调模型，而是负责**本轮执行的交互控制与结果管理**。

它通常管这些事情：

- typing signal
- block streaming
- tool output 如何展示
- reply-to 策略
- queue mode
- memory flush
- followup runner
- usage 统计
- session reset / compact 相关 bookkeeping

然后它会调用真正的执行总入口：

```ts
runAgentTurnWithFallback(...)
```

---

## 8.2 执行总调度：`src/auto-reply/reply/agent-runner-execution.ts -> runAgentTurnWithFallback()`

这是执行层总控制器。

它的职责是：

- 桥接 partial text / reasoning / tool result / lifecycle event
- 控制 provider/model fallback
- 根据运行模式分派到不同 agent runner

这里会出现两条主路：

### 路线 A：CLI Agent

调用：
`runCliAgent(...)`

### 路线 B：Embedded Pi Agent

调用：
`runEmbeddedPiAgent(...)`

这就是 OpenClaw Agent Runtime 的两大执行分支。

---

## 9. 第五条主链：CLI Agent 路径

典型文件：

- `src/agents/cli-runner.ts`

---

## 9.1 `runCliAgent()` 的作用

它负责把本轮任务委托给外部 CLI backend。

一般步骤包括：

1. 解析 workspace dir
2. 解析 provider 对应的 CLI backend config
3. 规范化模型名
4. 准备 bootstrap context
5. 解析 session agent ids
6. 构造 system prompt
7. 处理 session id
8. 写入图片或附件输入
9. 拼 prompt 输入
10. 组装 CLI 参数
11. 入队执行
12. 通过 process supervisor 拉起子进程
13. 读取 stdout/stderr/json/jsonl
14. 把结果转成统一的 run result 结构

### 对这条路径的理解

CLI Agent 路径更像：

**“把一轮任务委托给外部命令行 Agent Backend”**

特点通常是：

- 实现相对独立
- 工具能力可能受限
- 更适合作为兼容型后端或外部 provider wrapper

---

## 10. 第六条主链：Embedded Pi Agent 路径

典型文件：

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

这是整个项目最值得精读的 Agent 执行核心。

---

## 10.1 `runEmbeddedPiAgent()` 是做什么的

这个函数负责执行一轮完整的嵌入式 agent run，并处理所有复杂运行时问题：

- lane / queue
- provider/model 解析
- auth profile 轮换
- prompt 提交
- 工具调用
- 重试和 failover
- context overflow
- compaction
- usage 统计
- 错误分类与恢复

### 可以把它拆成几个逻辑段

---

### 第一段：并发控制与 lane

会先处理：

- session lane
- global lane
- enqueue command

说明它不是简单地“来一个请求就跑”，而是有明确的并发秩序控制。

这很重要，因为 AI agent 运行往往涉及：

- 同 session 顺序性
- 中断旧请求
- followup 排队
- 避免同一会话上下文错乱

---

### 第二段：执行前准备

通常包括：

- resolve workspace dir
- ensure models config
- before_model_resolve hook
- provider/model 初始值解析

也就是说，在真正调用模型前，还会经过一层环境准备和 hook 扩展。

---

### 第三段：认证和模型能力决策

常见事情包括：

- auth profile store 准备
- auth profile 排序
- 获取 API key
- resolve model
- 检查 context window guard

说明模型选择不是“直接用一个 model 字符串”，而是要综合 provider、认证、能力边界来决定。

---

### 第四段：主循环（非常关键）

这里通常会有一个重试/恢复主循环。

这个循环里会处理：

- auth profile cooldown / rotation
- 真正提交 prompt
- 累积 usage
- context overflow 检测
- 自动 compaction
- oversized tool result 截断
- timeout / rate limit / billing 错误分类
- provider/model fallback
- thinking level 降级

### 为什么这段重要

这说明 OpenClaw 的 Embedded Agent 不是“单次调用模型 API”，而是一个**有恢复能力的执行状态机**。

这是它和很多简单 agent wrapper 最大的区别之一。

---

## 10.2 单次执行 attempt：`run/attempt.ts`

`runEmbeddedPiAgent()` 可以看成“外层调度器”，  
`run/attempt.ts` 更像“单次原子执行单元”。

单次 attempt 往往负责：

- 组装本次模型输入
- 发起流式调用
- 接收 partial reasoning / partial text
- 处理工具调用请求
- 处理工具结果回填
- 形成单次 attempt 的最终产物
- 返回给外层主循环，供其决定是否继续重试/降级/回退

### 对它的定位

如果说：

- `runPreparedReply()` 负责装业务上下文
- `runReplyAgent()` 负责调度交互控制
- `runEmbeddedPiAgent()` 负责运行时状态机

那么：

**`run/attempt.ts` 就是最接近“真正一轮 agent 推理执行”的地方。**

---

## 11. 一个特别重要的设计点：统一入口复用同一条 pipeline

OpenClaw 架构里有一个非常漂亮的点：

不仅渠道消息会走同一条 pipeline，  
连 Gateway 的 RPC `chat.send` 也会复用这条链。

典型位置：

- `src/gateway/server-methods/chat.ts`

`chat.send` 大致会做：

1. 校验参数
2. 处理 attachment
3. 读取 session entry
4. 处理 stop command
5. 做 idempotency 去重
6. 构造 `MsgContext`
7. 调用统一入站分发

即：

```ts
dispatchInboundMessage(...)
```

### 这意味着什么

Web / RPC / Channel 并没有分叉出三套回复系统。

它们共享同一条：

**统一消息上下文 + Auto Reply Pipeline**

这会带来几个优点：

- 行为一致
- 调试点集中
- 扩展新入口成本低
- 会话和策略逻辑可复用

这是架构层面非常加分的设计。

---

## 12. 核心函数树（建议精读顺序）

下面给你一个“从顶层到下层”的阅读树。

---

## 12.1 系统启动链

```text
src/entry.ts
└─ runCli(...)
   └─ src/cli/run-main.ts
      ├─ buildProgram(...)
      ├─ registerSubClis(...)
      └─ parseAsync(...)
         └─ src/cli/gateway-cli/run.ts
            └─ runGatewayCommand(...)
               └─ src/gateway/server.impl.ts
                  └─ startGatewayServer(...)
                     ├─ loadGatewayPlugins(...)
                     ├─ loadGatewayModelCatalog(...)
                     ├─ createGatewayRuntimeState(...)
                     ├─ create HTTP/WS server
                     ├─ createChannelManager(...)
                     ├─ startChannels(...)
                     ├─ buildGatewayCronService(...)
                     ├─ startGatewayDiscovery(...)
                     └─ createGatewayCloseHandler(...)
```

---

## 12.2 入站消息链

```text
渠道 plugin / RPC chat.send / Web chat
└─ 构造 MsgContext
   └─ src/auto-reply/dispatch.ts
      └─ dispatchInboundMessage(...)
         └─ src/auto-reply/reply/dispatch-from-config.ts
            └─ dispatchReplyFromConfig(...)
               └─ src/auto-reply/reply/get-reply.ts
                  └─ getReplyFromConfig(...)
                     └─ src/auto-reply/reply/get-reply-run.ts
                        └─ runPreparedReply(...)
                           └─ src/auto-reply/reply/agent-runner.ts
                              └─ runReplyAgent(...)
                                 └─ src/auto-reply/reply/agent-runner-execution.ts
                                    └─ runAgentTurnWithFallback(...)
                                       ├─ runCliAgent(...)
                                       └─ runEmbeddedPiAgent(...)
```

---

## 12.3 Embedded Agent 深挖链

```text
runEmbeddedPiAgent(...)
├─ resolveSessionLane(...)
├─ enqueueCommandInLane(...)
├─ resolveRunWorkspaceDir(...)
├─ ensureModelsConfig(...)
├─ resolveAuthProfileOrder(...)
├─ getApiKeyForModel(...)
├─ resolveModel(...)
├─ evaluateContextWindowGuard(...)
├─ attempt loop
│  └─ src/agents/pi-embedded-runner/run/attempt.ts
│     ├─ build model input
│     ├─ stream response
│     ├─ handle tool call
│     ├─ collect usage
│     └─ return attempt result
├─ compact/fallback/retry
└─ final run result
```

---

## 13. 关键设计解读

## 13.1 为什么它要有 Auto Reply 这一层

因为不同消息来源虽然事件格式不同，但对“AI 回复系统”来说，本质都只是：

- 谁发来的
- 发到哪个会话
- 是否带附件/媒体
- 有没有 thread
- 当前 session 配置是什么
- 应该用哪个 agent/model 回复

所以做一层 Auto Reply Pipeline，可以把这些逻辑统一收口，避免：

- 每个渠道自己写一套 agent 调度
- Web/RPC/Channel 三套逻辑分裂
- 模型和会话策略分散在各入口里

---

## 13.2 为什么 Embedded Agent 复杂度很高

因为它要解决真实世界里的 agent 运行问题：

- 同一会话并发冲突
- 模型窗口不够
- 工具结果太大
- API key 限流
- provider 短暂错误
- thinking 模式过重
- fallback 到别的模型/provider
- 需要保住流式体验

所以 Embedded Agent 本质上是“运行时状态机”，而不是普通 API 调用函数。

---

## 13.3 为什么插件系统很重要

因为 OpenClaw 的扩展边界非常多：

- 渠道
- hook
- gateway method
- service
- sidecar
- 也可能包含模型/能力相关扩展

没有插件系统，这个项目会快速膨胀成一个难以维护的大单体。

---

## 13.4 为什么统一 MsgContext 很关键

这是整个架构复用性的基础。

只要不同入口最终都能转换成统一消息上下文，那么：

- 后面的回复策略能复用
- 会话逻辑能复用
- 工具/模型/记忆逻辑能复用
- 调试和可观测点更集中

---

## 14. 我认为最值得优先读的代码文件

如果你时间有限，我建议按这个顺序读。

### 第一批：看清系统主骨架

1. `src/gateway/server.impl.ts`
2. `src/auto-reply/reply/get-reply-run.ts`
3. `src/auto-reply/reply/agent-runner-execution.ts`
4. `src/agents/pi-embedded-runner/run.ts`

### 第二批：看清消息怎么进来

5. `src/gateway/server-channels.ts`
6. `src/auto-reply/dispatch.ts`
7. `src/auto-reply/reply/dispatch-from-config.ts`
8. `src/auto-reply/reply/get-reply.ts`

### 第三批：看清 Agent 单轮怎么执行

9. `src/agents/pi-embedded-runner/run/attempt.ts`
10. `src/agents/cli-runner.ts`
11. `src/agents/model-selection.ts`
12. `src/agents/model-auth.ts`

### 第四批：看扩展能力

13. `src/plugins/loader.ts`
14. `src/plugins/registry.ts`
15. `src/gateway/server-plugins.ts`
16. `src/channels/plugins/index.ts`

---

## 15. 如果你要继续做更深层源码分析，应该怎么挖

可以沿三条路线继续。

---

## 路线 A：盯一条真实消息链到底

从一个实际入口开始，比如 `chat.send` 或某个渠道消息。

推荐路径：

```text
chat.send / inbound event
→ dispatchInboundMessage
→ dispatchReplyFromConfig
→ getReplyFromConfig
→ runPreparedReply
→ runReplyAgent
→ runAgentTurnWithFallback
→ runEmbeddedPiAgent
→ run attempt
```

适合你建立“完整链路认知”。

---

## 路线 B：盯 Gateway 装配全过程

推荐路径：

```text
runGatewayCommand
→ startGatewayServer
→ load plugins/models
→ create runtime state
→ attach server methods
→ createChannelManager
→ start background services
→ register close/reload handlers
```

适合你看系统框架。

---

## 路线 C：盯渠道插件边界

推荐路径：

```text
load channel plugin
→ startAccount
→ inbound event adapter
→ MsgContext
→ dispatchInboundMessage
→ outbound send adapter
```

适合你看如何扩展新渠道。

---

## 16. 这个架构的优点和代价

## 优点

### 1）入口统一

不同入口共用统一业务主线。

### 2）扩展性好

渠道、插件、服务、方法都能比较自然地扩展。

### 3）策略集中

会话、模型、tool、typing、TTS 等逻辑集中在 auto-reply + agent runtime。

### 4）执行层成熟

Embedded Agent 看起来不是 demo 级别，而是考虑了真实运行时问题。

---

## 代价

### 1）编排函数容易变大

像 `runPreparedReply()`、`startGatewayServer()`、`runEmbeddedPiAgent()` 这类函数容易膨胀。

### 2）跨层信息传递复杂

session、channel、model、auth、tool、hook 的上下文穿透较多。

### 3）学习成本高

如果不先看懂业务骨架，只盯单文件会很难建立全貌。

---

## 17. 一句话总结项目设计

OpenClaw 的本质不是“某个聊天机器人功能集合”，而是：

**一个把多入口消息、统一会话上下文、回复编排、Agent 执行、插件扩展和多宿主能力整合在一起的 AI 助手运行平台。**

真正的核心，不在某个渠道插件，而在这条统一主链：

```text
统一消息上下文
→ Auto Reply Pipeline
→ Agent Runtime
→ 回复回写
```

---

## 18. 给你的下一步阅读建议

如果你想把它吃透，建议下一轮继续做下面这种更细的文档：

### 版本 2：函数级调用树教程

把每个关键函数再继续展开到下一层子函数，按树结构列出：

- 输入
- 输出
- 关键状态
- 调用下游
- 在整条链中的角色

### 版本 3：一条真实消息链逐函数走读

选一个入口（例如 `chat.send`），逐函数追踪：

- 参数如何变化
- session/context 如何组装
- 什么时候选模型
- 什么时候进入工具
- 结果如何回写

### 版本 4：Embedded Pi Agent 专项教程

单独深挖：

- lane / queue
- fallback
- compaction
- auth profile rotation
- attempt loop
- tool integration

---

## 19. 最后给你一个“最短记忆版”

如果你隔几天再回来，只记这几句就够了：

1. **Gateway 是控制平面**
2. **Auto Reply 是统一业务编排层**
3. **Embedded Pi Agent 是执行内核**
4. **Channel / Plugin 只是接入边界**
5. **所有入口最终尽量走同一条 reply pipeline**

---

## 20. 附：最关键函数速查表

| 层级          | 函数/文件                    | 作用                          |
| ------------- | ---------------------------- | ----------------------------- |
| 进程入口      | `src/entry.ts`               | 启动程序，转交 CLI            |
| CLI 总入口    | `runCli()`                   | 命令行总调度                  |
| Gateway CLI   | `runGatewayCommand()`        | 进入 Gateway 启动路径         |
| 系统装配      | `startGatewayServer()`       | 启动并装配整个 OpenClaw       |
| 渠道管理      | `createChannelManager()`     | 管理 channel account 生命周期 |
| 入站分发      | `dispatchInboundMessage()`   | 统一入站消息转发              |
| 回复调度      | `dispatchReplyFromConfig()`  | 判重/会话/typing/hook 编排    |
| 回复准备      | `getReplyFromConfig()`       | 解析模型和会话级控制          |
| 执行装配      | `runPreparedReply()`         | 组装本轮 agent 执行输入       |
| Agent 调度    | `runReplyAgent()`            | 管理本轮交互执行与结果        |
| 执行总入口    | `runAgentTurnWithFallback()` | fallback 与执行路径分发       |
| CLI 执行      | `runCliAgent()`              | 外部 CLI backend 执行         |
| Embedded 执行 | `runEmbeddedPiAgent()`       | 内嵌 Agent 运行时主循环       |
| 单次 attempt  | `run/attempt.ts`             | 一次真实推理/工具执行单元     |

---

这份文档适合作为第一版“系统骨架教程”。  
如果继续往下做，最值得挖的是 `runPreparedReply()`、`runEmbeddedPiAgent()` 和 `run/attempt.ts` 这三个核心点。
