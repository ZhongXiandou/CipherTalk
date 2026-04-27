import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { ConfigService } from '../config'
import {
  MEMORY_DB_NAME,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SOURCE_TYPES,
  MEMORY_VECTOR_STORES,
  type MemoryDatabaseStats,
  type MemoryEmbedding,
  type MemoryEmbeddingInput,
  type MemoryEmbeddingRow,
  type MemoryEvidenceRef,
  type MemoryItem,
  type MemoryItemInput,
  type MemoryItemRow,
  type MemorySourceType,
  type MemoryVectorStoreName
} from './memorySchema'

function nowMs(): number {
  return Date.now()
}

function getCacheBasePath(): string {
  const configService = new ConfigService()
  try {
    const cachePath = String(configService.get('cachePath') || '').trim()
    return cachePath || join(process.cwd(), 'cache')
  } finally {
    configService.close()
  }
}

function normalizeNullableText(value?: string | null): string | null {
  const text = String(value || '').trim()
  return text || null
}

function normalizeNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : fallback
}

function clamp01(value: unknown, fallback: number): number {
  const numberValue = normalizeNumber(value, fallback)
  return Math.max(0, Math.min(1, numberValue))
}

function safeJsonStringify(value: unknown, fallback: unknown): string {
  try {
    return JSON.stringify(value ?? fallback)
  } catch {
    return JSON.stringify(fallback)
  }
}

function parseStringArrayJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function parseEvidenceRefsJson(value: string): MemoryEvidenceRef[] {
  try {
    const parsed = JSON.parse(value || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item): MemoryEvidenceRef | null => {
        if (!item || typeof item !== 'object') return null
        const source = item as Record<string, unknown>
        const sessionId = String(source.sessionId || '').trim()
        const localId = Number(source.localId)
        const createTime = Number(source.createTime)
        const sortSeq = Number(source.sortSeq)
        if (!sessionId || !Number.isFinite(localId) || !Number.isFinite(createTime) || !Number.isFinite(sortSeq)) {
          return null
        }
        const senderUsername = String(source.senderUsername || '').trim()
        const excerpt = String(source.excerpt || '').trim()
        return {
          sessionId,
          localId,
          createTime,
          sortSeq,
          ...(senderUsername ? { senderUsername } : {}),
          ...(excerpt ? { excerpt } : {})
        }
      })
      .filter((item): item is MemoryEvidenceRef => Boolean(item))
  } catch {
    return []
  }
}

function safeSourceType(value: string): MemorySourceType {
  return MEMORY_SOURCE_TYPES.includes(value as MemorySourceType)
    ? value as MemorySourceType
    : 'message'
}

function safeVectorStore(value: string): MemoryVectorStoreName {
  return MEMORY_VECTOR_STORES.includes(value as MemoryVectorStoreName)
    ? value as MemoryVectorStoreName
    : 'sqlite_vec0'
}

function toMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: Number(row.id),
    memoryUid: row.memory_uid,
    sourceType: safeSourceType(row.source_type),
    sessionId: row.session_id,
    contactId: row.contact_id,
    groupId: row.group_id,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    entities: parseStringArrayJson(row.entities_json),
    tags: parseStringArrayJson(row.tags_json),
    importance: Number(row.importance || 0),
    confidence: Number(row.confidence || 0),
    timeStart: row.time_start == null ? null : Number(row.time_start),
    timeEnd: row.time_end == null ? null : Number(row.time_end),
    sourceRefs: parseEvidenceRefsJson(row.source_refs_json),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  }
}

function toMemoryEmbedding(row: MemoryEmbeddingRow): MemoryEmbedding {
  return {
    id: Number(row.id),
    memoryId: Number(row.memory_id),
    modelId: row.model_id,
    modelRevision: row.model_revision,
    vectorDim: Number(row.vector_dim),
    vectorStore: safeVectorStore(row.vector_store),
    vectorRef: row.vector_ref,
    contentHash: row.content_hash,
    indexedAt: Number(row.indexed_at || 0)
  }
}

export function hashMemoryContent(title: string, content: string): string {
  return createHash('sha256')
    .update(`${String(title || '').trim()}\n${String(content || '')}`)
    .digest('hex')
}

export class MemoryDatabase {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  getDbPath(): string {
    return join(getCacheBasePath(), MEMORY_DB_NAME)
  }

  getDb(): Database.Database {
    const nextDbPath = this.getDbPath()
    const dir = dirname(nextDbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    if (this.db && this.dbPath === nextDbPath) {
      return this.db
    }

    if (this.db) {
      this.close()
    }

    const db = new Database(nextDbPath)
    this.db = db
    this.dbPath = nextDbPath
    this.ensureSchema(db)
    return db
  }

  ensureReady(): void {
    this.getDb()
  }

  close(): void {
    if (!this.db) return
    try {
      this.db.close()
    } finally {
      this.db = null
      this.dbPath = null
    }
  }

  private ensureSchema(db: Database.Database): void {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_uid TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        session_id TEXT,
        contact_id TEXT,
        group_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        entities_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 1,
        time_start INTEGER,
        time_end INTEGER,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        model_revision TEXT NOT NULL DEFAULT '',
        vector_dim INTEGER NOT NULL,
        vector_store TEXT NOT NULL,
        vector_ref TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        UNIQUE(memory_id, model_id, vector_dim),
        FOREIGN KEY(memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_items_source_type
        ON memory_items(source_type);
      CREATE INDEX IF NOT EXISTS idx_memory_items_session_time
        ON memory_items(session_id, time_start, time_end);
      CREATE INDEX IF NOT EXISTS idx_memory_items_contact
        ON memory_items(contact_id);
      CREATE INDEX IF NOT EXISTS idx_memory_items_group
        ON memory_items(group_id);
      CREATE INDEX IF NOT EXISTS idx_memory_items_hash
        ON memory_items(content_hash);
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory
        ON memory_embeddings(memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model
        ON memory_embeddings(model_id, vector_dim);
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_store
        ON memory_embeddings(vector_store, vector_ref);
    `)

    db.prepare(`
      INSERT OR REPLACE INTO memory_meta(key, value, updated_at)
      VALUES ('schema_version', ?, ?)
    `).run(MEMORY_SCHEMA_VERSION, nowMs())
  }

  upsertMemoryItem(input: MemoryItemInput): MemoryItem {
    const db = this.getDb()
    const timestamp = nowMs()
    const memoryUid = String(input.memoryUid || '').trim()
    const content = String(input.content || '')
    const title = String(input.title || '')
    if (!memoryUid) throw new Error('memoryUid is required')
    if (!content.trim()) throw new Error('memory content is required')
    if (!MEMORY_SOURCE_TYPES.includes(input.sourceType)) {
      throw new Error(`Unsupported memory source type: ${input.sourceType}`)
    }

    const existing = db.prepare('SELECT created_at FROM memory_items WHERE memory_uid = ?')
      .get(memoryUid) as { created_at: number } | undefined
    const createdAt = Number(existing?.created_at || timestamp)
    const contentHash = input.contentHash || hashMemoryContent(title, content)

    db.prepare(`
      INSERT INTO memory_items (
        memory_uid, source_type, session_id, contact_id, group_id,
        title, content, content_hash, entities_json, tags_json,
        importance, confidence, time_start, time_end, source_refs_json,
        created_at, updated_at
      ) VALUES (
        @memoryUid, @sourceType, @sessionId, @contactId, @groupId,
        @title, @content, @contentHash, @entitiesJson, @tagsJson,
        @importance, @confidence, @timeStart, @timeEnd, @sourceRefsJson,
        @createdAt, @updatedAt
      )
      ON CONFLICT(memory_uid) DO UPDATE SET
        source_type = excluded.source_type,
        session_id = excluded.session_id,
        contact_id = excluded.contact_id,
        group_id = excluded.group_id,
        title = excluded.title,
        content = excluded.content,
        content_hash = excluded.content_hash,
        entities_json = excluded.entities_json,
        tags_json = excluded.tags_json,
        importance = excluded.importance,
        confidence = excluded.confidence,
        time_start = excluded.time_start,
        time_end = excluded.time_end,
        source_refs_json = excluded.source_refs_json,
        updated_at = excluded.updated_at
    `).run({
      memoryUid,
      sourceType: input.sourceType,
      sessionId: normalizeNullableText(input.sessionId),
      contactId: normalizeNullableText(input.contactId),
      groupId: normalizeNullableText(input.groupId),
      title,
      content,
      contentHash,
      entitiesJson: safeJsonStringify(input.entities || [], []),
      tagsJson: safeJsonStringify(input.tags || [], []),
      importance: normalizeNumber(input.importance, 0),
      confidence: clamp01(input.confidence, 1),
      timeStart: input.timeStart ?? null,
      timeEnd: input.timeEnd ?? null,
      sourceRefsJson: safeJsonStringify(input.sourceRefs || [], []),
      createdAt,
      updatedAt: timestamp
    })

    const item = this.getMemoryItemByUid(memoryUid)
    if (!item) throw new Error('Failed to load upserted memory item')
    return item
  }

  getMemoryItemById(id: number): MemoryItem | null {
    const row = this.getDb().prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as MemoryItemRow | undefined
    return row ? toMemoryItem(row) : null
  }

  getMemoryItemByUid(memoryUid: string): MemoryItem | null {
    const row = this.getDb().prepare('SELECT * FROM memory_items WHERE memory_uid = ?').get(memoryUid) as MemoryItemRow | undefined
    return row ? toMemoryItem(row) : null
  }

  listMemoryItems(options: {
    sourceType?: MemorySourceType
    sessionId?: string
    limit?: number
    offset?: number
  } = {}): MemoryItem[] {
    const clauses: string[] = []
    const params: Record<string, unknown> = {}

    if (options.sourceType) {
      clauses.push('source_type = @sourceType')
      params.sourceType = options.sourceType
    }
    if (options.sessionId) {
      clauses.push('session_id = @sessionId')
      params.sessionId = options.sessionId
    }

    const limit = Math.max(1, Math.min(Math.floor(options.limit || 100), 1000))
    const offset = Math.max(0, Math.floor(options.offset || 0))
    params.limit = limit
    params.offset = offset

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.getDb().prepare(`
      SELECT * FROM memory_items
      ${whereSql}
      ORDER BY COALESCE(time_end, time_start, updated_at) DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all(params) as MemoryItemRow[]
    return rows.map(toMemoryItem)
  }

  deleteMemoryItem(id: number): boolean {
    const result = this.getDb().prepare('DELETE FROM memory_items WHERE id = ?').run(id)
    return result.changes > 0
  }

  upsertMemoryEmbedding(input: MemoryEmbeddingInput): MemoryEmbedding {
    const db = this.getDb()
    const indexedAt = input.indexedAt || nowMs()
    if (!Number.isInteger(input.memoryId) || input.memoryId <= 0) throw new Error('memoryId is required')
    if (!String(input.modelId || '').trim()) throw new Error('modelId is required')
    if (!Number.isInteger(input.vectorDim) || input.vectorDim <= 0) throw new Error('vectorDim is required')
    if (!MEMORY_VECTOR_STORES.includes(input.vectorStore)) {
      throw new Error(`Unsupported memory vector store: ${input.vectorStore}`)
    }
    if (!String(input.vectorRef || '').trim()) throw new Error('vectorRef is required')
    if (!String(input.contentHash || '').trim()) throw new Error('contentHash is required')

    db.prepare(`
      INSERT INTO memory_embeddings (
        memory_id, model_id, model_revision, vector_dim,
        vector_store, vector_ref, content_hash, indexed_at
      ) VALUES (
        @memoryId, @modelId, @modelRevision, @vectorDim,
        @vectorStore, @vectorRef, @contentHash, @indexedAt
      )
      ON CONFLICT(memory_id, model_id, vector_dim) DO UPDATE SET
        model_revision = excluded.model_revision,
        vector_store = excluded.vector_store,
        vector_ref = excluded.vector_ref,
        content_hash = excluded.content_hash,
        indexed_at = excluded.indexed_at
    `).run({
      memoryId: input.memoryId,
      modelId: String(input.modelId).trim(),
      modelRevision: String(input.modelRevision || ''),
      vectorDim: input.vectorDim,
      vectorStore: input.vectorStore,
      vectorRef: String(input.vectorRef).trim(),
      contentHash: String(input.contentHash).trim(),
      indexedAt
    })

    const embedding = this.getMemoryEmbedding(input.memoryId, input.modelId, input.vectorDim)
    if (!embedding) throw new Error('Failed to load upserted memory embedding')
    return embedding
  }

  getMemoryEmbeddingById(id: number): MemoryEmbedding | null {
    const row = this.getDb().prepare('SELECT * FROM memory_embeddings WHERE id = ?').get(id) as MemoryEmbeddingRow | undefined
    return row ? toMemoryEmbedding(row) : null
  }

  getMemoryEmbedding(memoryId: number, modelId: string, vectorDim: number): MemoryEmbedding | null {
    const row = this.getDb().prepare(`
      SELECT * FROM memory_embeddings
      WHERE memory_id = ? AND model_id = ? AND vector_dim = ?
    `).get(memoryId, modelId, vectorDim) as MemoryEmbeddingRow | undefined
    return row ? toMemoryEmbedding(row) : null
  }

  listEmbeddingsForMemory(memoryId: number): MemoryEmbedding[] {
    const rows = this.getDb().prepare(`
      SELECT * FROM memory_embeddings
      WHERE memory_id = ?
      ORDER BY indexed_at DESC, id DESC
    `).all(memoryId) as MemoryEmbeddingRow[]
    return rows.map(toMemoryEmbedding)
  }

  deleteEmbeddingsByMemoryIds(memoryIds: number[]): number {
    const ids = Array.from(new Set(memoryIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)))
    if (ids.length === 0) return 0

    const placeholders = ids.map(() => '?').join(',')
    const result = this.getDb().prepare(`DELETE FROM memory_embeddings WHERE memory_id IN (${placeholders})`).run(...ids)
    return result.changes
  }

  clearEmbeddingsByModel(modelId: string, vectorDim?: number): number {
    const model = String(modelId || '').trim()
    if (!model) return 0

    const sql = Number.isInteger(vectorDim) && Number(vectorDim) > 0
      ? 'DELETE FROM memory_embeddings WHERE model_id = ? AND vector_dim = ?'
      : 'DELETE FROM memory_embeddings WHERE model_id = ?'
    const result = Number.isInteger(vectorDim) && Number(vectorDim) > 0
      ? this.getDb().prepare(sql).run(model, vectorDim)
      : this.getDb().prepare(sql).run(model)
    return result.changes
  }

  listStaleEmbeddings(options: { modelId?: string; vectorDim?: number; limit?: number } = {}): MemoryEmbedding[] {
    const clauses = ['e.content_hash != m.content_hash']
    const params: Record<string, unknown> = {}
    if (options.modelId) {
      clauses.push('e.model_id = @modelId')
      params.modelId = options.modelId
    }
    if (Number.isInteger(options.vectorDim) && Number(options.vectorDim) > 0) {
      clauses.push('e.vector_dim = @vectorDim')
      params.vectorDim = options.vectorDim
    }
    params.limit = Math.max(1, Math.min(Math.floor(options.limit || 100), 1000))

    const rows = this.getDb().prepare(`
      SELECT e.* FROM memory_embeddings e
      JOIN memory_items m ON m.id = e.memory_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.indexed_at ASC
      LIMIT @limit
    `).all(params) as MemoryEmbeddingRow[]
    return rows.map(toMemoryEmbedding)
  }

  getStats(): MemoryDatabaseStats {
    const db = this.getDb()
    const itemRow = db.prepare('SELECT COUNT(*) AS count FROM memory_items').get() as { count: number }
    const embeddingRow = db.prepare('SELECT COUNT(*) AS count FROM memory_embeddings').get() as { count: number }
    const staleRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_embeddings e
      JOIN memory_items m ON m.id = e.memory_id
      WHERE e.content_hash != m.content_hash
    `).get() as { count: number }

    return {
      itemCount: Number(itemRow.count || 0),
      embeddingCount: Number(embeddingRow.count || 0),
      staleEmbeddingCount: Number(staleRow.count || 0)
    }
  }
}

export const memoryDatabase = new MemoryDatabase()
