# OpenClaw 第二层地图：`runEmbeddedAttempt` 调用链与模块接力图

这份地图不是目录地图，而是专门回答一个问题：

`src/agents/pi-embedded-runner/run/attempt.ts` 里的 `runEmbeddedAttempt`，到底在系统里做了什么，以及它一路调用了哪些模块。

如果把 `openclaw_code_map.md` 看成“城市地图”，这份文件就是“地铁线路图”。

---

## 先记住一个核心判断

`runEmbeddedAttempt` 不是：

- 真正的大模型推理内核
- 单纯的 prompt 拼接函数
- 单纯的 tool 执行器

它更像一次完整 agent 尝试的“装配总控”。

它做的事是：

1. 整理工作目录和 sandbox
2. 装配 skills、bootstrap context、tools、system prompt
3. 打开和修复 session transcript
4. 创建 embedded agent session
5. 给 streamFn 套上一层层 provider 兼容、安全清洗、日志和缓存包装
6. 订阅流式事件
7. 真正调用 `activeSession.prompt(...)`
8. 等 compaction、处理超时、收尾并吐出结果

所以读这个文件时，应该把它当成“总调度函数”，不是“算法函数”。

---

## 它在上一层是怎么被调用的

上层入口不是 `runEmbeddedAttempt`，而是：

- `src/agents/pi-embedded-runner/run.ts`
  - `runEmbeddedPiAgent`

你可以把关系先记成：

```text
runEmbeddedPiAgent
  -> 排队 / lane / workspace / model / auth profile / retry
  -> runEmbeddedAttempt
       -> 单次实际尝试
```

也就是说：

- `run.ts` 更像“外层重试与调度器”
- `run/attempt.ts` 更像“单次真实执行体”

---

## 依赖簇：`attempt.ts` 在调哪些目录

这个文件 import 很多，但其实可以压成 8 组。

### 1. 运行环境与系统信息

- `utils`
- `infra/machine-name`
- `shell-utils`
- `sandbox`
- `sandbox/runtime-status`

作用：

- 解析 workspace
- 识别机器、shell、sandbox 状态
- 生成运行时信息给 system prompt

### 2. 会话与 transcript

- `session-file-repair`
- `session-tool-result-guard-wrapper`
- `session-transcript-repair`
- `session-write-lock`
- `transcript-policy`
- `session-manager-cache`
- `session-manager-init`

作用：

- 修 session 文件
- 锁 session
- 打开 `SessionManager`
- 限制 transcript 结构错误
- 做 tool result pairing 修复

### 3. Tools 与策略

- `pi-tools`
- `pi-tool-definition-adapter`
- `tool-name-allowlist`
- `tool-fs-policy`
- `tool-result-context-guard`
- `tool-split`

作用：

- 生成 OpenClaw tools
- 区分 built-in tools / custom tools / client tools
- 收窄允许出现的 tool name
- 控制 workspace only / tool result 注入 / context 膨胀

### 4. Prompt 与上下文组装

- `bootstrap-files`
- `skills`
- `system-prompt-params`
- `system-prompt-report`
- `system-prompt`
- `history`
- `history-image-prune`
- `images`

作用：

- 找 bootstrap 文件
- 构建 skills prompt
- 构建 runtime info
- 拼 system prompt
- 裁历史、清旧图、加载本次 prompt 图片

### 5. Provider / model 兼容包装

- `google`
- `thinking`
- `tool-call-id`
- `ollama-stream`
- `model-selection`
- `model-auth`
- `model`
- `utils/provider-utils`

作用：

- provider 特定 schema 兼容
- thinking block 处理
- tool call ID 清洗
- Ollama 原生 streaming 或 OpenAI-compatible 兼容

### 6. 订阅与流式回调

- `pi-embedded-subscribe`
- `runs`
- `wait-for-idle-before-flush`
- `compaction-timeout`

作用：

- 监听 assistant text、tool result、partial reply、reasoning stream
- 提供 active run 句柄
- 处理 compaction 中的等待和超时

### 7. 插件与 hooks

- `plugins/hook-runner-global`
- `plugins/types`
- `bootstrap-hooks`

作用：

- 在 prompt build、llm input、agent end 这些阶段插入插件逻辑

### 8. 外部 agent core / sdk

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`

作用：

- 真正创建 agent session
- 发送 prompt
- 产出流式回复和 tool call 生命周期

---

## 主执行链：按阶段理解 `runEmbeddedAttempt`

下面这 10 个阶段，就是这整个函数最值得记住的结构。

### 阶段 0：入口与工作目录定型

涉及函数：

- `resolveUserPath`
- `resolveSandboxContext`

它做什么：

- 把 `workspaceDir` 变成真实路径
- 解析 `sessionKey`
- 计算 sandbox 是否开启
- 决定 `effectiveWorkspace`

你应该理解成：

- 这一步不是“准备目录”这么简单
- 这一步是在决定这次 agent run 到底运行在宿主目录还是 sandbox 映射目录

目录接力：

```text
attempt.ts
  -> utils
  -> agents/sandbox
```

### 阶段 1：skills 和 bootstrap context 装配

涉及函数：

- `loadWorkspaceSkillEntries`
- `applySkillEnvOverrides`
- `applySkillEnvOverridesFromSnapshot`
- `resolveSkillsPromptForRun`
- `resolveBootstrapContextForRun`

它做什么：

- 读 workspace skills
- 注入 skill env overrides
- 找 bootstrap files / context files
- 生成 `skillsPrompt`

你应该理解成：

- 这一段是在给 agent 准备“项目本地经验”和“启动上下文”
- 不是模型推理本体

目录接力：

```text
attempt.ts
  -> agents/skills
  -> agents/bootstrap-files
```

### 阶段 2：agent 身份与 tool 集合装配

涉及函数：

- `resolveSessionAgentIds`
- `resolveAttemptFsWorkspaceOnly`
- `createOpenClawCodingTools`
- `sanitizeToolsForGoogle`
- `collectAllowedToolNames`

它做什么：

- 算出 default agent / session agent
- 算出 workspace-only 文件访问策略
- 创建一整套 tools
- 针对 Google provider 修 tool schema
- 收集允许的 tool names，后面做 transcript / history 清洗会用到

你应该理解成：

- OpenClaw 并不是先有一个固定 tools 数组再运行
- tools 是结合当前 session、channel、sandbox、message target、model 能力动态装出来的

目录接力：

```text
attempt.ts
  -> agents/agent-scope
  -> agents/pi-tools
  -> agents/tool-fs-policy
  -> agents/pi-embedded-runner/google
```

### 阶段 3：运行时能力与 system prompt 组装

涉及函数：

- `resolveChannelCapabilities`
- `listChannelSupportedActions`
- `resolveChannelMessageToolHints`
- `buildEmbeddedSandboxInfo`
- `buildSystemPromptParams`
- `buildEmbeddedSystemPrompt`
- `createSystemPromptOverride`

它做什么：

- 根据 channel 决定 capabilities
- 注入 Telegram / Signal reaction guidance 之类的渠道特性
- 把 host、os、arch、node、shell、channel、capabilities 做成 runtime info
- 拼出最终 system prompt

你应该理解成：

- 这一段是在把“现实世界环境”翻译成 agent 能理解的系统上下文

目录接力：

```text
attempt.ts
  -> config
  -> channel-tools
  -> agents/system-prompt*
  -> pi-embedded-runner/system-prompt
```

### 阶段 4：session 文件修复与 SessionManager 打开

涉及函数：

- `acquireSessionWriteLock`
- `repairSessionFileIfNeeded`
- `resolveTranscriptPolicy`
- `prewarmSessionFile`
- `guardSessionManager`
- `prepareSessionManagerForRun`

它做什么：

- 锁住 session 文件
- 修老 session 文件
- 算当前 provider 对 transcript 的约束策略
- 打开 `SessionManager`
- 给 session manager 做 run 前初始化

你应该理解成：

- OpenClaw 不是“拿到 session file 就直接喂模型”
- 中间有一整套 transcript 卫生层和并发保护层

目录接力：

```text
attempt.ts
  -> agents/session-*
  -> pi-embedded-runner/session-manager-*
```

### 阶段 5：创建真正的 embedded agent session

涉及函数：

- `createPreparedEmbeddedPiSettingsManager`
- `buildEmbeddedExtensionFactories`
- `splitSdkTools`
- `toClientToolDefinitions`
- `createAgentSession`
- `applySystemPromptOverrideToSession`
- `installToolResultContextGuard`

它做什么：

- 创建 settings manager
- 装上 extension factories
- 拆 built-in tools / custom tools
- 创建真正的 agent session
- 把 system prompt override 塞进 session
- 装上 tool result context guard

你应该理解成：

- 到这里才是真正“把之前准备的环境交给外部 agent core”
- 前面几百行都还是在搭台

目录接力：

```text
attempt.ts
  -> pi-project-settings
  -> pi-embedded-runner/extensions
  -> pi-tool-definition-adapter
  -> external pi-coding-agent
```

### 阶段 6：给 streamFn 一层层套包装

涉及函数：

- `createOllamaStreamFn`
- `wrapOllamaCompatNumCtx`
- `applyExtraParamsToAgent`
- `dropThinkingBlocks`
- `sanitizeToolCallIdsForCloudCodeAssist`
- `wrapStreamFnTrimToolCallNames`
- `createCacheTrace`
- `createAnthropicPayloadLogger`

它做什么：

- 决定 streamFn 走原生 Ollama 还是普通 `streamSimple`
- 给 Ollama OpenAI-compatible payload 塞 `num_ctx`
- 给 agent 增加 extra params
- provider 不兼容时，清 thinking blocks
- 清洗 tool call IDs
- trim tool call name
- 包日志与 cache trace

你应该理解成：

- 这里不是业务逻辑，而是“把不同 provider 的奇怪脾气在边界层统一收敛”

目录接力：

```text
attempt.ts
  -> ollama-stream
  -> thinking
  -> tool-call-id
  -> google / cache-trace / payload-log
```

### 阶段 7：session history 清洗后，正式进入可发送状态

涉及函数：

- `sanitizeSessionHistory`
- `validateGeminiTurns`
- `validateAnthropicTurns`
- `limitHistoryTurns`
- `sanitizeToolUseResultPairing`
- `activeSession.agent.replaceMessages`

它做什么：

- 在真正发 prompt 前清洗旧消息
- 验证 Gemini / Anthropic 的 turn 约束
- 做历史截断
- 修 tool_use / tool_result 配对

你应该理解成：

- 这是“发请求前最后一道 transcript 卫生门”

目录接力：

```text
attempt.ts
  -> pi-embedded-runner/google
  -> pi-embedded-helpers
  -> session-transcript-repair
  -> history
```

### 阶段 8：建立流式订阅与 abort 机制

涉及函数：

- `subscribeEmbeddedPiSession`
- `setActiveEmbeddedRun`
- `abortRun`
- `waitForCompactionRetry`

它做什么：

- 订阅流式事件
- 暴露 queue handle 给外层控制面
- 装 timeout、abortSignal、compaction 相关等待

你应该理解成：

- OpenClaw 这里开始把“模型流”变成“系统可观测、可中断、可投递的事件流”

目录接力：

```text
attempt.ts
  -> pi-embedded-subscribe
  -> runs
  -> compaction-timeout
```

### 阶段 9：运行 hooks、修 prompt、加载图片，然后真正 prompt

涉及函数：

- `resolvePromptBuildHookResult`
- `pruneProcessedHistoryImages`
- `detectAndLoadPromptImages`
- `activeSession.prompt`

它做什么：

- 让 hooks 追加 prompt context 或覆盖 system prompt
- 清理历史里已经处理过的 image blocks
- 读取这次 prompt 引用的图片
- 真正调用 `activeSession.prompt(...)`

这一步非常关键：

- 直到这里，模型调用才真的发生
- 前面所有阶段都只是为了让这一次 `prompt()` 更稳、更安全、更兼容

目录接力：

```text
attempt.ts
  -> plugins/hooks
  -> run/history-image-prune
  -> run/images
  -> external pi-agent-core session.prompt()
```

### 阶段 10：等待 compaction、选快照、写诊断、收尾

涉及函数：

- `waitForCompactionRetry`
- `appendCacheTtlTimestamp`
- `selectCompactionTimeoutSnapshot`
- `describeUnknownError`
- `runAgentEnd` hook

它做什么：

- 等 compaction retry
- 记录 cache ttl 时间戳
- 超时时决定用 pre-compaction 还是 current snapshot
- 持久化 prompt error 诊断
- 触发 agent_end hook

你应该理解成：

- 这个函数不仅负责“发起运行”
- 也负责“安全结束这次运行，并把状态整理回系统”

---

## 一张压缩版时序图

```text
runEmbeddedPiAgent
  -> 选 lane / workspace / model / auth
  -> runEmbeddedAttempt
       1. resolve workspace + sandbox
       2. load skills + bootstrap context
       3. create tools + allowedToolNames
       4. build runtimeInfo + systemPrompt
       5. lock session + repair transcript + open SessionManager
       6. createAgentSession
       7. wrap streamFn for provider compatibility / logging / sanitation
       8. sanitize history before prompt
       9. subscribe streaming + install abort/timeout
      10. run prompt hooks + load prompt images
      11. activeSession.prompt(...)
      12. wait compaction + snapshot + hooks + cleanup
```

---

## 你读这个文件时，应该把视线放在哪

如果你再回去读 `attempt.ts`，不要平均用力。

优先看这 6 个锚点：

1. `resolveSandboxContext`
2. `createOpenClawCodingTools`
3. `buildEmbeddedSystemPrompt`
4. `guardSessionManager` + `prepareSessionManagerForRun`
5. `createAgentSession`
6. `subscribeEmbeddedPiSession` + `activeSession.prompt`

只要这 6 个点你连成线了，这个文件就不会再像一团线。

---

## 你现在最该形成的直觉

`runEmbeddedAttempt` 的本质不是“让模型回答一句话”，而是：

- 把现实环境翻译成 prompt 和工具
- 把旧 session 修到能继续跑
- 把 provider 的怪癖在边界层收掉
- 把流式输出变成系统事件
- 把这次运行安全地收回 session 和控制面

所以它看起来很长，不是因为写得散，而是因为它本身就是系统边界的总装配点。

---

## 下一步建议

如果这张第二层地图你已经能跟上，下一步最值得做的不是继续扩散，而是继续做第三层：

- 只拆 `runEmbeddedAttempt` 的前半段
- 专门画出“system prompt 是怎么拼出来的”

或者换一条线：

- 只拆 `createOpenClawCodingTools`
- 看 OpenClaw 怎么把工具系统组织起来
