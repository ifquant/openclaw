# OpenClaw 总体业务调用层次图

OpenClaw 可以先看成一个把外部触发转换成 agent 运行的系统。主要触发来源只有 5 类：渠道消息、手动命令、follow-up / memory 回合、cron / 定时任务、plugin / hook / one-off task。它们大多都会汇合到同一条主线：

```text
外部触发
  -> 业务入口层
  -> 业务编排层
  -> 通用执行层
  -> 底层运行层
  -> 模型 / 工具 / transcript / compaction
```

四层各自的作用可以先压成一行：接事件 -> 定回应策略 -> 统一调度与恢复 -> 真正执行一轮 agent run。

---

## 四层模型

### 1. 业务入口层

这一层负责把外部事件接进系统。

典型外部事件：

- 渠道来了一条消息
- 用户执行了一个 CLI 命令
- cron 到点
- 插件 / webhook / hook 触发

这一层通常做什么：

- 识别事件来源
- 解析原始输入
- 构造内部上下文

你在这一层通常会看到：

- `ctx`
- channel metadata
- command args
- cron payload

代表文件：

- `src/auto-reply/reply/get-reply.ts`
- `src/commands/agent.ts`
- `src/cron/isolated-agent/run.ts`
- 各种 extension 的入口文件

读这一层时要问：

- 这个请求从哪里来？
- 它刚进入系统时是什么形态？
- 接下来会交给谁继续处理？

### 2. 业务编排层

这一层负责把“外部事件”变成“可执行的系统回应”。

这一层通常做什么：

- 初始化 session 状态
- 处理 reset / directives / model override
- 组织 typing / queue / group intro / delivery
- 准备 skill snapshot / memory flush / follow-up
- 决定走 embedded 还是 CLI
- 决定是否需要 model fallback

最关键的一点：

- 这层通常不直接决定“回复内容是什么”
- 它先决定“要不要问模型，以及带什么条件去问”

代表文件：

- `src/auto-reply/reply/get-reply-run.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`
- `src/auto-reply/reply/followup-runner.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`

读这一层时要问：

- 这次请求为什么会走这条分支？
- 它补了哪些上下文？
- 它改了哪些运行条件？

### 3. 通用执行层

这一层是很多业务线汇合的地方。

它不再关心“这条请求是不是从 Telegram 进来的”，而更关心：

- 用什么模型
- 用哪个 auth profile
- 是否要 fallback
- 是否要重试
- 走 embedded 还是 CLI

这一层通常做什么：

- model fallback
- auth profile 选择
- lane 排队
- thinking/profile 级恢复

代表文件：

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/model-fallback.ts`
- `src/agents/cli-runner.ts`

读这一层时要问：

- 为什么现在要重试？
- 为什么要换 profile / 降 thinking / 换模型？
- 哪些问题在这一层解决，哪些继续下沉？

### 4. 底层运行层

这一层才是真正把一轮 agent 跑起来的地方。

这一层通常做什么：

- 解析 workspace / sandbox
- 加载 skills / bootstrap / context files
- 构建 tools
- 构建 system prompt
- 打开 transcript
- 创建 agent session
- 调 `activeSession.prompt(...)`
- 处理 tool loop / compaction / cleanup

代表文件：

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/compact.ts`
- `src/agents/system-prompt.ts`
- `src/agents/openclaw-tools.ts`

读这一层时要问：

- 真正发给模型的输入是什么？
- tools / prompt / history / sandbox 是怎么装起来的？
- 哪一步真正调用了模型？

---

## 主要业务线

OpenClaw 的业务虽然很多，但从读代码角度，可以先收成 5 条主线。

### 1. 渠道消息 -> 自动回复主线

这是最像真实产品的一条。

调用骨架：

```text
渠道消息
  -> get-reply.ts
  -> get-reply-run.ts
  -> agent-runner-execution.ts
  -> runEmbeddedPiAgent 或 runCliAgent
  -> runEmbeddedAttempt
```

关键文件：

- `src/auto-reply/reply/get-reply.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`

这条线代表：

- 用户真的发来一条消息
- 系统要正常自动回复

### 2. follow-up / memory 主线

这是自动回复的衍生线。

调用骨架：

```text
follow-up / memory 触发
  -> followup-runner.ts 或 agent-runner-memory.ts
  -> runWithModelFallback(...)
  -> runEmbeddedPiAgent
  -> runEmbeddedAttempt
```

关键文件：

- `src/auto-reply/reply/followup-runner.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`

这条线代表：

- 不是首轮用户消息
- 而是后续追跑、补跑或内部维护回合

### 3. 手动命令主线

调用骨架：

```text
openclaw agent ...
  -> commands/agent.ts
  -> runWithModelFallback(...)
  -> runEmbeddedPiAgent 或 runCliAgent
  -> runEmbeddedAttempt
```

关键文件：

- `src/commands/agent.ts`

这条线代表：

- 用户明确要求“跑一轮 agent”
- 不是自然聊天触发

### 4. cron / 定时任务主线

调用骨架：

```text
cron 触发
  -> cron/isolated-agent/run.ts
  -> runWithModelFallback(...)
  -> runEmbeddedPiAgent 或 runCliAgent
  -> runEmbeddedAttempt
```

关键文件：

- `src/cron/isolated-agent/run.ts`

这条线代表：

- 到点自动执行
- 经常配合 isolated session / delivery

### 5. extension / one-off task 主线

调用骨架：

```text
plugin / hook / tool
  -> 各自入口文件
  -> runEmbeddedPiAgent
  -> runEmbeddedAttempt
```

典型文件：

- `src/hooks/llm-slug-generator.ts`
- `extensions/llm-task/src/llm-task-tool.ts`
- `extensions/voice-call/src/response-generator.ts`

这条线代表：

- 不是完整聊天业务
- 而是复用 runner 做一次任务

---

## 业务线和 docs 的对应关系

这部分只保留最有用的对应关系。

| 业务线     | 代码入口                                          | 对应 docs                                             | 怎么触发                                               |
| ---------- | ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| 自动回复   | `src/auto-reply/reply/get-reply.ts`               | `docs/channels/*`, `docs/tools/slash-commands.md`     | 在 Telegram/Discord/Slack 等渠道直接发消息             |
| 手动命令   | `src/commands/agent.ts`                           | `docs/cli/agent.md`                                   | `openclaw agent --message "hello"`                     |
| cron       | `src/cron/isolated-agent/run.ts`                  | `docs/cli/cron.md`, `docs/automation/cron-jobs.md`    | `openclaw cron add ...` / `openclaw cron run <job-id>` |
| llm-task   | `extensions/llm-task/src/llm-task-tool.ts`        | `docs/tools/llm-task.md`                              | `openclaw.invoke --tool llm-task ...`                  |
| voice-call | `extensions/voice-call/src/response-generator.ts` | `docs/plugins/voice-call.md`, `docs/cli/voicecall.md` | `openclaw voicecall start`                             |
| ACP        | `src/acp/*`                                       | `docs/tools/acp-agents.md`, `docs/cli/acp.md`         | `/acp ...` 或对应 CLI                                  |

注意：

- 不是每条线都该用 CLI 触发
- 自动回复主线最自然的触发方式是“发消息”
- cron 最自然的触发方式是“配置任务然后运行”

---

## 推荐阅读顺序

如果你要尽快建立整体层次，建议按这个顺序读。

### 第一轮：只建立骨架

1. `src/commands/agent.ts`
2. `src/auto-reply/reply/get-reply.ts`
3. `src/cron/isolated-agent/run.ts`
4. `src/agents/pi-embedded-runner/run.ts`
5. `src/agents/pi-embedded-runner/run/attempt.ts`

目标：

- 先看三类业务入口怎么汇入一条执行主线

### 第二轮：补自动回复内部编排

1. `src/auto-reply/reply/get-reply-run.ts`
2. `src/auto-reply/reply/agent-runner-execution.ts`
3. `src/auto-reply/reply/followup-runner.ts`
4. `src/auto-reply/reply/agent-runner-memory.ts`

目标：

- 看清自动回复内部怎么拆成 execution / follow-up / memory

### 第三轮：补底层运行机制

1. `src/agents/pi-embedded-runner/run/attempt.ts`
2. `src/agents/pi-embedded-runner/compact.ts`
3. `src/agents/system-prompt.ts`
4. `src/agents/openclaw-tools.ts`

目标：

- 看清一轮 run 到底如何真正执行

---

## 推荐实验顺序

下面这组实验的目标，是把“代码层次”和“真实触发方式”对上。

### 实验 1：命令主线

```bash
openclaw agent --message "hello"
```

看对应代码：

- `src/commands/agent.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

### 实验 2：自动回复主线

在已接入的聊天渠道里发一条普通消息：

```text
Summarize my tasks for today
```

看对应代码：

- `src/auto-reply/reply/get-reply.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`

### 实验 3：命令/控制面

在聊天里发：

```text
/status
/model
/think high
/new
```

重点观察：

- 哪些命令直接被命令系统处理
- 哪些命令会影响后续 agent run

### 实验 4：cron 主线

```bash
openclaw cron add \
  --name "test-job" \
  --at "2026-12-31T00:00:00Z" \
  --session isolated \
  --message "say hello from cron" \
  --announce

openclaw cron list
openclaw cron run <job-id>
```

看对应代码：

- `src/cron/isolated-agent/run.ts`

### 实验 5：one-off task 主线

```bash
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Return a JSON object with greeting and language.",
  "schema": {
    "type": "object",
    "properties": {
      "greeting": { "type": "string" },
      "language": { "type": "string" }
    },
    "required": ["greeting", "language"],
    "additionalProperties": false
  }
}'
```

看对应代码：

- `extensions/llm-task/src/llm-task-tool.ts`

---

## 读代码时最实用的判断法

以后你打开一个文件，先不要急着看细节，先问自己：

1. 这个文件属于哪一层？
2. 它属于哪条业务线？
3. 它是决定“要不要跑”，还是决定“怎么跑”，还是已经在“真正执行”？

如果这 3 个问题你能先答出来，OpenClaw 的整体结构就不会再散。
