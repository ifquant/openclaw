# OpenClaw 地图：`resolvePromptBuildHookResult` 设计与调用链

这份文档专门解释：

- `resolvePromptBuildHookResult` 在 OpenClaw 里到底是干什么的
- 为什么它同时处理 `before_prompt_build` 和 `before_agent_start`
- 它在 `runEmbeddedAttempt` 里处于什么位置
- 它如何体现 OpenClaw 的插件兼容策略

如果说 [`source_maps/openclaw_attempt_call_map.md`](/Users/dev/workspace2/claw_research/source_maps/openclaw_attempt_call_map.md) 讲的是 `runEmbeddedAttempt` 的总装配线，那这份文档讲的是其中一个关键接缝：

```text
插件 hook
  -> prompt build 合并层
  -> 真正 prompt 前的最后注入点
```

---

## 一句话定义

`resolvePromptBuildHookResult` 是 OpenClaw 在 **真正发 prompt 之前** 的一个 hook 合并器。

它做的事情不是直接改模型，也不是直接改 session，而是：

1. 调用新的 `before_prompt_build` hook
2. 兼容旧的 `before_agent_start` hook
3. 把两者能影响 prompt 的结果合并成统一结构

最终产出：

- `systemPrompt`
- `prependContext`

所以它本质上不是业务逻辑函数，而是一个 **新旧插件协议的过渡层**。

---

## 代码位置

主函数在：

- [`openclaw/src/agents/pi-embedded-runner/run/attempt.ts`](/Users/dev/workspace2/claw_research/openclaw/src/agents/pi-embedded-runner/run/attempt.ts)

相关支撑代码在：

- [`openclaw/src/plugins/hook-runner-global.ts`](/Users/dev/workspace2/claw_research/openclaw/src/plugins/hook-runner-global.ts)
- [`openclaw/src/plugins/hooks.ts`](/Users/dev/workspace2/claw_research/openclaw/src/plugins/hooks.ts)
- [`openclaw/src/plugins/types.ts`](/Users/dev/workspace2/claw_research/openclaw/src/plugins/types.ts)

测试最值得看：

- [`openclaw/src/agents/pi-embedded-runner/run/attempt.test.ts`](/Users/dev/workspace2/claw_research/openclaw/src/agents/pi-embedded-runner/run/attempt.test.ts)
- [`openclaw/src/plugins/hooks.model-override-wiring.test.ts`](/Users/dev/workspace2/claw_research/openclaw/src/plugins/hooks.model-override-wiring.test.ts)
- [`openclaw/src/plugins/hooks.before-agent-start.test.ts`](/Users/dev/workspace2/claw_research/openclaw/src/plugins/hooks.before-agent-start.test.ts)

---

## 它在总流程里的位置

在 `runEmbeddedAttempt` 中，`resolvePromptBuildHookResult` 出现在这里：

```text
1. 创建 activeSession
2. 安装 streamFn 包装、sanitize、history 清洗
3. 建立 subscription / abort / timeout
4. 准备真正 prompt
5. 调用 resolvePromptBuildHookResult
6. 修正 effectivePrompt / systemPrompt
7. detectAndLoadPromptImages
8. activeSession.prompt(...)
```

它不是 run 的最前面，也不是插件系统初始化点。

它处在一个很关键的位置：

- 此时 `activeSession` 已经创建好了
- session history 已经可用
- tools 和 system prompt 基础版本也已经准备好了
- 但真正的 `prompt()` 还没发出去

所以这一步是：

**插件还能影响本轮 prompt 的最后窗口**

---

## 为什么这个函数存在

因为 OpenClaw 的 hook 语义经历了演化。

现在的更清晰设计是：

- `before_model_resolve`
  控制 provider / model 解析前的覆盖
- `before_prompt_build`
  控制真正 prompt 构造前的上下文注入
- `llm_input`
  观察最终发给模型的输入
- `agent_end`
  在本轮结束后收尾

但历史上，很多事情可能都挂在：

- `before_agent_start`

所以系统不能直接粗暴删除旧 hook。

`resolvePromptBuildHookResult` 的存在，就是为了在 `attempt.ts` 这一层说清楚：

```text
新的 prompt build 语义优先生效
旧的 before_agent_start 仍然能提供兼容性回退
```

---

## 它不是“执行 hook”，而是“合并 hook 结果”

这是最容易忽略的一点。

这个函数不负责：

- 注册 hook
- 扫描插件
- 初始化 hook runner
- 决定 hook 执行顺序的底层机制

这些事情是：

- `hook-runner-global.ts`
- `plugins/hooks.ts`
- plugin registry

在负责。

`resolvePromptBuildHookResult` 的职责更窄：

```text
已知有一个 hook runner
已知可能存在新旧两个阶段 hook
把它们转成 attempt.ts 能直接消费的统一结果
```

所以这个函数是一个 **边界适配器**。

---

## 输入输出模型

函数签名可以压成这样理解：

### 输入

- `prompt`
  当前用户 prompt
- `messages`
  当前 session messages
- `hookCtx`
  当前 agent/session/workspace 的上下文
- `hookRunner`
  全局 hook runner
- `legacyBeforeAgentStartResult`
  可复用的旧 hook 结果

### 输出

- `systemPrompt`
  可用于覆盖当前 system prompt
- `prependContext`
  可拼到最终用户 prompt 前面

这个设计说明了一件事：

`resolvePromptBuildHookResult` 只关心 **本轮 prompt 的可变部分**，不试图返回所有 hook 产物。

---

## 主逻辑分解

它的逻辑非常短，但每一步都很有设计意味。

### 步骤 1：如果存在 `before_prompt_build`，先跑新的 hook

逻辑：

- 先检查 `hookRunner?.hasHooks("before_prompt_build")`
- 如果有，就执行 `runBeforePromptBuild`
- 如果抛错，记录 warning，吞掉错误

设计含义：

- 新 hook 是首选路径
- hook 失败不能把主 run 直接炸掉

这里体现的是 OpenClaw 一贯的边界策略：

**插件增强不能反客为主，主 agent run 仍要尽量继续。**

### 步骤 2：兼容 legacy `before_agent_start`

逻辑：

- 如果已经有 `legacyBeforeAgentStartResult`，就直接复用
- 否则只有在 hook 存在时才调用 `runBeforeAgentStart`

设计含义：

- 避免同一个 legacy hook 在上层已经跑过后又重复执行一次
- 保留旧插件合同，避免 prompt build 演化直接断插件生态

这一步非常重要，因为在 `run.ts` 外层其实就已经存在一条 legacy 兼容路径。

也就是说：

```text
上层可能已经跑过 before_agent_start
attempt.ts 这里不能盲目再跑一次
```

所以才会有：

- `legacyBeforeAgentStartResult ?? ...`

### 步骤 3：做统一结果合并

最终返回：

- `systemPrompt`
  取 `before_prompt_build` 优先，否则 fallback 到 legacy
- `prependContext`
  把新旧两边的 `prependContext` 拼起来

这里其实反映了两个不同策略：

#### 对 `systemPrompt`

策略是：

```text
新 hook 优先覆盖旧 hook
```

原因：

- system prompt 是强控制字段
- 同一轮里不希望多个来源互相打架

#### 对 `prependContext`

策略是：

```text
新旧上下文都可以拼接
```

原因：

- prepend context 更像补充上下文
- 合并风险比 system prompt 覆盖要小

这就是你在测试里能看到的设计点：

- `systemPrompt precedence`
- `prependContext concatenation`

---

## 它和 `run.ts` 的关系

这个函数单独看容易误会成“prompt hook 的唯一路径”，其实不是。

OpenClaw 在 `run.ts` 还有更早的 hook 阶段：

- `before_model_resolve`
- 以及 legacy `before_agent_start` 在 model resolve 路径上的兼容

所以可以把两层分工记成：

### `run.ts`

负责：

- model/provider 解析前的 hook
- 外层 run orchestration
- 某些 legacy hook 预计算

### `run/attempt.ts`

负责：

- 真正 prompt 前的 hook 合并
- active session 已就绪后的 prompt shaping

也就是说：

```text
run.ts 更早，偏模型与外层调度
attempt.ts 更晚，偏本轮 prompt 注入
```

---

## 它和 `llm_input` / `agent_end` 的区别

理解这个函数时，最好顺手把它和旁边几个 hook 阶段分开。

### `before_prompt_build`

是：

- 可修改 prompt 的 hook
- 真正 prompt 发送前

### `llm_input`

是：

- 观察型 hook
- 在最终 prompt / systemPrompt / history / image count 都已确定后触发
- 更偏审计和诊断

### `agent_end`

是：

- 收尾型 hook
- prompt 完成之后，拿结果做分析、记录、清理

所以：

```text
resolvePromptBuildHookResult
  属于修改链

llm_input / agent_end
  属于观察链 / 生命周期链
```

---

## 它为什么要吞错而不是抛错

代码里两条路径都会：

- catch hook error
- `log.warn(...)`
- 返回 `undefined`

这不是偷懒，而是插件系统的明确边界：

- 主 agent run 是主流程
- hook 是增强逻辑
- hook 失败默认不能让整个 agent run 失败

只有当插件本身设计成强约束、并且在更高层显式阻断时，才可能改变这个行为。

在这里，OpenClaw 做的是：

**默认把 hook 视为“软依赖”。**

---

## 它解决的真实工程问题

### 问题 1：插件协议升级不能把旧插件全部打死

所以要兼容：

- `before_prompt_build`
- `before_agent_start`

### 问题 2：同一个旧 hook 不能重复执行

所以要支持：

- `legacyBeforeAgentStartResult` 复用

### 问题 3：插件不该轻易炸掉主流程

所以要：

- catch + warn + fallback

### 问题 4：不同类型的修改字段需要不同合并策略

所以：

- `systemPrompt` 走优先级覆盖
- `prependContext` 走拼接

---

## 你读这个函数时最该抓住的 4 个点

### 1. 新旧 hook 的边界

记住：

- 新：`before_prompt_build`
- 旧：`before_agent_start`

### 2. 复用优先于重复执行

`legacyBeforeAgentStartResult` 的存在，就是为了防止双跑。

### 3. `systemPrompt` 和 `prependContext` 不是同一种合并语义

- 一个是覆盖优先
- 一个是拼接优先

### 4. 这是 prompt 发送前的最后注入层

真正的 `activeSession.prompt(...)` 还没发生。

---

## 压缩版时序图

```text
run.ts
  -> 可能预先得到 legacy before_agent_start result
  -> runEmbeddedAttempt
       -> activeSession 已创建
       -> resolvePromptBuildHookResult(...)
            1. run before_prompt_build if present
            2. reuse or run legacy before_agent_start
            3. merge systemPrompt + prependContext
       -> 改写 effectivePrompt / systemPrompt
       -> llm_input hook
       -> activeSession.prompt(...)
       -> agent_end hook
```

---

## 它在 OpenClaw 架构里的角色

如果你把整个插件 hook 体系看成一条流水线，`resolvePromptBuildHookResult` 不是主发动机，而是一个非常关键的“接缝件”。

它的角色是：

- 让旧插件继续活
- 让新 hook 语义更清晰
- 让 `attempt.ts` 不需要知道太多插件演化历史

也就是说，它在做：

```text
插件历史兼容
        +
prompt 构造边界收口
```

---

## 下一步建议

如果你已经理解 `resolvePromptBuildHookResult`，下一步最自然的是继续拆下面两条线之一：

1. `before_prompt_build` 在插件系统里是怎么注册、排序和执行的  
   重点看 `src/plugins/hooks.ts`

2. `resolvePromptBuildHookResult` 产出的 `systemPrompt` / `prependContext` 最终怎样影响 `activeSession.prompt(...)`  
   重点回到 `run/attempt.ts`

如果你愿意，我下一步可以继续给你做：

- `plugins/hooks.ts` 的 hook runner 地图
- 或 `buildEmbeddedSystemPrompt + resolvePromptBuildHookResult + llm_input + prompt()` 的串联地图
