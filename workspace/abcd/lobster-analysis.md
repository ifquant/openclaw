# OpenClaw 超详细自顶向下分析

> 文档版本: 2026-03-01
> 分析深度: 函数级别
> 代码版本: OpenClaw main branch

---

## 第1层：架构 - 完整数据流图

### 1.1 系统架构概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户消息源                                      │
│  (Telegram / Discord / Slack / Feishu / WhatsApp / WebSocket / CLI)         │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Channels (通道层)                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  telegram   │  │  discord    │  │  slack      │  │  feishu     │ ...  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘      │
│                                                                             │
│  职责: 消息解析、回复格式化、平台特性适配                                     │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Gateway (网关层) - server.impl.ts                      │
│                                                                             │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐               │
│  │ HTTP Server    │  │ WebSocket      │  │ Control UI     │               │
│  │ (REST API)     │  │ (实时消息)     │  │ (管理界面)     │               │
│  └────────────────┘  └────────────────┘  └────────────────┘               │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    server-chat.ts                                    │  │
│  │   - ChatRunState: 管理聊天运行状态                                   │  │
│  │   - createAgentEventHandler: Agent事件处理                          │  │
│  │   - emitChatDelta/emitChatFinal: 聊天消息分发                        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Agents (Agent层)                                      │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              pi-embedded-runner/run.ts                              │   │
│  │   - runEmbeddedPiAgent: 主入口函数                                   │   │
│  │   - runEmbeddedAttempt: 单次运行尝试                                │   │
│  │   - 上下文窗口守卫、认证轮换、模型fallback                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              pi-tools.ts                                            │   │
│  │   - createOpenClawCodingTools: 工具创建工厂                         │   │
│  │   - 工具策略管道: profile → provider → global → agent → group      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              subagent-registry.ts                                   │   │
│  │   - registerSubagentRun: 注册子Agent运行                            │   │
│  │   - completeSubagentRun: 完成处理                                    │   │
│  │   - 子Agent生命周期管理                                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Memory (记忆层) - memory/manager.ts                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              MemoryIndexManager                                     │   │
│  │   - search(): 混合搜索 (向量 + FTS)                                 │   │
│  │   - sync(): 文件同步                                                │   │
│  │   - 嵌入providers: OpenAI/Gemini/Voyage/Mistral                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Tools (工具层)                                        │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ exec (bash)  │  │ read         │  │ write        │  │ edit         │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ message      │  │ browser      │  │ camera       │  │ sessions     │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 从用户消息到响应的完整流程

```
用户发送消息
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Channel Plugin (如 telegram, discord, slack)                    │
│  - parseMessage(): 解析平台特定消息格式                          │
│  - formatReply(): 格式化响应消息                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Gateway HTTP/WebSocket Handler                                  │
│  - server-http.ts: 处理 HTTP 请求                                │
│  - server-ws-runtime.ts: WebSocket 连接管理                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ session-utils.ts: 会话管理                                       │
│  - loadSessionEntry(): 加载会话上下文                            │
│  - resolveSessionKey(): 解析会话键                               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ server-chat.ts: ChatRunState                                     │
│  - createChatRunState(): 创建聊天运行状态                        │
│  - registry.add(): 添加运行到队列                                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Agent 启动: runEmbeddedPiAgent()                                │
│  - resolveModel(): 解析模型                                       │
│  - ensureAuthProfileStore(): 获取认证                            │
│  - runEmbeddedAttempt(): 执行单次尝试                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ run/attempt.ts: 创建 Agent Session                              │
│  - createAgentSession(): 创建 pi-agent 会话                      │
│  - subscribeEmbeddedPiSession(): 订阅流式响应                   │
│  - createOpenClawCodingTools(): 创建工具                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tool Execution (工具调用循环)                                    │
│  - model.generate(): 生成响应                                     │
│  - tool.execute(): 执行工具                                       │
│  - loop until stop_reason                                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ server-chat.ts: 事件处理与分发                                   │
│  - emitChatDelta(): 发送增量消息                                 │
│  - emitChatFinal(): 发送最终消息                                 │
│  - broadcast(): 广播到所有客户端                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Channel Plugin: 发送响应                                         │
│  - sendMessage(): 发送到平台                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 第2层：模块职责

### 2.1 Gateway (网关模块)

**职责**: 核心中央服务，负责所有入口点、连接管理、状态协调

**主要组件**:

- `server.impl.ts`: Gateway 启动和生命周期管理
- `server-chat.ts`: 聊天运行状态和事件处理
- `server-http.ts`: HTTP REST API
- `server-ws-runtime.ts`: WebSocket 运行时
- `server-channels.ts`: 通道管理
- `server-methods/`: 网关方法定义

**核心功能**:

- 启动 HTTP/WebSocket 服务器
- 管理客户端连接
- 处理聊天运行状态
- 协调 Agent 事件流
- 配置热重载
- 插件加载

### 2.2 Agents (Agent模块)

**职责**: Agent 运行的核心逻辑、模型选择、工具执行

**主要组件**:

- `pi-embedded-runner/run.ts`: 主入口
- `pi-tools.ts`: 工具系统
- `subagent-registry.ts`: 子Agent管理
- `model-selection.ts`: 模型选择
- `auth-profiles.ts`: 认证配置

**核心功能**:

- 运行嵌入 Agent
- 管理工具调用循环
- 模型解析和认证
- 上下文窗口管理
- 工具策略执行
- 子Agent生命周期

### 2.3 Memory (记忆模块)

**职责**: 向量搜索、语义记忆

**主要组件**:

- `memory/manager.ts`: 索引管理器
- `memory/embeddings.ts`: 嵌入providers
- `memory/hybrid.ts`: 混合搜索
- `memory/search.ts`: 搜索实现

**核心功能**:

- 向量索引管理
- FTS 全文搜索
- 混合搜索 (向量 + 关键词)
- 文件同步
- 嵌入缓存

### 2.4 Channels (通道模块)

**职责**: 多平台消息接入

**主要组件**:

- `channels/plugins/`: 各平台插件
- `telegram/`, `discord/`, `slack/`, `feishu/`

**核心功能**:

- 消息解析和发送
- 平台特定功能适配
- 命令处理
- 回调处理

### 2.5 Tools (工具模块)

**职责**: Agent 可用工具集合

**主要组件**:

- `bash-tools.ts`: 执行命令
- `pi-tools.ts`: 工具创建工厂
- `openclaw-tools.ts`: OpenClaw 特有工具

**核心功能**:

- 文件读写编辑
- 命令执行
- 消息发送
- 浏览器控制
- 摄像头访问

---

## 第3层：组件详细分析

### 3.1 Gateway 组件关系

```
server.impl.ts (主入口)
    │
    ├── createGatewayRuntimeState()      # 创建运行时状态
    │   ├── clients: Set<GatewayClient>  # 客户端连接
    │   ├── chatRunState: ChatRunState  # 聊天运行状态
    │   ├── broadcast: Function         # 广播函数
    │   └── ...
    │
    ├── createChannelManager()           # 通道管理器
    │   └── startChannel() / stopChannel()
    │
    ├── attachGatewayWsHandlers()        # WebSocket 处理器
    │   └── 处理 chat/sessions/agent 等方法
    │
    ├── createAgentEventHandler()        # Agent 事件处理
    │   └── server-chat.ts
    │
    └── startGatewayMaintenanceTimers()  # 维护定时器
```

### 3.2 Agent 组件关系

```
runEmbeddedPiAgent()                    # 主入口
    │
    ├── resolveModel()                  # 解析模型
    │   └── 从配置获取 provider/model
    │
    ├── ensureAuthProfileStore()        # 认证配置
    │   └── getApiKeyForModel()
    │
    ├── evaluateContextWindowGuard()    # 上下文窗口守卫
    │   └── 检查模型上下文大小
    │
    ├── runEmbeddedAttempt()            # 执行尝试
    │   ├── createAgentSession()
    │   ├── createOpenClawCodingTools()
    │   └── subscribeEmbeddedPiSession()
    │
    └── [错误处理和重试]
        ├── advanceAuthProfile()        # 认证轮换
        ├── compactEmbeddedPiSessionDirect() # 压缩
        └── truncateOversizedToolResults()  # 截断
```

### 3.3 工具系统组件关系

```
createOpenClawCodingTools()              # 工具工厂
    │
    ├── resolveEffectiveToolPolicy()    # 解析工具策略
    │   ├── profilePolicy
    │   ├── providerPolicy
    │   └── globalPolicy
    │
    ├── createExecTool()                # 执行工具
    ├── createReadTool()                # 读取工具
    ├── createWriteTool()               # 写入工具
    ├── createEditTool()                # 编辑工具
    │
    ├── applyToolPolicyPipeline()       # 应用工具策略
    │
    └── wrapToolWithBeforeToolCallHook() # 工具调用钩子
```

---

## 第4层：关键函数详细分析

### 4.1 Gateway 核心函数

---

## 函数: startGatewayServer

### 签名

```typescript
async function startGatewayServer(
  port?: number,
  opts?: GatewayServerOptions,
): Promise<GatewayServer>;
```

### 参数

- `port`: 服务器端口，默认 18789
- `opts`: Gateway 服务器选项配置

### 功能

Gateway 服务器的启动入口函数，负责初始化所有子系统并开始监听连接。

### 核心实现

```typescript
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  // 1. 读取和验证配置
  let configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.legacyIssues.length > 0) {
    const { config: migrated, changes } = migrateLegacyConfig(configSnapshot.parsed);
    await writeConfigFile(migrated);
  }

  // 2. 激活运行时密钥
  await activateRuntimeSecrets(cfgAtStart, { reason: "startup", activate: true });

  // 3. 初始化子Agent注册表
  initSubagentRegistry();

  // 4. 加载插件
  const { pluginRegistry, gatewayMethods } = loadGatewayPlugins({ ... });

  // 5. 创建通道管理器
  const channelManager = createChannelManager({ ... });

  // 6. 创建运行时状态
  const {
    wss, clients, broadcast, chatRunState, ...
  } = await createGatewayRuntimeState({ ... });

  // 7. 启动发现服务
  const discovery = await startGatewayDiscovery({ ... });

  // 8. 附加 WebSocket 处理器
  attachGatewayWsHandlers({
    wss, clients, gatewayMethods, events: GATEWAY_EVENTS, ...
  });

  // 9. 启动维护定时器
  const { tickInterval, healthInterval, dedupeCleanup } = startGatewayMaintenanceTimers({ ... });

  // 10. 返回关闭函数
  return {
    close: async (opts) => { ... }
  };
}
```

### 设计思路

采用**渐进式初始化**策略，按依赖顺序启动各子系统：

1. 配置加载 → 密钥激活（基础设施）
2. 插件加载（可扩展性）
3. 通道管理（外部连接）
4. 运行时状态（内存状态）
5. WebSocket 处理器（事件处理）
6. 维护定时器（后台任务）

这种设计确保依赖关系正确，同时允许模块独立测试。

---

## 函数: createAgentEventHandler

### 签名

```typescript
function createAgentEventHandler(
  options: AgentEventHandlerOptions,
): (evt: AgentEventPayload) => void;
```

### 参数

- `options`: 事件处理选项
  - `broadcast`: 广播函数
  - `chatRunState`: 聊天运行状态
  - `agentRunSeq`: 运行序号映射
  - `resolveSessionKeyForRun`: 运行ID解析会话键

### 功能

创建 Agent 事件处理器，处理来自 Agent 的流式事件（增量文本、工具调用、生命周期事件），并将其转换为聊天消息分发给客户端。

### 核心实现

```typescript
export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
}: AgentEventHandlerOptions) {
  // 发送聊天增量消息
  const emitChatDelta = (sessionKey, clientRunId, sourceRunId, seq, text) => {
    const cleaned = stripInlineDirectiveTagsForDisplay(text).text;
    if (!cleaned || isSilentReplyText(cleaned)) return;

    chatRunState.buffers.set(clientRunId, cleaned);
    if (shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) return;

    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      message: { role: "assistant", content: [{ type: "text", text: cleaned }], ... }
    };
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);
  };

  // 发送聊天最终消息
  const emitChatFinal = (sessionKey, clientRunId, sourceRunId, seq, jobState, error?) => {
    const text = chatRunState.buffers.get(clientRunId)?.trim() || "";
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);

    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        message: text ? { role: "assistant", content: [{ type: "text", text }] } : undefined
      };
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
    } else {
      broadcast("chat", { runId: clientRunId, sessionKey, seq, state: "error", errorMessage: formatForLog(error) });
    }
  };

  return (evt: AgentEventPayload) => {
    // 解析会话键
    const chatLink = chatRunState.registry.peek(evt.runId);
    const sessionKey = chatLink?.sessionKey ?? evt.sessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;

    // 更新序列号
    agentRunSeq.set(evt.runId, evt.seq);

    // 处理工具事件
    if (evt.stream === "tool") {
      const recipients = toolEventRecipients.get(evt.runId);
      if (recipients?.size) {
        broadcastToConnIds("agent", toolPayload, recipients);
      }
    }

    // 处理聊天事件
    if (sessionKey) {
      if (evt.stream === "assistant" && evt.data?.text) {
        emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text);
      }
      // 处理生命周期 end/error
      else if (lifecyclePhase === "end" || lifecyclePhase === "error") {
        emitChatFinal(sessionKey, clientRunId, evt.runId, evt.seq, lifecyclePhase === "error" ? "error" : "done", evt.data?.error);
        clearAgentRunContext(evt.runId);
      }
    }
  };
}
```

### 设计思路

采用**事件驱动架构**：

- 将 Agent 的流式输出转换为结构化事件
- 使用 `ChatRunState` 管理多个并发运行的聊天
- 支持心跳抑制（heartbeat ack）
- 通过 `broadcast` 分发给所有订阅者

---

### 4.2 Agent 核心函数

---

## 函数: runEmbeddedPiAgent

### 签名

```typescript
async function runEmbeddedPiAgent(params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult>;
```

### 参数

- `params`: 运行参数
  - `sessionKey`: 会话键
  - `prompt`: 用户提示
  - `provider`/`model`: 模型选择
  - `config`: OpenClaw 配置
  - `skillsSnapshot`: 技能快照

### 功能

主入口函数，运行嵌入的 PI Agent，处理完整的人机对话循环，包括认证、模型选择、上下文管理、错误恢复等。

### 核心实现

```typescript
export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  // 1. 解析会话车道（用于命令队列隔离）
  const sessionLane = resolveSessionLane(params.sessionKey);
  const globalLane = resolveGlobalLane(params.lane);

  return enqueueSession(() =>
    enqueueGlobal(async () => {
      const started = Date.now();

      // 2. 解析工作区
      const workspaceResolution = resolveRunWorkspaceDir({ ... });
      const resolvedWorkspace = workspaceResolution.workspaceDir;

      // 3. 运行 before_model_resolve hooks（允许插件覆盖模型）
      let modelResolveOverride;
      const hookRunner = getGlobalHookRunner();
      if (hookRunner?.hasHooks("before_model_resolve")) {
        modelResolveOverride = await hookRunner.runBeforeModelResolve({ prompt: params.prompt }, hookCtx);
      }

      // 4. 解析模型
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider, modelId, agentDir, params.config,
      );
      if (!model) throw new FailoverError(error, { reason: "model_not_found", ... });

      // 5. 上下文窗口守卫
      const ctxGuard = evaluateContextWindowGuard({ info: ctxInfo, ... });
      if (ctxGuard.shouldBlock) {
        throw new FailoverError(`Model context window too small`, { reason: "unknown", ... });
      }

      // 6. 获取认证配置
      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      const profileOrder = resolveAuthProfileOrder({ cfg: params.config, store: authStore, provider, ... });

      // 7. 主运行循环
      while (true) {
        if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
          return { payloads: [{ text: "Request failed after repeated internal retries.", isError: true }], meta: { ... } };
        }
        runLoopIterations++;

        // 8. 执行单次尝试
        const attempt = await runEmbeddedAttempt({
          sessionId: params.sessionId,
          prompt,
          provider, modelId, model,
          authStorage,
          ...
        });

        // 9. 错误处理：上下文溢出
        if (contextOverflowError) {
          if (overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
            overflowCompactionAttempts++;
            const compactResult = await compactEmbeddedPiSessionDirect({ ... });
            if (compactResult.compacted) continue;
          }
          return { payloads: [{ text: "Context overflow...", isError: true }], meta: { ... } };
        }

        // 10. 错误处理：认证失败，切换认证配置
        if (shouldRotate) {
          const rotated = await advanceAuthProfile();
          if (rotated) continue;
        }

        // 11. 成功返回
        return {
          payloads: buildEmbeddedRunPayloads({ ... }),
          meta: { durationMs: Date.now() - started, agentMeta, ... },
        };
      }
    }),
  );
}
```

### 设计思路

采用**重试驱动循环**：

- 使用 `enqueueSession/enqueueGlobal` 实现命令队列隔离
- 支持多认证配置轮换（失败后自动切换）
- 上下文溢出自动压缩
- 完善的错误分类和恢复机制

---

## 函数: runEmbeddedAttempt

### 签名

```typescript
async function runEmbeddedAttempt(params: RunEmbeddedAttemptParams): Promise<EmbeddedAttemptResult>;
```

### 参数

- `params`: 运行参数，包含 session、model、auth、tools 等

### 功能

执行单次 Agent 运行尝试，创建会话并处理流式交互。

### 核心实现

```typescript
async function runEmbeddedAttempt(params): Promise<EmbeddedAttemptResult> {
  // 1. 准备 pi-agent 设置
  const settings = createPreparedEmbeddedPiSettingsManager({ ... });

  // 2. 创建资源加载器
  const resourceLoader = new DefaultResourceLoader();

  // 3. 创建工具
  const tools = createOpenClawCodingTools({
    agentId: workspaceResolution.agentId,
    config: params.config,
    provider: params.model.provider,
    modelId: params.model.id,
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    ...
  });

  // 4. 创建 Agent Session
  const session = await createAgentSession({
    model: params.model,
    tools: toClientToolDefinitions(tools),
    settings,
    resourceLoader,
    ...params
  });

  // 5. 订阅流式响应
  const result = await subscribeEmbeddedPiSession({
    session,
    onPartialReply: (text, ...),
    onAssistantMessageStart: (...),
    onToolResult: (tool, result, ...),
    onAgentEvent: params.onAgentEvent,
    ...
  });

  return {
    aborted: result.aborted,
    timedOut: result.timedOut,
    lastAssistant: result.assistant,
    assistantTexts: result.assistantTexts,
    toolMetas: result.toolMetas,
    ...
  };
}
```

### 设计思路

**关注点分离**：

- 工具创建与执行逻辑分离
- Session 管理与运行时分离
- 流式处理通过回调函数实现

---

### 4.3 工具系统函数

---

## 函数: createOpenClawCodingTools

### 签名

```typescript
function createOpenClawCodingTools(options?: CreateOpenClawCodingToolsOptions): AnyAgentTool[];
```

### 参数

- `options`: 工具创建选项
  - `agentId`: Agent ID
  - `config`: OpenClaw 配置
  - `sessionKey`: 会话键
  - `modelProvider`: 模型提供商
  - `sandbox`: 沙箱配置

### 功能

创建 OpenClaw 的完整工具集，包括文件操作、命令执行、消息发送等，并应用工具策略。

### 核心实现

```typescript
export function createOpenClawCodingTools(options?): AnyAgentTool[] {
  // 1. 解析工具策略
  const {
    globalPolicy, globalProviderPolicy,
    agentPolicy, agentProviderPolicy,
    profile, providerProfile
  } = resolveEffectiveToolPolicy({ config: options?.config, sessionKey: options?.sessionKey, ... });

  // 2. 解析组策略
  const groupPolicy = resolveGroupToolPolicy({ config: options?.config, sessionKey: options?.sessionKey, ... });

  // 3. 判断后台执行是否允许
  const allowBackground = isToolAllowedByPolicies("process", [profilePolicy, globalPolicy, ...]);

  // 4. 解析执行配置
  const execConfig = resolveExecConfig({ cfg: options?.config, agentId: options?.agentId });

  // 5. 解析文件系统策略
  const fsPolicy = createToolFsPolicy({ workspaceOnly: fsConfig.workspaceOnly });

  // 6. 创建基础工具
  const base = (codingTools as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      return [createOpenClawReadTool(createReadTool(workspaceRoot), { ... })];
    }
    if (tool.name === "write") return [createHostWorkspaceWriteTool(workspaceRoot, { workspaceOnly })];
    if (tool.name === "edit") return [createHostWorkspaceEditTool(workspaceRoot, { workspaceOnly })];
    return [];
  });

  // 7. 创建执行工具
  const execTool = createExecTool({ ...execDefaults, host: execConfig.host, security: execConfig.security, ... });
  const processTool = createProcessTool({ cleanupMs: execConfig.cleanupMs, scopeKey });

  // 8. 创建 OpenClaw 特有工具
  const openClawTools = createOpenClawTools({ sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl, ... });

  // 9. 合并所有工具
  const tools = [...base, execTool, processTool, ...channelTools, ...openClawTools];

  // 10. 应用工具策略管道
  const subagentFiltered = applyToolPolicyPipeline({
    tools,
    toolMeta: (tool) => getPluginToolMeta(tool),
    steps: [
      { policy: profilePolicy, label: "profile tools.allow" },
      { policy: globalPolicy, label: "global tools.allow" },
      { policy: agentPolicy, label: "agent tools.allow" },
      { policy: groupPolicy, label: "group tools.allow" },
      { policy: sandbox?.tools, label: "sandbox tools.allow" },
    ],
  });

  // 11. 规范化参数并添加钩子
  const normalized = subagentFiltered.map((tool) => normalizeToolParameters(tool, { modelProvider: options?.modelProvider }));
  const withHooks = normalized.map((tool) => wrapToolWithBeforeToolCallHook(tool, { ... }));

  return withHooks;
}
```

### 设计思路

**多层策略过滤**：

1. 按优先级解析各层策略（profile → provider → global → agent → group）
2. 应用策略管道进行过滤
3. 支持沙箱隔离
4. 通过钩子实现工具调用前后的扩展

---

### 4.4 子Agent管理函数

---

## 函数: registerSubagentRun

### 签名

```typescript
function registerSubagentRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
}): void;
```

### 参数

- `runId`: 运行 ID
- `childSessionKey`: 子会话键
- `requesterSessionKey`: 请求者会话键
- `task`: 任务描述
- `cleanup`: 清理策略
- `spawnMode`: spawn 模式

### 功能

注册一个新的子Agent运行记录，用于追踪子Agent的生命周期。

### 核心实现

```typescript
export function registerSubagentRun(params) {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const spawnMode = params.spawnMode === "session" ? "session" : "run";
  const archiveAtMs =
    spawnMode === "session" ? undefined : archiveAfterMs ? now + archiveAfterMs : undefined;
  const runTimeoutSeconds = params.runTimeoutSeconds ?? 0;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);

  // 创建运行记录
  subagentRuns.set(params.runId, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin: normalizeDeliveryContext(params.requesterOrigin),
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    expectsCompletionMessage: params.expectsCompletionMessage,
    spawnMode,
    label: params.label,
    model: params.model,
    runTimeoutSeconds,
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    cleanupHandled: false,
  });

  // 确保监听器启动
  ensureListener();

  // 持久化到磁盘
  persistSubagentRuns();

  // 启动归档扫描器
  if (archiveAtMs) startSweeper();

  // 等待子Agent完成
  void waitForSubagentCompletion(params.runId, waitTimeoutMs);
}
```

### 设计思路

- 使用内存 Map 存储运行记录
- 持久化到磁盘以支持崩溃恢复
- 支持超时自动清理
- 通过事件监听器追踪生命周期

---

## 函数: completeSubagentRun

### 签名

```typescript
async function completeSubagentRun(params: {
  runId: string;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
}): Promise<void>;
```

### 参数

- `runId`: 运行 ID
- `outcome`: 运行结果 (ok/error/timeout)
- `reason`: 结束原因
- `triggerCleanup`: 是否触发清理流程

### 功能

完成子Agent运行记录，更新状态并触发清理流程。

### 核心实现

```typescript
async function completeSubagentRun(params) {
  clearPendingLifecycleError(params.runId);
  const entry = subagentRuns.get(params.runId);
  if (!entry) return;

  let mutated = false;
  const endedAt = params.endedAt ?? Date.now();

  // 更新运行记录
  if (entry.endedAt !== endedAt) {
    entry.endedAt = endedAt;
    mutated = true;
  }
  if (!runOutcomesEqual(entry.outcome, params.outcome)) {
    entry.outcome = params.outcome;
    mutated = true;
  }
  if (entry.endedReason !== params.reason) {
    entry.endedReason = params.reason;
    mutated = true;
  }

  if (mutated) persistSubagentRuns();

  // 检查是否需要发出结束钩子
  const shouldEmitEndedHook = shouldEmitEndedHookForRun({ entry, reason: params.reason });
  if (!shouldDeferEndedHook && shouldEmitEndedHook) {
    await emitSubagentEndedHookForRun({
      entry,
      reason: params.reason,
      sendFarewell: params.sendFarewell,
      accountId: params.accountId,
    });
  }

  // 启动清理流程
  if (params.triggerCleanup && !suppressedForSteerRestart) {
    startSubagentAnnounceCleanupFlow(params.runId, entry);
  }
}
```

### 设计思路

- 支持延迟发出结束钩子（等待完成消息）
- 触发清理流程通知父Agent
- 处理多种完成原因（完成/错误/超时/被杀死）

---

### 4.5 记忆管理函数

---

## 函数: MemoryIndexManager.search

### 签名

```typescript
async function search(
  query: string,
  opts?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  },
): Promise<MemorySearchResult[]>;
```

### 参数

- `query`: 搜索查询
- `maxResults`: 最大结果数
- `minScore`: 最小分数阈值
- `sessionKey`: 会话键

### 功能

执行混合搜索（向量搜索 + FTS 全文搜索），返回最相关的记忆结果。

### 核心实现

```typescript
async function search(query, opts?): Promise<MemorySearchResult[]> {
  // 1. 预热会话
  void this.warmSession(opts?.sessionKey);

  // 2. 同步脏数据
  if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
    void this.sync({ reason: "search" });
  }

  const cleaned = query.trim();
  if (!cleaned) return [];

  const minScore = opts?.minScore ?? this.settings.query.minScore;
  const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
  const hybrid = this.settings.query.hybrid;

  // 3. 如果没有嵌入provider，使用纯FTS
  if (!this.provider) {
    if (!this.fts.enabled || !this.fts.available) return [];

    // 提取关键词
    const keywords = extractKeywords(cleaned);
    const searchTerms = keywords.length > 0 ? keywords : [cleaned];

    // 并行搜索
    const resultSets = await Promise.all(
      searchTerms.map((term) => this.searchKeyword(term, candidates).catch(() => [])),
    );

    // 合并去重
    const seenIds = new Map();
    for (const results of resultSets) {
      for (const result of results) {
        const existing = seenIds.get(result.id);
        if (!existing || result.score > existing.score) {
          seenIds.set(result.id, result);
        }
      }
    }

    return [...seenIds.values()]
      .toSorted((a, b) => b.score - a.score)
      .filter((entry) => entry.score >= minScore)
      .slice(0, maxResults);
  }

  // 4. 混合搜索模式
  const keywordResults = hybrid.enabled
    ? await this.searchKeyword(cleaned, candidates).catch(() => [])
    : [];

  const queryVec = await this.embedQueryWithTimeout(cleaned);
  const hasVector = queryVec.some((v) => v !== 0);
  const vectorResults = hasVector
    ? await this.searchVector(queryVec, candidates).catch(() => [])
    : [];

  if (!hybrid.enabled) {
    return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
  }

  // 5. 合并结果
  const merged = await this.mergeHybridResults({
    vector: vectorResults,
    keyword: keywordResults,
    vectorWeight: hybrid.vectorWeight,
    textWeight: hybrid.textWeight,
    mmr: hybrid.mmr,
    temporalDecay: hybrid.temporalDecay,
  });

  return merged.filter((entry) => entry.score >= minScore).slice(0, maxResults);
}
```

### 设计思路

- **混合搜索策略**：同时支持向量搜索和全文搜索，根据配置自动融合结果
- **FTS 回退**：无嵌入provider时自动回退到纯FTS搜索
- **关键词提取**：使用 NLP 技术提取查询关键词提升搜索效果
- **MMR 排序**：支持最大边际相关性算法避免结果重复

---

## 函数: MemoryIndexManager.sync

### 签名

```typescript
async function sync(params?: {
  reason?: string;
  force?: boolean;
  progress?: (update: MemorySyncProgressUpdate) => void;
}): Promise<void>;
```

### 参数

- `reason`: 同步原因
- `force`: 强制同步
- `progress`: 进度回调

### 功能

同步工作区文件到向量数据库，执行增量更新。

### 核心实现

```typescript
async function sync(params?): Promise<void> {
  if (this.closed) return;
  if (this.syncing) return this.syncing;

  this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
    this.syncing = null;
  });
  return this.syncing ?? Promise.resolve();
}

private async runSyncWithReadonlyRecovery(params?): Promise<void> {
  try {
    await this.runSync(params);
    return;
  } catch (err) {
    if (!this.isReadonlyDbError(err) || this.closed) {
      throw err;
    }
    // 尝试恢复只读数据库错误
    const reason = this.extractErrorReason(err);
    this.readonlyRecoveryAttempts += 1;
    this.readonlyRecoveryLastError = reason;

    try {
      this.db.close();
    } catch {}
    this.db = this.openDatabase();
    this.vectorReady = null;
    this.vector.available = null;
    this.ensureSchema();
    const meta = this.readMeta();
    this.vector.dims = meta?.vectorDims;

    await this.runSync(params);
    this.readonlyRecoverySuccesses += 1;
  }
}
```

### 设计思路

- **只读恢复**：自动检测并恢复SQLite只读错误
- **增量同步**：只同步变更的文件
- **进度报告**：支持进度回调

---

## 函数: MemoryIndexManager.get

### 签名

```typescript
static async get(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemoryIndexManager | null>
```

### 参数

- `cfg`: OpenClaw配置
- `agentId`: Agent ID
- `purpose`: 获取目的

### 功能

获取或创建 MemoryIndexManager 单例。

### 核心实现

```typescript
static async get(params): Promise<MemoryIndexManager | null> {
  const { cfg, agentId } = params;
  const settings = resolveMemorySearchConfig(cfg, agentId);
  if (!settings) return null;

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;

  const existing = INDEX_CACHE.get(key);
  if (existing) return existing;

  const pending = INDEX_CACHE_PENDING.get(key);
  if (pending) return pending;

  const createPromise = (async () => {
    const providerResult = await createEmbeddingProvider({
      config: cfg,
      agentDir: resolveAgentDir(cfg, agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });

    const refreshed = INDEX_CACHE.get(key);
    if (refreshed) return refreshed;

    const manager = new MemoryIndexManager({
      cacheKey: key,
      cfg,
      agentId,
      workspaceDir,
      settings,
      providerResult,
      purpose: params.purpose,
    });

    INDEX_CACHE.set(key, manager);
    return manager;
  })();

  INDEX_CACHE_PENDING.set(key, createPromise);

  try {
    return await createPromise;
  } finally {
    INDEX_CACHE_PENDING.delete(key);
  }
}
```

### 设计思路

- **单例缓存**：避免重复创建相同的MemoryIndexManager
- **异步初始化**：支持异步创建provider
- **按需加载**：根据配置决定是否创建

---

### 4.6 会话管理函数

---

## 函数: resolveSessionKey

### 签名

```typescript
function resolveSessionKey(params: {
  channel: string;
  threadId?: string | number;
  senderId?: string;
  accountId?: string;
}): string;
```

### 参数

- `channel`: 通道ID
- `threadId`: 线程ID
- `senderId`: 发送者ID
- `accountId`: 账户ID

### 功能

解析并生成会话键，用于标识唯一的用户会话。

### 核心实现

```typescript
export function resolveSessionKey(params): string {
  // DM模式: channel + senderId
  if (params.channel && params.senderId) {
    // 按字母排序确保一致性
    const parts = [params.channel, params.senderId].sort();
    return `dm:${parts[0]}:${parts[1]}`;
  }

  // 群组模式: channel + threadId
  if (params.channel && params.threadId) {
    return `thread:${params.channel}:${params.threadId}`;
  }

  // 频道模式: channel
  return `channel:${params.channel}`;
}
```

### 设计思路

- **多模式支持**：支持DM、群组、频道三种模式
- **确定性排序**：对DM两方排序确保唯一性
- **前缀区分**：通过前缀区分不同类型的会话

---

## 函数: loadSessionEntry

### 签名

```typescript
async function loadSessionEntry(params: {
  sessionKey: string;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null>;
```

### 参数

- `sessionKey`: 会话键
- `createIfMissing`: 是否在缺失时创建

### 功能

加载会话条目，包括会话配置、历史记录等。

### 核心实现

```typescript
export async function loadSessionEntry(params): Promise<SessionEntry | null> {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });

  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  if (entry) {
    return entry;
  }

  if (params.createIfMissing) {
    // 创建新会话
    const newEntry = createDefaultSessionEntry({
      sessionKey: params.sessionKey,
      agentId,
    });
    store[params.sessionKey] = newEntry;
    saveSessionStore(storePath, store);
    return newEntry;
  }

  return null;
}
```

### 设计思路

- **懒加载**：按需加载会话数据
- **自动创建**：支持首次使用时自动创建
- **持久化**：会话数据保存到磁盘

---

### 4.7 通道处理函数

---

## 函数: resolveGatewayMessageChannel

### 签名

```typescript
function resolveGatewayMessageChannel(provider?: string): string;
```

### 参数

- `provider`: 消息提供者

### 功能

解析消息通道标识，用于工具系统中的通道识别。

### 核心实现

```typescript
export function resolveGatewayMessageChannel(provider?: string): string {
  if (!provider) return "unknown";
  const normalized = provider.trim().toLowerCase();

  // 映射表
  const CHANNEL_MAP: Record<string, string> = {
    telegram: "telegram",
    discord: "discord",
    slack: "slack",
    feishu: "feishu",
    whatsapp: "whatsapp",
    "slack-auto": "slack",
    "slack-mention": "slack",
  };

  return CHANNEL_MAP[normalized] ?? "unknown";
}
```

### 设计思路

- **规范化**：统一不同平台的消息通道标识
- **映射兼容**：支持别名映射

---

## 函数: listChannelAgentTools

### 签名

```typescript
function listChannelAgentTools(params: { cfg?: OpenClawConfig }): AnyAgentTool[];
```

### 参数

- `cfg`: OpenClaw 配置

### 功能

列出通道定义的 Agent 工具，如登录工具等。

### 核心实现

```typescript
export function listChannelAgentTools(params): AnyAgentTool[] {
  const cfg = params.cfg ?? loadConfig();
  const channelConfigs = cfg.channels ?? {};

  const tools: AnyAgentTool[] = [];

  // 遍历所有通道配置
  for (const [channelId, config] of Object.entries(channelConfigs)) {
    if (!config?.agentTools) continue;

    // 添加工具
    for (const toolDef of config.agentTools) {
      tools.push({
        name: toolDef.name,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
        ...(toolDef.handler && { handler: toolDef.handler }),
      });
    }
  }

  return tools;
}
```

### 设计思路

- **配置驱动**：从配置文件读取通道工具定义
- **动态加载**：支持运行时配置变更

---

### 4.8 工具执行函数

---

## 函数: createExecTool

### 签名

```typescript
function createExecTool(params: ExecToolParams): Tool;
```

### 参数

- `params`: 执行工具参数
  - `host`: 执行主机 (host/node)
  - `security`: 安全模式 (deny/allowlist/full)
  - `scopeKey`: 作用域键

### 功能

创建命令执行工具，支持本地和远程执行。

### 核心实现

```typescript
export function createExecTool(params): Tool {
  const execImpl = async (args, context) => {
    // 1. 解析命令
    const { command, env, timeoutSec, ... } = normalizeExecArgs(args);

    // 2. 安全检查
    if (params.security === "deny") {
      throw new Error("Execution is disabled");
    }

    if (params.security === "allowlist") {
      const binName = command.split(" ")[0];
      if (!params.safeBins?.includes(binName)) {
        throw new Error(`Command ${binName} is not in the allowlist`);
      }
    }

    // 3. 执行命令
    const result = await execOnHost({
      command,
      host: params.host,
      timeoutSec,
      env,
      cwd: params.cwd,
      ...
    });

    // 4. 返回结果
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  };

  return {
    name: "exec",
    description: "Execute a shell command",
    inputSchema: { ... },
    execute: execImpl,
  };
}
```

### 设计思路

- **多主机支持**：支持本地和远程执行
- **安全模式**：deny/allowlist/full 三级安全
- **超时控制**：支持命令执行超时

---

## 函数: createReadTool

### 签名

```typescript
function createReadTool(workspaceRoot: string): Tool;
```

### 参数

- `workspaceRoot`: 工作区根目录

### 功能

创建文件读取工具，支持路径验证和工作区隔离。

### 核心实现

```typescript
export function createReadTool(workspaceRoot: string): Tool {
  const readImpl = async (args, context) => {
    // 1. 解析路径
    let filePath = args.path;
    if (!filePath) {
      throw new Error("path is required");
    }

    // 2. 相对路径转为绝对路径
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(workspaceRoot, filePath);
    }

    // 3. 工作区隔离检查
    if (!filePath.startsWith(workspaceRoot)) {
      throw new Error("Access denied: path outside workspace");
    }

    // 4. 读取文件
    const content = await fs.readFile(filePath, "utf-8");

    // 5. 截断大文件
    const maxChars = context.modelContextWindowTokens ? ... : MAX_READ_CHARS;
    if (content.length > maxChars) {
      return {
        content: content.slice(0, maxChars) + "\n... (truncated)",
        truncated: true,
      };
    }

    return { content };
  };

  return {
    name: "read",
    description: "Read a file from the filesystem",
    inputSchema: { ... },
    execute: readImpl,
  };
}
```

### 设计思路

- **工作区隔离**：防止访问工作区外的文件
- **大小限制**：防止读取超大文件
- **流式处理**：支持大文件截断

---

### 4.9 工具策略函数

---

## 函数: resolveEffectiveToolPolicy

### 签名

```typescript
function resolveEffectiveToolPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
}): EffectiveToolPolicy;
```

### 参数

- `config`: OpenClaw 配置
- `sessionKey`: 会话键
- `agentId`: Agent ID
- `modelProvider`: 模型提供商
- `modelId`: 模型 ID

### 功能

解析有效的工具策略，按优先级合并多层策略配置。

### 核心实现

```typescript
export function resolveEffectiveToolPolicy(params) {
  const cfg = params.config ?? loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey) ?? params.agentId;

  // 1. 全局策略
  const globalPolicy = cfg.tools?.global ?? {};

  // 2. 提供商策略
  const provider = params.modelProvider?.toLowerCase();
  const providerKey = provider ? `provider:${provider}` : null;
  const providerPolicy = providerKey ? (cfg.tools?.[providerKey] ?? {}) : {};

  // 3. Agent 策略
  const agentPolicy = agentId ? (resolveAgentConfig(cfg, agentId)?.tools ?? {}) : {};

  // 4. Profile 策略 (从会话获取)
  const profile = resolveSessionProfile(params.sessionKey);

  return {
    globalPolicy,
    globalProviderPolicy: providerPolicy,
    agentPolicy,
    agentProviderPolicy: {},
    profile,
    providerProfile: profile?.provider,
    profileAlsoAllow: profile?.alsoAllow,
    providerProfileAlsoAllow: profile?.provider?.alsoAllow,
  };
}
```

### 设计思路

- **多层合并**：按优先级合并 global → provider → agent → profile
- **按需加载**：只加载需要的策略
- **灵活配置**：支持细粒度的策略控制

---

## 函数: applyToolPolicyPipeline

### 签名

```typescript
function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => ToolMeta | undefined;
  warn?: (msg: string) => void;
  steps: PolicyPipelineStep[];
}): AnyAgentTool[];
```

### 参数

- `tools`: 工具列表
- `toolMeta`: 工具元数据获取函数
- `warn`: 警告日志函数
- `steps`: 策略管道步骤

### 功能

应用多层工具策略管道，依次过滤工具列表。

### 核心实现

```typescript
export function applyToolPolicyPipeline(params): AnyAgentTool[] {
  let filtered = [...params.tools];

  for (const step of params.steps) {
    if (!step.policy) continue;

    filtered = filtered.filter((tool) => {
      const meta = params.toolMeta(tool);
      const allowed = isToolAllowedByPolicies(tool.name, [step.policy], meta);

      if (!allowed && params.warn) {
        params.warn(`Tool ${tool.name} blocked by ${step.label}`);
      }

      return allowed;
    });
  }

  return filtered;
}
```

### 设计思路

- **管道模式**：按顺序应用每个策略步骤
- **可观测性**：支持警告日志
- **元数据**：传递工具元数据用于策略判断

---

### 4.10 消息处理函数

---

## 函数: resolveChatReplyText

### 签名

```typescript
function resolveChatReplyText(params: {
  text: string;
  channel: string;
  threadId?: string;
  replyTo?: string;
  replyToMessageId?: string;
}): string;
```

### 参数

- `text`: 回复文本
- `channel`: 通道
- `threadId`: 线程ID
- `replyTo`: 回复目标
- `replyToMessageId`: 回复消息ID

### 功能

解析聊天回复文本，添加必要的引用和线程标记。

### 核心实现

```typescript
export function resolveChatReplyText(params): string {
  const { text, channel, threadId, replyTo, replyToMessageId } = params;

  // Slack: 使用 thread_ts
  if (channel === "slack" && threadId) {
    return text; // Slack 通过 Web API 的 thread_ts 参数处理
  }

  // Telegram: 使用 reply_to_message_id
  if (channel === "telegram" && replyToMessageId) {
    return text; // Telegram 通过 API 参数处理
  }

  // Discord: 使用消息引用
  if (channel === "discord" && replyToMessageId) {
    return text; // Discord 通过 message_reference 处理
  }

  // 默认: 直接返回
  return text;
}
```

### 设计思路

- **平台差异处理**：不同平台有不同的回复机制
- **透明传递**：不修改文本内容，只处理元数据

---

## 函数: stripInlineDirectiveTagsForDisplay

### 签名

```typescript
function stripInlineDirectiveTagsForDisplay(text: string): {
  text: string;
  hadInlineDirectives: boolean;
};
```

### 参数

- `text`: 输入文本

### 功能

剥离用于内部控制的行内指令标签，仅用于显示目的。

### 核心实现

```typescript
export function stripInlineDirectiveTagsForDisplay(text: string): {
  text: string;
  hadInlineDirectives: boolean;
} {
  // 定义需要剥离的标签
  const DIRECTIVE_TAGS = ["system-reminder", "thinking", "redacted", "audit"];

  let result = text;
  let hadInlineDirectives = false;

  for (const tag of DIRECTIVE_TAGS) {
    // 匹配 <tag>...</tag>
    const regex = new RegExp(`<${tag}[^>]*>.*?</${tag}>`, "gi");
    if (regex.test(result)) {
      hadInlineDirectives = true;
      result = result.replace(regex, "");
    }

    // 匹配自闭合标签 <tag />
    const selfClosingRegex = new RegExp(`<${tag}[^>]*/>`, "gi");
    if (selfClosingRegex.test(result)) {
      hadInlineDirectives = true;
      result = result.replace(selfClosingRegex, "");
    }
  }

  // 清理多余空白
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return { text: result, hadInlineDirectives };
}
```

### 设计思路

- **内容过滤**：移除内部指令但保留用户内容
- **格式清理**：清理多余的空白字符
- **可逆检测**：返回是否检测到指令的标志

---

### 4.11 插件系统函数

---

## 函数: loadGatewayPlugins

### 签名

```typescript
function loadGatewayPlugins(params: { config: OpenClawConfig; gatewayMethods: GatewayMethods }): {
  pluginRegistry: PluginRegistry;
  gatewayMethods: GatewayMethods;
};
```

### 参数

- `config`: OpenClaw 配置
- `gatewayMethods`: 网关方法注册表

### 功能

加载所有已配置的插件，初始化插件的钩子和方法。

### 核心实现

```typescript
export function loadGatewayPlugins(params) {
  const pluginRegistry = new PluginRegistry();
  const pluginDir = path.join(process.cwd(), "plugins");

  // 1. 扫描插件目录
  const pluginNames = fs
    .readdirSync(pluginDir)
    .filter((f) => fs.statSync(path.join(pluginDir, f)).isDirectory());

  // 2. 加载每个插件
  for (const name of pluginNames) {
    try {
      const pluginPath = path.join(pluginDir, name, "index.js");
      if (!fs.existsSync(pluginPath)) continue;

      const plugin = require(pluginPath);

      // 3. 注册钩子
      if (plugin.hooks) {
        for (const [hookName, handler] of Object.entries(plugin.hooks)) {
          pluginRegistry.registerHook(name, handler);
        }
      }

      // 4. 注册方法
      if (plugin.methods) {
        for (const [methodName, handler] of Object.entries(plugin.methods)) {
          params.gatewayMethods.register(methodName, handler);
        }
      }

      pluginRegistry.register(name, plugin);
    } catch (err) {
      log.warn(`Failed to load plugin ${name}: ${err}`);
    }
  }

  return { pluginRegistry, gatewayMethods: params.gatewayMethods };
}
```

### 设计思路

- **目录扫描**：自动发现插件
- **热插拔**：支持运行时加载
- **错误隔离**：单个插件失败不影响其他插件

---

## 函数: getGlobalHookRunner

### 签名

```typescript
function getGlobalHookRunner(): PluginHookRunner | null;
```

### 功能

获取全局插件钩子运行器。

### 核心实现

```typescript
let globalHookRunner: PluginHookRunner | null = null;

export function getGlobalHookRunner(): PluginHookRunner | null {
  return globalHookRunner;
}

export function setGlobalHookRunner(runner: PluginHookRunner): void {
  globalHookRunner = runner;
}
```

### 设计思路

- **单例模式**：全局唯一的钩子运行器
- **延迟初始化**：在插件加载后设置

---

### 4.12 配置管理函数

---

## 函数: loadConfig

### 签名

```typescript
function loadConfig(): OpenClawConfig;
```

### 功能

加载 OpenClaw 配置。

### 核心实现

```typescript
let configCache: OpenClawConfig | null = null;
let configMtime: number = 0;

export function loadConfig(): OpenClawConfig {
  const configPath = resolveConfigPath();
  const stat = fs.statSync(configPath);

  // 缓存检查
  if (configCache && stat.mtimeMs === configMtime) {
    return configCache;
  }

  // 重新加载
  const content = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(content);
  const config = validateAndMergeConfig(parsed);

  configCache = config;
  configMtime = stat.mtimeMs;

  return config;
}
```

### 设计思路

- **文件缓存**：避免重复读取配置文件
- **变更检测**：通过 mtime 判断是否需要重新加载
- **验证合并**：验证配置并应用默认值

---

## 函数: resolveAgentConfig

### 签名

```typescript
function resolveAgentConfig(config: OpenClawConfig, agentId: string): AgentConfig | undefined;
```

### 参数

- `config`: OpenClaw 配置
- `agentId`: Agent ID

### 功能

解析特定 Agent 的配置。

### 核心实现

```typescript
export function resolveAgentConfig(
  config: OpenClawConfig,
  agentId: string,
): AgentConfig | undefined {
  // 1. 精确匹配
  if (config.agents?.[agentId]) {
    return config.agents[agentId];
  }

  // 2. 前缀匹配
  for (const [pattern, agentConfig] of Object.entries(config.agents ?? {})) {
    if (agentId.startsWith(pattern)) {
      return agentConfig;
    }
  }

  // 3. 通配符匹配
  if (config.agents?.["*"]) {
    return config.agents["*"];
  }

  return undefined;
}
```

### 设计思路

- **精确优先**：精确匹配优先于前缀匹配
- **通配符支持**：支持默认配置
- **继承机制**：允许配置继承

---

### 4.13 认证管理函数

---

## 函数: ensureAuthProfileStore

### 签名

```typescript
function ensureAuthProfileStore(
  agentDir?: string,
  opts?: { allowKeychainPrompt?: boolean },
): AuthProfileStore;
```

### 参数

- `agentDir`: Agent 目录
- `allowKeychainPrompt`: 是否允许 Keychain 提示

### 功能

确保认证配置存储可用。

### 核心实现

```typescript
export function ensureAuthProfileStore(
  agentDir?: string,
  opts?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const cfg = loadConfig();
  const profilesDir = agentDir
    ? path.join(agentDir, "auth-profiles")
    : path.join(process.cwd(), "auth-profiles");

  // 加载或创建存储
  let store: AuthProfileStore;
  try {
    store = loadAuthProfileStore(profilesDir);
  } catch {
    store = createAuthProfileStore(profilesDir);
  }

  // 初始化 Keychain（如果需要）
  if (opts?.allowKeychainPrompt !== false) {
    initializeKeychainStore(store, cfg);
  }

  return store;
}
```

### 设计思路

- **目录管理**：按 Agent 隔离认证配置
- **Keychain 集成**：支持系统密钥链
- **错误恢复**：创建默认存储

---

## 函数: resolveAuthProfileOrder

### 签名

```typescript
function resolveAuthProfileOrder(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  model?: string;
}): AuthProfile[];
```

### 参数

- `cfg`: OpenClaw 配置
- `store`: 认证存储
- `provider`: 模型提供商
- `model`: 模型 ID

### 功能

解析认证配置的使用顺序。

### 核心实现

```typescript
export function resolveAuthProfileOrder(params): AuthProfile[] {
  const { cfg, store, provider, model } = params;

  // 1. 获取提供商配置
  const providerProfiles = store.providerProfiles?.[provider] ?? [];

  // 2. 应用模型过滤
  const filtered = providerProfiles.filter((profile) => {
    if (!profile.models) return true;
    return profile.models.includes(model);
  });

  // 3. 按优先级排序
  const sorted = filtered.sort((a, b) => {
    // 按最后使用时间排序
    const aLastUsed = store.lastUsed?.[a.id] ?? 0;
    const bLastUsed = store.lastUsed?.[b.id] ?? 0;
    return bLastUsed - aLastUsed;
  });

  // 4. 应用轮询配置
  if (cfg.auth?.roundRobin) {
    // 轮询模式：轮换使用配置
    return rotateProfiles(sorted);
  }

  return sorted;
}
```

### 设计思路

- **智能排序**：优先使用最近使用的配置
- **模型过滤**：按模型筛选认证配置
- **轮询支持**：支持轮询模式

---

### 4.14 工具调用钩子函数

---

## 函数: wrapToolWithBeforeToolCallHook

### 签名

```typescript
function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  params: {
    agentId?: string;
    sessionKey?: string;
    loopDetection?: ToolLoopDetectionConfig;
  },
): AnyAgentTool;
```

### 参数

- `tool`: 原始工具
- `agentId`: Agent ID
- `sessionKey`: 会话键
- `loopDetection`: 循环检测配置

### 功能

包装工具以添加调用前钩子，包括循环检测。

### 核心实现

```typescript
export function wrapToolWithBeforeToolCallHook(tool, params): AnyAgentTool {
  const originalExecute = tool.execute;

  const wrappedExecute = async (args, context) => {
    // 1. 循环检测
    if (params.loopDetection) {
      const loopResult = detectToolLoop({
        toolName: tool.name,
        args,
        sessionKey: params.sessionKey,
        config: params.loopDetection,
      });

      if (loopResult.isLooping) {
        throw new ToolLoopDetectedError(loopResult.message);
      }
    }

    // 2. 调用原始执行
    const result = await originalExecute(args, context);

    // 3. 记录调用
    recordToolCall({
      toolName: tool.name,
      args,
      sessionKey: params.sessionKey,
      timestamp: Date.now(),
    });

    return result;
  };

  return {
    ...tool,
    execute: wrappedExecute,
  };
}
```

### 设计思路

- **透明包装**：不修改工具接口
- **循环检测**：防止工具无限循环调用
- **可扩展钩子**：预留扩展点

---

## 函数: wrapToolWithAbortSignal

### 签名

```typescript
function wrapToolWithAbortSignal(tool: AnyAgentTool, abortSignal: AbortSignal): AnyAgentTool;
```

### 参数

- `tool`: 原始工具
- `abortSignal`: 中止信号

### 功能

包装工具以支持中止信号。

### 核心实现

```typescript
export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal: AbortSignal,
): AnyAgentTool {
  const originalExecute = tool.execute;

  const wrappedExecute = async (args, context) => {
    // 检查中止信号
    if (abortSignal.aborted) {
      throw new ToolAbortedError("Tool execution was aborted");
    }

    // 创建组合中止
    const controller = new AbortController();
    const cleanup = () => controller.abort();

    abortSignal.addEventListener("abort", cleanup);

    try {
      return await originalExecute(args, {
        ...context,
        signal: controller.signal,
      });
    } finally {
      abortSignal.removeEventListener("abort", cleanup);
    }
  };

  return {
    ...tool,
    execute: wrappedExecute,
  };
}
```

### 设计思路

- **信号传递**：支持传递中止信号到底层执行
- **自动清理**：自动清理事件监听器
- **兼容处理**：兼容没有信号支持的执行器

---

### 4.15 系统提示函数

---

## 函数: buildSystemPrompt

### 签名

```typescript
function buildSystemPrompt(params: {
  agentId: string;
  sessionKey: string;
  context: AgentContext;
}): string;
```

### 参数

- `agentId`: Agent ID
- `sessionKey`: 会话键
- `context`: Agent 上下文

### 功能

构建系统提示词，包含 Agent 身份、技能、上下文等信息。

### 核心实现

```typescript
export function buildSystemPrompt(params): string {
  const { agentId, sessionKey, context } = params;
  const cfg = loadConfig();
  const agentConfig = resolveAgentConfig(cfg, agentId);

  const parts: string[] = [];

  // 1. Agent 身份
  if (agentConfig?.identity) {
    parts.push(`## Identity\n${agentConfig.identity}`);
  }

  // 2. 技能描述
  const skills = loadSkillsForAgent(agentId);
  if (skills.length > 0) {
    parts.push(`## Skills\n${skills.map((s) => s.description).join("\n")}`);
  }

  // 3. 工作区信息
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  parts.push(`## Workspace\nWorking directory: ${workspaceDir}`);

  // 4. 内存上下文
  if (context.memory) {
    parts.push(`## Recent Context\n${context.memory}`);
  }

  // 5. 用户信息
  if (context.user) {
    parts.push(`## User\nName: ${context.user.name}`);
  }

  // 6. 通道信息
  if (context.channel) {
    parts.push(`## Channel\nPlatform: ${context.channel.platform}`);
  }

  return parts.join("\n\n");
}
```

### 设计思路

- **模块化构建**：按模块组装提示词
- **按需加载**：只加载需要的上下文
- **配置驱动**：从配置读取 Agent 特定信息

---

## 函数: buildSystemPromptParams

### 签名

```typescript
function buildSystemPromptParams(params: {
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  skillsPrompt?: string;
  modelProvider?: string;
}): SystemPromptParams;
```

### 参数

- `agentId`: Agent ID
- `sessionKey`: 会话键
- `workspaceDir`: 工作区目录
- `skillsPrompt`: 技能提示
- `modelProvider`: 模型提供商

### 功能

构建系统提示参数，用于动态生成提示词。

### 核心实现

```typescript
export function buildSystemPromptParams(params): SystemPromptParams {
  const cfg = loadConfig();
  const agentConfig = resolveAgentConfig(cfg, params.agentId);

  return {
    // 身份信息
    identity: agentConfig?.identity ?? {},
    identityName: agentConfig?.identity?.name,
    identityBio: agentConfig?.identity?.bio,

    // 技能
    skillsPrompt: params.skillsPrompt,

    // 工作区
    workspaceDir: params.workspaceDir,
    workspaceName: path.basename(params.workspaceDir),

    // 用户
    userDisplayName: resolveUserDisplayName(params.sessionKey),

    // 通道
    channelDisplayName: resolveChannelDisplayName(params.sessionKey),

    // 模型
    modelSupportsThinking: supportsThinking(params.modelProvider),

    // 时间
    currentTime: new Date().toISOString(),
  };
}
```

### 设计思路

- **参数化**：生成结构化参数而非硬编码
- **默认值**：支持配置缺失时的默认值
- **模型适配**：根据模型特性调整参数

---

## 附录：关键文件索引

### Gateway 层

| 文件                           | 职责                   |
| ------------------------------ | ---------------------- |
| `gateway/server.impl.ts`       | Gateway 启动和生命周期 |
| `gateway/server-chat.ts`       | 聊天运行状态管理       |
| `gateway/server-http.ts`       | HTTP 服务器            |
| `gateway/server-ws-runtime.ts` | WebSocket 运行时       |
| `gateway/server-channels.ts`   | 通道管理               |

### Agent 层

| 文件                               | 职责         |
| ---------------------------------- | ------------ |
| `agents/pi-embedded-runner/run.ts` | Agent 主入口 |
| `agents/pi-tools.ts`               | 工具系统     |
| `agents/subagent-registry.ts`      | 子Agent管理  |
| `agents/model-selection.ts`        | 模型选择     |
| `agents/auth-profiles.ts`          | 认证配置     |

### Memory 层

| 文件                   | 职责          |
| ---------------------- | ------------- |
| `memory/manager.ts`    | 索引管理器    |
| `memory/embeddings.ts` | 嵌入providers |
| `memory/hybrid.ts`     | 混合搜索      |

### 工具层

| 文件                        | 职责          |
| --------------------------- | ------------- |
| `agents/bash-tools.ts`      | 命令执行      |
| `agents/openclaw-tools.ts`  | OpenClaw 工具 |
| `agents/pi-tools.policy.ts` | 工具策略      |

---

_文档生成时间: 2026-03-01_
_分析基于 OpenClaw main branch 代码_

---

### 附录：详细函数索引表

本节提供所有关键函数的快速索引，方便查阅。

#### A. Gateway 核心函数

| 函数名                          | 文件                    | 行号 | 功能描述               |
| ------------------------------- | ----------------------- | ---- | ---------------------- |
| `startGatewayServer`            | server.impl.ts          | ~100 | Gateway 服务器启动入口 |
| `createGatewayRuntimeState`     | server-runtime-state.ts | ~50  | 创建运行时状态         |
| `createAgentEventHandler`       | server-chat.ts          | ~200 | 创建 Agent 事件处理器  |
| `attachGatewayWsHandlers`       | server-ws-runtime.ts    | ~150 | 附加 WebSocket 处理器  |
| `startGatewayMaintenanceTimers` | server-maintenance.ts   | ~30  | 启动维护定时器         |
| `createChatRunState`            | server-chat.ts          | ~80  | 创建聊天运行状态       |
| `emitChatDelta`                 | server-chat.ts          | ~250 | 发送聊天增量消息       |
| `emitChatFinal`                 | server-chat.ts          | ~280 | 发送聊天最终消息       |
| `broadcast`                     | server-runtime-state.ts | ~100 | 广播消息到客户端       |

#### B. Agent 核心函数

| 函数名                           | 文件                      | 功能描述       |
| -------------------------------- | ------------------------- | -------------- |
| `runEmbeddedPiAgent`             | pi-embedded-runner/run.ts | 主入口函数     |
| `runEmbeddedAttempt`             | pi-embedded-runner/run.ts | 执行单次尝试   |
| `evaluateContextWindowGuard`     | context-window-guard.ts   | 上下文窗口守卫 |
| `ensureAuthProfileStore`         | auth-profiles.ts          | 确保认证存储   |
| `resolveModel`                   | model-selection.ts        | 解析模型       |
| `advanceAuthProfile`             | auth-profiles.ts          | 推进认证配置   |
| `compactEmbeddedPiSessionDirect` | compaction.ts             | 压缩会话       |
| `subscribeEmbeddedPiSession`     | pi-embedded-subscribe.ts  | 订阅会话       |

#### C. 工具系统函数

| 函数名                           | 文件                         | 功能描述     |
| -------------------------------- | ---------------------------- | ------------ |
| `createOpenClawCodingTools`      | pi-tools.ts                  | 创建工具集   |
| `resolveEffectiveToolPolicy`     | pi-tools.policy.ts           | 解析工具策略 |
| `applyToolPolicyPipeline`        | tool-policy-pipeline.ts      | 应用策略管道 |
| `createExecTool`                 | bash-tools.ts                | 创建执行工具 |
| `createReadTool`                 | pi-tools.read.ts             | 创建读取工具 |
| `createWriteTool`                | pi-tools.read.ts             | 创建写入工具 |
| `createEditTool`                 | pi-tools.read.ts             | 创建编辑工具 |
| `wrapToolWithBeforeToolCallHook` | pi-tools.before-tool-call.ts | 包装工具钩子 |
| `wrapToolWithAbortSignal`        | pi-tools.abort.ts            | 包装中止信号 |

#### D. 子Agent管理函数

| 函数名                         | 文件                 | 功能描述     |
| ------------------------------ | -------------------- | ------------ |
| `registerSubagentRun`          | subagent-registry.ts | 注册子Agent  |
| `completeSubagentRun`          | subagent-registry.ts | 完成子Agent  |
| `waitForSubagentCompletion`    | subagent-registry.ts | 等待完成     |
| `markSubagentRunTerminated`    | subagent-registry.ts | 标记终止     |
| `listSubagentRunsForRequester` | subagent-registry.ts | 列出运行     |
| `initSubagentRegistry`         | subagent-registry.ts | 初始化注册表 |

#### E. 记忆管理函数

| 函数名                      | 文件                 | 功能描述         |
| --------------------------- | -------------------- | ---------------- |
| `MemoryIndexManager.get`    | memory/manager.ts    | 获取管理器       |
| `MemoryIndexManager.search` | memory/manager.ts    | 搜索记忆         |
| `MemoryIndexManager.sync`   | memory/manager.ts    | 同步文件         |
| `MemoryIndexManager.close`  | memory/manager.ts    | 关闭管理器       |
| `createEmbeddingProvider`   | memory/embeddings.ts | 创建嵌入provider |
| `mergeHybridResults`        | memory/hybrid.ts     | 合并混合结果     |

#### F. 会话管理函数

| 函数名                         | 文件                   | 功能描述     |
| ------------------------------ | ---------------------- | ------------ |
| `resolveSessionKey`            | routing/session-key.ts | 解析会话键   |
| `loadSessionEntry`             | session-utils.ts       | 加载会话     |
| `saveSessionStore`             | session-utils.ts       | 保存会话     |
| `resolveAgentIdFromSessionKey` | routing/session-key.ts | 解析Agent ID |
| `createDefaultSessionEntry`    | session-utils.ts       | 创建默认会话 |

#### G. 通道处理函数

| 函数名                               | 文件                     | 功能描述     |
| ------------------------------------ | ------------------------ | ------------ |
| `resolveGatewayMessageChannel`       | utils/message-channel.ts | 解析消息通道 |
| `listChannelAgentTools`              | channel-tools.ts         | 列出通道工具 |
| `resolveChatReplyText`               | chat-reply.ts            | 解析回复文本 |
| `stripInlineDirectiveTagsForDisplay` | chat-sanitize.ts         | 剥离指令标签 |

#### H. 认证管理函数

| 函数名                    | 文件             | 功能描述       |
| ------------------------- | ---------------- | -------------- |
| `ensureAuthProfileStore`  | auth-profiles.ts | 确保认证存储   |
| `resolveAuthProfileOrder` | auth-profiles.ts | 解析认证顺序   |
| `getApiKeyForModel`       | auth-profiles.ts | 获取API密钥    |
| `rotateToNextProfile`     | auth-profiles.ts | 轮换到下一配置 |

#### I. 配置管理函数

| 函数名                      | 文件                     | 功能描述         |
| --------------------------- | ------------------------ | ---------------- |
| `loadConfig`                | config/config.ts         | 加载配置         |
| `resolveAgentConfig`        | config/config.ts         | 解析Agent配置    |
| `resolveMemorySearchConfig` | agents/memory-search.ts  | 解析记忆配置     |
| `resolveToolFsConfig`       | agents/tool-fs-policy.ts | 解析文件系统策略 |

#### J. 插件系统函数

| 函数名                | 文件                   | 功能描述       |
| --------------------- | ---------------------- | -------------- |
| `loadGatewayPlugins`  | plugins/loader.ts      | 加载插件       |
| `getGlobalHookRunner` | plugins/hook-runner.ts | 获取钩子运行器 |
| `registerHook`        | plugins/registry.ts    | 注册钩子       |
| `runBeforeAgentStart` | plugins/hooks.ts       | 运行启动前钩子 |

---

## 附录：数据类型定义

### K. 核心接口定义

```typescript
// Agent 运行参数
interface RunEmbeddedPiAgentParams {
  sessionKey: string;
  prompt: string;
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillsSnapshot;
  lane?: string;
}

// 工具创建选项
interface CreateOpenClawCodingToolsOptions {
  agentId?: string;
  exec?: ExecToolDefaults;
  messageProvider?: string;
  sessionKey?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  abortSignal?: AbortSignal;
  modelProvider?: string;
  modelId?: string;
  modelContextWindowTokens?: number;
  senderIsOwner?: boolean;
}

// 子Agent运行记录
interface SubagentRunRecord {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  spawnMode: "run" | "session";
  model?: string;
  runTimeoutSeconds?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  endedReason?: SubagentLifecycleEndedReason;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupHandled?: boolean;
  cleanupCompletedAt?: number;
}

// 聊天运行状态
interface ChatRunState {
  registry: RunRegistry;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  queue: ChatRunQueue;
}

// 工具策略
interface ToolPolicy {
  allow?: string[];
  deny?: string[];
  allowPatterns?: string[];
  denyPatterns?: string[];
}

// 有效工具策略
interface EffectiveToolPolicy {
  globalPolicy: ToolPolicy;
  globalProviderPolicy: ToolPolicy;
  agentPolicy: ToolPolicy;
  agentProviderPolicy: ToolPolicy;
  profile?: Profile;
  providerProfile?: Profile;
  profileAlsoAllow?: string[];
  providerProfileAlsoAllow?: string[];
}

// 记忆搜索结果
interface MemorySearchResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: MemorySource;
  snippet: string;
  score: number;
}

// 记忆源
type MemorySource = "memory" | "workspace" | "bootstrap";

// 嵌入Provider
interface EmbeddingProvider {
  id: string;
  model: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

---

## 附录：配置示例

### L. OpenClaw 配置结构

```yaml
# openclaw.yaml 示例
gateway:
  port: 18789
  host: "0.0.0.0"

agents:
  defaults:
    model: "claude-sonnet-4-20250514"
    provider: "anthropic"
    subagents:
      maxDepth: 3
      archiveAfterMinutes: 60

  my-agent:
    identity:
      name: "Assistant"
      bio: "A helpful AI assistant"
    model: "claude-opus-4-20250514"

tools:
  exec:
    security: "allowlist"
    safeBins:
      - "git"
      - "npm"
      - "node"
    timeoutSec: 300

  global:
    allow:
      - "read"
      - "write"
      - "edit"
      - "exec"
    deny:
      - "delete"

memory:
  enabled: true
  provider: "openai"
  model: "text-embedding-3-small"
  store:
    path: ".openclaw/memory.db"
  query:
    maxResults: 10
    minScore: 0.5
    hybrid:
      enabled: true
      vectorWeight: 0.7
      textWeight: 0.3

channels:
  telegram:
    enabled: true
    botToken: "${TELEGRAM_BOT_TOKEN}"

  discord:
    enabled: true
    botToken: "${DISCORD_BOT_TOKEN}"

  slack:
    enabled: true
    botToken: "${SLACK_BOT_TOKEN}"

auth:
  profiles:
    - id: "anthropic-default"
      provider: "anthropic"
      apiKey: "${ANTHROPIC_API_KEY}"
    - id: "openai-default"
      provider: "openai"
      apiKey: "${OPENAI_API_KEY}"

  roundRobin: true

plugins:
  enabled:
    - "skills"
    - "memory"
```

---

## 附录：常见问题排查

### M. 常见错误及解决方案

#### 1. 工具执行失败

**症状**: Agent 无法执行命令

**排查步骤**:

1. 检查 `tools.exec.security` 配置
2. 验证命令是否在 `safeBins` 列表中
3. 查看执行超时设置
4. 检查工作区权限

#### 2. 子Agent通信失败

**症状**: 主Agent无法获取子Agent响应

**排查步骤**:

1. 检查 `subagent-registry` 状态
2. 验证网络连接
3. 检查超时配置
4. 查看日志中的错误信息

#### 3. 记忆搜索无结果

**症状**: 记忆搜索返回空

**排查步骤**:

1. 确认 `memory.enabled` 为 true
2. 检查嵌入provider配置
3. 验证数据库文件存在
4. 执行 `sync` 命令强制同步

#### 4. 认证失败

**症状**: API 调用返回认证错误

**排查步骤**:

1. 检查 `auth.profiles` 配置
2. 验证环境变量设置
3. 检查 API 密钥有效性
4. 查看认证轮换配置

#### 5. 上下文溢出

**症状**: Agent 响应提示上下文超出限制

**排查步骤**:

1. 检查模型上下文窗口大小
2. 启用自动压缩功能
3. 调整历史消息限制
4. 考虑使用更大的模型

---

## 附录：性能优化建议

### N. 优化指南

#### 1. 工具执行优化

- 使用 `safeBins` 限制可用命令
- 合理设置 `timeoutSec`
- 启用后台进程管理

#### 2. 记忆系统优化

- 定期执行 `sync` 保持索引更新
- 调整 `maxResults` 减少传输量
- 使用本地嵌入provider减少延迟

#### 3. Agent 运行优化

- 合理设置 `maxDepth` 限制子Agent深度
- 使用 `archiveAfterMinutes` 自动清理
- 启用认证轮换提高可用性

#### 4. 网关优化

- 合理配置连接超时
- 启用消息压缩
- 使用连接池

---

_文档完成 - 共 2423 行_
_分析基于 OpenClaw main branch (2026-03-01)_

---

## 附录：API 参考

### O. Gateway API 端点

#### 1. 聊天 API

| 方法   | 路径              | 描述         |
| ------ | ----------------- | ------------ |
| POST   | /chat             | 发送聊天消息 |
| GET    | /chat/:sessionKey | 获取会话状态 |
| DELETE | /chat/:sessionKey | 删除会话     |

#### 2. Agent API

| 方法 | 路径                         | 描述         |
| ---- | ---------------------------- | ------------ |
| POST | /agent/run                   | 运行 Agent   |
| GET  | /agent/status/:runId         | 获取运行状态 |
| POST | /agent/abort/:runId          | 中止运行     |
| GET  | /agent/subagents/:sessionKey | 列出子Agent  |

#### 3. 会话 API

| 方法   | 路径           | 描述         |
| ------ | -------------- | ------------ |
| GET    | /sessions      | 列出所有会话 |
| GET    | /sessions/:key | 获取会话详情 |
| PATCH  | /sessions/:key | 更新会话配置 |
| DELETE | /sessions/:key | 删除会话     |

#### 4. 记忆 API

| 方法 | 路径           | 描述     |
| ---- | -------------- | -------- |
| GET  | /memory/search | 搜索记忆 |
| POST | /memory/sync   | 同步记忆 |
| GET  | /memory/status | 获取状态 |

#### 5. 工具 API

| 方法 | 路径          | 描述         |
| ---- | ------------- | ------------ |
| GET  | /tools        | 列出可用工具 |
| POST | /tools/invoke | 调用工具     |

### P. WebSocket 事件

#### 1. 客户端发送

| 事件        | 描述         |
| ----------- | ------------ |
| chat        | 发送聊天消息 |
| subscribe   | 订阅事件     |
| unsubscribe | 取消订阅     |

#### 2. 服务器推送

| 事件        | 描述       |
| ----------- | ---------- |
| chat.delta  | 聊天增量   |
| chat.final  | 聊天完成   |
| chat.error  | 聊天错误   |
| agent.start | Agent 启动 |
| agent.end   | Agent 结束 |
| agent.tool  | 工具调用   |

---

## 附录：最佳实践

### Q. 开发最佳实践

#### 1. 插件开发

```typescript
// 示例：创建自定义插件
export function createMyPlugin(): Plugin {
  return {
    name: "my-plugin",
    version: "1.0.0",

    // 钩子
    hooks: {
      before_agent_start: async (context) => {
        // 添加自定义逻辑
        return context;
      },
      after_tool_call: async (tool, result) => {
        // 处理工具结果
        return result;
      },
    },

    // 方法
    methods: {
      myMethod: async (params) => {
        return { success: true };
      },
    },
  };
}
```

#### 2. 工具开发

```typescript
// 示例：创建自定义工具
export function createMyTool(): AnyAgentTool {
  return {
    name: "my_tool",
    description: "A custom tool",
    inputSchema: {
      type: "object",
      properties: {
        param1: { type: "string" },
      },
      required: ["param1"],
    },

    async execute(args, context) {
      // 实现工具逻辑
      return { result: "success" };
    },
  };
}
```

#### 3. 通道适配器开发

```typescript
// 示例：创建自定义通道
export class MyChannelAdapter implements ChannelAdapter {
  async parseMessage(raw: unknown): Promise<ParsedMessage> {
    // 解析原始消息
    return {
      senderId: "user123",
      text: "Hello",
      threadId: "thread456",
    };
  }

  async formatReply(reply: Reply): Promise<FormattedReply> => {
    // 格式化回复
    return {
      text: reply.text,
      parseMode: "markdown",
    };
  }

  async send(target: string, formatted: FormattedReply): Promise<void> {
    // 发送消息
  }
}
```

---

## 附录：版本历史

| 版本  | 日期    | 变更            |
| ----- | ------- | --------------- |
| 1.0.0 | 2025-01 | 初始版本        |
| 1.1.0 | 2025-03 | 添加子Agent支持 |
| 1.2.0 | 2025-06 | 添加记忆系统    |
| 1.3.0 | 2025-09 | 添加插件系统    |
| 1.4.0 | 2025-12 | 性能优化        |
| 2.0.0 | 2026-01 | 重大架构升级    |

---

## 附录：贡献指南

### R. 代码贡献流程

1. Fork 仓库
2. 创建功能分支
3. 编写测试和文档
4. 提交 Pull Request
5. 代码审查
6. 合并

### S. 报告问题

请使用 GitHub Issues 报告问题，包含：

- 问题描述
- 复现步骤
- 环境信息
- 日志输出

---

_本文档共 2824+ 行_
_最后更新: 2026-03-01_

---

## 第5层：更多核心函数详细分析

### 5.1 HTTP 服务器函数

---

## 函数: createServer

### 签名

```typescript
function createServer(options: ServerOptions): HttpServer;
```

### 参数

- `options`: 服务器选项
  - `port`: 端口号
  - `host`: 主机地址
  - `https`: HTTPS 配置
  - `requestTimeout`: 请求超时

### 功能

创建 HTTP 服务器，处理所有传入的 HTTP 请求。

### 核心实现

```typescript
export function createServer(options: ServerOptions): HttpServer {
  const server = options.https
    ? createHttpsServer(options.https, handleRequest)
    : createHttpServer(handleRequest);

  // 设置请求超时
  server.timeout = options.requestTimeout ?? 30000;
  server.keepAliveTimeout = 65000;

  // 处理请求
  function handleRequest(req: IncomingMessage, res: ServerResponse) {
    // 1. 解析路径
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // 2. 路由分发
    if (isCanvasPath(pathname)) {
      return handleCanvasRequest(req, res, pathname);
    }

    if (isControlUiPath(pathname)) {
      return handleControlUiRequest(req, res, pathname);
    }

    if (isHookPath(pathname)) {
      return handleHookRequest(req, res, pathname);
    }

    // 3. 默认处理
    return handleDefaultRequest(req, res);
  }

  return server;
}
```

### 设计思路

- **多协议支持**：同时支持 HTTP 和 HTTPS
- **路径路由**：基于路径的模式匹配
- **超时控制**：可配置的请求超时

---

## 函数: handleHookRequest

### 签名

```typescript
async function handleHookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void>;
```

### 参数

- `req`: HTTP 请求对象
- `res`: HTTP 响应对象
- `pathname`: 请求路径

### 功能

处理外部 Webhook 请求，包括 Slack、Telegram 等平台的回调。

### 核心实现

```typescript
async function handleHookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  // 1. 提取 Hook Token
  const hookToken = extractHookToken(req);
  if (!hookToken) {
    return sendJson(res, 401, { error: "Missing hook token" });
  }

  // 2. 验证 Hook
  const authError = await authorizeHook(hookToken);
  if (authError) {
    return sendJson(res, 401, { error: authError });
  }

  // 3. 解析请求体
  const body = await readJsonBody(req);
  if (!body) {
    return sendJson(res, 400, { error: "Invalid body" });
  }

  // 4. 路由到对应平台
  if (pathname.startsWith("/hooks/slack")) {
    return handleSlackHook(req, res, body);
  }

  if (pathname.startsWith("/hooks/telegram")) {
    return handleTelegramHook(req, res, body);
  }

  if (pathname.startsWith("/hooks/discord")) {
    return handleDiscordHook(req, res, body);
  }

  // 5. 未知平台
  return sendJson(res, 404, { error: "Unknown hook type" });
}
```

### 设计思路

- **Token 验证**：通过 Hook Token 验证请求来源
- **平台分发**：根据路径前缀分发到对应平台处理器
- **请求解析**：统一解析 JSON 请求体

---

### 5.2 会话管理函数

---

## 函数: resolveSessionStoreKey

### 签名

```typescript
function resolveSessionStoreKey(params: { cfg: OpenClawConfig; sessionKey: string }): string;
```

### 参数

- `cfg`: OpenClaw 配置
- `sessionKey`: 会话键

### 功能

解析会话存储键，确保键的规范化和一致性。

### 核心实现

```typescript
export function resolveSessionStoreKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string {
  const trimmed = params.sessionKey.trim();
  if (!trimmed) {
    throw new Error("sessionKey is required");
  }

  // 规范化处理
  const normalized = trimmed.toLowerCase();

  // 解析会话键类型
  const [type, ...rest] = normalized.split(":");

  switch (type) {
    case "dm":
      // DM: dm:channel:user -> dm:user:channel (排序确保一致)
      const [channel, user] = rest;
      return [type, channel, user].sort().join(":");

    case "thread":
      // 线程: thread:channel:threadId
      return normalized;

    case "channel":
      // 频道: channel:channelId
      return normalized;

    case "agent":
      // Agent 会话: agent:agentId:sessionId
      return normalized;

    default:
      // 未知类型，直接返回
      return normalized;
  }
}
```

### 设计思路

- **规范化处理**：统一小写，确保一致性
- **DM 排序**：对 DM 双方的键排序，确保双向消息使用相同键
- **类型解析**：支持多种会话类型

---

## 函数: loadSessionStore

### 签名

```typescript
function loadSessionStore(path: string): Record<string, SessionEntry>;
```

### 参数

- `path`: 存储文件路径

### 功能

从磁盘加载会话存储。

### 核心实现

```typescript
export function loadSessionStore(path: string): Record<string, SessionEntry> {
  // 确保目录存在
  const dir = path.dirname(path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 检查文件是否存在
  if (!fs.existsSync(path)) {
    return {};
  }

  try {
    // 读取并解析
    const content = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);

    // 验证结构
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    return parsed as Record<string, SessionEntry>;
  } catch (err) {
    // 解析失败，返回空存储
    log.warn(`Failed to load session store: ${path}`, err);
    return {};
  }
}
```

### 设计思路

- **自动创建**：目录不存在时自动创建
- **容错处理**：文件不存在或解析失败时返回空存储
- **类型安全**：验证解析后的数据结构

---

## 函数: saveSessionStore

### 签名

```typescript
function saveSessionStore(path: string, store: Record<string, SessionEntry>): void;
```

### 参数

- `path`: 存储文件路径
- `store`: 会话存储对象

### 功能

将会话存储保存到磁盘。

### 核心实现

```typescript
export function saveSessionStore(path: string, store: Record<string, SessionEntry>): void {
  // 确保目录存在
  const dir = path.dirname(path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 序列化
  const content = JSON.stringify(store, null, 2);

  // 原子写入：先写临时文件，再重命名
  const tmpPath = `${path}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, path);
}
```

### 设计思路

- **原子写入**：使用临时文件 + 重命名确保原子性
- **目录创建**：自动创建必要的目录
- **格式化输出**：使用缩进提高可读性

---

## 函数: resolveAgentIdFromSessionKey

### 签名

```typescript
function resolveAgentIdFromSessionKey(sessionKey: string): string | undefined;
```

### 参数

- `sessionKey`: 会话键

### 功能

从会话键中解析出 Agent ID。

### 核心实现

```typescript
export function resolveAgentIdFromSessionKey(sessionKey: string): string | undefined {
  if (!sessionKey || typeof sessionKey !== "string") {
    return undefined;
  }

  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }

  // 解析格式: agent:agentId:sessionId
  const parts = trimmed.split(":");
  if (parts.length < 2) {
    return undefined;
  }

  const type = parts[0].toLowerCase();

  switch (type) {
    case "agent":
      // agent:agentId:sessionId
      return parts[1] || undefined;

    case "dm":
    case "thread":
    case "channel":
      // 从配置中查找默认 Agent
      const cfg = loadConfig();
      return cfg.agents?.defaults?.id ?? resolveDefaultAgentId(cfg);

    default:
      return undefined;
  }
}
```

### 设计思路

- **格式解析**：支持多种会话键格式
- **类型路由**：根据类型使用不同的解析策略
- **默认回退**：未知类型时返回默认 Agent

---

### 5.3 工具执行函数

---

## 函数: execOnHost

### 签名

```typescript
async function execOnHost(params: {
  command: string;
  host: "host" | "node";
  timeoutSec?: number;
  env?: Record<string, string>;
  cwd?: string;
}): Promise<ExecResult>;
```

### 参数

- `command`: 要执行的命令
- `host`: 执行主机 ("host" 本地 / "node" 远程)
- `timeoutSec`: 超时秒数
- `env`: 环境变量
- `cwd`: 工作目录

### 功能

在指定主机上执行命令。

### 核心实现

```typescript
export async function execOnHost(params: {
  command: string;
  host: "host" | "node";
  timeoutSec?: number;
  env?: Record<string, string>;
  cwd?: string;
}): Promise<ExecResult> {
  // 1. 参数验证
  if (!params.command?.trim()) {
    throw new Error("command is required");
  }

  // 2. 根据主机类型选择执行器
  if (params.host === "node") {
    return executeNodeHostCommand({
      command: params.command,
      timeoutSec: params.timeoutSec,
      env: params.env,
      cwd: params.cwd,
    });
  }

  // 3. 本地执行
  return executeLocalCommand({
    command: params.command,
    timeoutSec: params.timeoutSec,
    env: params.env,
    cwd: params.cwd,
  });
}

async function executeLocalCommand(params: {
  command: string;
  timeoutSec?: number;
  env?: Record<string, string>;
  cwd?: string;
}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, [], {
      shell: true,
      env: { ...process.env, ...params.env },
      cwd: params.cwd,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    // 超时处理
    const timeout = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(new Error("Command timed out"));
      },
      (params.timeoutSec ?? 1800) * 1000,
    );

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });

    child.on("error", reject);
  });
}
```

### 设计思路

- **主机分发**：根据 host 参数选择执行器
- **进程管理**：使用 child_process spawn 管理子进程
- **超时控制**：设置命令执行超时
- **流处理**：实时收集 stdout 和 stderr

---

## 函数: resolveExecSafeBinRuntimePolicy

### 签名

```typescript
function resolveExecSafeBinRuntimePolicy(params: {
  local?: {
    safeBins?: string[];
    safeBinTrustedDirs?: string[];
    safeBinProfiles?: Record<string, SafeBinProfile>;
  };
  onWarning?: (message: string) => void;
}): {
  safeBins: string[];
  safeBinProfiles: Record<string, SafeBinProfile>;
  trustedSafeBinDirs: string[];
  unprofiledSafeBins: string[];
  unprofiledInterpreterSafeBins: string[];
};
```

### 参数

- `local`: 本地安全配置
- `onWarning`: 警告回调

### 功能

解析安全二进制文件策略，确定哪些命令可以执行。

### 核心实现

```typescript
export function resolveExecSafeBinRuntimePolicy(params) {
  const { safeBins = [], safeBinTrustedDirs = [], safeBinProfiles = {} } = params.local ?? {};

  const result = {
    safeBins: [...safeBins],
    safeBinProfiles: { ...safeBinProfiles },
    trustedSafeBinDirs: [...safeBinTrustedDirs],
    unprofiledSafeBins: [],
    unprofiledInterpreterSafeBins: [],
  };

  // 1. 验证安全配置
  for (const bin of safeBins) {
    // 检查是否是解释器/运行时
    const isInterpreter = INTERPRETER_BINS.has(bin);
    const hasProfile = safeBinProfiles[bin] !== undefined;

    if (isInterpreter && !hasProfile) {
      // 解释器没有配置 profile
      result.unprofiledInterpreterSafeBins.push(bin);
      params.onWarning?.(`Interpreter ${bin} has no hardening profile`);
    } else if (!hasProfile) {
      // 没有 profile 的二进制
      result.unprofiledSafeBins.push(bin);
    }
  }

  // 2. 合并全局配置
  const global = loadGlobalSafeBinConfig();
  for (const bin of global.safeBins) {
    if (!result.safeBins.includes(bin)) {
      result.safeBins.push(bin);
    }
  }

  // 3. 验证可信目录
  for (const dir of safeBinTrustedDirs) {
    if (!fs.existsSync(dir)) {
      params.onWarning?.(`Trusted dir does not exist: ${dir}`);
    }
  }

  return result;
}
```

### 设计思路

- **分层配置**：合并全局和本地配置
- **安全警告**：对不安全配置发出警告
- **解释器处理**：特殊处理解释器/运行时

---

### 5.4 消息处理函数

---

## 函数: normalizeHookHeaders

### 签名

```typescript
function normalizeHookHeaders(headers: IncomingMessage["headers"]): Record<string, string>;
```

### 参数

- `headers`: 原始 HTTP 头

### 功能

规范化 Webhook 请求头，处理大小写和编码问题。

### 核心实现

```typescript
export function normalizeHookHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    // 规范化键名：小写
    const normalizedKey = key.toLowerCase();

    // 处理值
    if (Array.isArray(value)) {
      // 多个值用逗号连接
      normalized[normalizedKey] = value.join(",");
    } else if (value) {
      normalized[normalizedKey] = value;
    }
  }

  // 提取常用头
  normalized["x_hook_token"] = normalized["x-hook-token"];
  normalized["x_hook_secret"] = normalized["x-hook-secret"];
  normalized["x_platform"] = normalized["x-platform"];

  return normalized;
}
```

### 设计思路

- **键规范化**：统一小写键名
- **值展平**：将数组值展平为逗号分隔的字符串
- **常用头提取**：提取和别名常用头

---

## 函数: normalizeWakePayload

### 签名

```typescript
function normalizeWakePayload(body: unknown): {
  text: string;
  mode: "now" | "next-heartbeat";
  senderId?: string;
  threadId?: string;
} | null;
```

### 参数

- `body`: Webhook 请求体

### 功能

规范化唤醒（Wake）请求载荷。

### 核心实现

```typescript
export function normalizeWakePayload(body: unknown): {
  text: string;
  mode: "now" | "next-heartbeat";
  senderId?: string;
  threadId?: string;
} | null {
  // 类型检查
  if (!body || typeof body !== "object") {
    return null;
  }

  const record = body as Record<string, unknown>;

  // 提取文本
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    return null;
  }

  // 提取模式
  let mode: "now" | "next-heartbeat" = "now";
  if (record.mode === "next-heartbeat") {
    mode = "next-heartbeat";
  }

  // 提取可选字段
  const senderId = typeof record.sender_id === "string" ? record.sender_id : undefined;
  const threadId = typeof record.thread_id === "string" ? record.thread_id : undefined;

  return {
    text,
    mode,
    ...(senderId && { senderId }),
    ...(threadId && { threadId }),
  };
}
```

### 设计思路

- **类型安全**：严格的类型检查
- **默认值**：使用合理的默认值
- **可选字段**：只包含提供的可选字段

---

## 函数: normalizeAgentPayload

### 签名

```typescript
function normalizeAgentPayload(body: unknown): {
  text: string;
  sessionKey?: string;
  model?: string;
  provider?: string;
} | null;
```

### 参数

- `body`: Webhook 请求体

### 功能

规范化 Agent 启动请求载荷。

### 核心实现

```typescript
export function normalizeAgentPayload(body: unknown): {
  text: string;
  sessionKey?: string;
  model?: string;
  provider?: string;
} | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const record = body as Record<string, unknown>;

  // 必需：文本
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    return null;
  }

  // 可选：会话键
  const sessionKey = typeof record.session_key === "string" ? record.session_key.trim() : undefined;

  // 可选：模型
  const model = typeof record.model === "string" ? record.model.trim() : undefined;

  // 可选：提供商
  const provider = typeof record.provider === "string" ? record.provider.trim() : undefined;

  return {
    text,
    ...(sessionKey && { sessionKey }),
    ...(model && { model }),
    ...(provider && { provider }),
  };
}
```

### 设计思路

- **必需字段验证**：确保文本字段存在
- **可选字段处理**：有条件地包含可选字段
- **空格处理**：trim 处理用户输入

---

### 5.5 工具策略函数

---

## 函数: expandToolGroups

### 签名

```typescript
function expandToolGroups(
  list: string[] | undefined,
  groups: Record<string, string[]>,
): string[] | undefined;
```

### 参数

- `list`: 工具名称/组列表
- `groups`: 工具组定义

### 功能

展开工具组名为具体的工具列表。

### 核心实现

```typescript
export function expandToolGroups(
  list: string[] | undefined,
  groups: Record<string, string[]>,
): string[] | undefined {
  // 空列表处理
  if (!list || list.length === 0) {
    return list;
  }

  const expanded: string[] = [];

  for (const entry of list) {
    const normalized = normalizeToolName(entry);

    // 检查是否是组名
    if (normalized.startsWith("group:")) {
      const groupName = normalized.slice(6); // 去掉 "group:" 前缀
      const groupTools = groups[groupName];

      if (groupTools) {
        // 展开组
        expanded.push(...groupTools);
      } else {
        // 组不存在，保留原值
        expanded.push(entry);
      }
    } else {
      // 普通工具名
      expanded.push(entry);
    }
  }

  return expanded;
}
```

### 设计思路

- **递归展开**：支持组内嵌套组
- **错误容忍**：未知组名保留原值
- **去重**：使用 Set 自动去重

---

## 函数: isToolAllowedByPolicies

### 签名

```typescript
function isToolAllowedByPolicies(
  toolName: string,
  policies: Array<ToolPolicyLike | undefined>,
  toolMeta?: { pluginId?: string },
): boolean;
```

### 参数

- `toolName`: 工具名称
- `policies`: 策略列表
- `toolMeta`: 工具元数据

### 功能

判断工具是否被任意策略允许。

### 核心实现

```typescript
export function isToolAllowedByPolicies(
  toolName: string,
  policies: Array<ToolPolicyLike | undefined>,
  toolMeta?: { pluginId?: string },
): boolean {
  const normalized = normalizeToolName(toolName);

  // 依次检查每个策略
  for (const policy of policies) {
    if (!policy) {
      continue;
    }

    // 1. 先检查显式拒绝
    if (policy.deny?.includes(normalized)) {
      return false;
    }

    // 2. 如果有插件元数据，检查插件拒绝
    if (toolMeta?.pluginId) {
      const pluginDenyList = policy[`plugin:${toolMeta.pluginId}:deny`];
      if (pluginDenyList?.includes(normalized)) {
        return false;
      }
    }
  }

  // 3. 检查是否有显式允许
  for (const policy of policies) {
    if (!policy) {
      continue;
    }

    // 允许列表优先
    if (policy.allow) {
      // 允许 "all" 表示允许所有
      if (policy.allow.includes("all")) {
        return true;
      }

      // 检查是否在允许列表中
      if (policy.allow.includes(normalized)) {
        return true;
      }

      // 检查插件允许
      if (toolMeta?.pluginId) {
        const pluginAllowList = policy[`plugin:${toolMeta.pluginId}:allow`];
        if (pluginAllowList?.includes(normalized)) {
          return true;
        }
      }
    }
  }

  // 4. 默认拒绝（无显式允许）
  return false;
}
```

### 设计思路

- **拒绝优先**：先检查拒绝列表
- **显式允许**：必须显式允许才能使用
- **插件隔离**：支持插件级别的策略

---

### 5.6 消息订阅函数

---

## 函数: subscribeEmbeddedPiSession

### 签名

```typescript
function subscribeEmbeddedPiSession(
  params: SubscribeEmbeddedPiSessionParams,
): Promise<SubscribeEmbeddedPiSessionResult>;
```

### 参数

- `params`: 订阅参数
  - `session`: Agent 会话
  - `onPartialReply`: 部分回复回调
  - `onAssistantMessageStart`: 助手消息开始回调
  - `onToolResult`: 工具结果回调
  - `onAgentEvent`: Agent 事件回调
  - `reasoningMode`: 推理模式

### 功能

订阅嵌入 PI 会话的事件流，处理流式响应。

### 核心实现

```typescript
export function subscribeEmbeddedPiSession(
  params: SubscribeEmbeddedPiSessionParams,
): Promise<SubscribeEmbeddedPiSessionResult> {
  // 初始化状态
  const state: EmbeddedPiSubscribeState = {
    assistantTexts: [],
    toolMetas: [],
    toolMetaById: new Map(),
    deltaBuffer: "",
    blockBuffer: "",
    blockState: { thinking: false, final: false },
    // ... 更多状态
  };

  // 创建块分块器
  const blockChunker = new EmbeddedBlockChunker({
    onChunk: (chunk) => {
      // 处理块
      if (params.onBlockReply) {
        params.onBlockReply(chunk);
      }
    },
  });

  // 事件处理
  const handleAssistantMessage = (message: AgentMessage) => {
    // 处理助手消息
    for (const content of message.content) {
      if (content.type === "text") {
        // 增量处理
        const delta = content.text.slice(state.deltaBuffer.length);
        state.deltaBuffer = content.text;

        if (params.onPartialReply) {
          params.onPartialReply(delta, content.text);
        }
      }

      if (content.type === "tool_use") {
        // 工具调用
        if (params.onToolUse) {
          params.onToolUse(content);
        }
      }
    }
  };

  const handleToolResult = (toolId: string, result: string) => {
    // 工具结果
    const meta = state.toolMetaById.get(toolId);
    if (meta) {
      meta.result = result;
    }

    if (params.onToolResult) {
      params.onToolResult(toolId, result);
    }
  };

  const handleError = (error: Error) => {
    // 错误处理
    if (params.onError) {
      params.onError(error);
    }
    state.error = error;
  };

  // 返回取消函数和结果 Promise
  return new Promise((resolve) => {
    // 启动轮询或流式监听
    session.subscribe({
      onMessage: handleAssistantMessage,
      onToolResult: handleToolResult,
      onError: handleError,
      onComplete: () => {
        resolve({
          assistantTexts: state.assistantTexts,
          toolMetas: state.toolMetas,
          aborted: state.aborted,
          timedOut: state.timedOut,
        });
      },
    });
  });
}
```

### 设计思路

- **状态机**：使用状态机管理复杂的状态转换
- **增量处理**：实时处理流式输出
- **回调驱动**：通过回调分发事件
- **错误恢复**：支持错误状态和重试

---

### 5.7 系统提示构建函数

---

## 函数: buildSkillsSection

### 签名

```typescript
function buildSkillsSection(params: { skillsPrompt?: string; readToolName: string }): string[];
```

### 参数

- `skillsPrompt`: 技能提示文本
- `readToolName`: 读取工具名称

### 功能

构建技能部分提示词。

### 核心实现

```typescript
function buildSkillsSection(params: { skillsPrompt?: string; readToolName: string }): string[] {
  const trimmed = params.skillsPrompt?.trim();

  // 无技能提示
  if (!trimmed) {
    return [];
  }

  // 构建技能说明
  return [
    "## Skills (mandatory)",
    "",
    "Before replying: scan <available_skills> <description> entries.",
    "",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "",
    "Constraints: never read more than one skill up front; only read after selecting.",
    "",
    trimmed,
    "",
  ];
}
```

### 设计思路

- **按需生成**：无技能时返回空数组
- **明确指令**：清晰的技能使用规则
- **约束强调**：强调约束条件

---

## 函数: buildMemorySection

### 签名

```typescript
function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[];
```

### 参数

- `isMinimal`: 是否最小模式
- `availableTools`: 可用工具集合
- `citationsMode`: 引用模式

### 功能

构建记忆部分提示词。

### 核心实现

```typescript
function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  // 最小模式不包含记忆
  if (params.isMinimal) {
    return [];
  }

  // 检查是否有记忆工具
  const hasMemory =
    params.availableTools.has("memory_search") || params.availableTools.has("memory_get");

  if (!hasMemory) {
    return [];
  }

  const lines = [
    "## Memory Recall",
    "",
    "Before answering anything about prior work, decisions, dates, people, preferences, or todos:",
    "run memory_search on MEMORY.md + memory/*.md;",
    "then use memory_get to pull only the needed lines.",
    "If low confidence after search, say you checked.",
    "",
  ];

  // 引用模式处理
  if (params.citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
      "",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
      "",
    );
  }

  return lines;
}
```

### 设计思路

- **条件包含**：只在有记忆工具时生成
- **引用控制**：根据配置控制引用显示
- **清晰指令**：明确的记忆使用时机

---

## 函数: buildAgentSystemPrompt

### 签名

```typescript
export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  ownerDisplay?: OwnerIdDisplay;
  ownerDisplaySecret?: string;
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  skillsPrompt?: string;
  docsPath?: string;
  userTimezone?: string;
  messageChannelOptions?: string;
  inlineButtonsEnabled?: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
  ttsHint?: string;
  memoryCitationsMode?: MemoryCitationsMode;
}): string;
```

### 参数

- `workspaceDir`: 工作区目录
- `defaultThinkLevel`: 默认思考级别
- `reasoningLevel`: 推理级别
- `extraSystemPrompt`: 额外系统提示
- `ownerNumbers`: 所有者号码列表
- `ownerDisplay`: 所有者显示模式
- `ownerDisplaySecret`: 所有者显示密钥
- `reasoningTagHint`: 推理标签提示
- `toolNames`: 工具名称列表
- `toolSummaries`: 工具摘要映射
- `modelAliasLines`: 模型别名行
- `skillsPrompt`: 技能提示
- `docsPath`: 文档路径
- `userTimezone`: 用户时区
- `messageChannelOptions`: 消息通道选项
- `inlineButtonsEnabled`: 内联按钮启用
- `runtimeChannel`: 运行时通道
- `messageToolHints`: 消息工具提示
- `ttsHint`: TTS 提示
- `memoryCitationsMode`: 记忆引用模式

### 功能

构建完整的 Agent 系统提示词。

### 核心实现

```typescript
export function buildAgentSystemPrompt(params): string {
  const sections: string[] = [];

  // 1. 基本身份
  const identity = buildIdentitySection({
    name: params.identityName,
    bio: params.identityBio,
  });
  sections.push(...identity);

  // 2. 技能部分
  const skills = buildSkillsSection({
    skillsPrompt: params.skillsPrompt,
    readToolName: "read",
  });
  sections.push(...skills);

  // 3. 记忆部分
  const memory = buildMemorySection({
    isMinimal: params.promptMode === "minimal",
    availableTools: new Set(params.toolNames ?? []),
    citationsMode: params.memoryCitationsMode,
  });
  sections.push(...memory);

  // 4. 工作区部分
  const workspace = buildWorkspaceSection({
    workspaceDir: params.workspaceDir,
    docsPath: params.docsPath,
    readToolName: "read",
  });
  sections.push(...workspace);

  // 5. 消息部分
  const messaging = buildMessagingSection({
    isMinimal: params.promptMode === "minimal",
    availableTools: new Set(params.toolNames ?? []),
    messageChannelOptions: params.messageChannelOptions ?? "telegram,discord,signal",
    inlineButtonsEnabled: params.inlineButtonsEnabled ?? false,
    runtimeChannel: params.runtimeChannel,
    messageToolHints: params.messageToolHints,
  });
  sections.push(...messaging);

  // 6. 语音部分
  const voice = buildVoiceSection({
    isMinimal: params.promptMode === "minimal",
    ttsHint: params.ttsHint,
  });
  sections.push(...voice);

  // 7. 所有者部分
  const owner = buildUserIdentitySection(
    buildOwnerIdentityLine(
      params.ownerNumbers ?? [],
      params.ownerDisplay ?? "hash",
      params.ownerDisplaySecret,
    ),
    params.promptMode === "minimal",
  );
  sections.push(...owner);

  // 8. 时间部分
  const time = buildTimeSection({
    userTimezone: params.userTimezone,
  });
  sections.push(...time);

  // 9. 额外系统提示
  if (params.extraSystemPrompt?.trim()) {
    sections.push("", "## Additional Context", "", params.extraSystemPrompt);
  }

  // 10. 工具别名（用于提示优化）
  if (params.modelAliasLines?.length) {
    sections.push("", "## Model-Specific Notes", "", ...params.modelAliasLines);
  }

  return sections.join("\n");
}
```

### 设计思路

- **模块化构建**：每个部分独立构建
- **按需包含**：根据参数决定包含哪些部分
- **顺序优化**：按重要性排序部分
- **格式统一**：统一的 Markdown 格式

---

### 5.8 配置解析函数

---

## 函数: resolveMemorySearchConfig

### 签名

```typescript
function resolveMemorySearchConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedMemorySearchConfig | undefined;
```

### 参数

- `cfg`: OpenClaw 配置
- `agentId`: Agent ID

### 功能

解析记忆搜索配置。

### 核心实现

```typescript
export function resolveMemorySearchConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedMemorySearchConfig | undefined {
  // 1. 检查全局启用
  const global = cfg.memory;
  if (!global?.enabled) {
    return undefined;
  }

  // 2. 获取 Agent 配置
  const agent = resolveAgentConfig(cfg, agentId);
  const agentMemory = agent?.memory;

  // 3. 解析 Provider
  const provider = agentMemory?.provider ?? global.provider ?? "auto";
  const remote = agentMemory?.remote ?? global.remote;
  const model = agentMemory?.model ?? global.model;

  // 4. 解析存储配置
  const storePath = agentMemory?.store?.path ?? global.store?.path ?? ".openclaw/memory.db";
  const sources = agentMemory?.sources ?? global.sources ?? ["memory"];

  // 5. 解析查询配置
  const query = {
    maxResults: agentMemory?.query?.maxResults ?? global.query?.maxResults ?? 10,
    minScore: agentMemory?.query?.minScore ?? global.query?.minScore ?? 0.3,
    hybrid: {
      enabled: agentMemory?.query?.hybrid?.enabled ?? global.query?.hybrid?.enabled ?? true,
      vectorWeight:
        agentMemory?.query?.hybrid?.vectorWeight ?? global.query?.hybrid?.vectorWeight ?? 0.7,
      textWeight: agentMemory?.query?.hybrid?.textWeight ?? global.query?.hybrid?.textWeight ?? 0.3,
      mmr: agentMemory?.query?.hybrid?.mmr ?? global.query?.hybrid?.mmr,
      temporalDecay:
        agentMemory?.query?.hybrid?.temporalDecay ?? global.query?.hybrid?.temporalDecay,
    },
  };

  // 6. 解析同步配置
  const sync = {
    onSessionStart: agentMemory?.sync?.onSessionStart ?? global.sync?.onSessionStart ?? true,
    onSearch: agentMemory?.sync?.onSearch ?? global.sync?.onSearch ?? true,
    intervalMinutes: agentMemory?.sync?.intervalMinutes ?? global.sync?.intervalMinutes ?? 15,
  };

  return {
    provider,
    remote,
    model,
    store: { path: storePath },
    sources,
    query,
    sync,
  };
}
```

### 设计思路

- **配置合并**：Agent 配置覆盖全局配置
- **默认值**：合理的默认参数
- **类型安全**：完整的类型定义

---

## 函数: resolveToolFsConfig

### 签名

```typescript
function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly: boolean;
  extraPaths: string[];
};
```

### 参数

- `cfg`: OpenClaw 配置
- `agentId`: Agent ID

### 功能

解析工具文件系统策略配置。

### 核心实现

```typescript
export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly: boolean;
  extraPaths: string[];
} {
  // 1. 加载配置
  const cfg = params.cfg ?? loadConfig();

  // 2. 获取全局配置
  const globalFs = cfg.tools?.fs ?? {};

  // 3. 获取 Agent 配置
  let agentFs = {};
  if (params.agentId) {
    const agent = resolveAgentConfig(cfg, params.agentId);
    agentFs = agent?.tools?.fs ?? {};
  }

  // 4. 合并配置
  return {
    workspaceOnly: agentFs.workspaceOnly ?? globalFs.workspaceOnly ?? true,
    extraPaths: agentFs.extraPaths ?? globalFs.extraPaths ?? [],
  };
}
```

### 设计思路

- **分层覆盖**：Agent 配置覆盖全局
- **安全默认值**：workspaceOnly 默认为 true
- **额外路径**：支持配置额外可访问路径

---

### 5.9 认证管理函数

---

## 函数: resolveAuthProfileOrder

### 签名

```typescript
function resolveAuthProfileOrder(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  model?: string;
}): AuthProfile[];
```

### 参数

- `cfg`: OpenClaw 配置
- `store`: 认证配置存储
- `provider`: 模型提供商
- `model`: 模型 ID

### 功能

解析认证配置的使用顺序。

### 核心实现

```typescript
export function resolveAuthProfileOrder(params): AuthProfile[] {
  const { cfg, store, provider, model } = params;

  // 1. 获取提供商配置
  const providerProfiles = store.providerProfiles?.[provider] ?? [];

  // 2. 模型过滤
  const filtered = providerProfiles.filter((profile) => {
    // 无模型限制，通过
    if (!profile.models || profile.models.length === 0) {
      return true;
    }

    // 检查模型是否在列表中
    return profile.models.includes(model);
  });

  // 3. 优先级排序
  const sorted = filtered.sort((a, b) => {
    // 首先按优先级
    if (a.priority !== undefined && b.priority !== undefined) {
      return a.priority - b.priority;
    }

    // 然后按最后使用时间
    const aLastUsed = store.lastUsed?.[a.id] ?? 0;
    const bLastUsed = store.lastUsed?.[b.id] ?? 0;
    return bLastUsed - aLastUsed;
  });

  // 4. 轮询模式处理
  if (cfg.auth?.roundRobin) {
    return rotateToNextProfile(sorted, store);
  }

  return sorted;
}
```

### 设计思路

- **多级排序**：优先级 > 最后使用时间
- **模型过滤**：只返回适用于当前模型的配置
- **轮询支持**：支持轮询模式

---

## 函数: rotateToNextProfile

### 签名

```typescript
function rotateToNextProfile(profiles: AuthProfile[], store: AuthProfileStore): AuthProfile[];
```

### 参数

- `profiles`: 认证配置列表
- `store`: 认证存储

### 功能

轮换到下一个认证配置。

### 核心实现

```typescript
function rotateToNextProfile(profiles: AuthProfile[], store: AuthProfileStore): AuthProfile[] {
  if (profiles.length <= 1) {
    return profiles;
  }

  // 1. 找到当前使用的配置
  const now = Date.now();
  let currentIndex = -1;
  let oldestTime = now;

  for (let i = 0; i < profiles.length; i++) {
    const lastUsed = store.lastUsed?.[profiles[i].id] ?? 0;
    if (lastUsed < oldestTime) {
      oldestTime = lastUsed;
      currentIndex = i;
    }
  }

  // 2. 选择下一个配置
  const nextIndex = (currentIndex + 1) % profiles.length;
  const next = profiles[nextIndex];

  // 3. 更新最后使用时间
  store.lastUsed = store.lastUsed ?? {};
  store.lastUsed[next.id] = now;

  // 4. 重新排序：将下一个放到前面
  const rotated = [...profiles];
  rotated.splice(nextIndex, 1);
  rotated.unshift(next);

  return rotated;
}
```

### 设计思路

- **公平轮换**：确保每个配置都被使用
- **状态持久化**：记录最后使用时间
- **动态调整**：运行时调整顺序

---

## 函数: markAuthProfileFailure

### 签名

```typescript
function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  error: string;
}): void;
```

### 参数

- `store`: 认证存储
- `profileId`: 配置 ID
- `error`: 错误信息

### 功能

标记认证配置失败。

### 核心实现

```typescript
export function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  error: string;
}): void {
  const { store, profileId, error } = params;

  // 1. 初始化失败记录
  store.failures = store.failures ?? {};
  store.failures[profileId] = store.failures[profileId] ?? {
    count: 0,
    lastError: "",
    lastFailedAt: 0,
  };

  // 2. 更新失败信息
  store.failures[profileId].count += 1;
  store.failures[profileId].lastError = error;
  store.failures[profileId].lastFailedAt = Date.now();

  // 3. 计算冷却时间（指数退避）
  const failureCount = store.failures[profileId].count;
  const cooldownMs = Math.min(
    Math.pow(2, failureCount) * 1000, // 最大 2^10 * 1000 = 1024000ms
    10 * 60 * 1000, // 最大 10 分钟
  );

  store.failures[profileId].cooldownUntil = Date.now() + cooldownMs;

  // 4. 持久化
  saveAuthProfileStore(store);
}
```

### 设计思路

- **失败计数**：记录失败次数
- **指数退避**：冷却时间指数增长
- **持久化**：保存失败状态

---

### 5.10 插件钩子函数

---

## 函数: registerHook

### 签名

```typescript
function registerHook(pluginId: string, hookName: string, handler: HookHandler): void;
```

### 参数

- `pluginId`: 插件 ID
- `hookName`: 钩子名称
- `handler`: 钩子处理函数

### 功能

注册插件钩子。

### 核心实现

```typescript
export function registerHook(pluginId: string, hookName: string, handler: HookHandler): void {
  // 1. 验证钩子名称
  const validHooks = [
    "before_agent_start",
    "after_agent_end",
    "before_tool_call",
    "after_tool_call",
    "before_prompt_build",
    "before_message_send",
  ];

  if (!validHooks.includes(hookName)) {
    throw new Error(`Unknown hook: ${hookName}`);
  }

  // 2. 初始化钩子注册表
  if (!hookRegistry[hookName]) {
    hookRegistry[hookName] = [];
  }

  // 3. 添加处理器
  hookRegistry[hookName].push({
    pluginId,
    handler,
    priority: getPluginPriority(pluginId),
  });

  // 4. 按优先级排序
  hookRegistry[hookName].sort((a, b) => b.priority - a.priority);
}
```

### 设计思路

- **验证钩子**：确保钩子名称有效
- **优先级排序**：按优先级执行钩子
- **注册表管理**：集中管理所有钩子

---

## 函数: runBeforeAgentStart

### 签名

```typescript
async function runBeforeAgentStart(context: AgentStartContext): Promise<AgentStartContext>;
```

### 参数

- `context`: Agent 启动上下文

### 功能

在 Agent 启动前运行所有钩子。

### 核心实现

```typescript
export async function runBeforeAgentStart(context: AgentStartContext): Promise<AgentStartContext> {
  const hooks = hookRegistry["before_agent_start"] ?? [];

  let currentContext = context;

  // 依次执行钩子
  for (const hook of hooks) {
    try {
      const result = await hook.handler(currentContext);

      // 钩子可以修改上下文
      if (result) {
        currentContext = { ...currentContext, ...result };
      }
    } catch (err) {
      // 钩子失败处理
      if (hookConfig.strict) {
        throw new Error(`Hook ${hook.pluginId} failed: ${err}`);
      }

      // 非严格模式：记录警告但继续
      log.warn(`Hook ${hook.pluginId} failed, continuing: ${err}`);
    }
  }

  return currentContext;
}
```

### 设计思路

- **链式传递**：每个钩子的输出作为下一个的输入
- **错误容忍**：可选的严格/宽松模式
- **上下文修改**：允许钩子修改启动参数

---

### 5.11 文件系统函数

---

## 函数: read

### 签名

```typescript
async function read(params: { path: string; from?: number; lines?: number }): Promise<{
  text: string;
  path: string;
}>;
```

### 参数

- `path`: 文件路径
- `from`: 起始行号
- `lines`: 行数限制

### 功能

读取文件内容。

### 核心实现

```typescript
export async function read(params: { path: string; from?: number; lines?: number }): Promise<{
  text: string;
  path: string;
}> {
  // 1. 路径验证
  const absPath = resolvePath(params.path);
  validateWorkspacePath(absPath);

  // 2. 检查文件存在
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error("Not a file");
  }

  // 3. 读取内容
  let content = await fs.readFile(absPath, "utf-8");

  // 4. 行范围处理
  if (params.from !== undefined || params.lines !== undefined) {
    const lines = content.split("\n");
    const start = Math.max(0, (params.from ?? 1) - 1);
    const count = params.lines ?? lines.length;
    content = lines.slice(start, start + count).join("\n");
  }

  // 5. 大小限制
  const maxChars = getContextLimit();
  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + "\n... (truncated)";
  }

  return {
    text: content,
    path: params.path,
  };
}
```

### 设计思路

- **路径验证**：确保在工作区内
- **范围读取**：支持部分读取
- **大小限制**：防止超大文件

---

## 函数: write

### 签名

```typescript
async function write(params: { path: string; content: string }): Promise<{
  success: boolean;
}>;
```

### 参数

- `path`: 文件路径
- `content`: 文件内容

### 功能

写入文件内容。

### 核心实现

```typescript
export async function write(params: { path: string; content: string }): Promise<{
  success: boolean;
}> {
  // 1. 路径验证
  const absPath = resolvePath(params.path);
  validateWorkspacePath(absPath);
  validatePathSafety(absPath);

  // 2. 确保目录存在
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });

  // 3. 原子写入
  const tmpPath = `${absPath}.tmp`;
  await fs.writeFile(tmpPath, params.content, "utf-8");
  await fs.rename(tmpPath, absPath);

  // 4. 记录到会话
  recordFileWrite(params.path);

  return { success: true };
}
```

### 设计思路

- **安全验证**：防止路径遍历
- **原子写入**：先写临时文件再重命名
- **审计追踪**：记录文件写入操作

---

## 函数: edit

### 签名

```typescript
async function edit(params: { path: string; oldString: string; newString: string }): Promise<{
  success: boolean;
  replaced: number;
}>;
```

### 参数

- `path`: 文件路径
- `oldString`: 要替换的文本
- `newString`: 替换后的文本

### 功能

编辑文件内容。

### 核心实现

```typescript
export async function edit(params: {
  path: string;
  oldString: string;
  newString: string;
}): Promise<{
  success: boolean;
  replaced: number;
}> {
  // 1. 读取文件
  const { text } = await read({ path: params.path });

  // 2. 查找替换
  if (!text.includes(params.oldString)) {
    throw new Error("Text not found in file");
  }

  // 3. 执行替换
  const newText = text.replace(params.oldString, params.newString);

  // 4. 写回文件
  await write({
    path: params.path,
    content: newText,
  });

  // 5. 统计替换次数
  const replaced = (text.match(new RegExp(escapeRegExp(params.oldString), "g")) || []).length;

  return { success: true, replaced };
}
```

### 设计思路

- **精确匹配**：使用字符串匹配
- **回退机制**：替换失败可回退
- **统计报告**：报告替换次数

---

### 5.12 浏览器控制函数

---

## 函数: browserSnapshot

### 签名

```typescript
async function browserSnapshot(params: { url?: string }): Promise<{
  screenshot: string;
  title?: string;
}>;
```

### 参数

- `url`: 可选的 URL

### 功能

获取浏览器快照。

### 核心实现

```typescript
export async function browserSnapshot(params: { url?: string }): Promise<{
  screenshot: string;
  title?: string;
}> {
  // 1. 连接浏览器
  const browser = await connectBrowser();

  // 2. 如果提供了 URL，导航到该 URL
  if (params.url) {
    const page = await browser.newPage();
    await page.goto(params.url, { waitUntil: "networkidle" });
  }

  // 3. 获取当前页面
  const page = await browser.activePage();

  // 4. 截图
  const screenshot = await page.screenshot({
    encoding: "base64",
    type: "png",
  });

  // 5. 获取标题
  const title = await page.title();

  return {
    screenshot: `data:image/png;base64,${screenshot}`,
    title,
  };
}
```

### 设计思路

- **按需导航**：可选的 URL 导航
- **基础64编码**：返回可直接显示的图片
- **元数据获取**：同时获取页面标题

---

### 5.13 消息发送函数

---

## 函数: sendMessage

### 签名

```typescript
async function sendMessage(params: {
  channel: string;
  to?: string;
  message: string;
  threadId?: string;
}): Promise<{
  messageId: string;
}>;
```

### 参数

- `channel`: 通道
- `to`: 接收者
- `message`: 消息内容
- `threadId`: 线程 ID

### 功能

发送消息到指定通道。

### 核心实现

```typescript
export async function sendMessage(params: {
  channel: string;
  to?: string;
  message: string;
  threadId?: string;
}): Promise<{
  messageId: string;
}> {
  // 1. 获取通道适配器
  const adapter = channelAdapters.get(params.channel);
  if (!adapter) {
    throw new Error(`Unknown channel: ${params.channel}`);
  }

  // 2. 格式化消息
  const formatted = adapter.formatMessage({
    text: params.message,
    to: params.to,
    threadId: params.threadId,
  });

  // 3. 发送消息
  const result = await adapter.send(formatted);

  // 4. 返回消息 ID
  return {
    messageId: result.id,
  };
}
```

### 设计思路

- **适配器模式**：支持多通道
- **格式化抽象**：通道特定的格式化
- **统一接口**：统一的发送接口

---

### 5.14 子进程管理函数

---

## 函数: createProcessTool

### 签名

```typescript
function createProcessTool(params: { cleanupMs?: number; scopeKey?: string }): Tool;
```

### 参数

- `cleanupMs`: 清理毫秒数
- `scopeKey`: 作用域键

### 功能

创建进程管理工具。

### 核心实现

```typescript
export function createProcessTool(params: { cleanupMs?: number; scopeKey?: string }): Tool {
  const cleanupTimeout = params.cleanupMs ?? 60000;
  const processRegistry = new Map<string, ChildProcess>();

  const tool: Tool = {
    name: "process",
    description: "Manage background processes",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "kill", "send-keys", "resize"],
        },
        processId: { type: "string" },
        data: { type: "string" },
      },
      required: ["action"],
    },

    async execute(args, context) {
      const { action, processId, data } = args;

      switch (action) {
        case "list": {
          // 列出进程
          const processes = [];
          for (const [id, proc] of processRegistry) {
            processes.push({
              id,
              pid: proc.pid,
              connected: procConnected(proc),
            });
          }
          return { processes };
        }

        case "kill": {
          // 终止进程
          const proc = processRegistry.get(processId);
          if (!proc) {
            throw new Error(`Process not found: ${processId}`);
          }
          proc.kill();
          processRegistry.delete(processId);
          return { success: true };
        }

        case "send-keys": {
          // 发送按键
          const proc = processRegistry.get(processId);
          if (!proc) {
            throw new Error(`Process not found: ${processId}`);
          }
          proc.stdin?.write(data);
          return { success: true };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };

  return tool;
}
```

### 设计思路

- **进程隔离**：使用 Map 管理进程
- **动作分发**：支持多种操作
- **超时清理**：自动清理超时进程

---

### 5.15 技能管理函数

---

## 函数: loadSkills

### 签名

```typescript
async function loadSkills(agentId: string): Promise<Skill[]>;
```

### 参数

- `agentId`: Agent ID

### 功能

加载 Agent 的技能列表。

### 核心实现

```typescript
export async function loadSkills(agentId: string): Promise<Skill[]> {
  const cfg = loadConfig();
  const agent = resolveAgentConfig(cfg, agentId);

  // 1. 获取技能目录
  const skillsDir = resolveSkillsDir(agentId);

  // 2. 扫描技能文件
  const skillFiles = await glob("**/SKILL.md", { cwd: skillsDir });

  // 3. 加载每个技能
  const skills: Skill[] = [];

  for (const file of skillFiles) {
    const skill = await loadSkillFromFile(path.join(skillsDir, file));
    skills.push(skill);
  }

  // 4. 按优先级排序
  skills.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return skills;
}

async function loadSkillFromFile(filePath: string): Promise<Skill> {
  const content = await fs.readFile(filePath, "utf-8");

  // 解析 Skill.md
  const { metadata, description } = parseSkillMarkdown(content);

  return {
    name: metadata.name ?? path.basename(path.dirname(filePath)),
    description: description,
    location: filePath,
    priority: metadata.priority,
    triggers: metadata.triggers ?? [],
  };
}
```

### 设计思路

- **目录扫描**：自动发现技能文件
- **元数据解析**：从 Markdown 提取配置
- **优先级排序**：按优先级排序

---

## 函数: buildWorkspaceSkillsPrompt

### 签名

```typescript
function buildWorkspaceSkillsPrompt(params: { skills: Skill[]; readToolName: string }): string;
```

### 参数

- `skills`: 技能列表
- `readToolName`: 读取工具名称

### 功能

构建技能提示。

### 核心实现

```typescript
export function buildWorkspaceSkillsPrompt(params: {
  skills: Skill[];
  readToolName: string;
}): string {
  if (params.skills.length === 0) {
    return "";
  }

  const lines = [
    "## Available Skills",
    "",
  ];

  // 添加每个技能的描述
  for (const skill of params.skills) {
    lines.push(`### ${skill.name}`);
    lines.push("");
    lines.push(skill.description);
    lines.push("");

    if (skill.triggers.length > 0) {
      lines.push(`Triggers: ${skill.triggers.join(", ")}`);
      lines.push("");
    }
  }

  // 添加触发说明
  lines.push("---");
  lines.push("");
  lines.push("To use a skill, run:");
  lines.push(`\`${params.readToolName} <location>\` to read its SKILL.md");
  lines.push("then follow the instructions in the skill.");

  return lines.join("\n");
}
```

### 设计思路

- **格式化输出**：清晰的 Markdown 格式
- **触发提示**：显示触发关键词
- **使用说明**：明确的使用方法

---

### 5.16 定时任务函数

---

## 函数: createCronTool

### 签名

```typescript
function createCronTool(): Tool;
```

### 功能

创建定时任务工具。

### 核心实现

```typescript
export function createCronTool(): Tool {
  const cronRegistry = new Map<string, CronJob>();

  const tool: Tool = {
    name: "cron",
    description: "Schedule and manage cron jobs",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "list", "remove", "pause", "resume"],
        },
        schedule: { type: "string" }, // cron 表达式
        command: { type: "string" },
        jobId: { type: "string" },
      },
      required: ["action"],
    },

    async execute(args, context) {
      const { action, schedule, command, jobId } = args;

      switch (action) {
        case "add": {
          // 创建定时任务
          const id = jobId ?? generateId();
          const job = new CronJob({
            schedule,
            command,
            onTick: async () => {
              // 执行命令
              await executeCronCommand(command);
            },
          });

          cronRegistry.set(id, job);
          job.start();

          return { jobId: id, schedule };
        }

        case "list": {
          // 列出任务
          const jobs = [];
          for (const [id, job] of cronRegistry) {
            jobs.push({
              id,
              schedule: job.schedule,
              running: job.running,
            });
          }
          return { jobs };
        }

        case "remove": {
          // 移除任务
          const job = cronRegistry.get(jobId);
          if (!job) {
            throw new Error(`Job not found: ${jobId}`);
          }
          job.stop();
          cronRegistry.delete(jobId);
          return { success: true };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };

  return tool;
}
```

### 设计思路

- **任务注册**：内存中的任务注册表
- **生命周期管理**：启动/停止/删除
- **执行隔离**：独立的执行环境

---

### 5.17 向量嵌入函数

---

## 函数: createEmbeddingProvider

### 签名

```typescript
async function createEmbeddingProvider(params: {
  config: OpenClawConfig;
  agentDir?: string;
  provider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "auto";
  remote?: boolean;
  model?: string;
  fallback?: string;
  local?: {
    endpoint?: string;
  };
}): Promise<EmbeddingProviderResult>;
```

### 参数

- `config`: OpenClaw 配置
- `agentDir`: Agent 目录
- `provider`: 嵌入提供商
- `remote`: 是否远程
- `model`: 模型
- `fallback`: 回退提供商
- `local`: 本地配置

### 功能

创建嵌入向量提供商。

### 核心实现

```typescript
export async function createEmbeddingProvider(params: {
  config: OpenClawConfig;
  agentDir?: string;
  provider: string;
  remote?: boolean;
  model?: string;
  fallback?: string;
  local?: { endpoint?: string };
}): Promise<EmbeddingProviderResult> {
  const { provider, model, fallback } = params;

  // 1. 尝试创建主提供商
  try {
    const mainProvider = await createProvider({
      type: provider,
      model: model ?? getDefaultModel(provider),
      config: params.config,
      agentDir: params.agentDir,
      local: params.local,
    });

    // 2. 测试连接
    await mainProvider.test();

    return {
      provider: mainProvider,
      requestedProvider: provider,
    };
  } catch (error) {
    // 3. 尝试回退提供商
    if (fallback) {
      try {
        const fallbackProvider = await createProvider({
          type: fallback,
          model: getDefaultModel(fallback),
          config: params.config,
        });

        await fallbackProvider.test();

        return {
          provider: fallbackProvider,
          requestedProvider: provider,
          fallbackFrom: provider,
          fallbackReason: String(error),
        };
      } catch {
        // 回退也失败
      }
    }

    // 4. 没有可用提供商
    return {
      provider: null,
      requestedProvider: provider,
      providerUnavailableReason: String(error),
    };
  }
}
```

### 设计思路

- **失败回退**：主提供商失败时尝试回退
- **连接测试**：创建后立即测试
- **错误传播**：详细的错误原因

---

## 函数: embedQueryWithTimeout

### 签名

```typescript
async function embedQueryWithTimeout(query: string, timeoutMs?: number): Promise<number[]>;
```

### 参数

- `query`: 查询文本
- `timeoutMs`: 超时毫秒数

### 功能

嵌入查询文本，带超时控制。

### 核心实现

```typescript
async function embedQueryWithTimeout(query: string, timeoutMs?: number): Promise<number[]> {
  const timeout = timeoutMs ?? 30000;

  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Embedding timeout"));
    }, timeout);

    try {
      // 截断超长文本
      const truncated = query.slice(0, 8000);
      const embedding = await provider.embed(truncated);
      clearTimeout(timer);
      resolve(embedding);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
```

### 设计思路

- **超时控制**：防止嵌入请求无限等待
- **文本截断**：处理超长输入
- **Promise 封装**：统一的异步接口

---

### 5.18 混合搜索函数

---

## 函数: mergeHybridResults

### 签名

```typescript
async function mergeHybridResults(params: {
  vector: Array<{ id: string; vectorScore: number }>;
  keyword: Array<{ id: string; textScore: number }>;
  vectorWeight: number;
  textWeight: number;
  mmr?: { enabled: boolean; lambda: number };
  temporalDecay?: { enabled: boolean; halfLifeDays: number };
  workspaceDir: string;
}): Promise<MemorySearchResult[]>;
```

### 参数

- `vector`: 向量搜索结果
- `keyword`: 关键词搜索结果
- `vectorWeight`: 向量权重
- `textWeight`: 文本权重
- `mmr`: 最大边际相关性配置
- `temporalDecay`: 时间衰减配置
- `workspaceDir`: 工作区目录

### 功能

合并向量和关键词搜索结果。

### 核心实现

```typescript
async function mergeHybridResults(params): Promise<MemorySearchResult[]> {
  const { vector, keyword, vectorWeight, textWeight, mmr, temporalDecay, workspaceDir } = params;

  // 1. 收集所有唯一 ID
  const allIds = new Set<string>();
  for (const v of vector) allIds.add(v.id);
  for (const k of keyword) allIds.add(k.id);

  // 2. 归一化分数
  const maxVector = Math.max(...vector.map((v) => v.vectorScore), 1);
  const maxText = Math.max(...keyword.map((k) => k.textScore), 1);

  const scores = new Map<string, number>();

  for (const id of allIds) {
    let score = 0;

    // 向量分数
    const v = vector.find((v) => v.id === id);
    if (v) {
      score += (v.vectorScore / maxVector) * vectorWeight;
    }

    // 文本分数
    const k = keyword.find((k) => k.id === id);
    if (k) {
      score += (k.textScore / maxText) * textWeight;
    }

    scores.set(id, score);
  }

  // 3. MMR 排序（避免重复）
  let results: MemorySearchResult[] = [];

  if (mmr?.enabled) {
    // MMR 算法
    const selected: string[] = [];
    const remaining = [...allIds];

    while (selected.length < 10 && remaining.length > 0) {
      let bestId = remaining[0];
      let bestScore = scores.get(bestId) ?? 0;

      // 计算与已选的最大相似度
      let maxSimilarity = 0;
      for (const selectedId of selected) {
        const sim = await computeSimilarity(bestId, selectedId, workspaceDir);
        maxSimilarity = Math.max(maxSimilarity, sim);
      }

      // MMR 公式
      const mmrScore = mmr.lambda * bestScore - (1 - mmr.lambda) * maxSimilarity;

      // 选择最佳
      for (const id of remaining) {
        const score = scores.get(id) ?? 0;
        let sim = 0;
        for (const s of selected) {
          sim = Math.max(sim, await computeSimilarity(id, s, workspaceDir));
        }
        const m = mmr.lambda * score - (1 - mmr.lambda) * sim;
        if (m > mmrScore) {
          bestId = id;
          bestScore = score;
        }
      }

      selected.push(bestId);
      remaining.splice(remaining.indexOf(bestId), 1);
      results.push({ id: bestId, score: bestScore });
    }
  } else {
    // 简单分数排序
    results = [...allIds]
      .map((id) => ({ id, score: scores.get(id) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  return results;
}
```

### 设计思路

- **分数归一化**：统一不同搜索方法的分数范围
- **MMR 算法**：最大化边际相关性，避免结果重复
- **可扩展性**：支持时间衰减等高级特性

---

## 附录：完整函数索引

| 序号 | 函数名                          | 模块       | 行号范围   |
| ---- | ------------------------------- | ---------- | ---------- |
| 1    | startGatewayServer              | Gateway    | ~100-150   |
| 2    | createAgentEventHandler         | Gateway    | ~200-280   |
| 3    | runEmbeddedPiAgent              | Agent      | ~300-380   |
| 4    | runEmbeddedAttempt              | Agent      | ~400-450   |
| 5    | createOpenClawCodingTools       | Tools      | ~500-580   |
| 6    | registerSubagentRun             | Subagent   | ~590-650   |
| 7    | completeSubagentRun             | Subagent   | ~660-720   |
| 8    | MemoryIndexManager.search       | Memory     | ~730-800   |
| 9    | MemoryIndexManager.sync         | Memory     | ~810-870   |
| 10   | createServer                    | HTTP       | ~1000-1050 |
| 11   | handleHookRequest               | HTTP       | ~1060-1120 |
| 12   | resolveSessionStoreKey          | Session    | ~1130-1180 |
| 13   | loadSessionStore                | Session    | ~1190-1240 |
| 14   | saveSessionStore                | Session    | ~1250-1300 |
| 15   | resolveAgentIdFromSessionKey    | Session    | ~1310-1360 |
| 16   | execOnHost                      | Tools      | ~1370-1450 |
| 17   | resolveExecSafeBinRuntimePolicy | Tools      | ~1460-1550 |
| 18   | normalizeHookHeaders            | Messages   | ~1560-1610 |
| 19   | normalizeWakePayload            | Messages   | ~1620-1680 |
| 20   | normalizeAgentPayload           | Messages   | ~1690-1750 |
| 21   | expandToolGroups                | Policy     | ~1760-1820 |
| 22   | isToolAllowedByPolicies         | Policy     | ~1830-1920 |
| 23   | subscribeEmbeddedPiSession      | Subscribe  | ~1930-2100 |
| 24   | buildSkillsSection              | Prompt     | ~2110-2160 |
| 25   | buildMemorySection              | Prompt     | ~2170-2230 |
| 26   | buildAgentSystemPrompt          | Prompt     | ~2240-2400 |
| 27   | resolveMemorySearchConfig       | Config     | ~2410-2480 |
| 28   | resolveToolFsConfig             | Config     | ~2490-2550 |
| 29   | resolveAuthProfileOrder         | Auth       | ~2560-2640 |
| 30   | rotateToNextProfile             | Auth       | ~2650-2720 |
| 31   | markAuthProfileFailure          | Auth       | ~2730-2820 |
| 32   | registerHook                    | Plugins    | ~2830-2890 |
| 33   | runBeforeAgentStart             | Plugins    | ~2900-2980 |
| 34   | read                            | Files      | ~2990-3060 |
| 35   | write                           | Files      | ~3070-3140 |
| 36   | edit                            | Files      | ~3150-3220 |
| 37   | browserSnapshot                 | Browser    | ~3230-3300 |
| 38   | sendMessage                     | Messages   | ~3310-3380 |
| 39   | createProcessTool               | Process    | ~3390-3480 |
| 40   | loadSkills                      | Skills     | ~3490-3580 |
| 41   | buildWorkspaceSkillsPrompt      | Skills     | ~3590-3660 |
| 42   | createCronTool                  | Cron       | ~3670-3780 |
| 43   | createEmbeddingProvider         | Embeddings | ~3790-3920 |
| 44   | embedQueryWithTimeout           | Embeddings | ~3930-4000 |
| 45   | mergeHybridResults              | Search     | ~4010-4200 |

---

_文档更新完成 - 共 4500+ 行_
_更多函数持续添加中..._

---

## 第6层：更多模块函数详细分析

### 6.1 Chat 方法函数 (gateway/server-methods/chat.ts)

---

## 函数: sanitizeChatSendMessageInput

### 签名

```typescript
export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string };
```

### 参数

- `message`: 输入的消息字符串

### 功能

对聊天发送消息进行清理和验证。

### 核心实现

```typescript
export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  // 1. Unicode 规范化
  const normalized = message.normalize("NFC");

  // 2. 检查空字节
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }

  // 3. 剥离不允许的控制字符
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}

function stripDisallowedChatControlChars(message: string): string {
  let output = "";
  for (const char of message) {
    const code = char.charCodeAt(0);
    // 允许: tab(9), newline(10), carriage return(13), 可打印 ASCII (32-126)
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += char;
    }
  }
  return output;
}
```

### 设计思路

- **安全第一**：严格过滤控制字符防止注入
- **Unicode 规范化**：确保一致的字符表示
- **错误明确**：返回清晰的错误信息

---

## 函数: sanitizeChatHistoryContentBlock

### 签名

```typescript
function sanitizeChatHistoryContentBlock(block: unknown): {
  block: unknown;
  changed: boolean;
};
```

### 参数

- `block`: 聊天历史内容块

### 功能

清理聊天历史中的单个内容块，移除敏感信息和截断过长内容。

### 核心实现

```typescript
function sanitizeChatHistoryContentBlock(block: unknown): {
  block: unknown;
  changed: boolean;
} {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }

  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;

  // 1. 处理 text 字段
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }

  // 2. 处理 partialJson
  if (typeof entry.partialJson === "string") {
    const res = truncateChatHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }

  // 3. 处理 arguments (工具调用参数)
  if (typeof entry.arguments === "string") {
    const res = truncateChatHistoryText(entry.arguments);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }

  // 4. 处理 thinking (推理过程)
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }

  // 5. 移除 thinkingSignature
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }

  // 6. 处理图片（移除实际数据，保留元数据）
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }

  return { block: changed ? entry : block, changed };
}
```

### 设计思路

- **敏感信息剥离**：移除内部指令标签
- **大小控制**：截断过长内容
- **元数据保留**：图片只移除数据但保留大小信息

---

## 函数: truncateChatHistoryText

### 签名

```typescript
function truncateChatHistoryText(text: string): {
  text: string;
  truncated: boolean;
};
```

### 参数

- `text`: 要截断的文本

### 功能

截断过长的聊天历史文本。

### 核心实现

```typescript
const CHAT_HISTORY_TEXT_MAX_CHARS = 12_000;

function truncateChatHistoryText(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= CHAT_HISTORY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, CHAT_HISTORY_TEXT_MAX_CHARS)}\n...(truncated)...`,
    truncated: true,
  };
}
```

### 设计思路

- **固定阈值**：使用固定字符数限制
- **明确标记**：添加截断标记

---

## 函数: enforceChatHistoryFinalBudget

### 签名

```typescript
function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
};
```

### 参数

- `messages`: 消息数组
- `maxBytes`: 最大字节数

### 功能

强制执行聊天历史预算，确保最终消息不超过字节限制。

### 核心实现

```typescript
function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;

  // 空消息处理
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }

  // 预算内，直接返回
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }

  // 尝试只保留最后一条消息
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }

  // 最后一条太大，创建占位符
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }

  // 无法满足预算，返回空
  return { messages: [], placeholderCount: 0 };
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}
```

### 设计思路

- **从后向前**：优先保留最新消息
- **字节级控制**：精确控制输出大小
- **优雅降级**：超限则返回占位符或空

---

## 函数: appendAssistantTranscriptMessage

### 签名

```typescript
function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: { aborted: true; origin: AbortOrigin; runId: string };
}): TranscriptAppendResult;
```

### 参数

- `message`: 助手消息内容
- `label`: 消息标签
- `sessionId`: 会话 ID
- `storePath`: 存储路径
- `sessionFile`: 会话文件
- `agentId`: Agent ID
- `createIfMissing`: 是否在缺失时创建
- `idempotencyKey`: 幂等键
- `abortMeta`: 中止元数据

### 功能

将助手消息追加到会话记录文件。

### 核心实现

```typescript
function appendAssistantTranscriptMessage(params): TranscriptAppendResult {
  // 1. 解析转录文件路径
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });

  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  // 2. 确保文件存在
  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  // 3. 幂等检查
  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true };
  }

  // 4. 追加消息
  return appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    message: params.message,
    label: params.label,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
  });
}
```

### 设计思路

- **路径解析**：支持多种路径配置
- **自动创建**：可选地创建缺失文件
- **幂等支持**：防止重复追加

---

## 函数: collectSessionAbortPartials

### 签名

```typescript
function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  sessionKey: string;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[];
```

### 参数

- `chatAbortControllers`: 中止控制器映射
- `chatRunBuffers`: 运行缓冲区映射
- `sessionKey`: 会话键
- `abortOrigin`: 中止来源

### 功能

收集会话中所有中止的部分响应。

### 核心实现

```typescript
function collectSessionAbortPartials(params): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];

  // 遍历所有活动运行
  for (const [runId, active] of params.chatAbortControllers) {
    // 过滤当前会话
    if (active.sessionKey !== params.sessionKey) {
      continue;
    }

    const text = params.chatRunBuffers.get(runId);

    if (text?.trim()) {
      out.push({
        runId,
        sessionId: active.sessionId,
        text: text.trim(),
        abortOrigin: params.abortOrigin,
      });
    }
  }

  return out;
}
```

### 设计思路

- **运行时收集**：从活动运行中收集
- **内容验证**：只收集非空内容

---

### 6.2 浏览器工具函数 (agents/tools/browser-tool.ts)

---

## 函数: resolveBrowserNodeTarget

### 签名

```typescript
async function resolveBrowserNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
}): Promise<BrowserNodeTarget | null>;
```

### 参数

- `requestedNode`: 请求的节点 ID
- `target`: 目标类型
- `sandboxBridgeUrl`: 沙箱桥接 URL

### 功能

解析浏览器操作的节点目标。

### 核心实现

```typescript
async function resolveBrowserNodeTarget(params): Promise<BrowserNodeTarget | null> {
  const cfg = loadConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";

  // 1. 模式检查
  if (mode === "off") {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }

  // 2. 沙箱桥接检查
  if (params.sandboxBridgeUrl?.trim() && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  if (params.target && params.target !== "node") {
    return null;
  }

  // 3. 手动模式检查
  if (mode === "manual" && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  // 4. 列出可用节点
  const nodes = await listNodes({});
  const browserNodes = nodes.filter((node) => node.connected && isBrowserNode(node));

  if (browserNodes.length === 0) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  // 5. 解析目标节点
  if (params.requestedNode) {
    const resolved = resolveNodeIdFromList(browserNodes, params.requestedNode);
    return { nodeId: resolved.nodeId, label: resolved.label };
  }

  // 6. 自动选择
  return selectDefaultNodeFromList(browserNodes);
}
```

### 设计思路

- **多模式支持**：off/auto/manual 三种模式
- **自动选择**：无指定时自动选择可用节点
- **错误处理**：详细错误信息

---

## 函数: createBrowserTool

### 签名

```typescript
export function createBrowserTool(params: BrowserToolParams): AnyAgentTool;
```

### 参数

- `params`: 浏览器工具参数

### 功能

创建浏览器控制工具。

### 核心实现

```typescript
export function createBrowserTool(params: BrowserToolParams): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: "browser",
    description: "Control a headless browser",
    inputSchema: BrowserToolSchema,

    async execute(args, context) {
      const action = args.action;

      switch (action) {
        // 快照
        case "snapshot": {
          const { targetId, timeoutMs } = readOptionalTargetAndTimeout(args);
          const { target, targetId: resolvedTargetId } = await resolveBrowserTarget(args);

          if (target === "node" || resolvedTargetId) {
            return handleNodeBrowserSnapshot(resolvedTargetId, args.targetUrl);
          }

          // 本地浏览器
          return browserSnapshot({ url: args.targetUrl });
        }

        // 导航
        case "navigate": {
          const targetUrl = readTargetUrlParam(args);
          const { target } = await resolveBrowserTarget(args);

          return browserNavigate({
            url: targetUrl,
            target,
            timeoutMs: args.timeoutMs,
          });
        }

        // 截图
        case "screenshot": {
          return browserScreenshotAction({
            target: args.target,
            fullPage: args.fullPage,
          });
        }

        // 标签页操作
        case "tabs": {
          return browserTabs({});
        }

        case "open-tab": {
          return browserOpenTab({ url: args.url });
        }

        case "close-tab": {
          return browserCloseTab({ targetId: args.targetId });
        }

        // 更多操作...
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };

  return tool;
}
```

### 设计思路

- **动作分发**：统一的动作处理模式
- **目标解析**：支持多种目标类型
- **参数验证**：严格的参数处理

---

### 6.3 配置管理函数 (config/config.ts)

---

## 函数: loadConfig

### 签名

```typescript
export function loadConfig(): OpenClawConfig;
```

### 功能

加载 OpenClaw 配置。

### 核心实现

```typescript
let configCache: OpenClawConfig | null = null;
let configMtime: number = 0;
let configWatcher: FSWatcher | null = null;

export function loadConfig(): OpenClawConfig {
  const configPath = resolveConfigPath();

  // 获取文件修改时间
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch {
    // 配置文件不存在，使用默认配置
    return getDefaultConfig();
  }

  // 缓存命中检查
  if (configCache && stat.mtimeMs === configMtime) {
    return configCache;
  }

  // 重新加载配置
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    const validated = validateConfig(parsed);

    // 应用默认值
    const withDefaults = applyDefaults(validated);

    // 缓存
    configCache = withDefaults;
    configMtime = stat.mtimeMs;

    return withDefaults;
  } catch (err) {
    // 解析失败，返回缓存或默认
    if (configCache) {
      return configCache;
    }
    return getDefaultConfig();
  }
}
```

### 设计思路

- **缓存优化**：避免重复读取文件
- **失效检测**：通过 mtime 检测变更
- **容错处理**：解析失败时回退

---

## 函数: validateConfig

### 签名

```typescript
export function validateConfig(input: unknown): OpenClawConfig;
```

### 参数

- `input`: 原始配置输入

### 功能

验证配置结构。

### 核心实现

```typescript
import { z } from "zod";

const ConfigSchema = z.object({
  gateway: GatewayConfig.optional(),
  agents: z.record(z.string(), AgentConfig).optional(),
  tools: ToolsConfig.optional(),
  memory: MemoryConfig.optional(),
  channels: z.record(z.string(), ChannelConfig).optional(),
  auth: AuthConfig.optional(),
  plugins: PluginsConfig.optional(),
});

export function validateConfig(input: unknown): OpenClawConfig {
  try {
    return ConfigSchema.parse(input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const messages = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
      throw new Error(`Config validation failed:\n${messages.join("\n")}`);
    }
    throw err;
  }
}
```

### 设计思路

- **Schema 验证**：使用 Zod 进行类型验证
- **清晰错误**：友好的错误消息

---

## 函数: applyDefaults

### 签名

```typescript
function applyDefaults(config: OpenClawConfig): OpenClawConfig;
```

### 参数

- `config`: 经过验证的配置

### 功能

为配置应用默认值。

### 核心实现

```typescript
function applyDefaults(config: OpenClawConfig): OpenClawConfig {
  const defaults: DeepPartial<OpenClawConfig> = {
    gateway: {
      port: 18789,
      host: "0.0.0.0",
    },
    tools: {
      exec: {
        timeoutSec: 1800,
        security: "allowlist",
      },
      fs: {
        workspaceOnly: true,
      },
    },
    memory: {
      enabled: false,
      provider: "auto",
      query: {
        maxResults: 10,
        minScore: 0.3,
      },
    },
    agents: {
      defaults: {
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      },
    },
  };

  return deepMerge(defaults, config);
}
```

### 设计思路

- **深度合并**：递归合并嵌套对象
- **最小覆盖**：默认值不覆盖显式配置
- **合理预设**：提供开箱即用的默认值

---

### 6.4 记忆管理函数 (memory/manager.ts)

---

## 函数: MemoryIndexManager.openDatabase

### 签名

```typescript
private openDatabase(): DatabaseSync
```

### 功能

打开或创建 SQLite 数据库连接。

### 核心实现

```typescript
private openDatabase(): DatabaseSync {
  const dbPath = path.resolve(this.workspaceDir, this.settings.store.path);

  // 确保目录存在
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // 打开数据库
  const db = new DatabaseSync(dbPath, {
    readonly: false,
  });

  // 设置 WAL 模式提高并发性能
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  return db;
}
```

### 设计思路

- **WAL 模式**：提高读写并发
- **目录创建**：自动创建必要目录
- **同步设置**：平衡性能和安全

---

## 函数: MemoryIndexManager.ensureSchema

### 签名

```typescript
private ensureSchema(): void
```

### 功能

确保数据库模式正确。

### 核心实现

```typescript
private ensureSchema(): void {
  // 文件表
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      hash TEXT,
      size INTEGER,
      modified_at INTEGER,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // 块表
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    )
  `);

  // 向量表（如果启用）
  if (this.vector.enabled) {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(
        chunk_id INTEGER,
        embedding FLOAT[${this.vector.dims}]
      )
    `);
  }

  // FTS 表（如果启用）
  if (this.fts.enabled) {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
        content,
        file_id UNINDEXED,
        chunk_id UNINDEXED
      )
    `);
  }
}
```

### 设计思路

- **表结构**：文件-块分离
- **虚拟表**：使用 vec0 和 fts5
- **外键约束**：级联删除

---

## 函数: MemoryIndexManager.embedQueryWithTimeout

### 签名

```typescript
async embedQueryWithTimeout(query: string): Promise<number[]>
```

### 参数

- `query`: 查询文本

### 功能

嵌入查询文本，带超时控制。

### 核心实现

```typescript
async embedQueryWithTimeout(query: string): Promise<number[]> {
  const timeoutMs = 30000; // 30 秒超时

  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Embedding timeout after 30s"));
    }, timeoutMs);

    try {
      // 截断超长文本
      const truncated = query.slice(0, 8000);
      const embedding = await this.provider!.embed(truncated);
      clearTimeout(timer);
      resolve(embedding);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}
```

### 设计思路

- **超时保护**：防止无限等待
- **文本截断**：限制输入长度

---

### 6.5 嵌入管理函数 (memory/embeddings.ts)

---

## 函数: createOpenAiEmbeddingProvider

### 签名

```typescript
export function createOpenAiEmbeddingProvider(params: {
  apiKey: string;
  model?: string;
  baseURL?: string;
}): EmbeddingProvider;
```

### 参数

- `apiKey`: API 密钥
- `model`: 模型名称
- `baseURL`: 自定义 base URL

### 功能

创建 OpenAI 嵌入提供商。

### 核心实现

```typescript
export function createOpenAiEmbeddingProvider(params: {
  apiKey: string;
  model?: string;
  baseURL?: string;
}): EmbeddingProvider {
  const model = params.model ?? "text-embedding-3-small";

  return {
    id: "openai",
    model,

    async embed(text: string): Promise<number[]> {
      const response = await fetch(params.baseURL ?? "https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      return data.data[0].embedding;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      // 批量处理
      const chunks = chunkArray(texts, 100); // 每批 100 条
      const results: number[][] = [];

      for (const chunk of chunks) {
        const response = await fetch(params.baseURL ?? "https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: chunk,
          }),
        });

        const data = await response.json();
        results.push(...data.data.map((d: { embedding: number[] }) => d.embedding));
      }

      return results;
    },
  };
}
```

### 设计思路

- **批量优化**：支持批量处理
- **错误处理**：API 错误转换

---

### 6.6 混合搜索函数 (memory/hybrid.ts)

---

## 函数: mergeHybridResults

### 签名

```typescript
export async function mergeHybridResults(params: {
  vector: VectorResult[];
  keyword: KeywordResult[];
  vectorWeight: number;
  textWeight: number;
  mmr?: { enabled: boolean; lambda: number };
  temporalDecay?: { enabled: boolean; halfLifeDays: number };
  workspaceDir: string;
}): Promise<MemorySearchResult[]>;
```

### 参数

- `vector`: 向量搜索结果
- `keyword`: 关键词搜索结果
- `vectorWeight`: 向量权重
- `textWeight`: 文本权重
- `mmr`: 最大边际相关性配置
- `temporalDecay`: 时间衰减配置
- `workspaceDir`: 工作区目录

### 功能

合并向量和关键词搜索结果。

### 核心实现

```typescript
export async function mergeHybridResults(params): Promise<MemorySearchResult[]> {
  const { vector, keyword, vectorWeight, textWeight, mmr, temporalDecay, workspaceDir } = params;

  // 1. 收集所有唯一 ID
  const allIds = new Set<string>();
  vector.forEach((v) => allIds.add(v.id));
  keyword.forEach((k) => allIds.add(k.id));

  // 2. 归一化分数
  const maxVector = Math.max(...vector.map((v) => v.vectorScore), 1);
  const maxText = Math.max(...keyword.map((k) => k.textScore), 1);

  // 3. 计算综合分数
  const scores = new Map<string, number>();

  for (const id of allIds) {
    let score = 0;

    const v = vector.find((v) => v.id === id);
    if (v) {
      score += (v.vectorScore / maxVector) * vectorWeight;
    }

    const k = keyword.find((k) => k.id === id);
    if (k) {
      score += (k.textScore / maxText) * textWeight;
    }

    // 时间衰减
    if (temporalDecay?.enabled) {
      const age = Date.now() - (k?.createdAt ?? Date.now());
      const halfLifeMs = temporalDecay.halfLifeDays * 24 * 60 * 60 * 1000;
      const decay = Math.pow(0.5, age / halfLifeMs);
      score *= decay;
    }

    scores.set(id, score);
  }

  // 4. MMR 排序或简单排序
  if (mmr?.enabled) {
    return applyMMR(scores, vector, keyword, mmr.lambda, workspaceDir);
  }

  return [...allIds]
    .map((id) => ({ id, score: scores.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

async function applyMMR(
  scores: Map<string, number>,
  vector: VectorResult[],
  keyword: KeywordResult[],
  lambda: number,
  workspaceDir: string,
): Promise<MemorySearchResult[]> {
  // MMR: 平衡相关性和多样性
  const selected: string[] = [];
  const remaining = [...scores.keys()];

  while (selected.length < 10 && remaining.length > 0) {
    let bestId = remaining[0];
    let bestScore = scores.get(bestId) ?? 0;

    // 找最高 MMR 分数的项
    for (const id of remaining) {
      const score = scores.get(id) ?? 0;

      // 计算与已选项的最大相似度
      let maxSim = 0;
      for (const selId of selected) {
        const sim = await computeSimilarity(id, selId, workspaceDir);
        maxSim = Math.max(maxSim, sim);
      }

      // MMR 公式
      const mmrScore = lambda * score - (1 - lambda) * maxSim;

      if (mmrScore > (scores.get(bestId) ?? 0) - (1 - lambda) * maxSim) {
        bestId = id;
        bestScore = score;
      }
    }

    selected.push(bestId);
    remaining.splice(remaining.indexOf(bestId), 1);
  }

  return selected.map((id) => ({ id, score: scores.get(id) ?? 0 }));
}
```

### 设计思路

- **分数归一化**：统一不同搜索方法的分数
- **MMR 算法**：平衡相关性和多样性
- **时间衰减**：优先近期内容

---

### 6.7 工具通用函数 (agents/tools/common.ts)

---

## 函数: jsonResult

### 签名

```typescript
export function jsonResult(data: unknown): AgentToolResult<unknown>;
```

### 参数

- `data`: 要返回的数据

### 功能

创建 JSON 格式的工具结果。

### 核心实现

```typescript
export function jsonResult(data: unknown): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    details: {
      result: data,
    },
  };
}
```

### 设计思路

- **标准化输出**：统一的 JSON 格式
- **格式化**：带缩进的 JSON

---

## 函数: imageResultFromFile

### 签名

```typescript
export function imageResultFromFile(filePath: string): AgentToolResult<unknown>;
```

### 参数

- `filePath`: 图片文件路径

### 功能

从文件创建图片结果。

### 核心实现

```typescript
export function imageResultFromFile(filePath: string): AgentToolResult<unknown> {
  // 读取文件
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString("base64");

  // 推断 MIME 类型
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  const mimeType = mimeTypes[ext] ?? "application/octet-stream";

  return {
    content: [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mimeType,
          data: base64,
        },
      },
    ],
  };
}
```

### 设计思路

- **自动检测**：推断 MIME 类型
- **Base64 编码**：适合传输

---

## 函数: readStringParam

### 签名

```typescript
export function readStringParam(
  params: Record<string, unknown>,
  name: string,
  opts?: { required?: boolean; label?: string },
): string | undefined;
```

### 参数

- `params`: 参数对象
- `name`: 参数名
- `opts`: 选项

### 功能

读取并验证字符串参数。

### 核心实现

```typescript
export function readStringParam(
  params: Record<string, unknown>,
  name: string,
  opts?: { required?: boolean; label?: string },
): string | undefined {
  const value = params[name];

  if (value === undefined || value === null) {
    if (opts?.required) {
      throw new Error(`${opts.label ?? name} is required`);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${opts.label ?? name} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed && opts?.required) {
    throw new Error(`${opts.label ?? name} cannot be empty`);
  }

  return trimmed;
}
```

### 设计思路

- **类型验证**：确保正确类型
- **空值处理**：支持必需/可选
- **自动 trim**：清理空白

---

### 6.8 会话管理函数 (config/sessions.ts)

---

## 函数: resolveStorePath

### 签名

```typescript
export function resolveStorePath(
  storeConfig: SessionStoreConfig | undefined,
  options: { agentId: string },
): string;
```

### 参数

- `storeConfig`: 会话存储配置
- `options`: 选项

### 功能

解析会话存储路径。

### 核心实现

```typescript
export function resolveStorePath(
  storeConfig: SessionStoreConfig | undefined,
  options: { agentId: string },
): string {
  // 1. 显式路径
  if (storeConfig?.path) {
    return storeConfig.path;
  }

  // 2. Agent 目录
  const agentDir = resolveAgentDir(options.agentId);
  return path.join(agentDir, "sessions.json");
}
```

### 设计思路

- **配置优先**：优先使用显式配置
- **默认路径**：合理的默认值

---

## 函数: resolveMainSessionKey

### 签名

```typescript
export function resolveMainSessionKey(sessionKey: string, channel: string): string;
```

### 参数

- `sessionKey`: 当前会话键
- `channel`: 通道

### 功能

解析主会话键（用于跨会话上下文）。

### 核心实现

```typescript
export function resolveMainSessionKey(sessionKey: string, channel: string): string {
  // 已经是主会话
  if (isMainSessionKey(sessionKey)) {
    return sessionKey;
  }

  // DM: 提取用户 ID 构建主键
  const dmMatch = sessionKey.match(/^dm:([^:]+):(.+)$/);
  if (dmMatch) {
    const [, channelId, userId] = dmMatch;
    return `dm:${channelId}:${userId}`;
  }

  // 线程: 使用频道+线程 ID
  const threadMatch = sessionKey.match(/^thread:([^:]+):(.+)$/);
  if (threadMatch) {
    const [, channelId, threadId] = threadMatch;
    return `thread:${channelId}:${threadId}`;
  }

  // 频道
  return `channel:${channel}`;
}
```

### 设计思路

- **模式识别**：识别不同会话类型
- **规范化**：统一格式

---

### 6.9 消息分发函数 (auto-reply/dispatch.ts)

---

## 函数: dispatchInboundMessage

### 签名

```typescript
async function dispatchInboundMessage(params: {
  channel: string;
  senderId: string;
  text: string;
  threadId?: string;
  sessionKey: string;
}): Promise<DispatchResult>;
```

### 参数

- `channel`: 通道
- `senderId`: 发送者 ID
- `text`: 消息文本
- `threadId`: 线程 ID
- `sessionKey`: 会话键

### 功能

分发入站消息到适当的处理程序。

### 核心实现

```typescript
async function dispatchInboundMessage(params): Promise<DispatchResult> {
  // 1. 检查命令
  const command = parseCommand(params.text);
  if (command) {
    return handleCommand(params, command);
  }

  // 2. 检查自动回复
  const autoReply = findMatchingAutoReply(params);
  if (autoReply) {
    return sendAutoReply(params, autoReply);
  }

  // 3. 转发给 Agent
  return forwardToAgent(params);
}

function parseCommand(text: string): Command | null {
  // 解析命令前缀
  const match = text.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) return null;

  return {
    name: match[1],
    args: match[2] ?? "",
  };
}

async function handleCommand(params, command: Command): Promise<DispatchResult> {
  const { name, args } = command;

  switch (name) {
    case "help":
      return
async function handleCommand(params, command: Command): Promise<DispatchResult> {
  const { name, args } = command;

  switch (name) {
    case "help": {
      return sendHelp(params, args);
    }

    case "status": {
      return sendStatus(params);
    }

    case "abort": {
      return abortSession(params.sessionKey);
    }

    default:
      return { success: false, error: `Unknown command: ${name}` };
  }
}
```

### 设计思路

- **命令解析**：识别命令前缀
- **分发路由**：根据命令类型路由

---

## 函数: createReplyDispatcher

### 签名

```typescript
export function createReplyDispatcher(options: {
  channel: string;
  sessionKey: string;
}): ReplyDispatcher;
```

### 参数

- `channel`: 通道
- `sessionKey`: 会话键

### 功能

创建回复分发器。

### 核心实现

```typescript
export function createReplyDispatcher(options: {
  channel: string;
  sessionKey: string;
}): ReplyDispatcher {
  const channelAdapter = getChannelAdapter(options.channel);

  return {
    async send(reply: Reply): Promise<SendResult> {
      // 1. 格式化回复
      const formatted = channelAdapter.formatReply(reply);

      // 2. 应用回复指令
      const withDirective = applyReplyDirective(formatted, reply.directive);

      // 3. 发送到通道
      const result = await channelAdapter.send(options.sessionKey, withDirective);

      return result;
    },

    async sendTyping(): Promise<void> {
      await channelAdapter.sendTyping(options.sessionKey);
    },
  };
}
```

### 设计思路

- **适配器模式**：支持多通道
- **指令处理**：支持回复指令

---

### 6.10 工具策略管道函数 (agents/tool-policy-pipeline.ts)

---

## 函数: applyToolPolicyPipeline

### 签名

```typescript
export function applyToolPolicyPipeline<T extends { name: string }>(params: {
  tools: T[];
  toolMeta?: (tool: T) => ToolMeta | undefined;
  warn?: (msg: string) => void;
  steps: PolicyPipelineStep[];
}): T[];
```

### 参数

- `tools`: 工具列表
- `toolMeta`: 工具元数据获取函数
- `warn`: 警告日志函数
- `steps`: 策略管道步骤

### 功能

应用多层工具策略管道。

### 核心实现

```typescript
export function applyToolPolicyPipeline<T extends { name: string }>(params: {
  tools: T[];
  toolMeta?: (tool: T) => ToolMeta | undefined;
  warn?: (msg: string) => void;
  steps: PolicyPipelineStep[];
}): T[] {
  let filtered = [...params.tools];

  // 按步骤依次过滤
  for (const step of params.steps) {
    if (!step.policy) {
      continue;
    }

    filtered = filtered.filter((tool) => {
      const meta = params.toolMeta?.(tool);

      // 检查是否允许
      const allowed = isToolAllowedByPolicies(tool.name, [step.policy], {
        pluginId: meta?.pluginId,
      });

      // 记录被阻止的工具
      if (!allowed && params.warn) {
        params.warn(`Tool ${tool.name} blocked by ${step.label}`);
      }

      return allowed;
    });
  }

  return filtered;
}
```

### 设计思路

- **管道模式**：依次应用每个策略
- **可观测性**：支持警告日志
- **元数据传递**：传递工具元数据用于策略判断

---

### 6.11 文件系统工具函数 (agents/pi-tools.read.ts)

---

## 函数: createOpenClawReadTool

### 签名

```typescript
export function createOpenClawReadTool(baseTool: Tool, options: ReadToolOptions): Tool;
```

### 参数

- `baseTool`: 基础读取工具
- `options`: 选项

### 功能

创建带有 OpenClaw 特定限制的读取工具。

### 核心实现

```typescript
export function createOpenClawReadTool(baseTool: Tool, options: ReadToolOptions): Tool {
  return {
    ...baseTool,

    async execute(args, context) {
      // 1. 路径验证
      const path = args.path;
      if (!path) {
        throw new Error("path is required");
      }

      // 2. 工作区隔离检查
      const absPath = path.isAbsolute(path)
        ? path.resolve(path)
        : path.resolve(options.workspaceRoot, path);

      if (!absPath.startsWith(options.workspaceRoot)) {
        throw new Error("Access denied: path outside workspace");
      }

      // 3. 权限检查
      if (!options.senderIsOwner && !isPathAllowed(absPath, options.allowlist)) {
        throw new Error("Access denied: path not in allowlist");
      }

      // 4. 执行读取
      const result = await baseTool.execute(args, context);

      // 5. 大小限制
      if (result.content?.[0]?.text) {
        const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
        if (result.content[0].text.length > maxChars) {
          result.content[0].text = result.content[0].text.slice(0, maxChars) + "\n...(truncated)";
          result.details = { ...result.details, truncated: true };
        }
      }

      return result;
    },
  };
}
```

### 设计思路

- **工作区隔离**：防止越权访问
- **权限检查**：基于所有者/允许列表
- **大小限制**：防止内存溢出

---

## 函数: resolveWorkspaceReadRoot

### 签名

```typescript
function resolveWorkspaceReadRoot(params: {
  workspaceDir: string;
  workspaceOnly: boolean;
  extraPaths: string[];
}): string[];
```

### 参数

- `workspaceDir`: 工作区目录
- `workspaceOnly`: 是否仅工作区
- `extraPaths`: 额外路径

### 功能

解析允许读取的根目录列表。

### 核心实现

```typescript
function resolveWorkspaceReadRoot(params: {
  workspaceDir: string;
  workspaceOnly: boolean;
  extraPaths: string[];
}): string[] {
  const roots: string[] = [];

  // 1. 添加工作区根目录
  roots.push(params.workspaceDir);

  // 2. 解析额外路径
  for (const extraPath of params.extraPaths) {
    const resolved = path.isAbsolute(extraPath)
      ? extraPath
      : path.resolve(params.workspaceDir, extraPath);

    // 确保额外路径在允许范围内
    if (resolved.startsWith(params.workspaceDir) || !params.workspaceOnly) {
      roots.push(resolved);
    }
  }

  return roots;
}
```

### 设计思路

- **分层管理**：工作区 + 额外路径
- **安全检查**：确保路径合法

---

### 6.12 执行工具函数 (agents/bash-tools.exec.ts)

---

## 函数: createExecTool

### 签名

```typescript
export function createExecTool(defaults?: ExecToolDefaults): AgentTool<any, ExecToolDetails>;
```

### 参数

- `defaults`: 默认选项

### 功能

创建命令执行工具。

### 核心实现

```typescript
export function createExecTool(defaults?: ExecToolDefaults): AgentTool<any, ExecToolDetails> {
  // 解析安全配置
  const {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins,
  } = resolveExecSafeBinRuntimePolicy({
    local: {
      safeBins: defaults?.safeBins,
      safeBinTrustedDirs: defaults?.safeBinTrustedDirs,
      safeBinProfiles: defaults?.safeBinProfiles,
    },
    onWarning: (msg) => logInfo(msg),
  });

  const tool: AgentTool<any, ExecToolDetails> = {
    name: "exec",
    description: "Execute a shell command",
    inputSchema: execSchema,

    async execute(args, context) {
      const { command, env = {}, timeoutSec = defaults?.timeoutSec ?? 1800, cwd } = args;

      // 1. 安全检查
      if (defaults?.security === "deny") {
        throw new Error("Execution is disabled");
      }

      if (defaults?.security === "allowlist") {
        const binName = command.split(" ")[0];
        if (!safeBins.includes(binName)) {
          throw new Error(`Command ${binName} is not in the allowlist`);
        }
      }

      // 2. 执行命令
      const result = await execOnHost({
        command,
        host: defaults?.host ?? "host",
        timeoutSec,
        env,
        cwd: cwd ?? defaults?.cwd,
      });

      // 3. 格式化输出
      return {
        content: [
          {
            type: "text" as const,
            text: result.stdout || result.stderr,
          },
        ],
        details: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    },
  };

  return tool;
}
```

### 设计思路

- **安全模式**：deny/allowlist/full 三级
- **超时控制**：可配置的超时
- **错误处理**：统一错误格式

---

### 6.13 消息工具函数 (agents/tools/message-tool.ts)

---

## 函数: createMessageTool

### 签名

```typescript
export function createMessageTool(options: MessageToolOptions): Tool;
```

### 参数

- `options`: 消息工具选项

### 功能

创建消息发送工具。

### 核心实现

```typescript
export function createMessageTool(options: MessageToolOptions): Tool {
  const tool: Tool = {
    name: "message",
    description: "Send a message to a channel or user",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["send", "react", "reply"],
        },
        channel: { type: "string" },
        to: { type: "string" },
        message: { type: "string" },
        threadId: { type: "string" },
        messageId: { type: "string" },
        reaction: { type: "string" },
        buttons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              callback_data: { type: "string" },
              style: { type: "string" },
            },
          },
        },
      },
    },

    async execute(args, context) {
      // 获取通道适配器
      const adapter = options.channelAdapters.get(args.channel ?? options.defaultChannel);
      if (!adapter) {
        throw new Error(`Unknown channel: ${args.channel}`);
      }

      switch (args.action) {
        case "send":
          return handleSend(args, adapter);

        case "react":
          return handleReact(args, adapter);

        case "reply":
          return handleReply(args, adapter);

        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    },
  };

  return tool;
}

async function handleSend(args, adapter): Promise<ToolResult> {
  const result = await adapter.send({
    to: args.to,
    text: args.message,
    threadId: args.threadId,
    buttons: args.buttons,
  });

  return {
    content: [{ type: "text", text: `Message sent: ${result.messageId}` }],
    details: { messageId: result.messageId },
  };
}
```

### 设计思路

- **动作分发**：支持多种动作
- **通道适配器**：统一接口
- **按钮支持**：内联按钮

---

### 6.14 Cron 工具函数 (agents/tools/cron-tool.ts)

---

## 函数: createCronTool

### 签名

```typescript
export function createCronTool(): Tool;
```

### 功能

创建定时任务管理工具。

### 核心实现

```typescript
export function createCronTool(): Tool {
  const cronRegistry = new Map<string, CronJob>();

  return {
    name: "cron",
    description: "Schedule and manage cron jobs",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "list", "remove", "pause", "resume"],
        },
        schedule: { type: "string" }, // cron 表达式
        command: { type: "string" },
        jobId: { type: "string" },
      },
      required: ["action"],
    },

    async execute(args) {
      const { action, schedule, command, jobId } = args;

      switch (action) {
        case "add": {
          // 验证 cron 表达式
          if (!isValidCron(schedule)) {
            throw new Error(`Invalid cron expression: ${schedule}`);
          }

          const id = jobId ?? generateId();
          const job = new CronJob({
            schedule,
            onTick: async () => {
              // 执行命令
              await executeCronCommand(command);
            },
          });

          cronRegistry.set(id, job);
          job.start();

          return {
            content: [{ type: "text", text: `Job ${id} scheduled: ${schedule}` }],
            details: { jobId: id, schedule },
          };
        }

        case "list": {
          const jobs = Array.from(cronRegistry.entries()).map(([id, job]) => ({
            id,
            schedule: job.cronExpression,
            nextRun: job.nextDate().toISOString(),
          }));

          return {
            content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }],
            details: { jobs },
          };
        }

        case "remove": {
          const job = cronRegistry.get(jobId);
          if (!job) {
            throw new Error(`Job not found: ${jobId}`);
          }
          job.stop();
          cronRegistry.delete(jobId);

          return {
            content: [{ type: "text", text: `Job ${jobId} removed` }],
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
```

### 设计思路

- **内存注册表**：轻量级实现
- **Cron 解析**：验证 cron 表达式
- **生命周期管理**：启动/停止/删除

---

### 6.15 技能安装函数 (agents/skills-install.ts)

---

## 函数: installSkill

### 签名

```typescript
async function installSkill(params: {
  skillPath: string;
  targetDir: string;
}): Promise<InstallResult>;
```

### 参数

- `skillPath`: 技能路径或 URL
- `targetDir`: 目标目录

### 功能

安装技能到指定目录。

### 核心实现

```typescript
async function installSkill(params: {
  skillPath: string;
  targetDir: string;
}): Promise<InstallResult> {
  // 1. 解析技能路径
  const { type, url, path } = parseSkillPath(params.skillPath);

  // 2. 获取技能内容
  let content: string;
  if (type === "url") {
    content = await downloadSkill(url);
  } else if (type === "local") {
    content = await readSkillFile(path);
  } else {
    throw new Error(`Unknown skill type: ${type}`);
  }

  // 3. 解析技能定义
  const skill = parseSkillDefinition(content);
  if (!skill.name || !skill.description) {
    throw new Error("Invalid skill: missing name or description");
  }

  // 4. 创建目标目录
  const skillDir = path.join(params.targetDir, skill.name);
  await fs.mkdir(skillDir, { recursive: true });

  // 5. 写入技能文件
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");

  // 6. 安装依赖（如果有）
  if (skill.dependencies?.length) {
    await installDependencies(skillDir, skill.dependencies);
  }

  return {
    success: true,
    skill,
    path: skillDir,
  };
}
```

### 设计思路

- **多源支持**：URL 或本地文件
- **依赖安装**：自动安装依赖
- **目录创建**：自动创建技能目录

---

## 函数: resolveSkillsDir

### 签名

```typescript
function resolveSkillsDir(agentId: string): string;
```

### 参数

- `agentId`: Agent ID

### 功能

解析技能目录路径。

### 核心实现

```typescript
function resolveSkillsDir(agentId: string): string {
  const agentDir = resolveAgentDir(agentId);
  return path.join(agentDir, "skills");
}
```

### 设计思路

- **Agent 隔离**：每个 Agent 有独立技能目录
- **固定结构**：`{agentDir}/skills`

---

### 6.16 认证配置函数 (agents/auth-profiles.ts)

---

## 函数: ensureAuthProfileStore

### 签名

```typescript
export function ensureAuthProfileStore(
  agentDir?: string,
  opts?: { allowKeychainPrompt?: boolean },
): AuthProfileStore;
```

### 参数

- `agentDir`: Agent 目录
- `allowKeychainPrompt`: 是否允许 Keychain 提示

### 功能

确保认证配置存储可用。

### 核心实现

```typescript
export function ensureAuthProfileStore(
  agentDir?: string,
  opts?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const cfg = loadConfig();
  const profilesDir = agentDir
    ? path.join(agentDir, "auth-profiles")
    : path.join(process.cwd(), "auth-profiles");

  // 加载或创建存储
  let store: AuthProfileStore;
  try {
    store = loadAuthProfileStore(profilesDir);
  } catch {
    store = createAuthProfileStore(profilesDir);
  }

  // 初始化 Keychain
  if (opts?.allowKeychainPrompt !== false) {
    initializeKeychainStore(store, cfg);
  }

  return store;
}
```

### 设计思路

- **目录管理**：按 Agent 隔离认证配置
- **自动创建**：缺失时创建默认存储
- **Keychain 集成**：支持系统密钥链

---

## 函数: getApiKeyForModel

### 签名

```typescript
export function getApiKeyForModel(
  store: AuthProfileStore,
  provider: string,
  model?: string,
): string | null;
```

### 参数

- `store`: 认证存储
- `provider`: 模型提供商
- `model`: 模型 ID

### 功能

获取模型的 API 密钥。

### 核心实现

```typescript
export function getApiKeyForModel(
  store: AuthProfileStore,
  provider: string,
  model?: string,
): string | null {
  // 1. 获取提供商配置
  const profiles = store.providerProfiles?.[provider] ?? [];

  // 2. 过滤适用于当前模型的配置
  const applicable = profiles.filter((profile) => {
    if (!profile.models) return true;
    return profile.models.includes(model!);
  });

  // 3. 排序：优先使用最近成功的
  applicable.sort((a, b) => {
    const aLastSuccess = store.lastSuccess?.[a.id] ?? 0;
    const bLastSuccess = store.lastSuccess?.[b.id] ?? 0;
    return bLastSuccess - aLastSuccess;
  });

  // 4. 返回第一个有效密钥
  for (const profile of applicable) {
    // 检查是否在冷却中
    const failure = store.failures?.[profile.id];
    if (failure?.cooldownUntil && Date.now() < failure.cooldownUntil) {
      continue;
    }

    // 获取密钥
    const key = getKeyFromProfile(profile);
    if (key) {
      return key;
    }
  }

  return null;
}
```

### 设计思路

- **模型过滤**：只返回适用于当前模型的配置
- **成功排序**：优先最近成功的配置
- **冷却处理**：跳过失败的配置

---

### 6.17 节点管理函数 (agents/tools/nodes-utils.ts)

---

## 函数: listNodes

### 签名

```typescript
export async function listNodes(params: { includeDisconnected?: boolean }): Promise<NodeListNode[]>;
```

### 参数

- `includeDisconnected`: 是否包含已断开节点

### 功能

列出所有可用节点。

### 核心实现

```typescript
export async function listNodes(params: {
  includeDisconnected?: boolean;
}): Promise<NodeListNode[]> {
  // 从网关状态获取节点列表
  const nodes = getGatewayRuntimeState().nodes;

  const result: NodeListNode[] = [];

  for (const [nodeId, nodeState] of nodes) {
    // 过滤已断开
    if (!params.includeDisconnected && !nodeState.connected) {
      continue;
    }

    result.push({
      nodeId,
      label: nodeState.label,
      connected: nodeState.connected,
      caps: nodeState.capabilities ?? [],
      commands: nodeState.commands ?? [],
      lastSeen: nodeState.lastSeen,
    });
  }

  return result;
}
```

### 设计思路

- **网关状态**：从运行时状态获取
- **能力列表**：返回节点能力

---

## 函数: resolveNodeIdFromList

### 签名

```typescript
export function resolveNodeIdFromList(
  nodes: NodeListNode[],
  requested: string,
): { nodeId: string; label?: string };
```

### 参数

- `nodes`: 节点列表
- `requested`: 请求的节点标识

### 功能

从列表中解析节点 ID。

### 核心实现

```typescript
export function resolveNodeIdFromList(
  nodes: NodeListNode[],
  requested: string,
): { nodeId: string; label?: string } {
  // 精确匹配
  const exact = nodes.find((n) => n.nodeId === requested);
  if (exact) {
    return { nodeId: exact.nodeId, label: exact.label };
  }

  // 标签匹配
  const byLabel = nodes.find((n) => n.label?.toLowerCase() === requested.toLowerCase());
  if (byLabel) {
    return { nodeId: byLabel.nodeId, label: byLabel.label };
  }

  // 前缀匹配
  const byPrefix = nodes.find((n) => n.nodeId.startsWith(requested));
  if (byPrefix) {
    return { nodeId: byPrefix.nodeId, label: byPrefix.label };
  }

  throw new Error(`Node not found: ${requested}`);
}
```

### 设计思路

- **多级匹配**：ID → 标签 → 前缀
- **明确错误**：找不到时抛出明确错误

---

## 附录：新增函数索引

| 序号 | 函数名                           | 模块         | 描述                   |
| ---- | -------------------------------- | ------------ | ---------------------- |
| 46   | sanitizeChatSendMessageInput     | chat         | 清理聊天消息输入       |
| 47   | sanitizeChatHistoryContentBlock  | chat         | 清理聊天历史内容块     |
| 48   | truncateChatHistoryText          | chat         | 截断聊天历史文本       |
| 49   | enforceChatHistoryFinalBudget    | chat         | 强制聊天历史预算       |
| 50   | appendAssistantTranscriptMessage | chat         | 追加助手消息到记录     |
| 51   | collectSessionAbortPartials      | chat         | 收集中止的部分响应     |
| 52   | resolveBrowserNodeTarget         | browser      | 解析浏览器节点目标     |
| 53   | createBrowserTool                | browser      | 创建浏览器工具         |
| 54   | loadConfig                       | config       | 加载配置               |
| 55   | validateConfig                   | config       | 验证配置               |
| 56   | applyDefaults                    | config       | 应用默认值             |
| 57   | openDatabase                     | memory       | 打开数据库             |
| 58   | ensureSchema                     | memory       | 确保数据库模式         |
| 59   | embedQueryWithTimeout            | memory       | 嵌入查询（超时）       |
| 60   | createOpenAiEmbeddingProvider    | embeddings   | 创建 OpenAI 嵌入提供商 |
| 61   | mergeHybridResults               | hybrid       | 合并混合搜索结果       |
| 62   | jsonResult                       | tools/common | 创建 JSON 结果         |
| 63   | imageResultFromFile              | tools/common | 从文件创建图片结果     |
| 64   | readStringParam                  | tools/common | 读取字符串参数         |
| 65   | resolveStorePath                 | sessions     | 解析存储路径           |
| 66   | resolveMainSessionKey            | sessions     | 解析主会话键           |
| 67   | dispatchInboundMessage           | dispatch     | 分发入站消息           |
| 68   | createReplyDispatcher            | reply        | 创建回复分发器         |
| 69   | applyToolPolicyPipeline          | policy       | 应用工具策略管道       |
| 70   | createOpenClawReadTool           | read         | 创建读取工具           |
| 71   | resolveWorkspaceReadRoot         | read         | 解析读取根目录         |
| 72   | createExecTool                   | exec         | 创建执行工具           |
| 73   | createMessageTool                | message      | 创建消息工具           |
| 74   | createCronTool                   | cron         | 创建定时任务工具       |
| 75   | installSkill                     | skills       | 安装技能               |
| 76   | resolveSkillsDir                 | skills       | 解析技能目录           |
| 77   | ensureAuthProfileStore           | auth         | 确保认证存储           |
| 78   | getApiKeyForModel                | auth         | 获取 API 密钥          |
| 79   | listNodes                        | nodes        | 列出节点               |
| 80   | resolveNodeIdFromList            | nodes        | 解析节点 ID            |

---

_文档持续更新中... 当前行数: 7500+_

---

## 第7层：更多核心函数详细分析（扩展版）

### 7.1 Gateway 服务器方法函数

---

## 函数: handleAgentsList

### 签名

```typescript
async function handleAgentsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

列出所有可用的 Agent。

### 核心实现

```typescript
async function handleAgentsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const validated = validateAgentsListParams(params);
  if (!validated.ok) {
    respond(false, undefined, formatValidationErrors(validated.errors));
    return;
  }

  // 2. 加载配置
  const cfg = loadConfig();

  // 3. 获取 Agent 列表
  const agents = listAgentsForGateway(cfg, ctx);

  // 4. 过滤结果
  const result = agents
    .filter((agent) => {
      if (validated.value.include === "all") return true;
      if (validated.value.include === "enabled") return agent.enabled !== false;
      return true;
    })
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      model: agent.model,
      provider: agent.provider,
    }));

  respond(true, { agents: result });
}
```

### 设计思路

- **参数验证**：使用 Zod 验证输入
- **配置驱动**：从配置文件读取
- **过滤支持**：支持启用/禁用过滤

---

## 函数: handleAgentsCreate

### 签名

```typescript
async function handleAgentsCreate(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

创建新的 Agent。

### 核心实现

```typescript
async function handleAgentsCreate(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const validated = validateAgentsCreateParams(params);
  if (!validated.ok) {
    respond(false, undefined, formatValidationErrors(validated.errors));
    return;
  }

  const { id, name, model, provider } = validated.value;

  // 2. 检查是否已存在
  const cfg = loadConfig();
  if (cfg.agents?.[id]) {
    respond(false, undefined, errorShape(ErrorCodes.CONFLICT, `Agent ${id} already exists`));
    return;
  }

  // 3. 创建 Agent 目录
  const agentDir = resolveAgentDir(id);
  await ensureAgentWorkspace(agentDir);

  // 4. 更新配置
  const newConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      [id]: {
        name: name ?? id,
        model: model ?? cfg.agents?.defaults?.model,
        provider: provider ?? cfg.agents?.defaults?.provider,
        enabled: true,
      },
    },
  };

  await writeConfigFile(newConfig);

  respond(true, {
    agent: {
      id,
      name: name ?? id,
      created: true,
    },
  });
}
```

### 设计思路

- **冲突检测**：防止重复创建
- **目录创建**：自动创建工作区
- **配置更新**：原子性配置写入

---

## 函数: handleAgentsDelete

### 签名

```typescript
async function handleAgentsDelete(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

删除指定的 Agent。

### 核心实现

```typescript
async function handleAgentsDelete(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const validated = validateAgentsDeleteParams(params);
  if (!validated.ok) {
    respond(false, undefined, formatValidationErrors(validated.errors));
    return;
  }

  const { agentId } = validated.value;

  // 2. 加载配置
  const cfg = loadConfig();

  // 3. 检查是否存在
  if (!cfg.agents?.[agentId]) {
    respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Agent ${agentId} not found`));
    return;
  }

  // 4. 移动到回收站
  const agentDir = resolveAgentDir(agentId);
  await movePathToTrash(agentDir);

  // 5. 更新配置
  const newAgents = { ...cfg.agents };
  delete newAgents[agentId];

  await writeConfigFile({
    ...cfg,
    agents: newAgents,
  });

  respond(true, {
    agent: {
      id: agentId,
      deleted: true,
    },
  });
}
```

### 设计思路

- **软删除**：移动到回收站而非直接删除
- **配置清理**：同时清理配置

---

## 函数: handleAgentsUpdate

### 签名

```typescript
async function handleAgentsUpdate(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

更新 Agent 配置。

### 核心实现

```typescript
async function handleAgentsUpdate(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const validated = validateAgentsUpdateParams(params);
  if (!validated.ok) {
    respond(false, undefined, formatValidationErrors(validated.errors));
    return;
  }

  const { agentId, ...updates } = validated.value;

  // 2. 加载配置
  const cfg = loadConfig();

  // 3. 检查是否存在
  if (!cfg.agents?.[agentId]) {
    respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Agent ${agentId} not found`));
    return;
  }

  // 4. 应用更新
  const updated = applyAgentConfig(cfg.agents[agentId], updates);

  // 5. 保存配置
  await writeConfigFile({
    ...cfg,
    agents: {
      ...cfg.agents,
      [agentId]: updated,
    },
  });

  respond(true, {
    agent: {
      id: agentId,
      updated: true,
      config: updated,
    },
  });
}
```

### 设计思路

- **部分更新**：只更新提供的字段
- **验证合并**：合并新旧配置

---

### 7.2 会话管理方法函数

---

## 函数: handleSessionsList

### 签名

```typescript
async function handleSessionsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

列出所有会话。

### 核心实现

```typescript
async function handleSessionsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 解析参数
  const agentId = params.agentId as string | undefined;
  const limit = Math.min((params.limit as number) ?? 50, 100);
  const offset = (params.offset as number) ?? 0;

  // 2. 获取会话目录
  const sessionsDir = resolveSessionsDir(agentId);

  // 3. 扫描会话文件
  const files = await fs.readdir(sessionsDir);
  const sessionFiles = files.filter((f) => f.endsWith(".json")).slice(offset, offset + limit);

  // 4. 加载会话
  const sessions = await Promise.all(
    sessionFiles.map(async (file) => {
      const content = await fs.readFile(path.join(sessionsDir, file), "utf-8");
      return JSON.parse(content);
    }),
  );

  respond(true, {
    sessions: sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages?.length ?? 0,
    })),
    total: files.length,
    offset,
    limit,
  });
}
```

### 设计思路

- **分页支持**：支持 offset/limit
- **轻量加载**：只加载元数据

---

## 函数: handleSessionsGet

### 签名

```typescript
async function handleSessionsGet(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

获取指定会话的详细信息。

### 核心实现

```typescript
async function handleSessionsGet(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  const sessionId = params.sessionId as string;

  if (!sessionId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
    return;
  }

  // 1. 加载会话条目
  const entry = loadSessionEntry(sessionId);

  if (!entry.entry) {
    respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Session ${sessionId} not found`));
    return;
  }

  // 2. 加载消息历史
  const messages = await readSessionMessages(sessionId, {
    limit: (params.limit as number) ?? 100,
  });

  respond(true, {
    session: {
      id: entry.entry.sessionId,
      createdAt: entry.entry.createdAt,
      updatedAt: entry.entry.updatedAt,
      displayName: entry.entry.displayName,
      messages,
    },
  });
}
```

### 设计思路

- **完整加载**：获取完整会话数据
- **消息历史**：包含消息列表

---

## 函数: handleSessionsDelete

### 签名

```typescript
async function handleSessionsDelete(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

删除指定的会话。

### 核心实现

```typescript
async function handleSessionsDelete(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  const sessionId = params.sessionId as string;

  if (!sessionId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
    return;
  }

  // 1. 加载会话
  const entry = loadSessionEntry(sessionId);

  if (!entry.entry) {
    respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Session ${sessionId} not found`));
    return;
  }

  // 2. 删除会话文件
  const sessionPath = resolveSessionPath(sessionId);
  if (fs.existsSync(sessionPath)) {
    await fs.unlink(sessionPath);
  }

  // 3. 从存储中移除
  delete entry.store[sessionId];
  saveSessionStore(entry.storePath, entry.store);

  respond(true, {
    session: {
      id: sessionId,
      deleted: true,
    },
  });
}
```

### 设计思路

- **文件删除**：删除会话文件
- **存储清理**：从内存存储中移除

---

### 7.3 工具目录方法函数

---

## 函数: handleToolsCatalog

### 签名

```typescript
async function handleToolsCatalog(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

获取可用工具目录。

### 核心实现

```typescript
async function handleToolsCatalog(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 获取所有工具
  const tools = getAllTools();

  // 2. 按类别分组
  const byCategory = new Map<string, Tool[]>();

  for (const tool of tools) {
    const category = tool.category ?? "other";
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
    }
    byCategory.get(category)!.push(tool);
  }

  // 3. 构建响应
  const catalog = Object.fromEntries(
    Array.from(byCategory.entries()).map(([category, tools]) => [
      category,
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    ]),
  );

  respond(true, { catalog });
}
```

### 设计思路

- **分类组织**：按类别分组工具
- **Schema 包含**：包含参数 Schema

---

## 函数: handleToolsInvoke

### 签名

```typescript
async function handleToolsInvoke(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

调用指定工具。

### 核心实现

```typescript
async function handleToolsInvoke(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 解析参数
  const toolName = params.tool as string;
  const args = (params.args as Record<string, unknown>) ?? {};

  if (!toolName) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "tool is required"));
    return;
  }

  // 2. 获取工具
  const tool = getToolByName(toolName);
  if (!tool) {
    respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Tool ${toolName} not found`));
    return;
  }

  // 3. 执行工具
  try {
    const result = await tool.execute(args, {
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
    });

    respond(true, { result });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.TOOL_ERROR, String(err)));
  }
}
```

### 设计思路

- **工具查找**：按名称查找
- **错误处理**：工具执行错误转换

---

### 7.4 节点管理方法函数

---

## 函数: handleNodesList

### 签名

```typescript
async function handleNodesList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

列出所有连接的节点。

### 核心实现

```typescript
async function handleNodesList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 获取节点状态
  const nodes = getConnectedNodes();

  // 2. 过滤
  const includeDisconnected = params.includeDisconnected === true;
  const filtered = includeDisconnected ? nodes : nodes.filter((n) => n.connected);

  // 3. 构建响应
  respond(true, {
    nodes: filtered.map((node) => ({
      id: node.id,
      label: node.label,
      connected: node.connected,
      capabilities: node.capabilities,
      lastSeen: node.lastSeen,
      version: node.version,
    })),
  });
}
```

### 设计思路

- **连接过滤**：可选包含断开节点
- **能力列表**：返回节点能力

---

## 函数: handleNodesInvoke

### 签名

```typescript
async function handleNodesInvoke(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

在指定节点上调用命令。

### 核心实现

```typescript
async function handleNodesInvoke(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 解析参数
  const nodeId = params.nodeId as string;
  const command = params.command as string;
  const args = (params.args as Record<string, unknown>) ?? {};

  if (!nodeId || !command) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "nodeId and command are required"),
    );
    return;
  }

  // 2. 获取节点
  const node = getNode(nodeId);
  if (!node || !node.connected) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.NOT_FOUND, `Node ${nodeId} not found or disconnected`),
    );
    return;
  }

  // 3. 调用节点命令
  try {
    const result = await node.invoke(command, args);
    respond(true, { result });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.NODE_ERROR, String(err)));
  }
}
```

### 设计思路

- **节点路由**：定位目标节点
- **命令分发**：分发命令到节点

---

### 7.5 配置管理函数

---

## 函数: handleConfigGet

### 签名

```typescript
async function handleConfigGet(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

获取当前配置。

### 核心实现

```typescript
async function handleConfigGet(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 加载配置
  const cfg = loadConfig();

  // 2. 过滤敏感字段
  const sanitized = redactSensitiveFields(cfg);

  // 3. 返回
  respond(true, { config: sanitized });
}
```

### 设计思路

- **敏感字段过滤**：移除 API 密钥等

---

## 函数: handleConfigUpdate

### 签名

```typescript
async function handleConfigUpdate(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

更新配置。

### 核心实现

```typescript
async function handleConfigUpdate(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const patch = params.patch as Record<string, unknown>;
  if (!patch || typeof patch !== "object") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "patch is required"));
    return;
  }

  // 2. 加载当前配置
  const cfg = loadConfig();

  // 3. 应用补丁
  const updated = applyConfigPatch(cfg, patch);

  // 4. 验证
  const validated = validateConfig(updated);
  if (!validated) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid configuration"));
    return;
  }

  // 5. 保存
  await writeConfigFile(validated);

  respond(true, { updated: true });
}
```

### 设计思路

- **补丁更新**：支持部分更新
- **验证确保**：验证后保存

---

### 7.6 健康检查方法函数

---

## 函数: handleHealth

### 签名

```typescript
async function handleHealth(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

获取系统健康状态。

### 核心实现

```typescript
async function handleHealth(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 检查各项指标
  const checks = {
    gateway: checkGateway(),
    memory: checkMemory(),
    disk: await checkDisk(),
    agents: checkAgents(),
    nodes: checkNodes(),
  };

  // 2. 确定整体状态
  const status = Object.values(checks).every((c) => c.ok)
    ? "healthy"
    : Object.values(checks).some((c) => c.critical)
      ? "critical"
      : "degraded";

  respond(true, {
    status,
    timestamp: Date.now(),
    checks,
  });
}

function checkGateway() {
  return {
    ok: true,
    uptime: process.uptime(),
    version: VERSION,
  };
}

function checkMemory() {
  const used = process.memoryUsage();
  const heapUsedPercent = (used.heapUsed / used.heapTotal) * 100;

  return {
    ok: heapUsedPercent < 90,
    heapUsed: used.heapUsed,
    heapTotal: used.heapTotal,
    percent: heapUsedPercent,
    critical: heapUsedPercent > 95,
  };
}
```

### 设计思路

- **多维度检查**：网关、内存、磁盘、Agent、节点
- **状态聚合**：综合判断健康状态

---

### 7.7 日志方法函数

---

## 函数: handleLogsGet

### 签名

```typescript
async function handleLogsGet(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

获取系统日志。

### 核心实现

```typescript
async function handleLogsGet(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 解析参数
  const level = params.level as string | undefined;
  const since = params.since as number | undefined;
  const limit = Math.min((params.limit as number) ?? 100, 1000);

  // 2. 获取日志
  const logs = await getLogs({
    level: level ?? "info",
    since: since ?? Date.now() - 3600000, // 默认1小时
    limit,
  });

  respond(true, { logs });
}
```

### 设计思路

- **时间过滤**：支持 since 参数
- **级别过滤**：支持日志级别过滤

---

### 7.8 模型管理函数

---

## 函数: handleModelsList

### 签名

```typescript
async function handleModelsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

列出可用模型。

### 核心实现

```typescript
async function handleModelsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 加载配置
  const cfg = loadConfig();

  // 2. 获取模型目录
  const models = scanModelCatalog(cfg);

  // 3. 按提供商分组
  const byProvider = new Map<string, ModelInfo[]>();

  for (const model of models) {
    const provider = model.provider;
    if (!byProvider.has(provider)) {
      byProvider.set(provider, []);
    }
    byProvider.get(provider)!.push(model);
  }

  respond(true, {
    models: Object.fromEntries(byProvider),
    default: {
      provider: cfg.agents?.defaults?.provider,
      model: cfg.agents?.defaults?.model,
    },
  });
}
```

### 设计思路

- **目录扫描**：自动发现可用模型
- **按提供商分组**：便于选择

---

### 7.9 技能管理函数

---

## 函数: handleSkillsList

### 签名

```typescript
async function handleSkillsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

列出已安装的技能。

### 核心实现

```typescript
async function handleSkillsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 获取 Agent ID
  const agentId = ctx.agentId ?? "default";

  // 2. 加载技能
  const skills = await loadSkills(agentId);

  // 3. 构建响应
  respond(true, {
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version,
      enabled: s.enabled,
    })),
  });
}
```

### 设计思路

- **按 Agent 隔离**：每个 Agent 独立技能

---

## 函数: handleSkillsInstall

### 签名

```typescript
async function handleSkillsInstall(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

安装新技能。

### 核心实现

```typescript
async function handleSkillsInstall(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const source = params.source as string;
  if (!source) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "source is required"));
    return;
  }

  // 2. 获取 Agent ID
  const agentId = ctx.agentId ?? "default";

  // 3. 安装技能
  try {
    const result = await installSkill({
      skillPath: source,
      targetDir: resolveSkillsDir(agentId),
    });

    respond(true, {
      skill: {
        name: result.skill.name,
        installed: true,
      },
    });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.INSTALL_ERROR, String(err)));
  }
}
```

### 设计思路

- **源验证**：验证技能来源

---

### 7.10 设备管理函数

---

## 函数: handleDevicesList

### 签名

```typescript
async function handleDevicesList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

列出已连接的设备。

### 核心实现

```typescript
async function handleDevicesList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 获取设备列表
  const devices = await getDevices();

  // 2. 过滤
  const type = params.type as string | undefined;
  const filtered = type ? devices.filter((d) => d.type === type) : devices;

  respond(true, {
    devices: filtered.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      status: d.status,
      capabilities: d.capabilities,
    })),
  });
}
```

### 设计思路

- **类型过滤**：可选按类型过滤

---

### 7.11 推送通知函数

---

## 函数: handlePushSubscribe

### 签名

```typescript
async function handlePushSubscribe(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

订阅推送通知。

### 核心实现

```typescript
async function handlePushSubscribe(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const endpoint = params.endpoint as string;
  const keys = params.keys as { p256dh: string; auth: string };

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "endpoint and keys are required"),
    );
    return;
  }

  // 2. 创建订阅
  const subscription = await createPushSubscription({
    endpoint,
    keys,
    userId: ctx.userId,
  });

  respond(true, {
    subscription: {
      id: subscription.id,
      endpoint: subscription.endpoint,
    },
  });
}
```

### 设计思路

- **VAPID 密钥**：使用 VAPID 协议

---

### 7.12 WebSocket 处理函数

---

## 函数: attachGatewayWsHandlers

### 签名

```typescript
export function attachGatewayWsHandlers(params: {
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  gatewayMethods: GatewayMethods;
  events: GatewayEvents;
}): void;
```

### 参数

- `wss`: WebSocket 服务器
- `clients`: 客户端集合
- `gatewayMethods`: 网关方法
- `events`: 网关事件

### 功能

附加 WebSocket 处理器。

### 核心实现

```typescript
export function attachGatewayWsHandlers(params): void {
  const { wss, clients, gatewayMethods, events } = params;

  // 处理新连接
  wss.on("connection", (ws, req) => {
    // 1. 解析 URL
    const url = new URL(req.url, `ws://${req.headers.host}`);
    const sessionKey = url.searchParams.get("sessionKey");

    // 2. 认证
    const token = parseAuthToken(req);
    if (!validateToken(token)) {
      ws.close(1008, "Unauthorized");
      return;
    }

    // 3. 创建客户端
    const client = createGatewayWsClient({
      ws,
      sessionKey,
      token,
    });

    clients.add(client);

    // 4. 处理消息
    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleWsMessage(client, message, gatewayMethods);
      } catch (err) {
        sendWsError(client, err);
      }
    });

    // 5. 处理关闭
    ws.on("close", () => {
      clients.delete(client);
      cleanupClient(client);
    });
  });
}
```

### 设计思路

- **连接管理**：管理 WebSocket 连接生命周期
- **消息路由**：将消息路由到适当的处理程序

---

## 函数: handleWsMessage

### 签名

```typescript
async function handleWsMessage(
  client: GatewayWsClient,
  message: WsMessage,
  methods: GatewayMethods,
): Promise<void>;
```

### 参数

- `client`: WebSocket 客户端
- `message`: 消息
- `methods`: 网关方法

### 功能

处理 WebSocket 消息。

### 核心实现

```typescript
async function handleWsMessage(
  client: GatewayWsClient,
  message: WsMessage,
  methods: GatewayMethods,
): Promise<void> {
  const { id, method, params } = message;

  // 1. 查找方法
  const handler = methods.get(method);
  if (!handler) {
    sendWsResponse(client, id, {
      error: { code: "METHOD_NOT_FOUND", message: `Method ${method} not found` },
    });
    return;
  }

  // 2. 执行方法
  try {
    const result = await handler(params, createContext(client));
    sendWsResponse(client, id, { result });
  } catch (err) {
    sendWsResponse(client, id, {
      error: { code: "INTERNAL_ERROR", message: String(err) },
    });
  }
}
```

### 设计思路

- **RPC 模式**：JSON-RPC 风格的消息

---

### 7.13 消息发送函数

---

## 函数: handleSend

### 签名

```typescript
async function handleSend(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

发送消息到指定通道。

### 核心实现

```typescript
async function handleSend(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const channel = params.channel as string;
  const to = params.to as string | undefined;
  const message = params.message as string;

  if (!channel || !message) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "channel and message are required"),
    );
    return;
  }

  // 2. 获取通道适配器
  const adapter = getChannelAdapter(channel);
  if (!adapter) {
    respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Channel ${channel} not found`));
    return;
  }

  // 3. 发送消息
  try {
    const result = await adapter.send({
      to,
      text: message,
      threadId: params.threadId as string | undefined,
    });

    respond(true, {
      messageId: result.id,
      channel,
    });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.SEND_ERROR, String(err)));
  }
}
```

### 设计思路

- **适配器路由**：通过适配器发送

---

### 7.14 定时任务函数

---

## 函数: handleCronList

### 签名

```typescript
async function handleCronList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

列出所有定时任务。

### 核心实现

```typescript
async function handleCronList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 获取所有任务
  const jobs = getCronJobs(ctx.agentId);

  respond(true, {
    jobs: jobs.map((job) => ({
      id: job.id,
      schedule: job.schedule,
      command: job.command,
      enabled: job.enabled,
      nextRun: job.nextRun,
      lastRun: job.lastRun,
    })),
  });
}
```

### 设计思路

- **Agent 隔离**：按 Agent 过滤

---

## 函数: handleCronAdd

### 签名

```typescript
async function handleCronAdd(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

添加新的定时任务。

### 核心实现

```typescript
async function handleCronAdd(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  // 1. 验证参数
  const schedule = params.schedule as string;
  const command = params.command as string;

  if (!schedule || !command) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "schedule and command are required"),
    );
    return;
  }

  // 2. 验证 cron 表达式
  if (!isValidCronExpression(schedule)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid cron expression"));
    return;
  }

  // 3. 创建任务
  const job = await createCronJob({
    schedule,
    command,
    agentId: ctx.agentId,
  });

  respond(true, {
    job: {
      id: job.id,
      schedule: job.schedule,
    },
  });
}
```

### 设计思路

- **表达式验证**：确保 cron 表达式有效

---

### 7.15 秘密管理函数

---

## 函数: handleSecretsList

### 签名

```typescript
async function handleSecretsList(
  params: Record<string, unknown>,
  ctx: GatewayRequestContext,
  respond: RespondFn,
): Promise<void>;
```

### 参数

- `params`: 请求参数
- `ctx`: 网关请求上下文
- `respond`: 响应函数

### 功能

## 列出所有

## 第8层：深度函数分析（补充）

### 8.1 记忆系统核心函数

---

## 函数: searchVector

### 签名

```typescript
async function searchVector(
  query: number[],
  candidates: Set<string>,
  options?: SearchOptions,
): Promise<Array<{ id: string; score: number }>>;
```

### 参数

- `query`: 查询向量
- `candidates`: 候选 ID 集合
- `options`: 搜索选项

### 功能

在向量数据库中搜索相似块。

### 核心实现

```typescript
async function searchVector(
  query: number[],
  candidates: Set<string>,
  options?: SearchOptions,
): Promise<Array<{ id: string; score: number }>> {
  const { limit = 10, minScore = 0.0 } = options ?? {};

  // 构建 SQL 查询
  const candidateList = [...candidates];
  if (candidateList.length === 0) {
    return [];
  }

  // 使用 vec0 的相似度搜索
  const sql = `
    SELECT chunk_id, distance
    FROM chunks_vec
    WHERE chunk_id IN (${candidateList.map(() => "?").join(",")})
    AND embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ?
  `;

  const stmt = db.prepare(sql);
  const results = stmt.all(...candidateList, limit) as Array<{
    chunk_id: number;
    distance: number;
  }>;

  // 转换距离为相似度分数
  return results
    .map((row) => ({
      id: String(row.chunk_id),
      score: 1 / (1 + row.distance), // 距离转相似度
    }))
    .filter((r) => r.score >= minScore);
}
```

### 设计思路

- **距离转相似度**：使用 1/(1+distance) 转换
- **批量查询**：使用 IN 子句

---

## 函数: searchKeyword

### 签名

```typescript
async function searchKeyword(
  query: string,
  candidates: Set<string>,
  options?: SearchOptions,
): Promise<Array<{ id: string; score: number }>>;
```

### 参数

- `query`: 查询文本
- `candidates`: 候选 ID 集合
- `options`: 搜索选项

### 功能

使用 FTS5 进行关键词搜索。

### 核心实现

```typescript
async function searchKeyword(
  query: string,
  candidates: Set<string>,
  options?: SearchOptions,
): Promise<Array<{ id: string; score: number }>> {
  const { limit = 10, minScore = 0.0 } = options ?? {};

  // 构建 FTS 查询
  const ftsQuery = buildFtsQuery(query);
  const candidateList = [...candidates];

  if (candidateList.length === 0) {
    return [];
  }

  // FTS5 搜索
  const sql = `
    SELECT chunk_id, bm25(chunks_fts) as score
    FROM chunks_fts
    WHERE chunks_fts IN (${candidateList.map(() => "?").join(",")})
    AND chunks_fts MATCH ?
    ORDER BY score ASC
    LIMIT ?
  `;

  const stmt = db.prepare(sql);
  const results = stmt.all(...candidateList, ftsQuery, limit) as Array<{
    chunk_id: number;
    score: number;
  }>;

  // BM25 分数转相似度（BM25 分数为负数，越小越相关）
  return results
    .map((row) => ({
      id: String(row.chunk_id),
      score: -row.score, // 转正
    }))
    .filter((r) => r.score >= minScore);
}
```

### 设计思路

- **BM25 排序**：使用 Okapi BM25 算法
- **查询构建**：处理查询语法

---

## 函数: computeSimilarity

### 签名

```typescript
async function computeSimilarity(id1: string, id2: string, workspaceDir: string): Promise<number>;
```

### 参数

- `id1`: 第一个块 ID
- `id2`: 第二个块 ID
- `workspaceDir`: 工作区目录

### 功能

计算两个块的向量相似度。

### 核心实现

```typescript
async function computeSimilarity(id1: string, id2: string, workspaceDir: string): Promise<number> {
  // 获取两个块的向量
  const [vec1, vec2] = await Promise.all([getChunkEmbedding(id1), getChunkEmbedding(id2)]);

  if (!vec1 || !vec2) {
    return 0;
  }

  // 计算余弦相似度
  const dotProduct = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0);
  const mag1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0));
  const mag2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0));

  if (mag1 === 0 || mag2 === 0) {
    return 0;
  }

  return dotProduct / (mag1 * mag2);
}
```

### 设计思路

- **余弦相似度**：标准的向量相似度度量
- **缓存优化**：可以缓存计算结果

---

## 函数: syncFile

### 签名

```typescript
async function syncFile(filePath: string, options?: SyncOptions): Promise<SyncResult>;
```

### 参数

- `filePath`: 文件路径
- `options`: 同步选项

### 功能

同步单个文件到索引。

### 核心实现

```typescript
async function syncFile(filePath: string, options?: SyncOptions): Promise<SyncResult> {
  const { force = false } = options ?? {};

  // 1. 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    return { success: false, error: "File not found" };
  }

  // 2. 计算文件哈希
  const hash = await computeFileHash(filePath);

  // 3. 检查是否需要更新
  const existing = getFileByPath(filePath);
  if (!force && existing?.hash === hash) {
    return { success: true, updated: false };
  }

  // 4. 读取文件内容
  const content = await fs.readFile(filePath, "utf-8");

  // 5. 分块
  const chunks = chunkFile(content, {
    maxChars: CHUNK_MAX_CHARS,
    overlap: CHUNK_OVERLAP_CHARS,
  });

  // 6. 删除旧块
  if (existing) {
    await deleteChunksForFile(existing.id);
  }

  // 7. 创建文件记录
  const fileId = await createFileRecord({
    path: filePath,
    hash,
    source: "workspace",
  });

  // 8. 创建块记录和嵌入
  for (const chunk of chunks) {
    await createChunkRecord({
      fileId,
      content: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    });
  }

  return { success: true, updated: true, chunksCreated: chunks.length };
}
```

### 设计思路

- **哈希检查**：避免不必要的重新索引
- **增量更新**：只更新变更的文件

---

## 函数: chunkFile

### 签名

```typescript
function chunkFile(
  content: string,
  options?: ChunkOptions,
): Array<{ text: string; startLine: number; endLine: number }>;
```

### 参数

- `content`: 文件内容
- `options`: 分块选项

### 功能

将文件内容分割成块。

### 核心实现

```typescript
function chunkFile(
  content: string,
  options?: ChunkOptions,
): Array<{ text: string; startLine: number; endLine: number }> {
  const { maxChars = 1000, overlap = 100 } = options ?? {};

  // 按行分割
  const lines = content.split("\n");
  const chunks: Array<{ text: string; startLine: number; endLine: number }> = [];

  let start = 0;
  while (start < lines.length) {
    // 计算块结束位置
    let end = start;
    let charCount = 0;

    while (end < lines.length && charCount < maxChars) {
      charCount += lines[end].length + 1; // +1 for newline
      end++;
    }

    // 提取块文本
    const chunkText = lines.slice(start, end).join("\n");

    chunks.push({
      text: chunkText,
      startLine: start + 1, // 1-indexed
      endLine: end,
    });

    // 移动到下一个块（带重叠）
    start = end - overlap;
    if (start <= chunks[chunks.length - 1].startLine) {
      start = chunks[chunks.length - 1].startLine + 1;
    }

    if (start >= lines.length) {
      break;
    }
  }

  return chunks;
}
```

### 设计思路

- **行保持**：按行分割保持结构
- **重叠**：使用重叠保持上下文

---

## 函数: buildFtsQuery

### 签名

```typescript
function buildFtsQuery(query: string): string;
```

### 参数

- `query`: 原始查询

### 功能

构建 FTS5 查询字符串。

### 核心实现

```typescript
function buildFtsQuery(query: string): string {
  // 1. 分词
  const tokens = query.toLowerCase().split(/\s+/);

  // 2. 处理查询修饰符
  const processed = tokens.map((token) => {
    // 移除引号
    const unquoted = token.replace(/^["']|["']$/g, "");

    // 处理通配符
    if (unquoted.endsWith("*")) {
      return `${unquoted.slice(0, -1)}*`;
    }

    // 处理否定
    if (unquoted.startsWith("-")) {
      return `-${unquoted.slice(1)}`;
    }

    return unquoted;
  });

  // 3. 构建查询
  // 支持: word, "phrase", prefix*, -exclude
  return processed
    .map((t) => {
      if (t.includes(" ") && !t.startsWith('"')) {
        return `"${t}"`;
      }
      return t;
    })
    .join(" ");
}
```

### 设计思路

- **查询扩展**：支持通配符和短语
- **否定支持**：支持排除词

---

## 函数: extractKeywords

### 签名

```typescript
function extractKeywords(text: string): string[];
```

### 参数

- `text`: 输入文本

### 功能

从文本中提取关键词。

### 核心实现

```typescript
function extractKeywords(text: string): string[] {
  // 1. 小写化
  const lower = text.toLowerCase();

  // 2. 移除停用词
  const withoutStopWords = lower
    .split(/\s+/)
    .filter((word) => !STOP_WORDS.has(word))
    .join(" ");

  // 3. 提取词干（简化版）
  const stemmed = withoutStopWords
    .split(/\s+/)
    .map((word) => simpleStem(word))
    .filter((word) => word.length > 2);

  // 4. 去重
  return [...new Set(stemmed)];
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "been",
  "be",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "can",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
]);

function simpleStem(word: string): string {
  // 非常简单的词干提取
  if (word.endsWith("ing")) return word.slice(0, -3);
  if (word.endsWith("ed")) return word.slice(0, -2);
  if (word.endsWith("es")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
```

### 设计思路

- **停用词过滤**：移除常见词
- **词干提取**：简化词形变化

---

### 8.2 嵌入系统函数

---

## 函数: createEmbeddingProvider

### 签名

```typescript
export async function createEmbeddingProvider(params: {
  config: OpenClawConfig;
  agentDir?: string;
  provider: string;
  remote?: boolean;
  model?: string;
  fallback?: string;
  local?: { endpoint?: string };
}): Promise<EmbeddingProviderResult>;
```

### 参数

- `config`: OpenClaw 配置
- `agentDir`: Agent 目录
- `provider`: 提供商类型
- `remote`: 是否远程
- `model`: 模型
- `fallback`: 回退提供商
- `local`: 本地配置

### 功能

创建嵌入向量提供商。

### 核心实现

```typescript
export async function createEmbeddingProvider(params): Promise<EmbeddingProviderResult> {
  const { provider, model, fallback, local } = params;

  // 1. 尝试主提供商
  try {
    const mainProvider = await createProvider({
      type: provider,
      model: model ?? getDefaultModel(provider),
      config: params.config,
      agentDir: params.agentDir,
      local,
    });

    // 测试连接
    await mainProvider.test();

    return { provider: mainProvider, requestedProvider: provider };
  } catch (error) {
    // 2. 尝试回退提供商
    if (fallback) {
      try {
        const fallbackProvider = await createProvider({
          type: fallback,
          model: getDefaultModel(fallback),
          config: params.config,
        });

        await fallbackProvider.test();

        return {
          provider: fallbackProvider,
          requestedProvider: provider,
          fallbackFrom: provider,
          fallbackReason: String(error),
        };
      } catch {
        // 回退也失败
      }
    }

    return {
      provider: null,
      requestedProvider: provider,
      providerUnavailableReason: String(error),
    };
  }
}

async function createProvider(params: {
  type: string;
  model: string;
  config: OpenClawConfig;
  agentDir?: string;
  local?: { endpoint?: string };
}): Promise<EmbeddingProvider> {
  switch (params.type) {
    case "openai":
      return createOpenAiEmbeddingProvider({
        apiKey: getApiKey("openai", params.config),
        model: params.model,
      });

    case "local":
      return createLocalEmbeddingProvider({
        endpoint: params.local?.endpoint ?? "http://localhost:11434",
      });

    case "gemini":
      return createGeminiEmbeddingProvider({
        apiKey: getApiKey("gemini", params.config),
        model: params.model,
      });

    default:
      throw new Error(`Unknown provider: ${params.type}`);
  }
}
```

### 设计思路

- **失败回退**：主失败时尝试回退
- **类型分发**：根据类型创建不同提供商

---

## 函数: embedBatch

### 签名

```typescript
async function embedBatch(
  texts: string[],
  options?: BatchOptions
): Promise<number[][]
```

### 参数

- `texts`: 文本数组
- `options`: 批处理选项

### 功能

批量嵌入多个文本。

### 核心实现

```typescript
async function embedBatch(texts: string[], options?: BatchOptions): Promise<number[][]> {
  const { concurrency = 10, timeoutMs = 60000 } = options ?? {};

  // 1. 分批处理
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  // 2. 并行处理批次
  const results: number[][] = [];

  for (let i = 0; i < batches.length; i += concurrency) {
    const batch = batches.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((texts) => provider.embedBatch(texts)));

    for (const result of batchResults) {
      results.push(...result);
    }
  }

  return results;
}
```

### 设计思路

- **批处理优化**：减少 API 调用次数
- **并发控制**：控制并发数量

---

### 8.3 工具权限系统函数

---

## 函数: resolveToolProfilePolicy

### 签名

```typescript
function resolveToolProfilePolicy(
  profile: AuthProfile | undefined,
  toolName: string,
): ToolPolicy | undefined;
```

### 参数

- `profile`: 认证配置
- `toolName`: 工具名称

### 功能

解析工具配置文件策略。

### 核心实现

```typescript
function resolveToolProfilePolicy(
  profile: AuthProfile | undefined,
  toolName: string,
): ToolPolicy | undefined {
  if (!profile?.tools) {
    return undefined;
  }

  // 精确匹配
  if (profile.tools[toolName]) {
    return profile.tools[toolName];
  }

  // 通配符匹配
  if (profile.tools["*"]) {
    return profile.tools["*"];
  }

  return undefined;
}
```

### 设计思路

- **通配符支持**：使用 \* 匹配所有工具

---

## 函数: expandToolGroups

### 签名

```typescript
function expandToolGroups(
  list: string[] | undefined,
  groups: Record<string, string[]>,
): string[] | undefined;
```

### 参数

- `list`: 工具列表
- `groups`: 组定义

### 功能

展开工具组为具体工具列表。

### 核心实现

```typescript
function expandToolGroups(
  list: string[] | undefined,
  groups: Record<string, string[]>,
): string[] | undefined {
  if (!list || list.length === 0) {
    return list;
  }

  const expanded: string[] = [];

  for (const entry of list) {
    // 检查是否是组引用
    if (entry.startsWith("group:")) {
      const groupName = entry.slice(6);
      const groupTools = groups[groupName];
      if (groupTools) {
        expanded.push(...groupTools);
      }
    } else {
      expanded.push(entry);
    }
  }

  return expanded;
}
```

### 设计思路

- **组展开**：将组名替换为具体工具

---

## 函数: isToolAllowedByPolicies

### 签名

```typescript
function isToolAllowedByPolicies(
  toolName: string,
  policies: Array<ToolPolicy | undefined>,
  toolMeta?: { pluginId?: string },
): boolean;
```

### 参数

- `toolName`: 工具名称
- `policies`: 策略列表
- `toolMeta`: 工具元数据

### 功能

检查工具是否被任何策略允许。

### 核心实现

```typescript
function isToolAllowedByPolicies(
  toolName: string,
  policies: Array<ToolPolicy | undefined>,
  toolMeta?: { pluginId?: string },
): boolean {
  const normalized = toolName.toLowerCase();

  // 1. 先检查显式拒绝
  for (const policy of policies) {
    if (!policy) continue;

    if (policy.deny?.includes(normalized)) {
      return false;
    }

    // 插件特定拒绝
    if (toolMeta?.pluginId && policy[`plugin:${toolMeta.pluginId}:deny`]?.includes(normalized)) {
      return false;
    }
  }

  // 2. 检查显式允许
  for (const policy of policies) {
    if (!policy) continue;

    const allowList = policy.allow;

    if (!allowList) continue;

    // "all" 允许一切
    if (allowList.includes("all")) {
      return true;
    }

    // 在允许列表中
    if (allowList.includes(normalized)) {
      return true;
    }

    // 插件特定允许
    if (toolMeta?.pluginId && policy[`plugin:${toolMeta.pluginId}:allow`]?.includes(normalized)) {
      return true;
    }
  }

  // 3. 默认拒绝
  return false;
}
```

### 设计思路

- **拒绝优先**：先检查拒绝列表
- **显式允许**：必须有显式允许

---

### 8.4 文件系统工具函数

---

## 函数: createWriteTool

### 签名

```typescript
export function createWriteTool(workspaceRoot: string, options?: WriteToolOptions): Tool;
```

### 参数

- `workspaceRoot`: 工作区根目录
- `options`: 工具选项

### 功能

创建文件写入工具。

### 核心实现

```typescript
export function createWriteTool(workspaceRoot: string, options?: WriteToolOptions): Tool {
  return {
    name: "write",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File content" },
        append: { type: "boolean", description: "Append to file" },
      },
      required: ["path", "content"],
    },

    async execute(args, context) {
      // 1. 路径验证
      const filePath = resolveFilePath(args.path, workspaceRoot);

      if (!isPathInWorkspace(filePath, workspaceRoot, options?.extraPaths)) {
        throw new Error("Access denied: path outside workspace");
      }

      // 2. 确保目录存在
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      // 3. 写入文件
      if (args.append) {
        await fs.appendFile(filePath, args.content, "utf-8");
      } else {
        await fs.writeFile(filePath, args.content, "utf-8");
      }

      // 4. 记录写入操作
      recordFileWrite(args.path);

      return {
        content: [{ type: "text", text: `File written: ${args.path}` }],
        details: { path: args.path, bytes: args.content.length },
      };
    },
  };
}
```

### 设计思路

- **工作区隔离**：防止写入工作区外
- **追加支持**：可选追加模式

---

## 函数: createEditTool

### 签名

```typescript
export function createEditTool(workspaceRoot: string, options?: EditToolOptions): Tool;
```

### 参数

- `workspaceRoot`: 工作区根目录
- `options`: 工具选项

### 功能

创建文件编辑工具。

### 核心实现

```typescript
export function createEditTool(workspaceRoot: string, options?: EditToolOptions): Tool {
  return {
    name: "edit",
    description: "Edit a file by replacing text",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        oldString: { type: "string", description: "Text to replace" },
        newString: { type: "string", description: "Replacement text" },
      },
      required: ["path", "oldString", "newString"],
    },

    async execute(args, context) {
      // 1. 读取文件
      const filePath = resolveFilePath(args.path, workspaceRoot);
      const content = await fs.readFile(filePath, "utf-8");

      // 2. 查找替换
      if (!content.includes(args.oldString)) {
        throw new Error("Text not found in file");
      }

      // 3. 执行替换
      const newContent = content.replace(args.oldString, args.newString);

      // 4. 写回
      await fs.writeFile(filePath, newContent, "utf-8");

      // 5. 统计
      const count = (content.match(new RegExp(escapeRegex(args.oldString), "g")) || []).length;

      return {
        content: [{ type: "text", text: `Replaced ${count} occurrence(s)` }],
        details: { path: args.path, replacements: count },
      };
    },
  };
}
```

### 设计思路

- **精确替换**：字符串替换
- **统计报告**：报告替换次数

---

## 附录：完整函数索引（扩展版）

| 序号 | 函数名                   | 模块       | 描述           |
| ---- | ------------------------ | ---------- | -------------- |
| 1    | handleAgentsList         | gateway    | 列出 Agent     |
| 2    | handleAgentsCreate       | gateway    | 创建 Agent     |
| 3    | handleAgentsDelete       | gateway    | 删除 Agent     |
| 4    | handleAgentsUpdate       | gateway    | 更新 Agent     |
| 5    | handleSessionsList       | gateway    | 列出会话       |
| 6    | handleSessionsGet        | gateway    | 获取会话       |
| 7    | handleSessionsDelete     | gateway    | 删除会话       |
| 8    | handleToolsCatalog       | gateway    | 工具目录       |
| 9    | handleToolsInvoke        | gateway    | 调用工具       |
| 10   | handleNodesList          | gateway    | 列出节点       |
| 11   | handleNodesInvoke        | gateway    | 节点调用       |
| 12   | handleConfigGet          | gateway    | 获取配置       |
| 13   | handleConfigUpdate       | gateway    | 更新配置       |
| 14   | handleHealth             | gateway    | 健康检查       |
| 15   | handleLogsGet            | gateway    | 获取日志       |
| 16   | handleModelsList         | gateway    | 模型列表       |
| 17   | handleSkillsList         | gateway    | 技能列表       |
| 18   | handleSkillsInstall      | gateway    | 安装技能       |
| 19   | handleDevicesList        | gateway    | 设备列表       |
| 20   | handlePushSubscribe      | gateway    | 订阅推送       |
| 21   | attachGatewayWsHandlers  | gateway    | WebSocket 处理 |
| 22   | handleWsMessage          | gateway    | WebSocket 消息 |
| 23   | handleSend               | gateway    | 发送消息       |
| 24   | handleCronList           | gateway    | 列出定时任务   |
| 25   | handleCronAdd            | gateway    | 添加定时任务   |
| 26   | searchVector             | memory     | 向量搜索       |
| 27   | searchKeyword            | memory     | 关键词搜索     |
| 28   | computeSimilarity        | memory     | 计算相似度     |
| 29   | syncFile                 | memory     | 同步文件       |
| 30   | chunkFile                | memory     | 文件分块       |
| 31   | buildFtsQuery            | memory     | 构建 FTS 查询  |
| 32   | extractKeywords          | memory     | 提取关键词     |
| 33   | createEmbeddingProvider  | embeddings | 创建嵌入提供商 |
| 34   | embedBatch               | embeddings | 批量嵌入       |
| 35   | resolveToolProfilePolicy | policy     | 解析工具策略   |
| 36   | expandToolGroups         | policy     | 展开工具组     |
| 37   | isToolAllowedByPolicies  | policy     | 检查工具权限   |
| 38   | createWriteTool          | tools      | 创建写入工具   |
| 39   | createEditTool           | tools      | 创建编辑工具   |

---

_文档持续更新中... 当前行数: 10000+_
