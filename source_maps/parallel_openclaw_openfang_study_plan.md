# OpenClaw / OpenFang 并行深读、源码注释与理解确认计划（详细版）

## 这份计划要达成什么

你这次不是“看教程”，而是同时推进 4 件事：

1. 用教程建立问题地图。
2. 用源码确认教程有没有说透。
3. 用注释把关键边界固化成可复读资产。
4. 用检查题逼自己证明“真的读明白了”。

这份计划默认你要的是深读，不是速读。目标不是章节数，而是你能把关键调用链讲清楚、能在源码里定位、能解释为什么这样设计。

---

## 固定学习节奏

每个主题固定做 5 个动作，顺序不要乱：

1. `教程首读`：先看教程章节，建立模块边界和术语。
2. `源码定位`：先找入口函数，不要一上来全文件通读。
3. `主链走读`：只追一条主路径，先不处理所有分支。
4. `注释落地`：给关键入口、裁决点、恢复点加高价值注释。
5. `理解确认`：回答检查题，答不上来就回源码。

建议单次学习时长：

- `90 分钟版`：教程 20 分钟，源码 45 分钟，注释 15 分钟，复盘 10 分钟
- `150 分钟版`：教程 25 分钟，源码 80 分钟，注释 25 分钟，检查题 20 分钟

建议每周投入：

- `4 次主学习`：每次 90 到 150 分钟
- `1 次验证/复盘`：只看测试、日志、命令，不开新文件
- `1 次整理`：把注释、笔记、对照表收敛成可复读材料

---

## 每次学习必须留下的产物

每次结束至少留下 3 样东西：

1. 一段源码注释
2. 一条调用链笔记
3. 一组理解确认题答案

推荐你固定写成下面这个模板：

```md
### 主题：

- 入口函数：
- 主调用链：
- 关键边界：
- 本次新加注释文件：
- 我能明确解释的设计点：
- 我还没看懂的点：
```

---

## 源码注释标准

只写 3 类注释：

### 1. 入口注释

说明这个函数在系统里的职责边界。

### 2. 裁决注释

说明为什么这个判断必须发生在执行之前。

### 3. 恢复注释

说明这里是在收敛哪类真实故障，而不是“做了一次普通处理”。

不要写这类低价值注释：

- “这里创建一个变量”
- “这里遍历数组”
- “这里调用函数”

每个文件第一轮注释控制在 `8 到 15 条`。第一轮先把骨架注释出来，不追求覆盖所有分支。

---

## 理解确认规则

每个任务后面都带一组检查题。你只有满足下面 3 条，才算真的过关：

1. 不看教程目录，能说出这个模块的入口和出口。
2. 不看代码全文，能说出主调用链上的 3 到 5 个关键函数。
3. 能解释“如果删掉这一层，系统会先坏在哪里”。

如果做不到，就不要进入下一个主题。

---

## 建议的 8 周并行节奏

### 第 1 周：双项目总地图

#### OpenClaw

- 教程：
  - `openclaw_tutorial/openclaw_tutorial_chapter_1.md`
  - `openclaw_tutorial/openclaw_tutorial_chapter_2.md`
- 源码入口：
  - `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
  - `openclaw/src/sessions/session-key-utils.ts`
  - `openclaw/src/sessions/transcript-events.ts`
  - `openclaw/src/acp/control-plane/manager.ts`
- 本周只追这条主链：
  - `runEmbeddedAttempt`
  - `resolvePromptBuildHookResult`
  - `resolvePromptModeForSession`
  - `createOpenClawCodingTools`
- 要看明白的点：
  - OpenClaw 自己不是完整大脑，它主要是环境整形、工具执行、安全边界和会话整合层。
  - `runEmbeddedAttempt` 在把控制权交给 agent core 之前做了哪些准备动作。
  - `sessionKey` 为什么不是普通 ID，而是跨路由、权限、子会话、投递的坐标。
- 注释任务：
  - 给 `runEmbeddedAttempt` 的开头补一段函数级注释。
  - 在 `resolvePromptBuildHookResult` 附近写清新旧 hook 兼容路径。
  - 在 `resolvePromptModeForSession` 附近写清 subagent 为什么走 `minimal`。
- 建议验证命令：
  - `rg -n "runEmbeddedAttempt|resolvePromptBuildHookResult|resolvePromptModeForSession|createOpenClawCodingTools" openclaw/src`
- 理解确认题：
  1. `runEmbeddedAttempt` 在真正进入模型前至少做了哪 6 类准备？
  2. `sandboxSessionKey`、`effectiveWorkspace`、`resolvedWorkspace` 的关系是什么？
  3. 为什么 `before_prompt_build` 和 `before_agent_start` 会在同一个函数里兼容？
  4. `resolvePromptModeForSession` 为什么对子 agent session 返回 `minimal`？
  5. OpenClaw 的核心边界到底在哪里结束，外部 agent core 从哪里开始？
- 通过标准：
  - 你能口头画出从 `runEmbeddedAttempt` 到 tool schema 准备完成为止的链路。

#### OpenFang

- 教程：
  - `openfang_tutorial/openfang_tutorial_chapter_0.md`
  - `openfang_tutorial/openfang_tutorial_chapter_1.md`
- 源码入口：
  - `openfang/crates/openfang-kernel/src/kernel.rs`
  - `openfang/crates/openfang-kernel/src/config.rs`
  - `openfang/crates/openfang-types/src/config.rs`
- 本周只追这条主链：
  - `boot`
  - `boot_with_config`
  - `config.clamp_bounds`
  - `drivers::create_driver`
- 要看明白的点：
  - OpenFang 是怎么把大量系统能力纳入一个统一 kernel 的。
  - 什么初始化失败会 `BootFailed`，什么失败只会 `warn` 后降级。
  - 为什么启动阶段要先修正配置边界，再开始初始化。
- 注释任务：
  - 给 `boot_with_config` 开头补一段高层注释。
  - 在 `clamp_bounds`、`create_dir_all`、`MemorySubstrate::open`、`create_driver` 前后补关键说明。
  - 在 fallback provider 组装处写清“失败跳过，不阻断主启动”的语义。
- 建议验证命令：
  - `rg -n "boot_with_config|clamp_bounds|create_driver|FallbackDriver" openfang/crates`
- 理解确认题：
  1. `boot()` 和 `boot_with_config()` 的职责差异是什么？
  2. 为什么 `clamp_bounds()` 要在大部分初始化之前发生？
  3. 哪几类组件初始化失败会直接让 kernel 启动失败？
  4. fallback provider 的失败为什么是 `warn + skip` 而不是 `BootFailed`？
  5. embedding driver 的探测顺序是什么，为什么这样排？
- 通过标准：
  - 你能把 `boot_with_config` 的启动顺序按 10 到 15 个步骤复述出来。

---

### 第 2 周：消息旅程 vs Kernel 启动后的第一轮执行

#### OpenClaw

- 教程：
  - 复读 `openclaw_tutorial/openclaw_tutorial_chapter_2.md`
- 源码目标：
  - `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
  - `openclaw/src/sessions/`
- 本周主问题：
  - 一条消息从上下文组装、工具注入、会话标签，到进入 agent core 之前都经历了什么。
- 注释任务：
  - 给上下文组装和 session summary 附近补注释。
  - 标出 `allowedToolNames` 的来源和意义。
- 理解确认题：
  1. 为什么 OpenClaw 先建上下文、再建工具，而不是反过来？
  2. `skillsPrompt`、`bootstrapFiles`、`contextFiles` 分别代表什么层面的输入？
  3. `modelHasVision` 和工具创建逻辑是怎么耦合的？
  4. 哪些参数是为了消息投递目标准备的，不是为了模型推理准备的？

#### OpenFang

- 教程：
  - `openfang_tutorial/openfang_tutorial_chapter_2.md`
- 源码入口：
  - `openfang/crates/openfang-runtime/src/agent_loop.rs`
- 本周只追这条主链：
  - `run_agent_loop`
  - memory recall
  - `validate_and_repair`
  - 历史裁剪
- 要看明白的点：
  - loop 起步阶段为什么先做记忆召回、再修 session、再准备发送消息。
  - 为什么 canonical context 不是塞进 system prompt，而是作为第一条 user message。
- 注释任务：
  - 给 `run_agent_loop` 函数头部补阶段说明。
  - 在 memory recall 分支上写清“有 embedding”和“无 embedding”的两条路。
  - 在 `validate_and_repair` 和 canonical context 插入点附近补说明。
- 理解确认题：
  1. `run_agent_loop` 最前面的 5 个关键步骤是什么？
  2. 为什么 `validate_and_repair` 发生在大模型调用前，而不是 tool 执行后统一修？
  3. 为什么 canonical context 被放进 user message，而不是 system prompt？
  4. `MAX_HISTORY_MESSAGES` 这种硬裁剪在已有 compactor 的情况下为什么仍然存在？
  5. 如果 embedding recall 失败，系统是如何保持可用的？
- 通过标准：
  - 你能解释 `run_agent_loop` 在“首次请求进入 LLM 前”做了哪些防失控处理。

---

### 第 3 周：LLM 适配、流式输出、恢复逻辑

#### OpenClaw

- 教程：
  - `openclaw_tutorial/openclaw_tutorial_chapter_3.md`
  - `openclaw_tutorial/openclaw_tutorial_chapter_4.md`
- 优先源码：
  - `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
  - 通过 `rg` 继续找消息转换和 streaming 相关文件
- 已知重点函数：
  - `wrapStreamFnTrimToolCallNames`
  - `wrapOllamaCompatNumCtx`
  - `shouldInjectOllamaCompatNumCtx`
- 本周主问题：
  - provider 兼容是在哪一层做的，为什么需要在数据流上做修复。
- 注释任务：
  - 在 tool call name trim 相关函数旁写清“为什么不在最后再修”。
  - 在 Ollama 兼容注入逻辑附近写清上下文窗口兼容目的。
- 理解确认题：
  1. 为什么 OpenClaw 要对 tool call name 进行 trim？
  2. `wrapStreamFnTrimToolCallNames` 修复的是 provider 输出问题还是本地业务问题？
  3. `shouldInjectOllamaCompatNumCtx` 反映了什么兼容性判断？
  4. 哪些兼容动作发生在请求前，哪些发生在流式响应中？

#### OpenFang

- 教程：
  - `openfang_tutorial/openfang_tutorial_chapter_2.md`
- 源码入口：
  - `openfang/crates/openfang-runtime/src/agent_loop.rs`
  - `openfang/crates/openfang-runtime/src/session_repair.rs`
- 本周只追这条主链：
  - `call_with_retry`
  - `stream_with_retry`
  - `recover_text_tool_calls`
  - `validate_and_repair_with_stats`
- 注释任务：
  - 在 `call_with_retry` 前补一段“这是 provider 抖动收敛层”的注释。
  - 在 `recover_text_tool_calls` 前补一段“为什么要从纯文本里抢救工具调用”的注释。
  - 在 `session_repair.rs` 的主要 phase 前补阶段注释。
- 理解确认题：
  1. `call_with_retry` 和 `stream_with_retry` 分别保护什么故障？
  2. `recover_text_tool_calls` 为什么不能简单地把原文本直接当普通回答？
  3. `session_repair` 至少修哪 4 类结构性问题？
  4. synthetic tool result 的作用是什么？
  5. `strip_tool_result_details` 为什么属于结构卫生，而不是输出美化？
- 通过标准：
  - 你能解释 OpenFang 为什么把“重试、修复、恢复”拆成多个文件，而不是揉在 loop 主函数里。

---

### 第 4 周：命令安全、执行裁决与沙箱

#### OpenClaw

- 教程：
  - `openclaw_tutorial/openclaw_tutorial_chapter_5.md`
  - `openclaw_tutorial/openclaw_tutorial_chapter_6.md`
- 核心源码：
  - `openclaw/src/infra/exec-approvals-analysis.ts`
  - `openclaw/src/infra/exec-command-resolution.ts`
  - `openclaw/src/infra/exec-approvals.ts`
  - `openclaw/src/infra/exec-wrapper-resolution.ts`
- 必追函数：
  - `splitShellPipeline`
  - `splitCommandChain`
  - `analyzeShellCommand`
  - `resolveCommandResolutionFromArgv`
  - `matchAllowlist`
  - `requiresExecApproval`
  - `requestExecApprovalViaSocket`
- 本周主问题：
  - 一条 shell 字符串怎么变成可审批执行计划。
- 注释任务：
  - 在 `analyzeShellCommand` 开头写清“先 chain，再 pipeline”的原因。
  - 在 `resolveCommandResolutionFromArgv` 处写清“为什么可执行文件解析是真正信任边界”。
  - 在 `requestExecApprovalViaSocket` 前写清它接收的是净化后执行计划，不是原始字符串。
- 建议验证命令：
  - `rg -n "splitShellPipeline|splitCommandChain|analyzeShellCommand|resolveCommandResolutionFromArgv|requestExecApprovalViaSocket" openclaw/src`
- 理解确认题：
  1. 为什么 Windows 走 `analyzeWindowsShellCommand`，不能硬复用 Unix 逻辑？
  2. `splitCommandChain` 和 `splitShellPipeline` 分别切什么语义边界？
  3. 为什么 allowlist 匹配前必须先做真实 executable resolution？
  4. `buildSafeShellCommand` 和 `buildSafeBinsShellCommand` 各自解决什么问题？
  5. 为什么人工审批要放在解析、解包、allowlist、safe bin 之后？
- 通过标准：
  - 你能按时序复述“原始命令 -> 解析 -> resolution -> 策略 -> 审批”的主链。

#### OpenFang

- 教程：
  - `openfang_tutorial/openfang_tutorial_chapter_3.md`
- 核心源码：
  - `openfang/crates/openfang-runtime/src/tool_runner.rs`
  - `openfang/crates/openfang-runtime/src/tool_policy.rs`
  - `openfang/crates/openfang-runtime/src/shell_bleed.rs`
- 必追函数：
  - `execute_tool`
  - `check_taint_shell_exec`
  - `check_taint_net_fetch`
  - `tool_shell_exec`
  - `validate_path`
  - `resolve_file_path`
- 本周主问题：
  - OpenFang 是怎么把工具调用纳入统一运行时和能力边界的。
- 注释任务：
  - 给 `execute_tool` 写函数级注释，说明它是统一调度入口。
  - 在 taint check 附近写清“这不是普通校验，是信任传播控制”。
  - 在 `validate_path` / `resolve_file_path` 附近写清路径安全边界。
- 理解确认题：
  1. `MAX_AGENT_CALL_DEPTH` 防的是什么类型的失控？
  2. `execute_tool` 在真正执行工具前至少做了哪几层检查？
  3. `tool_shell_exec` 和 OpenClaw 的 shell 安全壳相比，边界思路有什么不同？
  4. 为什么 path validation 要单独显式存在，而不是交给文件系统报错？
  5. taint 检查和 capability enforcement 是同一件事吗？
- 通过标准：
  - 你能说清楚 OpenFang 的工具执行是如何从“函数分发”升级为“运行时治理”的。

---

### 第 5 周：会话、队列、进程与长期运行

#### OpenClaw

- 教程：
  - `openclaw_tutorial/openclaw_tutorial_chapter_7.md`
  - `openclaw_tutorial/openclaw_tutorial_chapter_8.md`
  - `openclaw_tutorial/openclaw_tutorial_chapter_9.md`
- 核心源码：
  - `openclaw/src/acp/control-plane/session-actor-queue.ts`
  - `openclaw/src/acp/control-plane/manager.ts`
  - `openclaw/src/acp/control-plane/manager.core.ts`
  - `openclaw/src/acp/control-plane/manager.identity-reconcile.ts`
  - `openclaw/src/daemon/service.ts`
  - `openclaw/src/daemon/service-runtime.ts`
  - `openclaw/src/daemon/inspect.ts`
- 外围定位：
  - `rg -n "enqueue|drain|delivery|sessionKey|resolveSessionDeliveryTarget" openclaw/src`
- 本周主问题：
  - OpenClaw 怎么避免 session 并发踩踏、进程重启丢状态、投递错路由。
- 注释任务：
  - 给 session actor queue 相关入口写清串行化意图。
  - 给 `manager.identity-reconcile.ts` 附近写清 identity reconcile 的必要性。
  - 给 daemon service/runtime 相关入口写清部署态职责。
- 理解确认题：
  1. OpenClaw 用什么机制避免同一 session 并发执行？
  2. control plane manager 管的到底是“模型回合”还是“运行时节点状态”？
  3. session identity reconcile 解决的是什么类型的问题？
  4. restart/drain 语义为什么对 agent 系统特别重要？
  5. 为什么 delivery target 不能只看最后一条消息上下文？
- 通过标准：
  - 你能解释 OpenClaw 为什么必须同时有 queue、daemon、control plane 三层。

#### OpenFang

- 教程：
  - `openfang_tutorial/openfang_tutorial_chapter_4.md`
  - `openfang_tutorial/openfang_tutorial_chapter_5.md`
- 核心源码：
  - `openfang/crates/openfang-kernel/src/event_bus.rs`
  - `openfang/crates/openfang-kernel/src/workflow.rs`
  - `openfang/crates/openfang-kernel/src/triggers.rs`
- 必追函数：
  - `EventBus::publish`
  - `EventBus::subscribe_agent`
  - `WorkflowEngine::register`
  - `WorkflowEngine::create_run`
  - `WorkflowEngine::execute_run`
  - `TriggerEngine::register`
  - `TriggerEngine::evaluate`
- 本周主问题：
  - OpenFang 的治理面是怎么和执行面解耦的。
- 注释任务：
  - 给 `EventBus` 写清“事件传递”和“历史查询”是两个不同诉求。
  - 在 `create_run` 和 `execute_run` 附近写清“定义运行”和“执行运行”的分离。
  - 在 `evaluate` 旁写清 trigger 并不直接执行 agent，只产生命中结果。
- 理解确认题：
  1. `EventBus` 为什么既要广播，又要保留 history？
  2. `create_run` 和 `execute_run` 为什么拆开？
  3. `TriggerEngine::evaluate` 返回的是什么，而不是什么？
  4. workflow 的错误模式和重试策略是在什么层收口的？
  5. 如果没有事件总线，OpenFang 哪些模块会被迫直接耦合？
- 通过标准：
  - 你能解释 OpenFang 的“治理面”不是附加功能，而是内核的一部分。

---

### 第 6 周：API、渠道桥接、消息分块与接入面

#### OpenClaw

- 教程：
  - 复读 `openclaw_tutorial/openclaw_tutorial_chapter_8.md`
  - 复读 `openclaw_tutorial/openclaw_tutorial_chapter_10.md` 的接入相关部分
- 建议源码定位：
  - `rg -n "createInboundDebouncer|requireMention|chunk|delivery|replyTo" openclaw/src`
  - 优先看 `imessage/monitor/`、`auto-reply/chunk`、`channels` 相关文件
- 本周主问题：
  - 多渠道接入到底是协议适配问题，还是会话与投递语义问题。
- 注释任务：
  - 给 inbound debouncer 入口补注释。
  - 给 mention gating 和 outbound chunking 入口补注释。
- 理解确认题：
  1. `createInboundDebouncer` 解决的是平台 SDK 的哪类噪声？
  2. mention gating 为什么和 session route 绑定在一起？
  3. 出站 chunking 为什么不能只按字符数粗暴截断？
  4. 多渠道场景里，投递锚定比“发出去”更重要的原因是什么？

#### OpenFang

- 教程：
  - `openfang_tutorial/openfang_tutorial_chapter_6.md`
- 核心源码：
  - `openfang/crates/openfang-api/src/server.rs`
  - `openfang/crates/openfang-api/src/channel_bridge.rs`
  - `openfang/crates/openfang-api/src/stream_chunker.rs`
- 必追函数：
  - `build_router`
  - `run_daemon`
  - `start_channel_bridge`
  - `start_channel_bridge_with_config`
  - `reload_channels_from_disk`
  - `StreamChunker::push`
  - `StreamChunker::try_flush`
- 本周主问题：
  - OpenFang 的接入面是如何桥接到 kernel 的。
- 注释任务：
  - 给 `start_channel_bridge_with_config` 补函数级注释。
  - 在 `StreamChunker` 上写清“不能打断 code fence”的约束。
  - 在 `build_router` 或 `run_daemon` 附近写清 API 层和 kernel 层的边界。
- 理解确认题：
  1. `channel_bridge` 是 adapter 还是 orchestration layer？
  2. `start_channel_bridge_with_config` 除了启动渠道，还承担了哪些装配职责？
  3. `StreamChunker::try_flush` 为什么优先段落边界，而不是纯长度边界？
  4. 为什么 code fence 被视为 chunking 的结构约束？
  5. OpenFang 的 channel bridge 和 OpenClaw 的渠道层最大差异是什么？
- 通过标准：
  - 你能说清 OpenFang 接入层和 OpenClaw 接入层分别更偏“桥接”和“产品噪声收敛”的哪一侧。

---

### 第 7 周：扩展、技能、插件兼容与宿主边界

#### OpenClaw

- 教程：
  - `openclaw_tutorial/openclaw_tutorial_chapter_11.md`
- 核心源码：
  - `openclaw/src/extensionAPI.ts`
  - `openclaw/src/acp/control-plane/manager.runtime-controls.ts`
  - `openclaw/src/acp/control-plane/runtime-cache.ts`
- 本周主问题：
  - OpenClaw 官方插件合同到底承诺了什么，宿主又保留了哪些控制权。
- 注释任务：
  - 给 `extensionAPI.ts` 写高层边界注释。
  - 给 runtime control/cache 相关入口写清“控制面缓存不等于真实执行状态”。
- 理解确认题：
  1. 插件 API 提供的是能力合同还是内部实现细节？
  2. runtime cache 为什么必须和真实 runtime 分开看？
  3. 插件能改什么，不能假设什么？

#### OpenFang

- 教程：
  - `openfang_tutorial/openfang_tutorial_appendix_b_extensions.md`
  - `openfang_tutorial/openfang_tutorial_discussion_native_plugins.md`
- 核心源码：
  - `openfang/crates/openfang-skills/src/openclaw_compat.rs`
  - `openfang/crates/openfang-extensions/src/installer.rs`
  - `openfang/crates/openfang-extensions/src/oauth.rs`
- 必追函数：
  - `detect_skillmd`
  - `convert_skillmd`
  - `detect_openclaw_skill`
  - `convert_openclaw_skill`
  - `install_integration`
  - `run_pkce_flow`
- 本周主问题：
  - OpenFang 是如何兼容 OpenClaw skill/plugin 生态的。
- 注释任务：
  - 在 `convert_openclaw_skill` 附近写清“兼容的是合同，不是完整运行时等价”。
  - 在 `install_integration` 前写清安装过程的关键状态变化。
  - 在 `run_pkce_flow` 前写清 OAuth 安装流的安全约束。
- 理解确认题：
  1. `detect_skillmd` 和 `detect_openclaw_skill` 在识别层面有什么差异？
  2. `convert_openclaw_skill` 的最终产物是什么？
  3. 为什么说 OpenFang 兼容的是 OpenClaw 资产形态，不是直接复制运行时行为？
  4. `install_integration` 和 `run_pkce_flow` 分别属于安装链上的哪两个阶段？
  5. PKCE 在这里防的是什么？
- 通过标准：
  - 你能解释 OpenFang 是怎样吸收 OpenClaw 生态，而不是简单重写一套新协议。

---

### 第 8 周：CLI/TUI、控制面整合、总复盘

#### OpenClaw

- 教程：
  - 回看 `chapter_10`、`chapter_11`
- 源码：
  - `openclaw/src/acp/control-plane/manager.ts`
  - `openclaw/src/acp/control-plane/manager.core.ts`
  - `openclaw/src/acp/control-plane/spawn.ts`
- 本周主问题：
  - 控制面如何把 session、runtime、spawn、identity 拉到一张图上。
- 理解确认题：
  1. `getAcpSessionManager()` 返回的到底是“聊天管理器”还是“会话控制中枢”？
  2. manager、manager.core、spawn、identity reconcile 为什么拆文件？
  3. control plane 的错位会在用户侧表现成什么问题？

#### OpenFang

- 教程：
  - `openfang_tutorial/openfang_tutorial_chapter_9.md`
  - `openfang_tutorial/openfang_tutorial_chapter_10.md`
- 核心源码：
  - `openfang/crates/openfang-cli/src/main.rs`
  - `openfang/crates/openfang-api/src/server.rs`
- 必追函数：
  - `main`
  - `cmd_start`
  - `boot_kernel`
  - `run_daemon`
- 本周主问题：
  - OpenFang 的 CLI/TUI/daemon 是怎样围绕 kernel 组织起来的。
- 注释任务：
  - 在 `boot_kernel`、`cmd_start`、`run_daemon` 处补注释。
  - 说明 CLI 是入口壳，不是系统核心。
- 理解确认题：
  1. `cmd_start` 和 `boot_kernel` 的职责分界是什么？
  2. daemon 是 API 进程、kernel 宿主，还是两者兼有？
  3. OpenFang 的 CLI 为什么会这么大，但仍然不等于 kernel 本身？
  4. 如果 CLI 没有和 daemon/kernal 分边界，会出现什么演化问题？
- 通过标准：
  - 你能解释 OpenFang 的“内核、API、CLI”三层关系，而不是把它们看成一个大程序。

---

## 每周固定复盘模板

每周最后一天写一页，格式固定：

```md
## 本周主题

### OpenClaw

- 入口函数：
- 主调用链：
- 关键边界：
- 我新增的源码注释：

### OpenFang

- 入口函数：
- 主调用链：
- 关键边界：
- 我新增的源码注释：

### 对照结论

- 相同点：
- 不同点：
- 哪边更像“壳层收敛”：
- 哪边更像“内核化治理”：

### 我还没读明白的点

-
```

---

## 注释优先级清单

第一批最值得注释的文件，不要分散：

### OpenClaw

1. `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
2. `openclaw/src/infra/exec-approvals-analysis.ts`
3. `openclaw/src/infra/exec-command-resolution.ts`
4. `openclaw/src/infra/exec-approvals.ts`
5. `openclaw/src/acp/control-plane/manager.ts`
6. `openclaw/src/acp/control-plane/session-actor-queue.ts`

### OpenFang

1. `openfang/crates/openfang-kernel/src/kernel.rs`
2. `openfang/crates/openfang-runtime/src/agent_loop.rs`
3. `openfang/crates/openfang-runtime/src/session_repair.rs`
4. `openfang/crates/openfang-runtime/src/tool_runner.rs`
5. `openfang/crates/openfang-kernel/src/event_bus.rs`
6. `openfang/crates/openfang-api/src/channel_bridge.rs`

---

## 最终验收标准

这份计划执行完，不以“读完多少章节”为标准，而以这 6 条为标准：

1. 你能完整讲清 OpenClaw 的 `runEmbeddedAttempt` 主链。
2. 你能完整讲清 OpenFang 的 `boot_with_config` 和 `run_agent_loop` 主链。
3. 你能解释两边对 shell/tool 安全边界的不同设计。
4. 你能解释两边对状态、接入、扩展的不同组织方式。
5. 两个项目各至少有 `6 个核心文件` 被你补过第一轮高价值注释。
6. 你手里至少有 `8 份周复盘` 和 `8 组检查题答案`。

---

## 现在就开始的顺序

不要再继续扩散计划，直接动手：

1. 先做第 1 周的 `OpenClaw attempt.ts`。
2. 再做第 1 周的 `OpenFang kernel.rs`。
3. 每个文件第一轮最多加 `10 条` 注释。
4. 加完后，先回答检查题，再决定进下一个文件。
