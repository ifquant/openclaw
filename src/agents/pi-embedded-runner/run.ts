import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeAgentStartResult } from "../../plugins/types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { hasConfiguredModelFallbacks } from "../agent-scope.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileGood,
  markAuthProfileUsed,
  resolveProfilesUnavailableReason,
} from "../auth-profiles.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  ensureAuthProfileStore,
  getApiKeyForModel,
  resolveAuthProfileOrder,
  type ResolvedProviderAuth,
} from "../model-auth.js";
import { normalizeProviderId } from "../model-selection.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import {
  formatBillingErrorMessage,
  classifyFailoverReason,
  formatAssistantErrorText,
  isAuthAssistantError,
  isBillingAssistantError,
  isCompactionFailureError,
  isLikelyContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  parseImageSizeError,
  parseImageDimensionError,
  isRateLimitAssistantError,
  isTimeoutErrorMessage,
  pickFallbackThinkingLevel,
  type FailoverReason,
} from "../pi-embedded-helpers.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../usage.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModel } from "./model.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import {
  truncateOversizedToolResultsInSession,
  sessionLikelyHasOversizedToolResults,
} from "./tool-result-truncation.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
import { describeUnknownError } from "./utils.js";

type ApiKeyInfo = ResolvedProviderAuth;

// Avoid Anthropic's refusal test token poisoning session transcripts.
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Cache fields from the most recent API call (not accumulated). */
  lastCacheRead: number;
  lastCacheWrite: number;
  lastInput: number;
};

const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  lastCacheRead: 0,
  lastCacheWrite: 0,
  lastInput: 0,
});

function createCompactionDiagId(): string {
  return `ovf-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

// Defensive guard for the outer run loop across all retry branches.
const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}

const hasUsageValues = (
  usage: ReturnType<typeof normalizeUsage>,
): usage is NonNullable<ReturnType<typeof normalizeUsage>> =>
  !!usage &&
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

const mergeUsageIntoAccumulator = (
  target: UsageAccumulator,
  usage: ReturnType<typeof normalizeUsage>,
) => {
  if (!hasUsageValues(usage)) {
    return;
  }
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.total +=
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  // Track the most recent API call's cache fields for accurate context-size reporting.
  // Accumulated cache totals inflate context size when there are multiple tool-call round-trips,
  // since each call reports cacheRead ≈ current_context_size.
  target.lastCacheRead = usage.cacheRead ?? 0;
  target.lastCacheWrite = usage.cacheWrite ?? 0;
  target.lastInput = usage.input ?? 0;
};

const toNormalizedUsage = (usage: UsageAccumulator) => {
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.total > 0;
  if (!hasUsage) {
    return undefined;
  }
  // Use the LAST API call's cache fields for context-size calculation.
  // The accumulated cacheRead/cacheWrite inflate context size because each tool-call
  // round-trip reports cacheRead ≈ current_context_size, and summing N calls gives
  // N × context_size which gets clamped to contextWindow (e.g. 200k).
  // See: https://github.com/openclaw/openclaw/issues/13698
  //
  // We use lastInput/lastCacheRead/lastCacheWrite (from the most recent API call) for
  // cache-related fields, but keep accumulated output (total generated text this turn).
  const lastPromptTokens = usage.lastInput + usage.lastCacheRead + usage.lastCacheWrite;
  return {
    input: usage.lastInput || undefined,
    output: usage.output || undefined,
    cacheRead: usage.lastCacheRead || undefined,
    cacheWrite: usage.lastCacheWrite || undefined,
    total: lastPromptTokens + usage.output || undefined,
  };
};

function resolveActiveErrorContext(params: {
  lastAssistant: { provider?: string; model?: string } | undefined;
  provider: string;
  model: string;
}): { provider: string; model: string } {
  return {
    provider: params.lastAssistant?.provider ?? params.provider,
    model: params.lastAssistant?.model ?? params.model,
  };
}

export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  /**
   * `runEmbeddedPiAgent` 是 embedded runner 的外层调度壳：
   * - 先做 session/global lane 排队，避免同会话和全局资源并发打架
   * - 解析 workspace、provider/model、auth profile 与 context-window 护栏
   * - 调用 `runEmbeddedAttempt` 执行一次真正的 agent 尝试
   * - 根据 attempt 结果决定是否要切换 profile、降 thinking、做 compaction 恢复
   * - 最后把内部运行结果整理成统一的 `EmbeddedPiRunResult`
   *
   * 这层函数的关键不在“如何具体执行一次 prompt”，而在“这一轮失败后要不要继续试，
   * 以及下一轮该换什么条件再试”。
   */
  // 同一个 session 要串行，避免 transcript 和工具执行互相覆盖；
  // 同时还要再过一层 global lane，限制整个进程级共享资源的并发压力。
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  return enqueueSession(() =>
    enqueueGlobal(async () => {
      const started = Date.now();
      // workspace 解析不是简单地“取传入路径”。
      // 这里可能会根据 session/agent/config 回退到更安全或更稳定的目录。
      const workspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }
      const prevCwd = process.cwd();

      let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
      // fallbackConfigured 不是“当前已经在 fallback”。
      // 它表示：如果这轮出现某些可恢复错误，是否允许把错误升级给更高层去换模型。
      const fallbackConfigured = hasConfiguredModelFallbacks({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      await ensureOpenClawModelsJson(params.config, agentDir);

      // 这里先给插件最后一次机会改 provider/model。
      // 必须发生在 resolveModel() 之前，因为一旦模型对象已经解析完成，
      // 后面再改字符串就没有意义了。
      //
      // 同时继续兼容旧版 before_agent_start 里的 override 字段；
      // 如果新旧 hook 都提供了值，以新的 before_model_resolve 为准。
      let modelResolveOverride: { providerOverride?: string; modelOverride?: string } | undefined;
      let legacyBeforeAgentStartResult: PluginHookBeforeAgentStartResult | undefined;
      const hookRunner = getGlobalHookRunner();
      const hookCtx = {
        agentId: workspaceResolution.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        workspaceDir: resolvedWorkspace,
        messageProvider: params.messageProvider ?? undefined,
      };
      if (hookRunner?.hasHooks("before_model_resolve")) {
        try {
          modelResolveOverride = await hookRunner.runBeforeModelResolve(
            { prompt: params.prompt },
            hookCtx,
          );
        } catch (hookErr) {
          log.warn(`before_model_resolve hook failed: ${String(hookErr)}`);
        }
      }
      if (hookRunner?.hasHooks("before_agent_start")) {
        try {
          legacyBeforeAgentStartResult = await hookRunner.runBeforeAgentStart(
            { prompt: params.prompt },
            hookCtx,
          );
          modelResolveOverride = {
            providerOverride:
              modelResolveOverride?.providerOverride ??
              legacyBeforeAgentStartResult?.providerOverride,
            modelOverride:
              modelResolveOverride?.modelOverride ?? legacyBeforeAgentStartResult?.modelOverride,
          };
        } catch (hookErr) {
          log.warn(
            `before_agent_start hook (legacy model resolve path) failed: ${String(hookErr)}`,
          );
        }
      }
      if (modelResolveOverride?.providerOverride) {
        provider = modelResolveOverride.providerOverride;
        log.info(`[hooks] provider overridden to ${provider}`);
      }
      if (modelResolveOverride?.modelOverride) {
        modelId = modelResolveOverride.modelOverride;
        log.info(`[hooks] model overridden to ${modelId}`);
      }

      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        params.config,
      );
      if (!model) {
        throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
          reason: "model_not_found",
          provider,
          model: modelId,
        });
      }

      const ctxInfo = resolveContextWindowInfo({
        cfg: params.config,
        provider,
        modelId,
        modelContextWindow: model.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      });
      const ctxGuard = evaluateContextWindowGuard({
        info: ctxInfo,
        warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
        hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      });
      if (ctxGuard.shouldWarn) {
        log.warn(
          `low context window: ${provider}/${modelId} ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
        );
      }
      if (ctxGuard.shouldBlock) {
        // 这里直接拦截，而不是让请求继续进入 attempt。
        // 如果模型窗口小到明显不合格，后面无论怎么拼 prompt 或压历史都只是浪费时间。
        log.error(
          `blocked model (context window too small): ${provider}/${modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}`,
        );
        throw new FailoverError(
          `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
          { reason: "unknown", provider, model: modelId },
        );
      }

      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      const preferredProfileId = params.authProfileId?.trim();
      // lockedProfileId 表示“用户显式锁死到某个账号”。
      // 一旦锁定，本轮 run 就不能再自动轮换到别的 profile。
      let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
      if (lockedProfileId) {
        const lockedProfile = authStore.profiles[lockedProfileId];
        if (
          !lockedProfile ||
          normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(provider)
        ) {
          lockedProfileId = undefined;
        }
      }
      const profileOrder = resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider,
        preferredProfile: preferredProfileId,
      });
      if (lockedProfileId && !profileOrder.includes(lockedProfileId)) {
        throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
      }
      const profileCandidates = lockedProfileId
        ? [lockedProfileId]
        : profileOrder.length > 0
          ? profileOrder
          : [undefined];
      let profileIndex = 0;

      // thinking 级别也参与外层重试决策：某些模型不支持高 thinking，
      // 这时会在不换模型的前提下，先降级 thinking 再试一次。
      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;

      const resolveAuthProfileFailoverReason = (params: {
        allInCooldown: boolean;
        message: string;
        profileIds?: Array<string | undefined>;
      }): FailoverReason => {
        if (params.allInCooldown) {
          // 如果所有 profile 都在 cooldown，优先从 profile 状态反推真正原因，
          // 而不是只看当前报错文本。
          const profileIds = (params.profileIds ?? profileCandidates).filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
          return (
            resolveProfilesUnavailableReason({
              store: authStore,
              profileIds,
            }) ?? "rate_limit"
          );
        }
        const classified = classifyFailoverReason(params.message);
        return classified ?? "auth";
      };

      const throwAuthProfileFailover = (params: {
        allInCooldown: boolean;
        message?: string;
        error?: unknown;
      }): never => {
        const fallbackMessage = `No available auth profile for ${provider} (all in cooldown or unavailable).`;
        const message =
          params.message?.trim() ||
          (params.error ? describeUnknownError(params.error).trim() : "") ||
          fallbackMessage;
        const reason = resolveAuthProfileFailoverReason({
          allInCooldown: params.allInCooldown,
          message,
          profileIds: profileCandidates,
        });
        if (fallbackConfigured) {
          // 配置了模型 fallback 时，这里不要把问题吃掉。
          // 要升级成 FailoverError，让更高层有机会直接切 provider/model。
          throw new FailoverError(message, {
            reason,
            provider,
            model: modelId,
            status: resolveFailoverStatus(reason),
            cause: params.error,
          });
        }
        if (params.error instanceof Error) {
          throw params.error;
        }
        throw new Error(message);
      };

      const resolveApiKeyForCandidate = async (candidate?: string) => {
        return getApiKeyForModel({
          model,
          cfg: params.config,
          profileId: candidate,
          store: authStore,
          agentDir,
        });
      };

      const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
        apiKeyInfo = await resolveApiKeyForCandidate(candidate);
        const resolvedProfileId = apiKeyInfo.profileId ?? candidate;
        if (!apiKeyInfo.apiKey) {
          // 某些模式（例如 aws-sdk）不需要传统 API key。
          // 这里只在“本应拿到 key 却没有”的情况下才视为异常。
          if (apiKeyInfo.mode !== "aws-sdk") {
            throw new Error(
              `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
            );
          }
          lastProfileId = resolvedProfileId;
          return;
        }
        if (model.provider === "github-copilot") {
          // Copilot 不能直接拿 GitHub token 当运行时 API key，
          // 要先换成真正可调用模型接口的短期 token。
          const { resolveCopilotApiToken } =
            await import("../../providers/github-copilot-token.js");
          const copilotToken = await resolveCopilotApiToken({
            githubToken: apiKeyInfo.apiKey,
          });
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
        } else {
          authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        }
        lastProfileId = apiKeyInfo.profileId;
      };

      const advanceAuthProfile = async (): Promise<boolean> => {
        if (lockedProfileId) {
          return false;
        }
        // profile 轮换不仅切账号，还会把 thinking 级别和“已经试过的 thinking 集合”
        // 一并重置，避免新账号平白继承上一账号的降级状态。
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          if (candidate && isProfileInCooldown(authStore, candidate)) {
            nextIndex += 1;
            continue;
          }
          try {
            await applyApiKeyInfo(candidate);
            profileIndex = nextIndex;
            thinkLevel = initialThinkLevel;
            attemptedThinking.clear();
            return true;
          } catch (err) {
            if (candidate && candidate === lockedProfileId) {
              throw err;
            }
            nextIndex += 1;
          }
        }
        return false;
      };

      try {
        // 先为第一轮 run 找到一个真正可用的 profile。
        // 如果连第一轮都选不出来，后面的 attempt 就不该启动。
        while (profileIndex < profileCandidates.length) {
          const candidate = profileCandidates[profileIndex];
          if (
            candidate &&
            candidate !== lockedProfileId &&
            isProfileInCooldown(authStore, candidate)
          ) {
            profileIndex += 1;
            continue;
          }
          await applyApiKeyInfo(profileCandidates[profileIndex]);
          break;
        }
        if (profileIndex >= profileCandidates.length) {
          throwAuthProfileFailover({ allInCooldown: true });
        }
      } catch (err) {
        if (err instanceof FailoverError) {
          throw err;
        }
        if (profileCandidates[profileIndex] === lockedProfileId) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
        const advanced = await advanceAuthProfile();
        if (!advanced) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
      }

      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
      const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(profileCandidates.length);
      // overflowCompactionAttempts 和 toolResultTruncationAttempted 是“外层 run 级”的，
      // 不是单个 attempt 级的。它们要跨重试轮次累计，才能防止恢复逻辑无限打转。
      let overflowCompactionAttempts = 0;
      let toolResultTruncationAttempted = false;
      const usageAccumulator = createUsageAccumulator();
      let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      let autoCompactionCount = 0;
      let runLoopIterations = 0;
      const maybeMarkAuthProfileFailure = async (failure: {
        profileId?: string;
        reason?: Parameters<typeof markAuthProfileFailure>[0]["reason"] | null;
        config?: RunEmbeddedPiAgentParams["config"];
        agentDir?: RunEmbeddedPiAgentParams["agentDir"];
      }) => {
        const { profileId, reason } = failure;
        // timeout 不记进 profile cooldown。
        // 超时更可能是模型/网络波动，而不是这个账号凭证本身坏了。
        if (!profileId || !reason || reason === "timeout") {
          return;
        }
        await markAuthProfileFailure({
          store: authStore,
          profileId,
          reason,
          cfg: params.config,
          agentDir,
        });
      };
      try {
        while (true) {
          if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
            const message =
              `Exceeded retry limit after ${runLoopIterations} attempts ` +
              `(max=${MAX_RUN_LOOP_ITERATIONS}).`;
            log.error(
              `[run-retry-limit] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} attempts=${runLoopIterations} ` +
                `maxAttempts=${MAX_RUN_LOOP_ITERATIONS}`,
            );
            return {
              payloads: [
                {
                  text:
                    "Request failed after repeated internal retries. " +
                    "Please try again, or use /new to start a fresh session.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: {
                  sessionId: params.sessionId,
                  provider,
                  model: model.id,
                },
                error: { kind: "retry_limit", message },
              },
            };
          }
          runLoopIterations += 1;
          attemptedThinking.add(thinkLevel);
          await fs.mkdir(resolvedWorkspace, { recursive: true });

          // Anthropic 的某些拒绝测试魔法串如果直接写进 transcript，后续会污染 session。
          // 这里只在真正发往 Anthropic 前做脱敏替换，避免后续重试也被同一字符串毒化。
          const prompt =
            provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt;

          // 从这里开始，才真正进入“单次具体尝试”。
          // 这个 attempt 已经拿到了当前轮决定好的 provider/model/profile/thinking 条件。
          const attempt = await runEmbeddedAttempt({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            spawnedBy: params.spawnedBy,
            senderIsOwner: params.senderIsOwner,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            sessionFile: params.sessionFile,
            workspaceDir: resolvedWorkspace,
            agentDir,
            config: params.config,
            skillsSnapshot: params.skillsSnapshot,
            prompt,
            images: params.images,
            disableTools: params.disableTools,
            provider,
            modelId,
            model,
            authStorage,
            modelRegistry,
            agentId: workspaceResolution.agentId,
            legacyBeforeAgentStartResult,
            thinkLevel,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: params.timeoutMs,
            runId: params.runId,
            abortSignal: params.abortSignal,
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onPartialReply: params.onPartialReply,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onReasoningStream: params.onReasoningStream,
            onReasoningEnd: params.onReasoningEnd,
            onToolResult: params.onToolResult,
            onAgentEvent: params.onAgentEvent,
            extraSystemPrompt: params.extraSystemPrompt,
            inputProvenance: params.inputProvenance,
            streamParams: params.streamParams,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
          });

          const {
            aborted,
            promptError,
            timedOut,
            timedOutDuringCompaction,
            sessionIdUsed,
            lastAssistant,
          } = attempt;
          const lastAssistantUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const attemptUsage = attempt.attemptUsage ?? lastAssistantUsage;
          mergeUsageIntoAccumulator(usageAccumulator, attemptUsage);
          // 这里单独保留“最后一次模型调用”的 usage，
          // 避免 tool loop / compaction 重试把累计 usage 误当成当前上下文大小。
          lastRunPromptUsage = lastAssistantUsage ?? attemptUsage;
          const lastTurnTotal = lastAssistantUsage?.total ?? attemptUsage?.total;
          const attemptCompactionCount = Math.max(0, attempt.compactionCount ?? 0);
          autoCompactionCount += attemptCompactionCount;
          const activeErrorContext = resolveActiveErrorContext({
            lastAssistant,
            provider,
            model: modelId,
          });
          const formattedAssistantErrorText = lastAssistant
            ? formatAssistantErrorText(lastAssistant, {
                cfg: params.config,
                sessionKey: params.sessionKey ?? params.sessionId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
              })
            : undefined;
          const assistantErrorText =
            lastAssistant?.stopReason === "error"
              ? lastAssistant.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;

          const contextOverflowError = !aborted
            ? (() => {
                if (promptError) {
                  const errorText = describeUnknownError(promptError);
                  if (isLikelyContextOverflowError(errorText)) {
                    return { text: errorText, source: "promptError" as const };
                  }
                  // prompt 提交阶段已经明确失败，且不是 overflow。
                  // 这时不要再回头拿历史 assistant error 混进来，否则会误判这轮失败原因。
                  return null;
                }
                if (assistantErrorText && isLikelyContextOverflowError(assistantErrorText)) {
                  return { text: assistantErrorText, source: "assistantError" as const };
                }
                return null;
              })()
            : null;

          if (contextOverflowError) {
            // context overflow 是这层函数最重的恢复分支：
            // 先判断这次 overflow 是不是 compaction 自己失败导致的，
            // 再决定要不要显式触发一次 overflow compaction，最后才考虑裁工具结果。
            const overflowDiagId = createCompactionDiagId();
            const errorText = contextOverflowError.text;
            const msgCount = attempt.messagesSnapshot?.length ?? 0;
            log.warn(
              `[context-overflow-diag] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} source=${contextOverflowError.source} ` +
                `messages=${msgCount} sessionFile=${params.sessionFile} ` +
                `diagId=${overflowDiagId} compactionAttempts=${overflowCompactionAttempts} ` +
                `error=${errorText.slice(0, 200)}`,
            );
            const isCompactionFailure = isCompactionFailureError(errorText);
            const hadAttemptLevelCompaction = attemptCompactionCount > 0;
            // 如果这次 attempt 内部已经发生过自动 compaction，就不要立刻再手动 compact 一次。
            // 否则很容易变成“同一个 overflow 触发器”连续压两遍。
            if (
              !isCompactionFailure &&
              hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              overflowCompactionAttempts++;
              log.warn(
                `context overflow persisted after in-attempt compaction (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); retrying prompt without additional compaction for ${provider}/${modelId}`,
              );
              continue;
            }
            // 显式 overflow compaction 只在“本轮还没自动 compact 过”时才尝试。
            if (
              !isCompactionFailure &&
              !hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=compact ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                    `attempt=${overflowCompactionAttempts + 1} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
              overflowCompactionAttempts++;
              log.warn(
                `context overflow detected (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); attempting auto-compaction for ${provider}/${modelId}`,
              );
              const compactResult = await compactEmbeddedPiSessionDirect({
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                messageChannel: params.messageChannel,
                messageProvider: params.messageProvider,
                agentAccountId: params.agentAccountId,
                authProfileId: lastProfileId,
                sessionFile: params.sessionFile,
                workspaceDir: resolvedWorkspace,
                agentDir,
                config: params.config,
                skillsSnapshot: params.skillsSnapshot,
                senderIsOwner: params.senderIsOwner,
                provider,
                model: modelId,
                runId: params.runId,
                thinkLevel,
                reasoningLevel: params.reasoningLevel,
                bashElevated: params.bashElevated,
                extraSystemPrompt: params.extraSystemPrompt,
                ownerNumbers: params.ownerNumbers,
                trigger: "overflow",
                diagId: overflowDiagId,
                attempt: overflowCompactionAttempts,
                maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
              });
              if (compactResult.compacted) {
                autoCompactionCount += 1;
                log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
                continue;
              }
              log.warn(
                `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
              );
            }
            // compaction 也救不回来时，再退到“裁掉超大 tool result”这条兜底路。
            // 它针对的是单个工具结果块本身就大得离谱，压缩历史结构也缩不下来的场景。
            if (!toolResultTruncationAttempted) {
              const contextWindowTokens = ctxInfo.tokens;
              const hasOversized = attempt.messagesSnapshot
                ? sessionLikelyHasOversizedToolResults({
                    messages: attempt.messagesSnapshot,
                    contextWindowTokens,
                  })
                : false;

              if (hasOversized) {
                if (log.isEnabled("debug")) {
                  log.debug(
                    `[compaction-diag] decision diagId=${overflowDiagId} branch=truncate_tool_results ` +
                      `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=${hasOversized} ` +
                      `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                  );
                }
                toolResultTruncationAttempted = true;
                log.warn(
                  `[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} ` +
                    `(contextWindow=${contextWindowTokens} tokens)`,
                );
                const truncResult = await truncateOversizedToolResultsInSession({
                  sessionFile: params.sessionFile,
                  contextWindowTokens,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                });
                if (truncResult.truncated) {
                  log.info(
                    `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
                  );
                  // 这里不要把 overflowCompactionAttempts 清零。
                  // compaction 重试上限必须跨整个 run 生效，否则会重新打开无限恢复循环。
                  continue;
                }
                log.warn(
                  `[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`,
                );
              } else if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=${hasOversized} ` +
                    `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
            }
            if (
              (isCompactionFailure ||
                overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS ||
                toolResultTruncationAttempted) &&
              log.isEnabled("debug")
            ) {
              log.debug(
                `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                  `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                  `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
              );
            }
            const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
            return {
              payloads: [
                {
                  text:
                    "Context overflow: prompt too large for the model. " +
                    "Try /reset (or /new) to start a fresh session, or use a larger-context model.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: {
                  sessionId: sessionIdUsed,
                  provider,
                  model: model.id,
                },
                systemPromptReport: attempt.systemPromptReport,
                error: { kind, message: errorText },
              },
            };
          }

          if (promptError && !aborted) {
            const errorText = describeUnknownError(promptError);
            // role 排序错误通常不是“重试一次就好”的问题，直接返回更明确的用户提示。
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              return {
                payloads: [
                  {
                    text:
                      "Message ordering conflict - please try again. " +
                      "If this persists, use /new to start a fresh session.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: {
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                  },
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "role_ordering", message: errorText },
                },
              };
            }
            // 图片尺寸/大小超限也不值得内部重试，直接提示用户换图更合理。
            const imageSizeError = parseImageSizeError(errorText);
            if (imageSizeError) {
              const maxMb = imageSizeError.maxMb;
              const maxMbLabel =
                typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
              const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
              return {
                payloads: [
                  {
                    text:
                      `Image too large for the model${maxBytesHint}. ` +
                      "Please compress or resize the image and try again.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: {
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                  },
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "image_size", message: errorText },
                },
              };
            }
            const promptFailoverReason = classifyFailoverReason(errorText);
            await maybeMarkAuthProfileFailure({
              profileId: lastProfileId,
              reason: promptFailoverReason,
            });
            if (
              isFailoverErrorMessage(errorText) &&
              promptFailoverReason !== "timeout" &&
              (await advanceAuthProfile())
            ) {
              continue;
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            // 如果当前 agent 配了模型 fallback，这类 prompt 阶段的可切换错误
            // 不能只在本函数里兜底，要升级成 FailoverError 交给更高层换模型。
            if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
              throw new FailoverError(errorText, {
                reason: promptFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status: resolveFailoverStatus(promptFailoverReason ?? "unknown"),
              });
            }
            throw promptError;
          }

          const fallbackThinking = pickFallbackThinkingLevel({
            message: lastAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const authFailure = isAuthAssistantError(lastAssistant);
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant);
          const billingFailure = isBillingAssistantError(lastAssistant);
          const failoverFailure = isFailoverAssistantError(lastAssistant);
          const assistantFailoverReason = classifyFailoverReason(lastAssistant?.errorMessage ?? "");
          const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
          const imageDimensionError = parseImageDimensionError(lastAssistant?.errorMessage ?? "");

          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          // shouldRotate 决定的是：这轮是否该尝试切到下一个 auth profile。
          // 注意 compaction 期间超时不算 profile 问题，因为模型主调用其实已经完成了。
          const shouldRotate =
            (!aborted && failoverFailure) || (timedOut && !timedOutDuringCompaction);

          if (shouldRotate) {
            if (lastProfileId) {
              const reason =
                timedOut || assistantFailoverReason === "timeout"
                  ? "timeout"
                  : (assistantFailoverReason ?? "unknown");
              // timeout 不记 cooldown。否则会把“网络/模型抖动”误伤成“账号坏了”，
              // 连同同 provider 下其他 fallback 模型一起污染掉。
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason,
              });
              if (timedOut && !isProbeSession) {
                log.warn(`Profile ${lastProfileId} timed out. Trying next account...`);
              }
              if (cloudCodeAssistFormatError) {
                log.warn(
                  `Profile ${lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
                );
              }
            }

            const rotated = await advanceAuthProfile();
            if (rotated) {
              continue;
            }

            if (fallbackConfigured) {
              // 这里优先用格式化后的错误文案，把 provider 特定错误翻成更可读的文本，
              // 再升级成 FailoverError 交给更高层模型切换逻辑。
              const message =
                (lastAssistant
                  ? formatAssistantErrorText(lastAssistant, {
                      cfg: params.config,
                      sessionKey: params.sessionKey ?? params.sessionId,
                      provider: activeErrorContext.provider,
                      model: activeErrorContext.model,
                    })
                  : undefined) ||
                lastAssistant?.errorMessage?.trim() ||
                (timedOut
                  ? "LLM request timed out."
                  : rateLimitFailure
                    ? "LLM request rate limited."
                    : billingFailure
                      ? formatBillingErrorMessage(
                          activeErrorContext.provider,
                          activeErrorContext.model,
                        )
                      : authFailure
                        ? "LLM request unauthorized."
                        : "LLM request failed.");
              const status =
                resolveFailoverStatus(assistantFailoverReason ?? "unknown") ??
                (isTimeoutErrorMessage(message) ? 408 : undefined);
              throw new FailoverError(message, {
                reason: assistantFailoverReason ?? "unknown",
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
                profileId: lastProfileId,
                status,
              });
            }
          }

          const usage = toNormalizedUsage(usageAccumulator);
          if (usage && lastTurnTotal && lastTurnTotal > 0) {
            usage.total = lastTurnTotal;
          }
          // usage 是整轮 run 的累计量，但 context window 展示更需要“最后一次调用”的快照。
          // 所以这里同时保留累计 usage 和 lastCallUsage 两套视角。
          const lastCallUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const promptTokens = derivePromptTokens(lastRunPromptUsage);
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: lastAssistant?.provider ?? provider,
            model: lastAssistant?.model ?? model.id,
            usage,
            lastCallUsage: lastCallUsage ?? undefined,
            promptTokens,
            compactionCount: autoCompactionCount > 0 ? autoCompactionCount : undefined,
          };

          const payloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            lastToolError: attempt.lastToolError,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            suppressToolErrorWarnings: params.suppressToolErrorWarnings,
            inlineToolResultsAllowed: false,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
          });

          // 超时中断可能让这一轮完全没有 assistant payload。
          // 这里要显式吐一个 timeout 错误，而不是静默成功返回，
          // 否则调用方看到的只会是一个孤立 user turn。
          if (timedOut && !timedOutDuringCompaction && payloads.length === 0) {
            return {
              payloads: [
                {
                  text:
                    "Request timed out before a response was generated. " +
                    "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
          }
          return {
            payloads: payloads.length ? payloads : undefined,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              // 如果这轮命中了宿主侧托管 client tool，就把 stopReason 和 pendingToolCalls
              // 按 OpenResponses 风格补回去，方便更上层继续接这个 tool call。
              stopReason: attempt.clientToolCall ? "tool_calls" : undefined,
              pendingToolCalls: attempt.clientToolCall
                ? [
                    {
                      id: randomBytes(5).toString("hex").slice(0, 9),
                      name: attempt.clientToolCall.name,
                      arguments: JSON.stringify(attempt.clientToolCall.params),
                    },
                  ]
                : undefined,
            },
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
            successfulCronAdds: attempt.successfulCronAdds,
          };
        }
      } finally {
        // 外层调度壳无论走到哪条分支，都要把 cwd 还原。
        // 这层和 attempt 都可能切目录，所以最终出口必须做一次卫生收尾。
        process.chdir(prevCwd);
      }
    }),
  );
}
