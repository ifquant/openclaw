## 第十一章：插件系统：官方合同、宿主接口与微内核装配线 (Plugin System) 🧩

> 对应第一章中与插件加载、作用域归并、冲突诊断和配置校验相关的脏活条目（81 / 110 / 111 / 148 / 152 / 156 / 158）
> 核心代码：`src/plugins/registry.ts`, `src/plugins/loader.ts`, `src/plugins/package-manager.ts`, `src/plugins/schema.ts`
> 索引回跳：如果你想先看全景脏活入口，请先回到 [第一章](./openclaw_tutorial_chapter_1.md) 中与插件相关的条目（81 / 110 / 111 / 148 / 152 / 156 / 158）；这一章会把它们还原成完整的插件微内核装配线。

---

### 11.1 开场：一场“接入一个渠道，打碎整台机器”的升级事故 🔥

某个周末，你决定给团队内部的 Agent 增加一个新的企业微信群入口。需求看起来并不大：

- 让机器人能接群消息；
- 顺手挂一个新的内部模型提供商；
- 再加一个后台巡检服务，每 5 分钟自动汇报状态。

你图省事，直接在核心代码里加了三段逻辑：

- 在主网关里硬塞一个新的 Webhook 入口；
- 在模型调度里加一个 `if provider === "internal"`；
- 在启动流程里再拉起一个定时服务。

当晚一切正常。两周后，OpenClaw 升级。新的核心循环改了 hook 顺序，provider 的 schema 也变了一个字段名。你那三段“顺手加进去”的逻辑没有任何隔离层，升级后一半功能静默失效，另一半则在启动时直接把整个网关拖死。

最糟的是，你根本没法判断问题出在：

- 插件代码本身；
- 插件配置；
- 核心升级带来的协议不兼容；
- 还是两个扩展同时抢占了同一个槽位。

这类事故说明一件事：**插件系统如果只是“顺便提供几个工具函数”，那它并不是生态层，而只是把不稳定性偷偷塞回核心。**

### 11.2 天真方案：大多数人会怎么做 🤡

很多所谓的“插件系统”，本质上只是一个工具数组：

```typescript
export default {
  tools: [searchWeb, readPage, sendMail],
};
```

看上去很轻，很优雅，也足够 demo。

问题是，一旦你要扩展的不是“给大模型多一个函数”，而是以下这些能力：

- 接入一个完整的聊天渠道；
- 新增一类模型 provider；
- 注册 CLI 子命令；
- 启动后台 service；
- 注入 HTTP route 或 gateway handler；

你很快就会回到最原始的状态：继续改核心源码，继续加 `if-else`，继续让升级变成一次高风险拆弹。

### 11.3 死亡真相：为什么“工具插件”撑不起工业级生态 💀

1. **扩展点太窄**：如果插件只能挂 tool，它就没法接管 Channel、Provider、CLI、Service 这些真正影响系统边界的部位。
2. **加载边界不清**：插件可能来自项目级、用户级、甚至第三方 npm 包。若没有作用域去重和装载边界，重名工具、冲突命令、路径逃逸会一起出现。
3. **配置没有裁决层**：管理员 YAML 少一个字段、类型写错、旧版配置残留，若系统不在注册前拦截，这些错误会拖到运行时才爆炸。
4. **独占资源会互相踩踏**：像 memory provider 这类单槽位能力，两个插件同时抢占时，不做裁决就会让系统进入不可预测状态。

所以真正的插件系统，解决的不是“怎么把功能挂进来”，而是：**怎么让功能在不污染核心的前提下，被装载、被裁决、被诊断、被隔离。**

### 11.4 手术室：OpenClaw 的插件微内核 🔬

#### 11.4.1 先把插件合同说清楚：OpenClaw 官方插件到底是什么

如果要理解 OpenClaw 插件系统，第一步不是看“能注册几个 tool”，而是先看 **官方插件合同**。按照当前实现与官方文档，OpenClaw 插件至少满足下面几个条件：

1. 插件根目录必须带 `openclaw.plugin.json`
2. 插件可以导出函数 `(api) => {}`，也可以导出对象 `{ id, name, configSchema, register(api) {} }`
3. 一个包可以通过 `package.json.openclaw.extensions` 暴露多个扩展入口
4. 插件配置通过 `plugins.entries.<id>.config` 进入宿主
5. 插件默认与 Gateway 同进程运行，因此它本质上是受宿主治理的 trusted code

这一步必须先讲清楚，因为如果只把插件理解成“几个可插拔工具函数”，后面关于 API、配置、冲突诊断和宿主边界的讨论都会失真。

#### 11.4.2 11 维度注册表：不是一个工具篮子，而是一台可接管的机器

OpenClaw 的杀手锏在 `src/plugins/registry.ts`。它不是只暴露一个 `tools[]`，而是把整台机器拆成多个正式扩展点，让插件能在不同层面挂载能力。

```typescript
// src/plugins/registry.ts
export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  channels: PluginChannelRegistration[];
  providers: PluginProviderRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  httpRoutes: PluginHttpRouteRegistration[];
  cliRegistrars: PluginCliRegistration[];
  services: PluginServiceRegistration[];
  commands: PluginCommandRegistration[];
};
```

这一层最重要的价值是：**核心不再为“未来会接什么”负责，它只为“允许哪些位置被正规接入”负责。**

这意味着：

- 要接企业微信群，不需要侵入主网关，只要注册 `channels`；
- 要接私有模型，不需要改调度主链，只要注册 `providers`；
- 要加自启动守护任务，不需要把逻辑塞回 boot 流程，只要注册 `services`。

这才是“微内核”真正成立的地方。核心造插槽，不造业务分支。

#### 11.4.3 插件作者真正面对的接口：`api` 不只是 `registerTool()`

理解插件系统的第二步，是知道插件 register 时宿主到底传了什么。当前 `src/plugins/registry.ts` 里构造出来的 `api`，至少包含：

1. 插件元信息：`id`、`name`、`version`、`description`、`source`
2. 配置：`config`、`pluginConfig`
3. 运行时环境：`runtime`
4. 日志：`logger`
5. 注册接口：`registerTool`、`registerHook`、`registerHttpHandler`、`registerHttpRoute`、`registerChannel`、`registerProvider`、`registerGatewayMethod`、`registerCli`、`registerService`、`registerCommand`
6. 辅助接口：`resolvePath`、`on(...)`

```typescript
// src/plugins/registry.ts
return {
  id: record.id,
  name: record.name,
  version: record.version,
  description: record.description,
  source: record.source,
  config: params.config,
  pluginConfig: params.pluginConfig,
  runtime: registryParams.runtime,
  logger: normalizeLogger(registryParams.logger),
  registerTool: (tool, opts) => registerTool(record, tool, opts),
  registerHook: (events, handler, opts) =>
    registerHook(record, events, handler, opts, params.config),
  registerHttpHandler: (handler) => registerHttpHandler(record, handler),
  registerHttpRoute: (params) => registerHttpRoute(record, params),
  registerChannel: (registration) => registerChannel(record, registration),
  registerProvider: (provider) => registerProvider(record, provider),
  registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
  registerCli: (registrar, opts) => registerCli(record, registrar, opts),
  registerService: (service) => registerService(record, service),
  registerCommand: (command) => registerCommand(record, command),
  resolvePath: (input: string) => resolveUserPath(input),
  on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts),
};
```

这说明 OpenClaw 插件系统不是“给你一个工具数组”，而是给你一个正式宿主接口层。

#### 11.4.4 插件看到的外部环境：`api.runtime` 是宿主能力面，不是附赠工具箱

仅仅知道 `register*` 接口还不够。OpenClaw 插件还有一个更关键的宿主入口：`api.runtime`。它把宿主能力按命名空间整理给插件使用。

当前 runtime 至少包含：

1. `runtime.version`
2. `runtime.config`
3. `runtime.system`
4. `runtime.media`
5. `runtime.tts`
6. `runtime.tools`
7. `runtime.channel`
8. `runtime.logging`
9. `runtime.state`

这意味着插件作者默认运行在一个已经准备好如下外部环境的宿主里：

1. 可以读写宿主配置
2. 可以触发系统事件，甚至执行带超时的系统命令
3. 可以复用宿主的媒体、TTS、memory tool、状态目录等基础设施
4. 可以调用成熟的 channel helper，而不是自己从零处理 Telegram、Discord、Slack、WhatsApp、Line 这类渠道细节

所以从教程角度，OpenClaw 插件系统最重要的一条事实是：

**插件依赖的不只是一个 SDK 包名，而是一整套已经整理好的宿主环境。**

#### 11.4.5 一个最小可工作的插件到底长什么样

前面把合同、接口和 runtime 说清楚之后，最好立刻落到一个最小例子上。否则读者很容易知道很多原则，却仍然不知道“一个真正可装载的插件目录应该长什么样”。

一个最小插件至少有 4 个东西：

1. `openclaw.plugin.json`
2. 可被加载的入口文件
3. 可选的 `package.json.openclaw.extensions`
4. 宿主配置中的 `plugins.entries.<id>`

下面给一个最小 `tool` 插件示意：

```json
// openclaw.plugin.json
{
  "id": "hello-plugin",
  "name": "Hello Plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "greeting": { "type": "string" }
    }
  },
  "uiHints": {
    "greeting": { "label": "Greeting" }
  }
}
```

```json
// package.json
{
  "name": "hello-plugin",
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

```ts
// index.ts
export default function register(api) {
  api.registerTool({
    name: "hello_plugin.say_hello",
    description: "Return a greeting from the plugin host.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    execute: async ({ name }) => {
      const greeting = api.pluginConfig?.greeting ?? "Hello";
      api.logger.info(`hello-plugin invoked for ${name}`);
      return { ok: true, message: `${greeting}, ${name}` };
    },
  });
}
```

```yaml
# config.yaml
plugins:
  entries:
    hello-plugin:
      enabled: true
      config:
        greeting: "Hello"
```

这个最小例子有几个特别重要的观察点：

1. **manifest 先于执行**：OpenClaw 会先看 `openclaw.plugin.json`，而不是先执行 `index.ts`。
2. **配置先进入宿主，再进入插件**：插件看到的不是任意外部 JSON，而是已经落在 `plugins.entries.<id>.config` 下的宿主配置。
3. **入口导出不是随便约定**：要么导出函数，要么导出带 `register(api)` 的对象。
4. **插件逻辑默认运行在宿主环境里**：工具实现直接使用 `api.pluginConfig` 和 `api.logger`，这说明插件天然依赖宿主接口，而不是一个完全自给自足的独立脚本。

如果读者只想先把一个插件“看懂”，这段例子应该先读，再回去读加载、冲突和裁决语义。

#### 11.4.6 一个复杂插件样例：同时使用配置、日志、runtime、tool、command、hook、service

最小例子只适合建立“插件长什么样”的第一印象，但它还不能体现 OpenClaw 插件系统真正强在哪。真正有代表性的插件，通常不会只注册一个 tool，而是会同时使用多种宿主能力。

下面给一个“值班巡检插件”示意。它做 4 件事：

1. 注册一个 tool，让 Agent 主动触发巡检
2. 注册一个 command，让用户直接手动执行巡检
3. 注册一个 hook，在特定事件发生时记录状态
4. 注册一个后台 service，定期执行宿主命令并把结果写入状态目录

它同时会使用：

1. `api.pluginConfig`
2. `api.logger`
3. `api.runtime.system`
4. `api.runtime.media`
5. `api.runtime.state`
6. `api.registerTool`
7. `api.registerCommand`
8. `api.registerHook`
9. `api.registerService`

```json
// openclaw.plugin.json
{
  "id": "ops-watch",
  "name": "Ops Watch",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "intervalSec": { "type": "integer", "minimum": 30 },
      "command": {
        "type": "array",
        "items": { "type": "string" },
        "minItems": 1
      },
      "enabledHooks": {
        "type": "array",
        "items": { "type": "string" }
      },
      "sampleImageUrl": { "type": "string" }
    }
  },
  "uiHints": {
    "intervalSec": { "label": "Check Interval (sec)" },
    "command": { "label": "Health Command" },
    "sampleImageUrl": { "label": "Optional Media Probe URL" }
  }
}
```

```ts
// index.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeConfig(api) {
  const raw = api.pluginConfig ?? {};
  return {
    intervalSec: typeof raw.intervalSec === "number" ? raw.intervalSec : 300,
    command: Array.isArray(raw.command) && raw.command.length > 0 ? raw.command : ["echo", "ok"],
    enabledHooks: Array.isArray(raw.enabledHooks) ? raw.enabledHooks : ["command:new"],
    sampleImageUrl: typeof raw.sampleImageUrl === "string" ? raw.sampleImageUrl : null,
  };
}

async function runHealthCheck(api, cfg) {
  const result = await api.runtime.system.runCommandWithTimeout(cfg.command, {
    timeoutMs: 10_000,
  });

  let mediaProbe = null;
  if (cfg.sampleImageUrl) {
    const media = await api.runtime.media.loadWebMedia({ url: cfg.sampleImageUrl });
    const mime = api.runtime.media.detectMime(media.buffer);
    mediaProbe = { bytes: media.buffer.length, mime };
  }

  const stateDir = api.runtime.state.resolveStateDir("ops-watch");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "last-check.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        command: cfg.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        mediaProbe,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    mediaProbe,
  };
}

export default {
  id: "ops-watch",
  name: "Ops Watch",
  register(api) {
    const cfg = normalizeConfig(api);

    api.logger.info(`ops-watch: registered with interval ${cfg.intervalSec}s`);

    api.registerTool({
      name: "ops_watch.run_check",
      description: "Run the health-check command and return the latest result.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: async () => {
        api.logger.info("ops-watch: tool-triggered health check");
        return runHealthCheck(api, cfg);
      },
    });

    api.registerCommand({
      name: "ops-watch-check",
      description: "Run plugin health check from command surface.",
      execute: async () => {
        const summary = await runHealthCheck(api, cfg);
        return {
          ok: summary.ok,
          message: summary.ok ? "health check passed" : "health check failed",
          data: summary,
        };
      },
    });

    for (const hookName of cfg.enabledHooks) {
      api.registerHook(
        hookName,
        async () => {
          api.logger.info(`ops-watch: observed hook ${hookName}`);
        },
        {
          name: `ops-watch.${hookName}`,
          description: `Observe ${hookName} and emit diagnostics logs`,
        },
      );
    }

    api.registerService({
      name: "ops-watch.scheduler",
      description: "Periodically run health checks and persist latest result.",
      start: async (ctx) => {
        ctx.logger.info("ops-watch: background scheduler started");
        const timer = setInterval(async () => {
          try {
            await runHealthCheck(api, cfg);
          } catch (err) {
            ctx.logger.error(`ops-watch: scheduled check failed: ${String(err)}`);
          }
        }, cfg.intervalSec * 1000);

        return async () => {
          clearInterval(timer);
          ctx.logger.info("ops-watch: background scheduler stopped");
        };
      },
    });
  },
};
```

这个例子故意写得比最小例子重，因为它刚好能暴露 OpenClaw 插件系统的几个本质：

1. **插件不是一个单函数扩展，而是一个小型宿主程序集**：同一个插件同时接入 tool、command、hook、service 四个面。
2. **插件不是只消费自己的配置**：它把宿主配置解释成定时策略、命令参数和 hook 开关。
3. **插件不是只做纯计算**：它会调用宿主提供的系统命令执行、媒体探测和状态目录能力。
4. **插件不是“运行完就结束”**：service 说明插件可以拥有持续生命周期。
5. **插件日志不是额外装饰**：`api.logger` 与 `ctx.logger` 都参与到宿主可观测性里。

如果读者要理解“OpenClaw 插件系统为什么值得单独成章”，比起最小例子，这个复杂样例更能说明它是一个正式的宿主扩展面，而不是工具脚本收纳箱。

#### 11.4.7 逐项拆解：这个复杂样例到底覆盖了哪些宿主能力？

如果把上面的 `ops-watch` 样例当成一张检查清单，它实际上覆盖了 OpenClaw 插件系统的 5 个关键层面：

1. **合同层**
   它同时用到了 `openclaw.plugin.json`、对象式导出、`plugins.entries.<id>.config`。这说明一个复杂插件首先仍然服从同一份官方合同，而不是额外走“高级插件特殊通道”。

2. **注册层**
   它调用了 `registerTool`、`registerCommand`、`registerHook`、`registerService`。这说明插件系统真正的价值不在“能挂一个点”，而在“一个插件可以同时挂多个正式扩展点”。

3. **宿主环境层**
   它调用了 `runtime.system.runCommandWithTimeout(...)`、`runtime.media.loadWebMedia(...)`、`runtime.media.detectMime(...)`、`runtime.state.resolveStateDir(...)`。这说明插件不是独立脚本，而是默认运行在宿主基础设施之上。

4. **治理层**
   它用 `pluginConfig` 驱动行为，用 `logger` / `ctx.logger` 暴露可观测性。也就是说，插件不是“悄悄跑一段代码”，而是宿主可配置、可记录、可排障的正规构件。

5. **生命周期层**
   `tool` 和 `command` 体现即时调用，`hook` 体现事件响应，`service` 体现持续运行。这 3 类生命周期放在同一个插件里，刚好能说明 OpenClaw 插件不是单次执行模型，而是一个可以同时承载同步入口、事件入口和后台入口的扩展系统。

如果后续有人要在别的系统里兼容 OpenClaw 插件，这个复杂样例其实可以直接当成一份很实用的最低验收标准：

1. 能不能吃下这份 manifest 与配置布局
2. 能不能让一个插件同时注册多个扩展点
3. 能不能提供最基本的 `runtime.system`、`runtime.media`、`runtime.state`
4. 能不能承接插件的持续生命周期与日志输出

#### 11.4.8 热装载兼容层：把 ESM / CJS / TS 一起吞下去，但不让插件越狱

生态一旦起来，格式兼容就会变成第一层脏活。有人交 `CommonJS`，有人交 `ESM`，有人直接扔 `TypeScript` 源码。OpenClaw 没要求所有人先统一编译，而是在加载器里用 `jiti` 做兼容，同时用边界检查守住文件系统外缘。

```typescript
// src/plugins/loader.ts
let jitiLoader = createJiti(import.meta.url, {
  interopDefault: true,
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".json"],
  alias: {
    "openclaw/plugin-sdk": resolvePluginSdkAlias(),
  },
});

const opened = openBoundaryFileSync({
  absolutePath: candidate.source,
  rootPath: pluginRoot,
});

const mod = jitiLoader(safeSource) as OpenClawPluginModule;
```

这段设计有两层匠气：

1. `jiti` 把“生态作者写什么模块格式”从核心问题里剥掉，让装载器兜底。
2. `openBoundaryFileSync()` 又把“你能不能借加载过程顺手爬出插件目录”这件事提前封死。

也就是说，OpenClaw 不是只追求“能加载”，而是在追求**可兼容地加载，同时带边界地加载**。

#### 11.4.9 作用域归并与冲突诊断：项目优先，但不是静默覆盖

插件系统最容易出现的幽灵问题，不是完全加载失败，而是“加载成功了，但你以为生效的是 A，实际生效的是 B”。

OpenClaw 在这里做了两件很成熟的事：

- 对多作用域插件先做去重归并，遵循 `project-wins`；
- 对 Tool / Command / Flag / Prompt / Theme 的名称碰撞生成诊断，而不是悄悄吞掉。

这背后对应的正是第一章那些很容易被忽视、但对生态质量极关键的脏活：

- `dedupePackages()` 负责把项目级和全局级插件按“同一身份”归并；
- `detectExtensionConflicts()` 负责把同名资源的冲突显式报告出来；
- `dedupePrompts()` / `dedupeThemes()` 负责记录 winner / loser，而不是让用户只能靠猜。

这一层的判断非常务实：**冲突未必需要阻止启动，但必须可见、可解释、可追责。**

#### 11.4.10 单槽位裁决与 Schema 上岗审查：允许扩展，但不允许争王位

开放生态最怕两种东西：

- 多个插件抢同一个独占槽位；
- 插件配置错了还照样启动。

OpenClaw 直接在注册链前段做裁决和校验，而不是让系统带病运行。

```typescript
// src/plugins/loader.ts
if (record.kind === "memory") {
  const memoryDecision = resolveMemorySlotDecision({
    id: record.id,
    selectedId: selectedMemoryPluginId,
  });

  if (!memoryDecision.enabled) {
    record.status = "disabled";
    record.error = "已经被覆盖！(overridden by existing memory plugin)";
    continue;
  }
}

const validatedConfig = validatePluginConfig({
  schema: manifestRecord.configSchema,
  value: entry.config,
});

if (!validatedConfig.ok) {
  record.status = "error";
  continue;
}
```

这里最值得写进教程的地方，不是“用了 schema 校验”，而是它把插件生命周期分成了三种命运：

- `enabled`：合法且获准上岗；
- `disabled`：能力合法，但因为槽位竞争被裁掉；
- `error`：配置或装载本身就不合格，禁止继续前进。

这类状态分层会让运维和生态作者在出问题时非常清楚：到底是“我写错了”，还是“我被更高优先级的插件覆盖了”。

### 11.5 给插件作者和兼容实现者的阅读顺序 📚

如果你是 **插件作者**，建议按这个顺序读：

1. 11.4.1 看清官方插件合同
2. 11.4.3 看清 `api` 接口面
3. 11.4.4 看清 `api.runtime` 提供的宿主环境
4. 11.4.5 先看一个最小可工作的插件例子
5. 11.4.6 再看一个会同时用到多种宿主能力的复杂插件例子
6. 11.4.7 看清这个复杂样例到底覆盖了哪些宿主能力
7. 11.4.8 到 11.4.10 再理解加载、冲突与裁决语义

如果你是 **兼容实现者**，比如要在别的系统里支持 OpenClaw 插件，建议反过来看：

1. 先看 11.4.1、11.4.3、11.4.4、11.4.5、11.4.6、11.4.7，明确“插件到底依赖了什么”
2. 再看 11.4.8、11.4.9、11.4.10，明确“宿主还要负责什么治理语义”

### 11.6 架构模式提炼 📐

把这一章压缩成方法论，可以得到四个生态扩展模式：

- **微内核插槽模式 (Microkernel Slotting)**：核心只维护稳定扩展面，不把业务扩展写死在主链路里。
- **兼容式沙箱装载 (Compatibility-First Sandboxed Loading)**：用统一加载器吞下异构模块格式，同时用目录边界和 SDK 别名控制装载上下文。
- **显式冲突诊断 (Explicit Collision Diagnostics)**：重名与覆盖不可避免，但必须可见、可解释，而不是静默吞并。
- **单槽位裁决 (Single-Slot Arbitration)**：对 memory/provider 等独占能力，先裁决再注册，绝不让系统带着多王并立的状态起跑。

| 模式         | OpenClaw 中的落点                   | 通用等价物                         | 适用场景                  |
| ------------ | ----------------------------------- | ---------------------------------- | ------------------------- |
| 微内核插槽   | `PluginRegistry` / hooks / channels | Microkernel / plugin bus           | 工具、渠道、provider 扩展 |
| 兼容式装载   | `jiti` + 边界文件                   | Sandboxed Dynamic Loader           | ESM/CJS 混部、项目插件    |
| 显式冲突诊断 | winner / loser diagnostics          | Conflict Report / lint diagnostics | 重名 prompt、theme、tool  |
| 单槽位裁决   | memory/provider arbitration         | Single-owner election              | 独占扩展能力              |

### 11.7 启示录

> 思考题：如果插件系统只追求“能加载就算成功”，却不区分 `enabled / disabled / error` 三种命运，生态一旦扩张，排障成本会以什么方式指数级上升？

**成熟的插件系统，不是“任何人都能往里塞代码”，而是“任何扩展都必须通过同一条可裁决、可诊断、可隔离的装配线”。**

到这里，OpenClaw 的整体轮廓就闭环了。前十章解决的是消息、状态、网络和控制面的长期秩序，第十一章解决的是另一件同样重要的事：**当系统继续长大时，变化应该被吸纳进生态层，而不是重新污染核心。**

这也是为什么微内核在 Agent 世界里格外重要。因为真正拖垮系统的，往往不是第一次写出来的核心循环，而是后面那一百次“顺手再加一个入口”的工程冲动。
