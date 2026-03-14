# OpenClaw 代码地图：按目录理解 `src/`

这份地图的目标不是解释每个文件，而是先帮你建立一个最低可用的目录认知：

- 这个目录在系统里扮演什么角色
- 它更偏“入口 / 编排 / 基础设施 / 渠道 / UI / 测试”中的哪一类
- 如果你现在很茫然，应该先读哪几个目录

---

## 一句话先讲清 OpenClaw

OpenClaw 不是一个“把 Agent loop 全写在自己仓库里”的项目。

它更像一个很厚的工程壳，主要负责：

- 把真实世界的消息、渠道、文件、浏览器、命令执行、安全审批、会话状态整理干净
- 把这些现实世界的复杂性整理成一套可以交给外部 agent core 的运行环境
- 再把 agent 的输出重新收束为可执行动作、可投递消息、可持续运行的状态

所以你读 `openclaw` 时，不要先问“它的大脑在哪”，要先问：

- 输入是怎么被整形的
- 工具是怎么被组织和裁决的
- 会话是怎么被维持的
- 输出是怎么被安全送回去的

---

## 建议阅读顺序

如果你现在对整个仓库一片茫然，建议按这个顺序读：

1. `src/agents/pi-embedded-runner/`
2. `src/agents/`
3. `src/infra/`
4. `src/sessions/`
5. `src/acp/control-plane/`
6. `src/channels/` + 某一个具体渠道目录，例如 `src/imessage/` 或 `src/telegram/`
7. `src/daemon/`
8. `src/cli/` 和 `src/commands/`

最小起步文件：

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/infra/exec-approvals-analysis.ts`
- `src/infra/exec-command-resolution.ts`
- `src/acp/control-plane/manager.ts`
- `src/sessions/session-key-utils.ts`

---

## 顶层分区

### 1. Agent 运行内核壳

- `src/agents/`
  OpenClaw 最核心的运行壳。这里负责 prompt 组装、工具创建、模型兼容、session 处理、subagent、tool policy、sandbox、skills 等。

- `src/agents/pi-embedded-runner/`
  现在最值得优先读的目录。负责把一次真实会话整理成 embedded agent run，包括上下文、工具、prompt、流式响应、compaction、安全限制。

- `src/agents/pi-embedded-helpers/`
  embedded runner 的辅助逻辑，比如 session 消息清洗、文本格式化、bootstrap context 构建辅助。

- `src/agents/pi-extensions/`
  给 embedded runner 增加运行期扩展能力，比如上下文裁剪、compaction safeguard、session manager runtime registry。

- `src/agents/sandbox/`
  sandbox 真正的实现层。负责 docker/host 路径、绑定、browser bridge、env 清洗、安全校验、registry、workspace 映射。

- `src/agents/schema/`
  工具 schema 和 provider 兼容层的小型适配代码。

- `src/agents/skills/`
  workspace skills、bundled skills、plugin skills、frontmatter、env overrides、prompt 构建等。

- `src/agents/tools/`
  具体工具实现目录。浏览器、cron、gateway、canvas、discord actions 等偏“工具实体”的代码在这里。

- `src/agents/auth-profiles/`
  多 provider / 多认证资料的轮换、失败标记、cooldown、运行快照等。

- `src/agents/cli-runner/`
  让 agent 通过 CLI backend 运行的配套逻辑。

- `src/agents/test-helpers/`
  给 agent 相关测试准备的 fixture 和 stub。

### 2. ACP 与控制面

先单独解释一下 `ACP`。

#### ACP 是什么

在 OpenClaw 里，你可以先把 `ACP` 理解成一种 **Agent Control Protocol / Agent Coordination Protocol** 风格的内部协议层。

它不是“大模型协议”，也不是“某个渠道协议”，而是 OpenClaw 自己用来解决下面这些问题的一层中间协议：

- 如何把一次会话抽象成统一的 session
- 如何把运行中的 agent、消息事件、tool 事件、控制命令映射成统一格式
- 如何让“控制面”可以操作“运行中的会话”，而不直接耦合到某个具体渠道或某个具体 agent 实现

如果说：

- `channels/*` 负责和 Telegram、iMessage、Discord 这些外部世界说话
- `agents/*` 负责和 embedded agent session / tools / prompt 这些运行时说话

那么 `acp/*` 就是在两者之上，提供一套 **统一会话与控制语义**。

你可以把它粗略理解成：

```text
外部渠道 / CLI / 控制请求
        ↓
      ACP 层
        ↓
会话控制 / 运行时管理 / agent 事件映射
        ↓
真正的 agent run / tool run / message delivery
```

#### 为什么 OpenClaw 需要 ACP

因为 OpenClaw 不是一个单进程、单对话框、单渠道的小 demo。

它要处理的是：

- 一个 session 正在流式输出时，外部能不能 steer / abort
- 不同渠道来的消息，如何映射成统一的 session 标识
- 控制面如何查看“当前这个会话是不是还在跑、跑到哪了、要不要中断”
- 节点、runtime、session target、delivery target 这些状态，如何不用直接碰底层 agent 对象就能管理

如果没有 ACP，这些能力就会散落在：

- 某个渠道 monitor 里
- 某个 agent runner 里
- 某个 CLI 命令里
- 某个 daemon 进程里

最后整个系统会没有统一的“控制语义”。

所以 ACP 的存在，本质上是在做两件事：

1. 把运行中的 agent 会话抽象成可控制对象
2. 把控制命令和运行事件抽象成统一协议

#### ACP 不是控制面本身

这一点很容易混。

- `ACP` 更像 **协议层 / 语义桥**
- `control-plane` 更像 **真正的控制中枢实现**

也就是说：

- `src/acp/` 负责定义“怎么表示 session、event、policy、command”
- `src/acp/control-plane/` 负责实现“怎么管理这些 session 和 runtime”

你可以记成：

```text
ACP = 语言和协议
control-plane = 调度和管理
```

#### 你读代码时该怎么看 ACP

如果你现在第一次看 OpenClaw，不要一上来试图把 `acp/` 当成某种网络协议实现。

你应该先这样理解：

- `src/acp/session.ts`
  是会话抽象
- `src/acp/event-mapper.ts`
  是运行事件到 ACP 事件的翻译层
- `src/acp/translator.ts`
  是不同表示之间的转换层
- `src/acp/server.ts` / `client.ts`
  是协议的进出接口
- `src/acp/control-plane/*`
  才是 ACP 真正落地成“控制面”的地方

所以你看见 `ACP`，不要脑中联想到“又一个 provider API”。
它更接近：

- 会话控制协议
- 运行时协调协议
- 控制面和执行面之间的统一语义层

- `src/acp/`
  ACP 协议层。包括 client/server、session 映射、event 翻译、policy、session 模型，是运行面和控制面之间的协议桥。

- `src/acp/control-plane/`
  控制面的核心目录。管理 session actor queue、runtime cache、spawn、identity reconcile、runtime controls。你可以把它理解为“OpenClaw 的会话控制中枢”。

- `src/acp/runtime/`
  ACP 运行期相关实现，偏 runtime 适配而不是控制策略。

### 3. 渠道与消息接入

- `src/channels/`
  渠道抽象层。放公共渠道逻辑、plugin channel 桥接、allowlist、web/telegram 等共享适配。

- `src/channels/allowlists/`
  渠道级 allowlist / 访问控制相关逻辑。

- `src/channels/plugins/`
  插件渠道的桥接层，不是内建渠道本体。

- `src/channels/telegram/`
  渠道抽象层里与 Telegram 共享或桥接的部分。

- `src/channels/web/`
  渠道抽象层里与 Web 渠道相关的共用逻辑。

- `src/discord/`
  Discord 渠道实现本体。

- `src/discord/monitor/`
  Discord 入站监听和监控。

- `src/discord/voice/`
  Discord 语音相关支持。

- `src/imessage/`
  iMessage 渠道实现。

- `src/imessage/monitor/`
  iMessage 的入站处理、mention gating、debounce、delivery 等关键逻辑。

- `src/line/`
  LINE 渠道实现。

- `src/line/flex-templates/`
  LINE 富消息模板。

- `src/signal/`
  Signal 渠道实现。

- `src/signal/monitor/`
  Signal 入站监听和监控。

- `src/slack/`
  Slack 渠道实现。

- `src/slack/http/`
  Slack HTTP 交互层。

- `src/slack/monitor/`
  Slack 入站监听逻辑。

- `src/telegram/`
  Telegram 渠道实现。

- `src/telegram/bot/`
  Telegram bot 侧逻辑。

- `src/web/`
  Web 渠道 / Web 入口层。

- `src/web/auto-reply/`
  Web 渠道的自动回复逻辑。

- `src/web/inbound/`
  Web 渠道的入站处理。

- `src/whatsapp/`
  WhatsApp 渠道支持。

- `src/browser/`
  浏览器自动化与浏览器能力桥接。

- `src/browser/routes/`
  浏览器功能暴露出的路由层。

### 4. 会话、路由、记忆、自动回复

- `src/sessions/`
  会话轻量公共层。放 session key、send policy、label、input provenance、level/model override 等。

- `src/routing/`
  消息如何路由到哪个 agent / session / channel 的规则层。

- `src/memory/`
  记忆能力和会话记忆相关逻辑。

- `src/auto-reply/`
  自动回复主逻辑，包括回复生成、chunking、触发条件等。

- `src/auto-reply/reply/`
  自动回复里更具体的 reply 规则、mention 判断等。

- `src/cron/`
  定时任务和计划任务系统。

- `src/cron/isolated-agent/`
  隔离 agent 的 cron 运行逻辑。

- `src/cron/service/`
  cron 服务层，不是单次 job 逻辑。

### 5. 安全、执行、进程、系统基础设施

- `src/infra/`
  基础设施核心目录。最重要的一层之一。这里有命令审批、allowlist、safe bin、安全网络、出站收敛、TLS、时间格式等。

- `src/infra/format-time/`
  时间格式化基础设施。

- `src/infra/net/`
  网络层基础设施。

- `src/infra/outbound/`
  出站消息 / 出站动作相关基础设施。

- `src/infra/tls/`
  TLS 相关基础设施。

- `src/process/`
  进程生命周期、子进程管理相关逻辑。

- `src/process/supervisor/`
  进程监督器、守护、清理、存活性管理。

- `src/daemon/`
  长期运行的服务化壳层。systemd、launchd、schtasks、runtime binary、service audit、inspect 都在这里。

- `src/node-host/`
  把某些能力交给 node host 执行时的桥接层。

- `src/security/`
  更泛化的安全逻辑，不局限于 shell exec。

- `src/secrets/`
  secret 管理与存储。

- `src/pairing/`
  设备配对、连接身份、配对状态持久化。

- `src/config/`
  配置系统主目录。

- `src/config/sessions/`
  session 持久化和 session store 相关配置。

### 6. 网关、协议、插件、宿主

- `src/gateway/`
  gateway 主实现。用于把系统以网关/服务形式暴露出来。

- `src/gateway/protocol/`
  gateway 协议定义。

- `src/gateway/server/`
  gateway server 运行层。

- `src/gateway/server-methods/`
  gateway 暴露的方法集合。

- `src/plugins/`
  插件系统主目录。

- `src/plugins/runtime/`
  插件运行时支持。

- `src/plugin-sdk/`
  给插件开发者使用的 SDK 暴露面，不是宿主内部实现本体。

- `src/providers/`
  provider 层逻辑，偏模型或外部服务 provider 适配。

### 7. CLI、命令入口、终端 UI

- `src/cli/`
  命令行入口和各命令子系统。

- `src/cli/browser-cli-actions-input/`
  browser CLI 相关输入处理。

- `src/cli/cron-cli/`
  cron 相关 CLI。

- `src/cli/daemon-cli/`
  daemon 相关 CLI。

- `src/cli/gateway-cli/`
  gateway 相关 CLI，是比较值得读的一层。

- `src/cli/node-cli/`
  node 相关 CLI。

- `src/cli/nodes-cli/`
  节点管理相关 CLI。

- `src/cli/program/`
  CLI program 装配。

- `src/cli/shared/`
  CLI 公共逻辑。

- `src/cli/update-cli/`
  更新相关 CLI。

- `src/commands/`
  具体命令实现目录。比 `cli/` 更偏“命令语义本体”。

- `src/commands/agent/`
  agent 相关命令。

- `src/commands/channels/`
  channels 相关命令。

- `src/commands/gateway-status/`
  gateway 状态命令。

- `src/commands/models/`
  models 相关命令。

- `src/commands/onboard-non-interactive/`
  非交互式 onboarding。

- `src/commands/onboarding/`
  onboarding 主流程。

- `src/commands/status-all/`
  聚合状态命令。

- `src/tui/`
  终端 UI。

- `src/tui/components/`
  TUI 组件。

- `src/tui/theme/`
  TUI 主题。

- `src/terminal/`
  终端输出、palette、TTY 交互通用支持。

- `src/wizard/`
  引导式配置 / 安装 / 设置向导。

### 8. 多媒体、文档、渲染、边缘能力

- `src/media/`
  文件、图片、音频、mime、fetch guard、media store 等媒体基础设施。

- `src/media-understanding/`
  媒体理解能力。

- `src/media-understanding/providers/`
  媒体理解 provider 适配。

- `src/tts/`
  文本转语音。

- `src/canvas-host/`
  canvas 渲染宿主。

- `src/canvas-host/a2ui/`
  A2UI bundle 和其宿主资源。

- `src/markdown/`
  Markdown 处理和转换。

- `src/link-understanding/`
  链接理解相关能力。

- `src/docs/`
  与文档或文档生成辅助相关的源码。

### 9. 公共类型、共享工具、兼容层、测试支撑

- `src/shared/`
  通用共享逻辑。

- `src/shared/net/`
  共享网络工具。

- `src/shared/text/`
  共享文本工具。

- `src/types/`
  类型定义中心。

- `src/utils/`
  通用工具函数。

- `src/compat/`
  向后兼容 / 兼容层代码。

- `src/logging/`
  日志系统。

- `src/test-helpers/`
  全局测试辅助。

- `src/test-utils/`
  测试工具和测试通用件。

- `src/scripts/`
  仓库内部脚本型逻辑。

---

## 你现在最应该怎么建立直觉

如果你只想先读懂“OpenClaw 到底在干嘛”，不要全仓扫。按下面四个问题读：

### 问题 1：一次 agent 尝试是怎么开始的

先读：

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

你要回答：

- 上下文是怎么来的
- tools 是怎么生成的
- sandbox 是怎么接进来的
- 最终在哪里把控制权交给外部 agent core

### 问题 2：系统命令为什么不会直接裸跑

再读：

- `src/infra/exec-approvals-analysis.ts`
- `src/infra/exec-command-resolution.ts`
- `src/infra/exec-approvals.ts`

你要回答：

- shell 字符串如何被拆解
- real executable 如何被解析
- allowlist 和 safe bin 的裁决点在哪
- 人工审批插在什么阶段

### 问题 3：会话为什么不会乱

再读：

- `src/sessions/session-key-utils.ts`
- `src/acp/control-plane/manager.ts`
- `src/acp/control-plane/session-actor-queue.ts`

你要回答：

- session key 为什么这么重要
- control plane 为什么不是可有可无
- 同一 session 的任务为什么不会乱并发

### 问题 4：真实消息怎么进来又怎么出去

挑一个渠道读：

- `src/imessage/monitor/`
  或
- `src/telegram/`

配合：

- `src/auto-reply/`
- `src/routing/`

你要回答：

- 入站消息如何去重、合并、mention gating
- 出站消息如何 chunk、route、deliver

---

## 对你当前最重要的结论

你现在卡住，不是因为你没读懂某个函数，而是因为你还没有先把仓库分成这 6 类：

1. `agents`：agent 运行壳
2. `infra`：安全和基础设施壳
3. `acp/control-plane`：会话控制中枢
4. `channels + 某个具体渠道目录`：消息接入与投递
5. `sessions/routing/auto-reply`：会话与消息流
6. `daemon/cli/commands`：部署与操作入口

只要你先把这 6 块分清楚，后面再看 `runEmbeddedAttempt` 就不会觉得它像一团线了。

---

## 下一步建议

下一步不要继续扩散目录。

直接做这三件事：

1. 只读 `src/agents/pi-embedded-runner/run/attempt.ts`
2. 只读 `src/infra/exec-approvals-analysis.ts`
3. 只读 `src/acp/control-plane/manager.ts`

如果你愿意，我下一步可以继续做第二层地图：

- 不是“目录做什么”
- 而是“`runEmbeddedAttempt` 会实际调用哪些模块，它们按什么顺序接力”
