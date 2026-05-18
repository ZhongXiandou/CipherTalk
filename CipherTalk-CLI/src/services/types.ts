import type { RuntimeConfig } from '../types.js'

export interface StatusData {
  configured: boolean
  configPath: string
  dbPath?: string
  wxid?: string
  nativeRoot: string
  databaseFiles: number
  connection?: {
    attempted: boolean
    ok: boolean
    sessionCount?: number
    error?: string
  }
}

export interface SessionRow {
  sessionId: string
  displayName: string
  type: 'private' | 'group' | 'mp' | 'other'
  lastMessage: string
  lastTime: number
  messageCount?: number
}

export interface MessageRow {
  localId?: number
  serverId?: number
  createTime?: number
  sortSeq?: number
  direction: 'in' | 'out' | 'unknown'
  senderUsername?: string
  type?: number | string
  content: string
  raw?: unknown
}

export interface ContactRow {
  wxid: string
  displayName: string
  type: 'friend' | 'group' | 'mp' | 'former_friend' | 'other'
  remark?: string
  nickname?: string
  avatarUrl?: string
  lastContactTime?: number
}

export interface DataService {
  getStatus(config: RuntimeConfig): Promise<StatusData>
  listSessions(config: RuntimeConfig, options: { type?: string; limit: number; offset?: number }): Promise<{ sessions: SessionRow[]; hasMore: boolean }>
  getMessages(config: RuntimeConfig, session: string, options: { limit: number; offset?: number; from?: string; to?: string; type?: string; direction?: string; cursor?: string }): Promise<{ messages: MessageRow[]; cursor: string | null }>
  listContacts(config: RuntimeConfig, options: { type?: string; limit: number }): Promise<{ contacts: ContactRow[] }>
  getContactInfo(config: RuntimeConfig, contact: string): Promise<ContactRow | null>
}

export interface KeyService {
  setKey(hex: string): Promise<{ saved: boolean; keyHex: string }>
  testKey(config: RuntimeConfig): Promise<{ validFormat: boolean; connection?: StatusData['connection'] }>
  getKey(config: RuntimeConfig, options?: { save?: boolean }): Promise<{ keyHex: string; saved: boolean }>
}

export interface SearchResult {
  sessionId: string
  sessionName: string
  messages: MessageRow[]
  total: number
}

export interface StatsOptions {
  type: 'global' | 'contacts' | 'time' | 'session' | 'keywords' | 'group'
  session?: string
  top?: number
  year?: number
  from?: string
  to?: string
  by?: string
}

export interface ExportOptions {
  session?: string
  all?: boolean
  output?: string
  from?: string
  to?: string
  withMedia?: boolean
}

export interface GlobalStats {
  totalMessages: number
  totalSessions: number
  totalContacts: number
  textMessages: number
  mediaMessages: number
  timeRange?: { first: number | null; last: number | null }
}

export interface ContactStats {
  contacts: Array<{ wxid: string; displayName: string; messageCount: number }>
}

export interface TimeStats {
  distribution: Record<string, number>
}

export interface SessionStats {
  totalMessages: number
  textMessages: number
  mediaMessages: number
  sentMessages: number
  receivedMessages: number
  activeDays: number
  firstMessageTime: number | null
  lastMessageTime: number | null
}

export interface KeywordStats {
  keywords: Array<{ word: string; count: number }>
}

export interface GroupStats {
  totalMessages: number
  activeMembers: number
}

export interface MomentsOptions {
  limit?: number
  user?: string
  from?: string
  to?: string
}

export interface MomentsEntry {
  id: string
  author: { wxid: string; displayName: string }
  createTime: number
  contentText: string
  mediaUrls: string[]
  likes: number
  comments: number
  raw: unknown
}

export interface MomentsResult {
  entries: MomentsEntry[]
  total: number
  limit: number
  meta?: {
    nativeSupported: boolean
    note?: string
  }
}

export interface ReportOptions {
  year?: number
  allTime?: boolean
  session?: string
  topContacts?: number
  topKeywords?: number
}

export interface ReportMessageRef {
  time: number | null
  content: string
}

export interface ReportSummary {
  totalMessages: number
  sentMessages: number
  receivedMessages: number
  activeDays: number
  topContacts: Array<{ wxid: string; displayName: string; count: number }>
  topKeywords: Array<{ word: string; count: number }>
  hourlyDistribution: Record<string, number>
  firstMessage: ReportMessageRef | null
  lastMessage: ReportMessageRef | null
}

export interface ReportResult {
  scope: 'year' | 'all' | 'session'
  year?: number
  sessionId?: string
  summary: ReportSummary
  meta?: {
    dbCount: number
    tableCount: number
    truncated?: boolean
    note?: string
  }
}

export interface AdvancedService {
  search(config: RuntimeConfig, keyword: string, options?: { session?: string; limit?: number; from?: string; to?: string }): Promise<SearchResult>
  stats(config: RuntimeConfig, options: StatsOptions): Promise<GlobalStats | ContactStats | TimeStats | SessionStats | KeywordStats | GroupStats>
  exportChat(config: RuntimeConfig, options: ExportOptions): Promise<{ path: string; count: number }>
  moments(config: RuntimeConfig, options?: MomentsOptions): Promise<MomentsResult>
  report(config: RuntimeConfig, options?: ReportOptions): Promise<ReportResult>
  mcpServe(): Promise<never>
}

export interface ServiceRegistry {
  data: DataService
  key: KeyService
  advanced: AdvancedService
}
