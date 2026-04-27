export const MEMORY_DB_NAME = 'agent_memory.db'
export const MEMORY_SCHEMA_VERSION = '1'

export const MEMORY_SOURCE_TYPES = [
  'message',
  'conversation_block',
  'fact',
  'relationship',
  'profile',
  'timeline_summary',
  'media'
] as const

export const MEMORY_VECTOR_STORES = [
  'sqlite_vec0',
  'sqlite_vec1',
  'lancedb',
  'qdrant'
] as const

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number]
export type MemoryVectorStoreName = (typeof MEMORY_VECTOR_STORES)[number]

export type MemoryEvidenceRef = {
  sessionId: string
  localId: number
  createTime: number
  sortSeq: number
  senderUsername?: string
  excerpt?: string
}

export type MemoryItem = {
  id: number
  memoryUid: string
  sourceType: MemorySourceType
  sessionId: string | null
  contactId: string | null
  groupId: string | null
  title: string
  content: string
  contentHash: string
  entities: string[]
  tags: string[]
  importance: number
  confidence: number
  timeStart: number | null
  timeEnd: number | null
  sourceRefs: MemoryEvidenceRef[]
  createdAt: number
  updatedAt: number
}

export type MemoryItemInput = {
  memoryUid: string
  sourceType: MemorySourceType
  sessionId?: string | null
  contactId?: string | null
  groupId?: string | null
  title?: string
  content: string
  contentHash?: string
  entities?: string[]
  tags?: string[]
  importance?: number
  confidence?: number
  timeStart?: number | null
  timeEnd?: number | null
  sourceRefs?: MemoryEvidenceRef[]
}

export type MemoryEmbedding = {
  id: number
  memoryId: number
  modelId: string
  modelRevision: string
  vectorDim: number
  vectorStore: MemoryVectorStoreName
  vectorRef: string
  contentHash: string
  indexedAt: number
}

export type MemoryEmbeddingInput = {
  memoryId: number
  modelId: string
  modelRevision?: string
  vectorDim: number
  vectorStore: MemoryVectorStoreName
  vectorRef: string
  contentHash: string
  indexedAt?: number
}

export type MemoryItemRow = {
  id: number
  memory_uid: string
  source_type: string
  session_id: string | null
  contact_id: string | null
  group_id: string | null
  title: string
  content: string
  content_hash: string
  entities_json: string
  tags_json: string
  importance: number
  confidence: number
  time_start: number | null
  time_end: number | null
  source_refs_json: string
  created_at: number
  updated_at: number
}

export type MemoryEmbeddingRow = {
  id: number
  memory_id: number
  model_id: string
  model_revision: string
  vector_dim: number
  vector_store: string
  vector_ref: string
  content_hash: string
  indexed_at: number
}

export type MemoryDatabaseStats = {
  itemCount: number
  embeddingCount: number
  staleEmbeddingCount: number
}
