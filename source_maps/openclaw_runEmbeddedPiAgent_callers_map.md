# OpenClaw 全景调用图：`runEmbeddedPiAgent` 在哪里被调用

这份文档专门回答两个问题：

1. `runEmbeddedPiAgent` 在仓库里到底被谁调用？
2. 如果我想从“总体架构”快速进入代码，应该先走哪几条主路径？

如果你现在对 OpenClaw 还处在“目录能看懂，但入口还是糊的”阶段，这份图比单看 `run.ts` 更重要。

---

## 先记一个总判断

`runEmbeddedPiAgent` 不是只给一个地方用。

它是 OpenClaw 里“非 CLI provider 的通用 agent 执行主入口”之一。

你可以先把系统压成这个结构：

```text
外部触发
  -> 上层业务调度器
    -> runEmbeddedPiAgent
      -> runEmbeddedAttempt
        -> createAgentSession / prompt / tool loop
```

也就是说：

- 业务层决定“为什么要跑一轮 agent”
- `runEmbeddedPiAgent` 决定“这一轮怎么调度和失败恢复”
- `runEmbeddedAttempt` 决定“这一轮具体怎么执行”

---

## 它的定义与导出位置

真正定义在：

- `src/agents/pi-embedded-runner/run.ts`

对外再导出一层：

- `src/agents/pi-embedded-runner.ts`

很多业务代码并不是直接 import `run.ts`，而是通过：

- `src/agents/pi-embedded.js`
- 或 `src/agents/pi-embedded-runner.js`

这种聚合入口拿到它。

所以你读引用时，不要只搜 `./run.js`，要搜函数名本身。

---

## 全景主图

先看最有用的一张简化图：

```text
用户消息 / 定时任务 / 命令 / 内部工具
  -> 业务层入口
    -> runEmbeddedPiAgent
      -> runEmbeddedAttempt
        -> createAgentSession
        -> activeSession.prompt()
        -> tool loop / compaction / cleanup
      -> buildEmbeddedRunPayloads
      -> 返回业务层
```

真正复杂的部分不是 `runEmbeddedPiAgent` 被“很多地方”调用，
而是这些地方本质上可以归并成 6 条主业务线。

---

## 主路径 1：自动回复主线

这是最值得先读的一条。

直接调用点：

- `src/auto-reply/reply/agent-runner-execution.ts`

这一条线代表的是真正的“用户消息进来，然后 agent 回复”。

你可以把主关系记成：

```text
消息进入 auto-reply
  -> reply 相关调度器
    -> agent-runner-execution.ts
      -> runEmbeddedPiAgent
        -> runEmbeddedAttempt
```

这条线里，上层做的事情包括：

- 解析 sender / group / session context
- 构建 embedded run base params
- 连接 typing、partial reply、reasoning stream、tool lifecycle 等回调
- 决定 tool result 的格式是 `markdown` 还是 `plain`

如果你要理解“真实聊天里 agent 怎么跑起来”，第一条就该读它。

---

## 主路径 2：跟进消息 / follow-up 主线

直接调用点：

- `src/auto-reply/reply/followup-runner.ts`

这条线代表的是：

- 某条消息不是立刻完成
- 后面要继续补跑一个 follow-up
- 或者带模型 fallback 的继续追问

关系可以记成：

```text
follow-up 队列
  -> followup-runner.ts
    -> runWithModelFallback(...)
      -> runEmbeddedPiAgent
```

这一层最重要的不是 prompt 本身，而是：

- 外层先做模型 fallback
- 再把当前选中的 provider / model 交给 `runEmbeddedPiAgent`

所以这条线会帮你看清：

- `runEmbeddedPiAgent` 不是最顶层 fallback
- 它自己做的是“profile / thinking / overflow”这一层恢复
- 更高一层还可能做“换模型”

---

## 主路径 3：记忆 flush / memory 管理主线

直接调用点：

- `src/auto-reply/reply/agent-runner-memory.ts`

这条线不是普通用户对话，而是“为了 session 和记忆系统自己再跑一轮”。

关系可以记成：

```text
memory flush 触发
  -> agent-runner-memory.ts
    -> runWithModelFallback(...)
      -> runEmbeddedPiAgent
```

它的特征是：

- prompt 不是用户原始输入，而是 memory flush 专用 prompt
- extraSystemPrompt 也会被换成 memory 管理导向版本
- 会特别观察 compaction 是否完成

如果你想理解：

- OpenClaw 不只是“聊天回复”
- 它也会自己跑内部维护回合

这条线很关键。

---

## 主路径 4：CLI / 手动命令主线

直接调用点：

- `src/commands/agent.ts`

这条线代表的是：

- 用户明确执行 agent 命令
- 然后系统决定走 CLI provider 还是 embedded provider

关系可以记成：

```text
命令入口
  -> commands/agent.ts
    -> runCliAgent 或 runEmbeddedPiAgent
```

这里最值得你记住的是：

- OpenClaw 不是所有 agent run 都走 `runEmbeddedPiAgent`
- 如果 provider 被识别成 CLI provider，会切到另一条执行链
- 所以 `runEmbeddedPiAgent` 是“embedded 路径的主入口”，不是系统唯一入口

这个区别很重要。

---

## 主路径 5：Cron / 定时代理主线

直接调用点：

- `src/cron/isolated-agent/run.ts`

这条线代表的是定时、独立会话、后台自动执行类 agent。

关系可以记成：

```text
cron 触发
  -> cron/isolated-agent/run.ts
    -> runWithModelFallback(...)
      -> runEmbeddedPiAgent
```

它的特征是：

- lane 往往会带上 `cron`
- 可能禁用或限制 message tool
- 可能要求显式 message target
- 运行语义更像后台 worker，而不是实时聊天

如果你未来要看“agent 为什么会自己定时工作”，就走这条线。

---

## 主路径 6：轻量 one-off LLM 调用主线

这些不是“完整聊天会话”，而是把 `runEmbeddedPiAgent` 当统一 LLM 执行壳来复用。

典型调用点：

- `src/hooks/llm-slug-generator.ts`
- `extensions/llm-task/src/llm-task-tool.ts`
- `extensions/voice-call/src/response-generator.ts`

### 6.1 Slug 生成

`src/hooks/llm-slug-generator.ts`

作用：

- 临时建一个 session file
- 跑一轮非常短的小 prompt
- 从结果里抽 slug

这条线能帮助你理解：

- `runEmbeddedPiAgent` 不是只能服务“复杂对话”
- 它也能作为一次性小任务执行器

### 6.2 LLM Task 扩展

`extensions/llm-task/src/llm-task-tool.ts`

作用：

- 把 agent 当 JSON-only function 用
- 禁用 tools
- 做 schema 校验

这条线能帮助你理解：

- 这个 runner 也能被扩展当“结构化输出引擎”来用

### 6.3 Voice Call 响应

`extensions/voice-call/src/response-generator.ts`

作用：

- 电话场景里用 embedded agent 生成一句简短语音回复

这条线能帮助你理解：

- messageProvider 不一定是文字聊天渠道
- 同一个 runner 也能被 voice 场景复用

---

## 最实用的调用层次图

如果你的目标是“尽快建立代码层次感”，请直接记下面这张：

```text
第一层：外部触发层
  - auto-reply
  - follow-up
  - memory flush
  - command
  - cron
  - hook / extension / voice

第二层：业务调度层
  - agent-runner-execution.ts
  - followup-runner.ts
  - agent-runner-memory.ts
  - commands/agent.ts
  - cron/isolated-agent/run.ts
  - llm-slug-generator.ts / llm-task-tool.ts / response-generator.ts

第三层：通用执行壳
  - runEmbeddedPiAgent

第四层：单次尝试执行
  - runEmbeddedAttempt

第五层：底层 agent core
  - createAgentSession
  - activeSession.prompt()
  - tool loop / streamFn / compaction
```

只要这 5 层装进脑子里，你再看 OpenClaw 就不会是一堆平铺文件了。

---

## 如果你只想先读“最像真实产品主线”的 4 个文件

建议顺序：

1. `src/auto-reply/reply/agent-runner-execution.ts`
2. `src/agents/pi-embedded-runner/run.ts`
3. `src/agents/pi-embedded-runner/run/attempt.ts`
4. `src/agents/pi-embedded-runner/compact.ts`

这 4 个文件分别对应：

1. 用户消息为什么会触发 agent
2. 外层调度与恢复怎么决定
3. 一次具体尝试怎么执行
4. 上下文爆了之后怎么补救

---

## 如果你只想先读“系统复用能力”的 4 个文件

建议顺序：

1. `src/commands/agent.ts`
2. `src/cron/isolated-agent/run.ts`
3. `src/hooks/llm-slug-generator.ts`
4. `extensions/llm-task/src/llm-task-tool.ts`

这 4 个文件会让你更快看到：

- 同一个 embedded runner 被多少种业务复用
- 哪些上层逻辑是场景特有的
- 哪些能力已经抽成通用壳

---

## 你可以怎么自己生成“函数调用全景流程”

如果你以后想自己做，不只针对 `runEmbeddedPiAgent`，最实用的方法不是盲目搜 import，而是按这 3 步：

### 第一步：找函数定义

搜：

```bash
rg -n "export async function runEmbeddedPiAgent|function runEmbeddedPiAgent"
```

### 第二步：找直接调用点

搜：

```bash
rg -n "runEmbeddedPiAgent\\("
```

### 第三步：把调用点按“业务场景”分组，而不是按文件罗列

例如分成：

- 自动回复
- follow-up
- memory
- cron
- 命令
- 扩展 / hook / one-off task

真正让你形成层次感的，不是“20 个引用文件名”，而是“6 条主业务路径”。

---

## 你现在最该继续看的下一份图

如果你要把这条线真正串起来，下一步最值的是继续做：

- `agent-runner-execution.ts -> runEmbeddedPiAgent -> runEmbeddedAttempt` 的上半段全景图

也就是专门做一份：

- 用户消息进入 auto-reply 后，如何一路走到 embedded runner

这会比继续拆单个 helper 更能帮你建立整体感。
