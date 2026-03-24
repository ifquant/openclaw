# OpenClaw 地图：`createOpenClawCodingTools` 设计与装配链

这份文档专门解释：

- `createOpenClawCodingTools` 到底在做什么
- 为什么它不是“返回一个 tools 数组”这么简单
- OpenClaw 的工具系统是如何按 session、sandbox、channel、policy、provider 逐层装出来的
- 为什么这个函数是 `runEmbeddedAttempt` 的核心枢纽之一

如果 [`source_maps/openclaw_attempt_call_map.md`](/Users/dev/workspace2/agents_research/source_maps/openclaw_attempt_call_map.md) 讲的是 run 的总装配线，那么这份文档讲的是其中最关键的一条支线：

```text
当前会话上下文
  -> 生成一组当前真的可用的工具
  -> agent 才能拿着这些工具去思考和行动
```

---

## 一句话定义

`createOpenClawCodingTools` 是 OpenClaw 的 **工具总装配器**。

它不是某个单独工具的实现，也不是纯粹的工具注册表。

它做的是：

1. 先拿到一组基础 coding tools
2. 按当前运行环境替换成 host 或 sandbox 版本
3. 再补上 OpenClaw 自己的 exec/process/apply_patch/channel/openclaw tools
4. 再经过一整套 policy / allowlist / owner-only / subagent / provider 过滤
5. 最后再给每个工具包上 hook、loop detection、abort、schema normalization

最后才把这组工具交给 `createAgentSession(...)`

所以它本质上是在做：

**“当前这次 run，模型到底能看到和调用哪些工具” 的最终裁决。**

---

## 代码位置

主函数在：

- [`src/agents/pi-tools.ts`](src/agents/pi-tools.ts)

它依赖的关键模块包括：

- [`src/agents/bash-tools.ts`](src/agents/bash-tools.ts)
- [`src/agents/openclaw-tools.ts`](src/agents/openclaw-tools.ts)
- [`src/agents/pi-tools.policy.ts`](src/agents/pi-tools.policy.ts)
- [`src/agents/tool-policy.ts`](src/agents/tool-policy.ts)
- [`src/agents/tool-policy-pipeline.ts`](src/agents/tool-policy-pipeline.ts)
- [`src/agents/pi-tools.read.ts`](src/agents/pi-tools.read.ts)
- [`src/agents/tool-fs-policy.ts`](src/agents/tool-fs-policy.ts)
- [`src/agents/channel-tools.ts`](src/agents/channel-tools.ts)
- [`src/agents/pi-tool-definition-adapter.ts`](src/agents/pi-tool-definition-adapter.ts)

---

## 它在总流程里的位置

在 `runEmbeddedAttempt` 中，这条线是：

```text
resolveSessionAgentIds
  -> createOpenClawCodingTools(...)
  -> sanitizeToolsForGoogle(...)
  -> collectAllowedToolNames(...)
  -> splitSdkTools(...)
  -> createAgentSession({ tools, customTools, ... })
```

所以它是连接这两层的桥：

- 上游：session、sandbox、channel、config、policy
- 下游：agent session 真实可见的 tools

你可以把它理解成：

**agent 工具能力的最终编译步骤**

---

## 先建立一个整体直觉

这个函数不是在做“创建工具”，而是在做“装配工具权限和形态”。

换句话说：

- 真正的工具实现分散在很多文件里
- `createOpenClawCodingTools` 负责把这些工具按当前上下文拼成一组最终可见工具

所以你读它时，不要问：

> 这个函数实现了什么工具？

要问：

> 它是如何决定哪些工具出现、哪些工具消失、哪些工具换成 sandbox 版本、哪些工具再被二次包装的？

---

## 输入参数为什么这么多

`options` 看起来很长，但其实可以按 6 组理解。

### 1. Agent / session 作用域

- `agentId`
- `sessionKey`
- `spawnedBy`

作用：

- 决定 agent 级 tool policy
- 决定 subagent policy
- 决定 process scopeKey

### 2. 执行环境

- `sandbox`
- `workspaceDir`
- `agentDir`
- `abortSignal`

作用：

- 决定 read/write/edit 是 host 版本还是 sandbox 版本
- 决定 apply_patch 是否可用
- 决定工具是否能被中断

### 3. 渠道上下文

- `messageProvider`
- `agentAccountId`
- `messageTo`
- `messageThreadId`
- `groupId`
- `groupChannel`
- `groupSpace`
- `currentChannelId`
- `currentThreadTs`
- `currentMessageId`
- `replyToMode`
- `hasRepliedRef`

作用：

- 决定 message tool / channel tools 的行为
- 决定 group policy 和 auto-threading

### 4. 模型上下文

- `modelProvider`
- `modelId`
- `modelContextWindowTokens`
- `modelAuthMode`
- `modelHasVision`

作用：

- 决定 provider-specific schema 处理
- 决定 apply_patch 是否允许
- 决定 read/image 预算

### 5. 安全与身份

- `senderIsOwner`
- `requireExplicitMessageTarget`
- `disableMessageTool`

作用：

- 决定 owner-only tools
- 决定消息发送工具是否需要显式 target

### 6. exec defaults

- `exec`

作用：

- 决定 `exec` / `process` 工具的安全模式、host、ask、timeouts、safe bins 等

所以它参数很多，不是接口设计差，而是因为它确实是一个跨层装配点。

---

## 主装配链：按阶段理解

下面这 10 个阶段是这整个函数最值得记住的结构。

### 阶段 0：先收口 policy 语义

涉及函数：

- `resolveEffectiveToolPolicy`
- `resolveGroupToolPolicy`
- `resolveToolProfilePolicy`
- `mergeAlsoAllowPolicy`
- `resolveSubagentToolPolicy`

它做什么：

- 解析全局、provider、agent、group、profile、subagent 多层工具策略

你应该理解成：

- OpenClaw 不是先生成所有工具再随手过滤
- 它一开始就在收集“策略来源”

这一步的输出不是最终工具，而是：

- 一组待合并的 policy 视角

---

### 阶段 1：决定 scopeKey、subagent policy、background 能力

涉及逻辑：

- 优先用 `sessionKey` 做 `scopeKey`
- 如果是 subagent，会额外算 `subagentPolicy`
- 用多层 policy 判断 `process` 是否允许 background

设计含义：

- process / exec 的隔离范围优先是 session，而不是 agent
- 这样可以避免跨 session 互相看到或 kill 进程

这一点非常关键：

```text
scopeKey 优先 sessionKey
  = 进程隔离按会话生命线做
```

---

### 阶段 2：收口 exec/fs 配置

涉及函数：

- `resolveExecConfig`
- `resolveToolFsConfig`
- `createToolFsPolicy`

它做什么：

- 把全局配置和 agent 局部配置合并成最终 exec/fs 策略

典型结果包括：

- `host / security / ask`
- `safeBins / safeBinProfiles`
- `workspaceOnly`
- `applyPatch.enabled`

这一步的意义是：

- 工具行为先收敛为统一配置
- 后面具体创建工具时不用到处查 config

---

### 阶段 3：从 `codingTools` 基础包开始，替换读写类工具

涉及：

- `codingTools`
- `readTool`
- `createReadTool`
- `createOpenClawReadTool`
- `createHostWorkspaceWriteTool`
- `createHostWorkspaceEditTool`
- `createSandboxedReadTool`
- `createSandboxedWriteTool`
- `createSandboxedEditTool`

这是最核心的一段之一。

它做的不是简单保留默认 tools，而是：

- 遇到 `read` 时，替换成 OpenClaw 包装后的读工具
- 遇到 `write` / `edit` 时，替换成 host workspace 或 sandbox 版本
- 遇到 `bash` / `exec` 时，先剔除，后面自己重新挂 OpenClaw 的 exec tool

这说明：

**OpenClaw 不是直接用上游 pi-coding-agent 的工具，而是接管了关键工具的实现和安全边界。**

---

### 阶段 4：构造 OpenClaw 自己的 exec/process/apply_patch

涉及函数：

- `createExecTool`
- `createProcessTool`
- `createApplyPatchTool`

作用：

- 构造命令执行能力
- 构造后台进程操作能力
- 构造 patch 工具

这里有几个关键设计点：

#### `execTool`

拿到的是：

- host / security / ask / safeBins / timeoutSec / approvalRunningNoticeMs
- `scopeKey`
- `sessionKey`
- channel/thread/account 上下文
- sandbox 信息

这说明 `exec` 不是独立工具，它是被 deeply contextualized 的。

#### `processTool`

拿到的是：

- `scopeKey`
- `cleanupMs`

这说明进程管理是强绑定当前会话隔离域的。

#### `applyPatchTool`

只有在满足条件时才启用：

- `applyPatch.enabled`
- provider 是 OpenAI 路径
- model 命中 allowModels
- 如果在 sandbox 且 workspace 只读，就不能启用

这说明 `apply_patch` 是经过专门 gating 的，不是默认开放。

---

### 阶段 5：补上 OpenClaw 自己的高层工具

涉及函数：

- `listChannelAgentTools`
- `createOpenClawTools`

这一段会把更高层的 OpenClaw 能力挂上去，比如：

- channel tools
- browser/message/session/cron/subagent 等 OpenClaw 自定义工具

你可以把工具体系粗略分成三层：

1. 基础 coding tools
2. 执行/文件系统/patch 基础设施工具
3. OpenClaw 产品级工具

而 `createOpenClawCodingTools` 就是把这三层拼起来。

---

### 阶段 6：按 message provider 做第一轮工具禁用

涉及函数：

- `applyMessageProviderToolPolicy`

目前最典型的例子：

- `voice` 渠道会 deny `tts`

这是一个很有意思的设计点：

- 工具可见性不只由 agent policy 决定
- 也由当前 message provider 决定

所以工具系统本身就是渠道感知的。

---

### 阶段 7：按 owner-only 和多层 policy 做大过滤

涉及函数：

- `applyOwnerOnlyToolPolicy`
- `applyToolPolicyPipeline`
- `buildDefaultToolPolicyPipelineSteps`
- `getPluginToolMeta`

这是工具系统真正的“裁决层”。

到这一步时，工具已经基本成形，但还不能直接给 agent。

还要再经过：

- profile policy
- provider profile policy
- global policy
- global provider policy
- agent policy
- group policy
- sandbox policy
- subagent policy
- plugin tool meta

所以你应该把这一段理解成：

**工具系统的 allow/deny 裁决流水线**

而不是简单的 `.filter()`

---

### 阶段 8：统一 schema 形态

涉及函数：

- `normalizeToolParameters`
- `cleanToolSchemaForGemini`
- `patchToolSchemaForClaudeCompatibility`

这一段的意义是：

- 工具不仅要“逻辑上可用”
- 还要“对当前 provider 的 schema 验证器可用”

因为不同模型供应商对 tool schema 的要求不一样。

所以工具系统在最后还要做 provider-aware schema normalization。

这一步说明：

**OpenClaw 的工具系统不仅是权限系统，也是 provider 兼容系统。**

---

### 阶段 9：给每个工具包 hook 和 loop detection

涉及函数：

- `wrapToolWithBeforeToolCallHook`
- `resolveToolLoopDetectionConfig`

这一步做的事情是：

- 在每个工具调用前都允许 hook 介入
- 给工具调用安装 loop detection 配置

这说明工具不是裸对象，而是会被统一加上一层“工具调用前拦截器”。

也就是说：

```text
tool definition
  -> before_tool_call hook capable
  -> loop detection aware
```

---

### 阶段 10：给每个工具包 abort signal

涉及函数：

- `wrapToolWithAbortSignal`

如果当前 run 有 `abortSignal`，最后会给所有工具统一包上 abort 能力。

这一步的意义是：

- 工具系统和 run 的超时/中断系统统一起来
- 不是 run 停了但工具还在外面乱跑

到这里，这组工具才真正完成装配。

---

## 一张压缩版时序图

```text
config + sessionKey + sandbox + channel + model + owner state
  -> resolve effective tool policies
  -> resolve exec/fs config
  -> start from base codingTools
  -> replace read/write/edit with host or sandbox variants
  -> add exec/process/apply_patch
  -> add channel tools + OpenClaw product tools
  -> filter by message provider
  -> filter by owner-only + policy pipeline
  -> normalize tool schemas for provider compatibility
  -> wrap with before_tool_call hook + loop detection
  -> wrap with abort signal
  -> final tools[]
```

---

## 为什么这个函数如此重要

因为在 OpenClaw 里，“工具”不是静态资产，而是运行时裁决结果。

同一个 `message` 工具，在不同 run 里可能：

- 存在
- 不存在
- 需要显式 target
- 只能在某些 owner 身份下出现

同一个 `read/edit/write` 工具，在不同 run 里可能：

- 指向 host workspace
- 指向 sandbox bridge
- 被 workspace root guard 包裹
- 被完全禁用

同一个 `exec` 工具，在不同 run 里可能：

- host 模式
- sandbox 模式
- allowlist/security/full 模式不同
- background 能力不同

所以 `createOpenClawCodingTools` 的真正作用是：

**把“当前上下文下允许的能力”编译成 agent 可见的工具表。**

---

## 你读这个函数时最该抓的 6 个点

1. 它从 `codingTools` 起步，但不会原样保留上游工具。
2. `read/write/edit` 会被换成 host 或 sandbox 版本。
3. `exec/process/apply_patch` 是 OpenClaw 自己重新挂的。
4. tool visibility 由多层 policy 决定，不是单一开关。
5. 最后还有 provider-aware schema normalization。
6. 最终工具会被统一包上 hook、loop detection、abort。

---

## 和 `runEmbeddedAttempt` 的关系

在 `runEmbeddedAttempt` 里，`createOpenClawCodingTools` 之后紧接着发生的是：

- `sanitizeToolsForGoogle`
- `collectAllowedToolNames`
- `splitSdkTools`
- `createAgentSession`

这说明 `createOpenClawCodingTools` 给出的不是最终 wire-level 形态，而是：

- OpenClaw 视角下的最终工具集合

后面还会再做：

- 某些 provider-specific 清洗
- builtIn/customTools 拆分
- 交给 agent session

---

## 最后一句总结

`createOpenClawCodingTools` 的意义，不在于“创建了多少工具”，而在于它把 OpenClaw 的这些系统约束一次性压进了工具集合里：

- sandbox 约束
- workspace 约束
- provider 兼容
- owner 身份
- session/subagent 语义
- group policy
- abort / hook / loop detection

所以它其实是 OpenClaw 工具体系的“编译器”。

---

## 下一步建议

顺着这条线，最值得继续拆的有两个方向：

1. [`src/agents/openclaw-tools.ts`](src/agents/openclaw-tools.ts)  
   看 OpenClaw 自己的高层产品工具到底有哪些、怎么分类

2. [`src/agents/pi-tools.policy.ts`](src/agents/pi-tools.policy.ts) + [`src/agents/tool-policy-pipeline.ts`](src/agents/tool-policy-pipeline.ts)  
   看工具策略流水线到底如何裁决 allow/deny

如果你现在最想建立直觉，我更建议先拆第一个。  
这样你会先看到“OpenClaw 认为 agent 应该会做哪些事”。
