# OpenClaw 主干教程 2：从总体设计到代码实现

这篇教程只做一件事：

把 OpenClaw 的主干流程打通。

目标不是罗列所有精巧细节，而是让你先在脑中形成一个稳定的系统骨架：

- OpenClaw 到底是什么
- 它的总体设计为什么是这样
- 主要业务流程有哪几条
- 每条流程对应到哪些关键代码
- 如果你想做一个类似 OpenClaw 的系统，应该先实现哪些东西

如果你之前读 OpenClaw 读到很多“精妙局部”，却始终没有全局概念，那么这篇文档就是先把那根主梁搭起来。

---

## 1. 先用一句话说清 OpenClaw

OpenClaw 不是一个“自己实现了完整 Agent 大脑”的项目。

它更像一个厚重的工程壳，用来把真实世界的复杂性整理成一轮可运行的 agent 会话。

更准确地说：

```text
OpenClaw = 多入口业务系统 + 通用 agent 执行壳 + 运行时安全/状态/路由基础设施
```

这里面最重要的架构判断是：

- 思考和工具决策的核心 loop 很大程度上委托给外部 agent core
- OpenClaw 自己把大量精力放在“外部世界的接入、整理、裁决、保护、投递、恢复”上

所以如果你要理解 OpenClaw，不要先问：

- “它的 ReAct while loop 在哪？”

你应该先问：

- 一条消息怎么进来
- 系统怎么决定要不要跑 agent
- 系统怎么准备 prompt、tools、session、sandbox
- agent 跑完以后，输出怎么安全回到真实世界

这才是 OpenClaw 的主干。

---

## 2. OpenClaw 的总体设计：它在解决什么问题

OpenClaw 面对的不是一个单一聊天框，而是一个复杂的、持续运行的、与外部世界长期交互的 agent 系统。

它要同时处理这些问题：

- 来自不同渠道的消息入口
- 用户命令、群聊、定时任务、plugin、hook 这些不同触发源
- session 如何长期存在、切换、恢复、压缩
- 模型和 provider 如何切换、fallback、重试
- 工具如何暴露、裁决、限制、审批
- 文件系统、shell、浏览器、网络这些高风险边界如何被壳层约束
- agent 跑完以后，结果如何被送回不同渠道

所以它的设计不是“一个模型调用器”，而是一台持续运行的 agent 机器。

这台机器的总流程可以先压成一条线：

```text
外部触发
  -> 系统接住事件
  -> 系统决定如何回应
  -> 系统组装执行条件
  -> 系统真正跑一轮 agent
  -> 系统把结果回写到世界
```

这条线就是后面整篇教程的骨架。

---

## 3. 四层心智模型：先别看函数，先看层次

把 OpenClaw 压成四层，是最容易建立全局感的方法。

```text
第一层：业务入口层
第二层：业务编排层
第三层：通用执行层
第四层：底层运行层
```

你可以把这四层理解成：

```text
业务入口层：系统接住“发生了什么”
业务编排层：系统决定“应该怎么回应”
通用执行层：系统决定“用什么条件去跑”
底层运行层：系统真正执行“这一轮 run”
```

### 3.1 业务入口层

这一层负责把现实世界的事件接进系统。

典型入口有：

- 渠道消息
- 手动命令
- follow-up / memory 回合
- cron / 定时任务
- plugin / hook / one-off task

这一层做的事不是跑模型，而是把事件转成系统内部能理解的上下文。

典型文件：

- `openclaw/src/auto-reply/reply/get-reply.ts`
- `openclaw/src/commands/agent.ts`
- `openclaw/src/cron/isolated-agent/run.ts`
- `openclaw/src/hooks/llm-slug-generator.ts`
- `openclaw/extensions/voice-call/src/response-generator.ts`

你在这一层应该关注：

- 事件从哪里来
- 输入最原始长什么样
- 它接下来被交给哪个编排器

### 3.2 业务编排层

这一层负责把“外部事件”变成“可执行的系统回应”。

它通常做这些事：

- 初始化 session 状态
- 处理 reset / directives / model override
- 决定 typing、queue、group intro、delivery
- 处理 follow-up、memory flush、skill snapshot
- 决定走 embedded 还是 CLI
- 决定是否要 model fallback

最关键的是：

- 这层一般不直接决定“回复内容”
- 它先决定“要不要问模型，以及怎么带着条件去问模型”

典型文件：

- `openclaw/src/auto-reply/reply/get-reply-run.ts`
- `openclaw/src/auto-reply/reply/agent-runner-execution.ts`
- `openclaw/src/auto-reply/reply/followup-runner.ts`
- `openclaw/src/auto-reply/reply/agent-runner-memory.ts`

### 3.3 通用执行层

这一层是不同业务线汇合的地方。

它不再关心“是不是 Telegram 消息”，而更关心：

- 用什么模型
- 用哪个 auth profile
- 是否要 fallback
- 是否要重试
- 走 embedded 还是 CLI

这一层最典型的文件是：

- `openclaw/src/agents/pi-embedded-runner/run.ts`
- `openclaw/src/agents/model-fallback.ts`
- `openclaw/src/agents/cli-runner.ts`

### 3.4 底层运行层

这一层才真正开始跑一轮 agent。

它通常做这些事：

- 解析 workspace / sandbox
- 加载 skills / bootstrap / context files
- 构建 tools
- 构建 system prompt
- 打开 transcript / session
- 创建 agent session
- 调 `activeSession.prompt(...)`
- 处理 tool loop / compaction / cleanup

这一层的关键文件是：

- `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `openclaw/src/agents/pi-embedded-runner/compact.ts`
- `openclaw/src/agents/system-prompt.ts`
- `openclaw/src/agents/openclaw-tools.ts`

如果你把四层装进脑子里，再看 OpenClaw 的任意文件，就不会再那么容易迷路。

---

## 4. 五条主要业务线：从不同入口汇合到一条执行主线

虽然 OpenClaw 很大，但主业务线其实可以先收成五条。

### 4.1 渠道消息 -> 自动回复主线

这是最像真实产品路径的一条。

它的骨架是：

```text
渠道消息
  -> getReplyFromConfig
  -> runPreparedReply
  -> runReplyAgent
  -> agent-runner-execution
  -> runEmbeddedPiAgent / runCliAgent
  -> runEmbeddedAttempt
```

关键文件：

- `openclaw/src/auto-reply/reply/get-reply.ts`
- `openclaw/src/auto-reply/reply/get-reply-run.ts`
- `openclaw/src/auto-reply/reply/agent-runner-execution.ts`

这条线最能代表 OpenClaw 的产品主路径。

### 4.2 follow-up / memory 主线

这条线是自动回复的衍生路径。

它的骨架是：

```text
follow-up / memory 触发
  -> followup-runner / agent-runner-memory
  -> runWithModelFallback
  -> runEmbeddedPiAgent
  -> runEmbeddedAttempt
```

关键文件：

- `openclaw/src/auto-reply/reply/followup-runner.ts`
- `openclaw/src/auto-reply/reply/agent-runner-memory.ts`

它说明 OpenClaw 不只是处理“当前这条消息”，还会处理后续追跑和内部维护型回合。

### 4.3 手动命令主线

这条线代表的是用户明确要求系统跑一轮 agent。

骨架：

```text
openclaw agent ...
  -> commands/agent.ts
  -> runWithModelFallback
  -> runEmbeddedPiAgent / runCliAgent
  -> runEmbeddedAttempt
```

关键文件：

- `openclaw/src/commands/agent.ts`

这条线的重要性在于，它让你看到业务入口并不一定来自“聊天消息”。

### 4.4 cron / 定时任务主线

这条线代表系统自己在某个时间点启动一轮任务。

骨架：

```text
cron 触发
  -> cron/isolated-agent/run.ts
  -> runWithModelFallback
  -> runEmbeddedPiAgent / runCliAgent
  -> runEmbeddedAttempt
```

关键文件：

- `openclaw/src/cron/isolated-agent/run.ts`

这条线非常重要，因为它让 OpenClaw 从“被动回复”变成“主动执行”。

### 4.5 plugin / one-off task 主线

这条线说明 `runEmbeddedPiAgent` 不只是聊天执行器，也被复用成统一的任务执行壳。

典型骨架：

```text
plugin / hook / one-off task
  -> 各自入口文件
  -> runEmbeddedPiAgent
  -> runEmbeddedAttempt
```

典型文件：

- `openclaw/src/hooks/llm-slug-generator.ts`
- `openclaw/extensions/llm-task/src/llm-task-tool.ts`
- `openclaw/extensions/voice-call/src/response-generator.ts`

这条线很值得注意，因为它说明 OpenClaw 的执行壳已经被抽得足够通用。

---

## 5. 一条消息的主干流程：从渠道到模型，再回到用户

如果你只想看一条最重要的业务路径，那就看“渠道消息 -> 自动回复”。

它可以压成下面这条链：

```text
渠道监听器
  -> 整理 MsgContext
  -> getReplyFromConfig(...)
  -> runPreparedReply(...)
  -> runReplyAgent(...)
  -> runEmbeddedPiAgent(...)
  -> runEmbeddedAttempt(...)
  -> activeSession.prompt(...)
  -> agent 输出 payload
  -> routeReply / channel delivery
```

把它拆开来看：

### 5.1 渠道层先整理输入

渠道 monitor 负责把真实世界的消息整形成一个统一上下文。

例如 Web / WhatsApp 路径里可以看到类似：

- `monitorWebChannel(...)`
- `processMessage(...)`
- `dispatchReplyFromConfig(...)`

这些代码负责的不是跑模型，而是：

- 识别发件人、群组、消息体、附件、回复关系
- 构造内部 sessionKey
- 去重、记日志、做安全门控

### 5.2 `getReplyFromConfig` 把消息接进自动回复系统

真正的自动回复入口在：

- `openclaw/src/auto-reply/reply/get-reply.ts`

这里做的事很多，但可以压成四类：

- 加载配置
- 决定当前 session 和 agent
- 做 model / workspace / typing / session state 初始化
- 最终交给 `runPreparedReply(...)`

这一步的本质是：

- 系统已经知道“收到了什么”
- 现在开始决定“要不要认真回复，以及用什么上下文去回复”

### 5.3 `runPreparedReply` 做业务编排

入口在：

- `openclaw/src/auto-reply/reply/get-reply-run.ts`

这里会处理：

- group chat context
- inbound meta system prompt
- queue / typing policy
- skill snapshot
- reset / directives / queue mode

这一步是典型的业务编排层。

### 5.4 `agent-runner-execution` 决定进入哪条执行路径

入口在：

- `openclaw/src/auto-reply/reply/agent-runner-execution.ts`

这里会决定：

- 走 `runEmbeddedPiAgent`
- 还是走 `runCliAgent`
- 怎么对接 partial reply、reasoning、tool event、typing 信号

它是自动回复系统汇入通用执行层的桥梁。

### 5.5 `runEmbeddedPiAgent` 做外层调度

入口在：

- `openclaw/src/agents/pi-embedded-runner/run.ts`

这里负责的是：

- lane 排队
- provider/model 解析
- auth profile 选择
- context overflow 恢复
- fallback / retry / thinking 降级

它不是单次执行体，而是一次 agent run 的外层调度壳。

### 5.6 `runEmbeddedAttempt` 才是单次真实执行体

入口在：

- `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`

这里会做真正的运行装配：

- 解析 sandbox / effective workspace
- 构建 tools
- 构建 system prompt
- 打开 session transcript
- 创建 agent session
- 调 `activeSession.prompt(...)`
- 等待 compaction / cleanup

这一步才是系统正式把请求交给模型和工具 loop。

### 5.7 结果回到真实世界

模型完成后，结果会被重新收束成 payload，再被发回具体渠道。

所以从总体上看，OpenClaw 的自动回复不是一段 while loop，而是一条“输入整形 -> 编排 -> 统一执行 -> 底层运行 -> 输出投递”的长链。

---

## 6. 为什么 OpenClaw 会长成这样：几个关键设计判断

如果你想做类似 OpenClaw 的系统，你必须先理解它的几个总判断。

### 6.1 “大脑外包，壳层做厚”

OpenClaw 的最大判断不是去重写一个完整 agent core，而是把大量投入放在壳层：

- 接入
- 工具
- 安全
- session
- fallback
- compaction
- 路由

这是一种很现实的工程策略。

因为真正让系统在生产里失稳的，往往不是“模型不会思考”，而是：

- 触发源太多
- 外部环境太脏
- 长期 session 太难维护
- 高风险工具太难约束

### 6.2 “业务入口可以很多，但执行壳应该尽量统一”

OpenClaw 的消息、命令、cron、plugin 入口很多。

但它们大多会汇入少数几个统一执行壳：

- `runEmbeddedPiAgent`
- `runCliAgent`
- `runEmbeddedAttempt`

这说明一个重要经验：

如果你想让系统可维护，不要为每条业务线单独发明一套执行器。

正确做法是：

- 上层业务多样
- 下层执行统一

### 6.3 “业务编排层不直接替模型思考”

业务编排层的核心职责是：

- 决定是否要问模型
- 决定用什么条件问模型

而不是：

- 自己在代码里替模型算出回复内容

这是一条很重要的分界线。

如果编排层开始同时处理太多业务判断和内容决策，系统会很快变得混乱。

### 6.4 “长期运行比单轮优雅更重要”

OpenClaw 里大量代码都在为“长期运行”服务：

- session transcript
- compaction
- auth profile rotation
- model fallback
- queue / lane
- delivery / retry / cleanup

这说明它的目标不是“单轮跑通”，而是“长期不崩”。

---

## 7. 几个跨业务线的核心对象

如果你想自己做类似系统，有几个对象几乎一定会出现。

### 7.1 `sessionKey`

它是跨业务线最重要的身份键。

它决定：

- 消息归属哪个 session
- group / DM / subagent / cron 如何被区分
- 后续 routing、storage、policy 如何对齐

你可以重点看：

- `openclaw/src/sessions/session-key-utils.ts`
- `openclaw/src/routing/session-key.ts`

### 7.2 session transcript

如果没有长期 transcript，系统就没法做：

- 历史上下文
- compaction
- tool result pairing
- follow-up / memory / heartbeat

你可以重点看：

- `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `openclaw/src/agents/transcript-policy.ts`

### 7.3 tools 与 tool policy

OpenClaw 不是把一堆工具“无脑塞给模型”。

它会根据：

- session 范围
- sender 权限
- sandbox
- provider 能力
- subagent / group / channel 约束

来构建最终可见工具集。

重点看：

- `openclaw/src/agents/openclaw-tools.ts`
- `openclaw/src/agents/pi-tools.policy.ts`
- `openclaw/src/agents/tool-policy-pipeline.ts`
- `openclaw/src/agents/pi-tools.ts`

### 7.4 system prompt

OpenClaw 的 system prompt 不是静态字符串。

它是多种运行信息拼起来的：

- runtime info
- workspace info
- tools
- sandbox
- skills
- docs / context files
- message channel 能力

重点看：

- `openclaw/src/agents/system-prompt.ts`
- `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`

### 7.5 ACP / control-plane

这一块不是最先要读的，但它很重要。

它代表的是：

- 统一会话语义
- 运行时控制面
- 对运行中 session 的管理和控制

重点看：

- `openclaw/src/acp/`
- `openclaw/src/acp/control-plane/manager.ts`

---

## 8. 如果你自己实现一个类似 OpenClaw 的软件，应该怎么分阶段做

不要一开始就照着 OpenClaw 抄全量功能。

你应该按能力层级逐步实现。

### 阶段 1：先做统一执行壳

先只做：

- 一个 session
- 一个模型 provider
- 一组简单 tools
- 一个最小 transcript
- 一条 `run -> prompt -> tool -> reply` 主线

目标不是产品化，而是把“通用执行层 + 底层运行层”跑通。

### 阶段 2：再做业务入口层

先选一种入口：

- CLI 命令
- 或一个聊天渠道

把“消息 / 命令 -> 内部上下文 -> 执行壳”这条链打通。

### 阶段 3：加入业务编排层

这时才开始做：

- session state
- directives
- typing
- queue
- group / DM 区分
- skill snapshot
- model override

你会发现这一步才真正开始接近 OpenClaw 的复杂度。

### 阶段 4：加入长期运行能力

也就是：

- compaction
- transcript 修复
- fallback
- auth profile rotation
- retry
- delivery

这是从“demo”迈向“系统”的关键一步。

### 阶段 5：最后再做控制面与生态

例如：

- ACP
- plugins
- 多渠道适配
- cron
- one-off task

这一步是系统化扩展，不该放在最前面。

---

## 9. 建议阅读顺序：先骨架，再细节

如果你现在的目标是“真正理解 OpenClaw 的总体设计”，建议这样读：

### 第一轮：只看主梁

1. `openclaw/source_maps/openclaw_business_call_hierarchy_map.md`
2. `openclaw/source_maps/openclaw_code_map.md`
3. `openclaw/src/commands/agent.ts`
4. `openclaw/src/auto-reply/reply/get-reply.ts`
5. `openclaw/src/agents/pi-embedded-runner/run.ts`
6. `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`

目标：

- 建立“四层 + 五条主线”的总体骨架

### 第二轮：只看自动回复主线

1. `openclaw/src/auto-reply/reply/get-reply.ts`
2. `openclaw/src/auto-reply/reply/get-reply-run.ts`
3. `openclaw/src/auto-reply/reply/agent-runner-execution.ts`
4. `openclaw/src/agents/pi-embedded-runner/run.ts`
5. `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`

目标：

- 把“渠道消息 -> 自动回复 -> agent 执行”这条主线读通

### 第三轮：补安全、控制面和生态

1. `openclaw/src/infra/`
2. `openclaw/src/sessions/`
3. `openclaw/src/acp/`
4. `openclaw/src/channels/`
5. `openclaw/extensions/`

目标：

- 看清工程壳为什么会变得这么厚

---

## 10. 最后给你一个真正有用的判断标准

以后你再打开 OpenClaw 的某个文件，不要先问“这个函数细节是什么”。

先问这 4 个问题：

1. 这个文件属于哪一层？
2. 它属于哪条业务线？
3. 它是在决定“要不要跑”，还是“用什么条件跑”，还是“真正执行一轮 run”？
4. 它的输入来自哪里，输出又交给谁？

只要这 4 个问题先答出来，OpenClaw 的主干就不会散。

这也是你将来实现一个类似 OpenClaw 的系统时，最需要保留的思维方式。
