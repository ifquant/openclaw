## 第七章：进程管理与命令队列 (Process Management & Command Queue) 🔄

> 对应第一章 **1.3.3 🔄 进程管理与命令队列**（13 个脏活场景）
> 核心代码：`src/process/kill-tree.ts`, `src/process/command-queue.ts`, `src/process/spawn-utils.ts`, `src/agents/pty.ts`, `src/agents/pw-session.ts`
> 索引回跳：如果你想先看全景编号和故障分层，请先回到 [第一章](./openclaw_tutorial_chapter_1.md) 的 **1.3.3**；这一章会把 kill tree、命令排队和重启排水放回同一条执行链里讲。

---

### 7.1 开场：一场由 Webpack 引发的 OOM 惨案 🔥

你的 Agent 正在帮用户开发一个全栈应用。它执行了 `npm run dev`，Node 启动了 Webpack，Webpack 又在后台唤起了一个无头 Chromium 进行端到端测试。
此时用户看出了前端样式跑偏了，立刻点下“中止操作并重来”。

Agent 收到了打断信号，忠实地对底层 PTY 进程发送了 `process.kill(ptyPid)`。
PTY 死了，你的 `execute` Promise 也成功 `resolve` 释放了。Agent 愉快地跟用户说：“好的，操作已停止。接下来做什么？”

一切看起来很完美。
然而由于 Linux/Mac 的孤儿进程托管机制，那个被拉起来的 Node 和 Chromium 根本没有死！它们在后台疯狂狂奔，死死霸占着 `8080` 端口和 1GB 的内存。
5 分钟后，Agent 再次被指示执行 `npm run dev`。因为 `8080` 被占用，进程卡在此处疯狂报错。Agent 为了自救，又起了一个新的测试沙箱……

3 个小时后，服务器响起了严重的警报：所有 64GB 内存被吞噬殆尽，内核触发了最极端的 OOM Killer (Out Of Memory)。你的 Agent 连同整个宿主集群，轰然倒塌。

### 7.2 天真方案：大多数人会怎么做 🤡

“这还不容易？结束子进程不就行了嘛！” 你随手写下了看似毫无破绽的代码：

```javascript
child_process.kill(pid, "SIGKILL");
```

可惜，在操作系统面前，这种单薄的命令连纸糊的都算不上。

### 7.3 结构真相：为什么只杀父进程没用

在 Unix 世界里有一个铁律：**除非通过特定的进程组传递，向父进程发送的 `SIGKILL` 绝不会自动广播给子进程。**

不仅如此，由于 Node.js 异步模型和系统调用的时差：

1. **残留控制台输出**：PTY 在被杀死之前吐出了一半的 ANSI 颜色乱码，导致下一个任务从内存中读到的日志残缺不全，大模型的解析彻底崩溃。
2. **挂起的旧任务**：当用户点下“停止”时，队列里还排着 3 个马上要执行的耗时系统调用。你如果没有做“代际隔离（Generation）”，前一轮中止刚结束，后续排队的闭包又会被重新激活，继续向系统投递旧调用。

### 7.4 解决方案：OpenClaw 的进程终止与队列隔离机制

为了对抗操作系统层面的资源泄漏，OpenClaw 主要依赖两块基础设施：`kill-tree` 和 `command-queue`。

#### 7.4.1 伪装者与 ANSI 血迹清洗 (脏活 10/15)

大模型就像一个只懂纯文本的有代码洁癖的阅读器。当 OpenClaw 使用 `node-pty` 骗过操作系统起一个虚拟终端时，吐出的日志里充满了像进度条回车符 `\r` 还有让人发疯的 `\x1B[31m` 这种终端颜色控制码。如果不清洗，LLM 会立刻陷入灾难性的幻觉。

```typescript
// src/agents/pty.ts 核心脱敏骨架
const ptyProcess = pty.spawn("bash", [], {
  name: "xterm-color",
  cols: 80,
  rows: 30,
});

ptyProcess.onData((data) => {
  // 脏活 10：利用暴力正则剥离进度条回车符 \r 和终端控制码 \x1B
  const cleanText = data.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
  buffer.push(cleanText);
});
```

#### 7.4.2 孤儿进程树清理 (脏活 137/71)

面对前面提到的 `Webpack -> Chromium` 孤儿链条，简单的一句 `kill` 无济于事。OpenClaw 的 `kill-tree.ts` 实施了一套明确的**二阶段清理**：

```typescript
// src/process/kill-tree.ts 核心脱敏骨架
import getProcessTree from "ps-tree";

async function obliterateProcessTree(rootPid: number) {
  // 收集整棵子进程树
  const children = await getProcessTree(rootPid);

  // 第一阶段：先发 SIGTERM，给进程一个优雅释放文件锁和端口的机会
  for (const child of children) {
    process.kill(child.pid, "SIGTERM");
  }

  // 等待 grace period
  await waitForExit(2000);

  // 第二阶段：仍未退出的进程升级为 SIGKILL
  for (const child of children) {
    if (isAlive(child.pid)) {
      process.kill(child.pid, "SIGKILL");
    }
  }
}
```

**机制点评**：先礼后兵的二阶段升级。既不给进程赖着不走的机会，又避免了直接硬杀导致的数据文件损坏。

#### 7.4.3 多泳道排队与 Generation 代际失效 (脏活 138/140)

如果在 Agent 重启时，那些 `await` 中的闭包恢复了该怎么办？单纯的数组队列 `[].length = 0` 无法清除内存里悬空的异步 Promise 闭包。这里使用的是一种很有效的办法：**版本号（Generation）失效法**。

```typescript
// src/process/command-queue.ts 核心脱敏骨架
let currentGeneration = 0;

// 当发生打断或硬重启时
function resetQueue() {
  currentGeneration++; // 当前代际切换
  queue.clear();
}

async function enqueue(task) {
  // 执行入队前记录当时的代际
  const myGen = currentGeneration;
  await queue.push(task);

  // 从队列里被取出准备执行时，先确认是不是旧代际任务
  if (myGen !== currentGeneration) {
    throw new Error("Stale Task Omitted: generation changed, drop stale task");
  }
  // 开绿灯，正式调用 `exec`
}
```

**机制点评**：这种按代际失效旧任务的模式，能有效切断悬挂 Promise 被重新唤醒后继续执行的风险。

#### 7.4.4 CDP 物理斩断与无痕沙箱 (脏活 16/17/63)

当 Agent 使用 Playwright 控制隐形浏览器（Browser CDP Session）进行爬取时，网页上可能有无限触发的弹出框，甚至暗藏挖矿脚本。绝不能相信网页的 `onload`，必须建立物理斩断（Physical Severance）的护城河：

```typescript
// src/agents/pw-session.ts 核心机制
const context = await browser.newContext({
  // 保障并进行 Profile 隔离，决不让他接触到上一个用户的 Cookie
  userDataDir: `/tmp/agent-isolate-${generateUUID()}`,
});

// 设下强制死亡时钟，时间一到不管你在渲染什么，闭门截断
const safetyTimer = setTimeout(() => {
  context.close();
}, 30_000);
```

#### 7.4.5 一图速记：进程终止与队列断代的完整顺序

```text
[收到中止 / 重启信号]
   │
   ▼
 标记 gatewayDraining
   │
   ▼
 停止新任务入队
   │
   ▼
 对当前进程组发送 SIGTERM / taskkill
   │
   ▼
 等待 grace period
   │
   ├── 已退出? ──▶ [清理 activeTaskIds]
   │
   ▼
 升级到 SIGKILL / force taskkill
   │
   ▼
 generation++
   │
   ▼
 旧 Promise 被视为前朝任务
   │
   ▼
 仅新世代任务允许继续 pump
```

### 7.5 架构模式提炼 📐

透过这些防备进程崩溃和卡死的血泪防御，能抽出几个极具指导意义的基础架构：

- **二阶段升级模式 (2-Phase Escalation)**: 对待外部宿主的子进程，先给予温和且短暂的 `SIGTERM` 要求其优雅交代后事，超时再采取 `SIGKILL` 物理抹杀。
- **代际废弃模式 (Generation-Gated Lock)**: 对于挂起在内存堆栈中的异步 Promise 队列，不直接摧毁，而是升级外层封锁“版本号”（Generation），并在执行前校验，使得旧版本任务即使被唤醒也只能抛出废弃错误。
- **树形株连模式 (Process Tree Severance)**: 不杀单一 PID，必遍历 `ps` 树拔出萝卜带出泥，绝不允许残留任何孤儿叶子节点。

| 模式         | OpenClaw 中的落点              | 通用等价物                     | 适用场景                  |
| ------------ | ------------------------------ | ------------------------------ | ------------------------- |
| 二阶段升级   | SIGTERM → wait → SIGKILL       | Graceful Shutdown + Force Kill | 构建、测试、长跑任务      |
| 代际废弃     | `generation` 门控              | Epoch invalidation             | 中断、重启、清队列        |
| 树形株连     | kill process group / task tree | Process Group Reaping          | npm / jest / browser 套娃 |
| 沙箱定时斩断 | 浏览器 safety timer            | Watchdog timer                 | CDP、网页挖矿、卡死页面   |

### 7.6 启示录

> 思考题：如果系统只会 `kill(pid)`，却没有进程组、generation 和排水逻辑，哪三类“看起来已经停止”的任务最容易以残留状态继续活着？

**在坚若磐石的操作系统面前，你的应用代码不过是一个脆弱的租客。**
只有深刻理解进程、信号、父子孤儿关系、终端缓冲流机制，你才能真正拥有一个 7x24 小时不掉线、不爆内存、不污染重叠的 Engineering Agent。

处理完了这三个从 API、网络到操作系统的“灾变地盘”，我们终于可以进入第八章，看看 OpenClaw 是如何把人类输入、多渠道消息和回复出口一起压回秩序：既要防抖、去重、分块，也要保证同一轮 reply 永远回到正确的那条会话线上。

### 7.7 本章记住 3 件事

1. 进程终止不是“kill 一个 pid”这么简单，真正稳定的系统必须处理进程组、子进程树和 grace period。
2. 队列重置也不是简单清空数组；只要存在悬挂 Promise，就需要 generation 这一类代际失效机制来阻断旧任务回流。
3. 这一章的核心不是某个具体实现技巧，而是“停止、清理、回收、隔离”必须被当成一条完整的工程链路来设计。

### 7.8 最容易误解的点

最容易误解的一点是：**只要系统支持超时和取消按钮，就等于已经具备了可靠的停止能力。**

并不是这样。用户态的“停止”只是入口，真正决定系统能否干净停住的，是后面有没有进程树清理、代际失效、缓冲排水和浏览器/PTY 等外围资源的回收逻辑。
