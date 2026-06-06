/**
 * 上下文压缩 —— 用 AI SDK pruneMessages 确定性裁剪（不额外花 LLM）。
 *
 * 本 agent 最大的上下文来源是工具结果（semantic_search / get_context 返回大数组），
 * 24 步 ReAct 循环里累积起来才是「爆上下文」的真凶。故在 engine 的 prepareStep 里，对
 * 「每步将发给模型的 messages」做裁剪：保留最近若干步的工具调用/结果原样，裁掉更早的
 * （它们已被模型消化进自己的文本回答），并去掉旧推理痕迹与空消息。prepareStep 在 step 0
 * 也会跑，所以一处即覆盖「历史轮次」与「循环内累积」两种情况。
 *
 * 对短对话是 no-op（消息数不足 KEEP_RECENT 时无可裁）。
 * 早期轮次「摘要化」（需额外 LLM 调用）作为后续可选项，暂不做。
 */
import { pruneMessages, type ModelMessage } from 'ai'

/** 保留最近这么多条消息的工具调用/结果原样，更早的裁掉（约 4 个工具往返）。 */
const KEEP_RECENT_TOOL_MESSAGES = 8

export function compactMessages(messages: ModelMessage[]): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: 'before-last-message',
    toolCalls: `before-last-${KEEP_RECENT_TOOL_MESSAGES}-messages`,
    emptyMessages: 'remove',
  })
}
