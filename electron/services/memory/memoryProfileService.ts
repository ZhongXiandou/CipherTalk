import type { AIProvider } from '../ai/providers/base'
import { hashMemoryContent, memoryDatabase } from './memoryDatabase'
import { memoryBuildService } from './memoryBuildService'
import type { MemoryEvidenceRef, MemoryItem, MemoryItemInput } from './memorySchema'

export type SessionProfileMemoryState = {
  sessionId: string
  profileCount: number
  memoryId?: number
  memoryUid?: string
  updatedAt?: number
  isRunning: boolean
  lastError?: string
}

export type SessionProfileMemoryBuildOptions = {
  sessionId: string
  sessionName?: string
  provider: AIProvider
  model: string
}

export type SessionProfileMemoryBuildResult = SessionProfileMemoryState & {
  content: string
  provider: string
  model: string
}

type ProfileBuildTask = {
  promise: Promise<SessionProfileMemoryBuildResult>
  state: SessionProfileMemoryState
}

type PersonaProfileJson = {
  targetName?: string
  profileType?: string
  overview?: string
  relationship?: string
  personality?: string[]
  topics?: string[]
  communicationStyle?: {
    tone?: string
    sentencePattern?: string
    punctuation?: string
    emojiHabit?: string
    catchphrases?: string[]
  }
  preferences?: string[]
  cautions?: string[]
  evidenceSummary?: string[]
}

const PROFILE_MEMORY_VERSION = 'llm:v1'
const PROFILE_MEMORY_CONTEXT_LIMIT = 12000
const PROFILE_MEMORY_TEXT_LIMIT = 8000
const PROFILE_SAMPLE_LIMITS: Record<'fact' | 'conversation_block' | 'message', number> = {
  fact: 80,
  conversation_block: 40,
  message: 180
}

function compactText(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function stripThinkBlocks(value: string): string {
  return String(value || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

function stripJsonFence(value: string): string {
  const text = stripThinkBlocks(value)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : text).trim()
}

function isGroupSession(sessionId: string): boolean {
  return sessionId.includes('@chatroom')
}

function profileMemoryUid(sessionId: string): string {
  return `profile:${sessionId}:${PROFILE_MEMORY_VERSION}`
}

function buildSessionRefs(sessionId: string): Pick<MemoryItemInput, 'sessionId' | 'contactId' | 'groupId'> {
  return {
    sessionId,
    contactId: isGroupSession(sessionId) ? null : sessionId,
    groupId: isGroupSession(sessionId) ? sessionId : null
  }
}

function uniqueStrings(values: unknown[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

function normalizeProfileJson(value: Record<string, unknown>, fallbackName: string): PersonaProfileJson {
  const style = value.communicationStyle && typeof value.communicationStyle === 'object'
    ? value.communicationStyle as Record<string, unknown>
    : {}

  return {
    targetName: compactText(String(value.targetName || fallbackName || '当前会话'), 80),
    profileType: compactText(String(value.profileType || 'session_profile'), 40),
    overview: compactText(String(value.overview || ''), 600),
    relationship: compactText(String(value.relationship || ''), 240),
    personality: uniqueStrings(Array.isArray(value.personality) ? value.personality : [], 8),
    topics: uniqueStrings(Array.isArray(value.topics) ? value.topics : [], 12),
    communicationStyle: {
      tone: compactText(String(style.tone || ''), 160),
      sentencePattern: compactText(String(style.sentencePattern || ''), 160),
      punctuation: compactText(String(style.punctuation || ''), 120),
      emojiHabit: compactText(String(style.emojiHabit || ''), 120),
      catchphrases: uniqueStrings(Array.isArray(style.catchphrases) ? style.catchphrases : [], 12)
    },
    preferences: uniqueStrings(Array.isArray(value.preferences) ? value.preferences : [], 12),
    cautions: uniqueStrings(Array.isArray(value.cautions) ? value.cautions : [], 10),
    evidenceSummary: uniqueStrings(Array.isArray(value.evidenceSummary) ? value.evidenceSummary : [], 8)
  }
}

function parseProfileJson(response: string, fallbackName: string): PersonaProfileJson {
  const parsed = JSON.parse(stripJsonFence(response)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('画像生成结果不是 JSON 对象')
  }

  const profile = normalizeProfileJson(parsed as Record<string, unknown>, fallbackName)
  if (!profile.overview && !profile.communicationStyle?.tone && profile.topics?.length === 0) {
    throw new Error('画像 JSON 缺少可用内容')
  }
  return profile
}

function renderList(title: string, values?: string[]): string {
  const items = (values || []).filter(Boolean)
  if (!items.length) return ''
  return [`## ${title}`, ...items.map((item) => `- ${item}`)].join('\n')
}

function renderProfileContent(profile: PersonaProfileJson): string {
  const style = profile.communicationStyle || {}
  const sections = [
    `# ${profile.targetName || '当前会话'} 数字分身画像`,
    profile.overview ? `## 概览\n${profile.overview}` : '',
    profile.relationship ? `## 关系与互动\n${profile.relationship}` : '',
    renderList('性格与行为倾向', profile.personality),
    renderList('高频主题', profile.topics),
    [
      '## 语言风格',
      style.tone ? `- 语气：${style.tone}` : '',
      style.sentencePattern ? `- 句式：${style.sentencePattern}` : '',
      style.punctuation ? `- 标点：${style.punctuation}` : '',
      style.emojiHabit ? `- 表情习惯：${style.emojiHabit}` : '',
      style.catchphrases?.length ? `- 常用表达：${style.catchphrases.join('、')}` : ''
    ].filter(Boolean).join('\n'),
    renderList('偏好与关注点', profile.preferences),
    renderList('互动注意事项', profile.cautions),
    renderList('证据摘要', profile.evidenceSummary)
  ].filter(Boolean)

  return compactText(sections.join('\n\n'), PROFILE_MEMORY_TEXT_LIMIT)
}

function collectSourceRefs(memories: MemoryItem[], limit = 30): MemoryEvidenceRef[] {
  const refs: MemoryEvidenceRef[] = []
  const seen = new Set<string>()
  for (const memory of memories) {
    for (const ref of memory.sourceRefs || []) {
      const key = `${ref.sessionId}:${ref.localId}:${ref.createTime}:${ref.sortSeq}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({
        sessionId: ref.sessionId,
        localId: ref.localId,
        createTime: ref.createTime,
        sortSeq: ref.sortSeq,
        ...(ref.senderUsername ? { senderUsername: ref.senderUsername } : {}),
        ...(ref.excerpt ? { excerpt: compactText(ref.excerpt, 160) } : {})
      })
      if (refs.length >= limit) return refs
    }
  }
  return refs
}

function buildMemoryContext(memories: MemoryItem[]): string {
  const lines: string[] = []
  for (const [index, memory] of memories.entries()) {
    const time = memory.timeStart || memory.timeEnd
      ? `${memory.timeStart || ''}${memory.timeEnd && memory.timeEnd !== memory.timeStart ? `-${memory.timeEnd}` : ''}`
      : 'unknown'
    const refs = memory.sourceRefs.slice(0, 2)
      .map((ref) => `${ref.createTime}:${compactText(ref.excerpt || '', 80)}`)
      .filter(Boolean)
      .join('；')
    lines.push([
      `${index + 1}. [${memory.sourceType}] ${memory.title || '无标题'} | time=${time} | importance=${memory.importance}`,
      compactText(memory.content, 420),
      refs ? `证据：${refs}` : ''
    ].filter(Boolean).join('\n'))
  }
  return compactText(lines.join('\n\n'), PROFILE_MEMORY_CONTEXT_LIMIT)
}

function buildProfilePrompt(input: {
  sessionId: string
  sessionName?: string
  memories: MemoryItem[]
}): string {
  return `请基于下面的本地微信会话长期记忆，为“${input.sessionName || input.sessionId}”生成数字分身画像。

要求：
1. 只根据给定材料总结，不要编造没有证据的事实。
2. 画像用于后续 RAG 检索和 system prompt 组装，重点关注长期稳定特征、语言风格、互动关系、偏好与注意事项。
3. 如果证据不足，对应字段用空数组或空字符串，不要猜测。
4. 只输出一个严格 JSON 对象，不要 Markdown，不要解释。

JSON 字段：
{
  "targetName": "会话对象或群名",
  "profileType": "contact_profile 或 group_profile",
  "overview": "100-200字画像概览",
  "relationship": "与用户的互动关系和边界",
  "personality": ["性格/行为倾向"],
  "topics": ["高频主题或长期关注点"],
  "communicationStyle": {
    "tone": "语气",
    "sentencePattern": "句式特点",
    "punctuation": "标点习惯",
    "emojiHabit": "表情/贴图习惯",
    "catchphrases": ["常用表达"]
  },
  "preferences": ["偏好、习惯、重要事项"],
  "cautions": ["互动注意事项或敏感点"],
  "evidenceSummary": ["可追溯证据摘要"]
}

会话记忆：
${buildMemoryContext(input.memories) || '无'}`
}

function collectProfileMemories(sessionId: string): MemoryItem[] {
  const facts = memoryDatabase.listMemoryItems({
    sessionId,
    sourceType: 'fact',
    limit: PROFILE_SAMPLE_LIMITS.fact
  })
  const blocks = memoryDatabase.listMemoryItems({
    sessionId,
    sourceType: 'conversation_block',
    limit: PROFILE_SAMPLE_LIMITS.conversation_block
  })
  const messages = memoryDatabase.listMemoryItems({
    sessionId,
    sourceType: 'message',
    limit: PROFILE_SAMPLE_LIMITS.message
  })
  return [...facts, ...blocks, ...messages]
}

function buildProfileMemoryInput(input: {
  sessionId: string
  sessionName?: string
  profile: PersonaProfileJson
  memories: MemoryItem[]
}): MemoryItemInput {
  const content = renderProfileContent(input.profile)
  const title = `${input.sessionName || input.sessionId} 数字分身画像`
  const timeValues = input.memories
    .flatMap((memory) => [memory.timeStart, memory.timeEnd])
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
  return {
    memoryUid: profileMemoryUid(input.sessionId),
    sourceType: 'profile',
    ...buildSessionRefs(input.sessionId),
    title,
    content,
    contentHash: hashMemoryContent(title, content),
    entities: uniqueStrings([
      input.sessionName,
      input.profile.targetName,
      ...(input.profile.topics || []),
      ...((input.profile.communicationStyle?.catchphrases || []))
    ], 24),
    tags: ['profile', PROFILE_MEMORY_VERSION, isGroupSession(input.sessionId) ? 'group_profile' : 'contact_profile'],
    importance: 0.85,
    confidence: 0.82,
    timeStart: timeValues.length ? Math.min(...timeValues) : null,
    timeEnd: timeValues.length ? Math.max(...timeValues) : null,
    sourceRefs: collectSourceRefs(input.memories)
  }
}

export class MemoryProfileService {
  private tasks = new Map<string, ProfileBuildTask>()

  getSessionProfileState(sessionId: string): SessionProfileMemoryState {
    const normalizedSessionId = String(sessionId || '').trim()
    const running = this.tasks.get(normalizedSessionId)?.state
    if (running) return { ...running }
    if (!normalizedSessionId) {
      return {
        sessionId: '',
        profileCount: 0,
        isRunning: false
      }
    }

    const memoryUid = profileMemoryUid(normalizedSessionId)
    const item = normalizedSessionId ? memoryDatabase.getMemoryItemByUid(memoryUid) : null
    return {
      sessionId: normalizedSessionId,
      profileCount: item ? 1 : memoryDatabase.countMemoryItems({ sessionId: normalizedSessionId, sourceType: 'profile' }),
      ...(item ? { memoryId: item.id, memoryUid: item.memoryUid, updatedAt: item.updatedAt } : {}),
      isRunning: false
    }
  }

  async buildSessionProfileMemory(options: SessionProfileMemoryBuildOptions): Promise<SessionProfileMemoryBuildResult> {
    const sessionId = String(options.sessionId || '').trim()
    if (!sessionId) throw new Error('sessionId 不能为空')
    if (!options.provider) throw new Error('AI provider 不能为空')
    if (!String(options.model || '').trim()) throw new Error('AI model 不能为空')

    const existing = this.tasks.get(sessionId)
    if (existing) return existing.promise

    const state: SessionProfileMemoryState = {
      sessionId,
      profileCount: 0,
      isRunning: true
    }
    const task: ProfileBuildTask = {
      state,
      promise: this.runBuildSessionProfileMemory({ ...options, sessionId }, state)
    }
    this.tasks.set(sessionId, task)
    try {
      return await task.promise
    } finally {
      this.tasks.delete(sessionId)
    }
  }

  private async runBuildSessionProfileMemory(
    options: SessionProfileMemoryBuildOptions,
    state: SessionProfileMemoryState
  ): Promise<SessionProfileMemoryBuildResult> {
    try {
      let memories = collectProfileMemories(options.sessionId)
      if (memories.length === 0) {
        await memoryBuildService.prepareSessionMemory(options.sessionId)
        memories = collectProfileMemories(options.sessionId)
      }
      if (memories.length === 0) {
        throw new Error('当前会话没有可用于生成画像的记忆')
      }

      const raw = await options.provider.chat([
        {
          role: 'system',
          content: '你是 CipherTalk 的数字分身画像生成器。你只输出严格 JSON，不输出 Markdown 或解释。'
        },
        {
          role: 'user',
          content: buildProfilePrompt({
            sessionId: options.sessionId,
            sessionName: options.sessionName,
            memories
          })
        }
      ], {
        model: options.model,
        temperature: 0.2,
        maxTokens: 1200,
        enableThinking: false
      })

      const profile = parseProfileJson(raw, options.sessionName || options.sessionId)
      const item = memoryDatabase.upsertMemoryItem(buildProfileMemoryInput({
        sessionId: options.sessionId,
        sessionName: options.sessionName,
        profile,
        memories
      }))

      state.profileCount = 1
      state.memoryId = item.id
      state.memoryUid = item.memoryUid
      state.updatedAt = item.updatedAt
      state.isRunning = false
      return {
        ...state,
        content: item.content,
        provider: options.provider.name,
        model: options.model
      }
    } catch (error) {
      state.isRunning = false
      state.lastError = String(error)
      throw error
    }
  }
}

export const memoryProfileService = new MemoryProfileService()
