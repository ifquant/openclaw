# OpenClaw 地图：`resolvePromptModeForSession` 设计与影响链

这份文档专门解释：

- `resolvePromptModeForSession` 为什么只有几行代码却很重要
- 它怎样把 `sessionKey` 和 `system prompt` 的层级设计连起来
- 为什么 subagent 会走 `minimal`，普通主会话走 `full`
- 它在 `runEmbeddedAttempt` 和 compaction 里起什么作用

如果 [`source_maps/openclaw_sessionkey_design_map.md`](/Users/dev/workspace2/agents_research/source_maps/openclaw_sessionkey_design_map.md) 讲的是 `sessionKey` 是什么，那么这份文档讲的是：

```text
sessionKey 的某种语义
  -> promptMode
  -> system prompt 内容多少
  -> agent 行为边界
```

---

## 一句话定义

`resolvePromptModeForSession` 是一个 **基于 session 类型选择 prompt 档位** 的开关函数。

它当前逻辑非常简单：

- subagent session -> `minimal`
- 其他 session -> `full`

但它的重要性不在于代码复杂，而在于它把一个更大的架构原则编码成了一个非常小的决策点：

**不是所有会话都应该吃同样厚的 system prompt。**

---

## 代码位置

主函数在：

- [`openclaw/src/agents/pi-embedded-runner/run/attempt.ts`](/Users/dev/workspace2/agents_research/openclaw/src/agents/pi-embedded-runner/run/attempt.ts)

真正消费 `promptMode` 的地方在：

- [`openclaw/src/agents/pi-embedded-runner/system-prompt.ts`](/Users/dev/workspace2/agents_research/openclaw/src/agents/pi-embedded-runner/system-prompt.ts)
- [`openclaw/src/agents/system-prompt.ts`](/Users/dev/workspace2/agents_research/openclaw/src/agents/system-prompt.ts)

它依赖的 session 语义判断在：

- [`openclaw/src/sessions/session-key-utils.ts`](/Users/dev/workspace2/agents_research/openclaw/src/sessions/session-key-utils.ts)
- [`openclaw/src/routing/session-key.ts`](/Users/dev/workspace2/agents_research/openclaw/src/routing/session-key.ts)

相关测试：

- [`openclaw/src/agents/pi-embedded-runner/run/attempt.test.ts`](/Users/dev/workspace2/agents_research/openclaw/src/agents/pi-embedded-runner/run/attempt.test.ts)
- [`openclaw/src/agents/system-prompt.test.ts`](/Users/dev/workspace2/agents_research/openclaw/src/agents/system-prompt.test.ts)

---

## 先看它本身有多小

逻辑几乎只有两步：

```ts
export function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full" {
  if (!sessionKey) {
    return "full";
  }
  return isSubagentSessionKey(sessionKey) ? "minimal" : "full";
}
```

如果你只看函数体，会误以为：

- 这只是个小工具函数
- 以后随时可以内联掉

但真正重要的是它后面的架构含义。

这个函数是在说：

```text
prompt 的厚度，不由模型决定，不由用户消息决定，
而由当前会话的系统角色决定。
```

---

## 它在总流程里的位置

在 `runEmbeddedAttempt` 中，这条线是：

```text
sessionKey
  -> resolvePromptModeForSession(sessionKey)
  -> promptMode = "full" | "minimal"
  -> buildEmbeddedSystemPrompt({ promptMode, ... })
  -> buildAgentSystemPrompt(...)
  -> 不同 promptMode 生成不同系统提示内容
```

这意味着：

- `resolvePromptModeForSession` 自己不生成 prompt
- 它只做一个非常早的档位选择
- 后面 `system-prompt.ts` 才根据这个档位决定删掉哪些 section

所以它是一个：

**轻决策，重影响**

的函数。

---

## 为什么 OpenClaw 需要 prompt mode

因为不同 session 的职责不一样。

### 主会话（main session）

通常承担的是：

- 和真实用户长期对话
- 接收更完整的产品行为约束
- 接收更完整的渠道、工具、工作区、文档、安全提示

所以更适合：

- `full`

### subagent 会话

通常承担的是：

- 被主 agent 派出去做一个更窄的子任务
- 在局部上下文里执行
- 不需要重新吃一整套厚重的主会话级说明

所以更适合：

- `minimal`

这背后的架构原则是：

**越靠近任务分工末梢的 agent，会话提示词应该越瘦，避免重复灌输和上下文浪费。**

---

## 它依赖的核心判断：`isSubagentSessionKey`

`resolvePromptModeForSession` 的全部判断都建立在：

- `isSubagentSessionKey(sessionKey)`

之上。

也就是说，这个函数本质上在复用 `sessionKey` 里的系统语义：

```text
如果 sessionKey 表示“这是 subagent 会话”
那么 prompt 档位就要切到 minimal
```

这正好说明 `sessionKey` 在 OpenClaw 里不是单纯的 ID，而是系统角色编码。

如果没有这种编码，`resolvePromptModeForSession` 就只能依赖：

- 额外布尔参数
- 外部状态
- 某种 side channel

而现在它只要看 sessionKey 就够了。

这就是 OpenClaw 的一个典型设计风格：

**让关键运行语义能从会话坐标里直接推导出来。**

---

## `promptMode` 真正影响什么

这点必须看 `system-prompt.ts`。

源码里已经直接写了：

- `"full"`：All sections
- `"minimal"`：Reduced sections
- `"none"`：更极端的收缩

也就是说 `promptMode` 决定的是：

**system prompt 中哪些硬编码 section 会被包含**

不是只有字数差异，而是结构差异。

---

## `minimal` 不等于“什么都没有”

这是最容易误会的地方。

很多人看到 `minimal` 会脑补成：

- 几乎没 prompt
- 安全提示没了
- tools 提示没了

但从 `system-prompt.ts` 和测试可以看出，不是这样。

`minimal` 的意思更接近：

- 保留必须的运行信息
- 删除主会话才需要的厚重说明
- 缩短提示词长度和认知负担

举例来说：

- 某些工具信息仍然保留
- skills 在某些 minimal 场景仍然会保留
- 只是不会把所有“用户侧产品说明 + 扩展 section + 全量上下文”都灌进去

所以：

```text
minimal = 结构性瘦身
不是 prompt 消失
```

---

## 为什么 subagent 要走 `minimal`

可以从 4 个角度理解。

### 1. 避免重复灌 prompt

subagent 往往是主 agent 拆出来的执行分支。

如果它还重新吃完整主 prompt，会出现：

- token 浪费
- 信息重复
- 模型注意力被分散

### 2. 避免角色混乱

主 agent 面向用户。
subagent 面向任务。

两者角色不同，system prompt 应该不同。

如果 subagent 仍吃 full prompt，容易带着主会话的行为幻觉去执行局部任务。

### 3. 降低上下文膨胀风险

OpenClaw 本身已经有很多：

- bootstrap files
- skills
- tools
- docs
- runtime info

如果每个 subagent 都吃 full prompt，context window 会很快被磨穿。

### 4. 把 prompt 分层做成显式系统设计

不是“某个场景偶尔少传一点文本”，而是把 prompt 档位显式编码成：

- `full`
- `minimal`

这样系统未来更容易演进成多档。

---

## 为什么 cron 在这里是 `full`

这是一个很值得注意的细节。

测试明确表明：

- cron session 不是 `minimal`
- cron 仍然走 `full`

这说明 OpenClaw 的 prompt 分层不是“所有非主会话都收缩”，而是：

**只有那些明确属于 subagent 语义的会话，才收缩为 minimal。**

原因大概率是：

- cron 虽然不是用户直接发起的聊天
- 但它常常仍需要比较完整的系统能力和上下文
- 特别是它可能要读 skills、工作区说明、执行环境约束

所以：

```text
subagent = 最窄执行角色 -> minimal
cron = 独立任务角色 -> full
```

这其实说明 OpenClaw 的分层不是“按来源分”，而是“按角色分”。

---

## 它在 compaction 里的镜像逻辑

这个点很重要。

除了 `runEmbeddedAttempt`，在：

- [`openclaw/src/agents/pi-embedded-runner/compact.ts`](/Users/dev/workspace2/agents_research/openclaw/src/agents/pi-embedded-runner/compact.ts)

也有一条相似逻辑：

```ts
const promptMode =
  isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
    ? "minimal"
    : "full";
```

这说明：

- 正常 run 路径和 compaction 路径的 promptMode 策略并不完全一样
- compaction 时，cron 也会走 `minimal`

这是一个很有价值的系统细节：

**同一条会话，在不同系统阶段，prompt 档位策略可以不同。**

为什么？

因为 compaction 的目标不是完整执行任务，而是：

- 压缩上下文
- 保留必要信息
- 尽量降低 token 成本

所以 compaction 比正式运行更适合 aggressive 地用 `minimal`。

这个差异非常值得你记住，因为它说明：

`promptMode` 不是 session 的静态属性，而是“当前阶段对 session 的解释方式”。

---

## 它体现的架构思想

`resolvePromptModeForSession` 虽然很小，但它背后其实有 3 个架构思想。

### 1. Prompt 不是一份固定文本，而是分层资源

OpenClaw 没把 prompt 设计成：

- 一个大字符串常量

而是设计成：

- 按 session 角色可切档位的结构化资源

### 2. Session 语义应该驱动 prompt 语义

这也是 `sessionKey` 为什么要编码 `subagent`。

因为系统想要做到：

```text
会话是什么角色
-> 决定提示词该有多厚
```

### 3. 小函数承载大边界

OpenClaw 里很多关键边界不是大模块，而是这种：

- 非常小的决策函数
- 但它接在两大系统之间

`resolvePromptModeForSession` 就是典型例子：

- 一边接 `sessionKey` 设计
- 一边接 `system prompt` 设计

---

## 你读这个函数时最该抓的 4 个点

### 1. 它不是在判断“用户是谁”，而是在判断“当前会话扮演什么角色”

### 2. 它不直接改 prompt 内容，只选择 prompt 档位

### 3. `minimal` 是结构收缩，不是 prompt 消失

### 4. 这条逻辑和 compaction 的 promptMode 策略不同，说明 prompt 档位是阶段相关的

---

## 压缩版调用链

```text
sessionKey
  -> isSubagentSessionKey(sessionKey)
  -> resolvePromptModeForSession(sessionKey)
  -> promptMode = minimal | full
  -> buildEmbeddedSystemPrompt({ promptMode, ... })
  -> buildAgentSystemPrompt(...)
  -> 生成不同层级的 system prompt
```

---

## 它在 `runEmbeddedAttempt` 里的价值

如果没有这个函数，`runEmbeddedAttempt` 要么：

- 直接硬编码 `isSubagentSessionKey` 判断
- 要么在调用 `buildEmbeddedSystemPrompt` 时散落各种条件分支

有了它之后，`attempt.ts` 的表达更清晰：

```text
先决定 prompt mode
再把这个 mode 交给 prompt builder
```

这就把：

- session 角色识别
- prompt 结构生成

解耦开了。

---

## 最后一句总结

`resolvePromptModeForSession` 的意义，不在于“它能判断 minimal 还是 full”，而在于它把 OpenClaw 的一个重要系统原则显式化了：

**不同角色的会话，应该吃不同厚度的系统提示。**

---

## 下一步建议

如果你继续顺着这条线往下读，最自然的两个方向是：

1. 拆 [`openclaw/src/agents/system-prompt.ts`](/Users/dev/workspace2/agents_research/openclaw/src/agents/system-prompt.ts)，看 `full` 和 `minimal` 到底差了哪些 section
2. 拆 [`openclaw/src/agents/pi-embedded-runner/compact.ts`](/Users/dev/workspace2/agents_research/openclaw/src/agents/pi-embedded-runner/compact.ts)，看为什么 compaction 路径的 promptMode 策略和正常 run 不一样

如果你愿意，我下一步更推荐先拆第一个：  
直接做一份 `full vs minimal system prompt` 对照地图。
