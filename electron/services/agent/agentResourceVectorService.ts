import Database from 'better-sqlite3'
import { cosineSimilarity } from 'ai'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../config'
import {
  embedQuery,
  embedTexts,
  getEmbeddingConfig,
  type EmbeddingConfig,
} from '../ai/embeddingService'
import type { AgentMcpToolDescriptor } from './types'

export type AgentResourceKind = 'skill' | 'mcp_tool'
export type AgentResourceBuildStage = 'loading' | 'embedding' | 'done'

export interface AgentResourceBuildProgress {
  kind: AgentResourceKind
  stage: AgentResourceBuildStage
  current: number
  total: number
  indexed: number
  message: string
}

export interface AgentResourceVectorStoreInfo {
  dbPath: string
  exists: boolean
  sizeBytes: number
  updatedAtMs: number | null
  count: number
  storedCount: number
  currentCount: number
  staleCount: number
  dimensions: number[]
}

export interface AgentResourceStatus {
  enabled: boolean
  kind: AgentResourceKind
  count: number
  currentCount: number
  staleCount: number
  store: AgentResourceVectorStoreInfo
}

export interface SkillResourceDocument {
  name: string
  version: string
  description: string
  content: string
}

interface ResourceDocument<TPayload> {
  kind: AgentResourceKind
  id: string
  name: string
  description: string
  text: string
  fingerprint: string
  payload: TPayload
}

interface ResourceRow {
  id: string
  name: string
  description: string | null
  fingerprint: string
  model_key: string
  dim: number
  embedding: Buffer
  payload_json: string
}

const VECTOR_DB_NAME = 'agent_resource_vectors.db'
const EMBED_BATCH = 64
const SKILL_TEXT_CAP = 6000
const MCP_SCHEMA_LINE_LIMIT = 80

function nowMs(): number {
  return Date.now()
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function getCacheBasePath(): string {
  const cs = new ConfigService()
  try {
    const cachePath = String(cs.get('cachePath') || '').trim()
    return cachePath || join(process.cwd(), 'cache')
  } finally {
    cs.close()
  }
}

function stripSkillFrontmatter(content: string): string {
  return String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').trim()
}

function compactText(value: string, maxChars: number): string {
  const normalized = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return normalized.length > maxChars ? normalized.slice(0, maxChars).trim() : normalized
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return 'null'
  }
}

function parsePayload<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function modelKey(cfg: EmbeddingConfig): string {
  return [
    cfg.protocol || 'openai-compatible',
    cfg.baseURL || '',
    cfg.model || '',
    String(cfg.dimension || 0),
  ].join('|')
}

function isEmbeddingReady(cfg: EmbeddingConfig): boolean {
  return !!(cfg.enabled && cfg.apiKey && cfg.model)
}

function vectorToBuffer(vector: number[]): Buffer {
  return Buffer.from(Float32Array.from(vector).buffer)
}

function bufferToVector(buffer: Buffer): number[] {
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
  return Array.from(view)
}

function normalizeSchemaType(schema: Record<string, unknown>): string {
  const type = schema.type
  if (Array.isArray(type)) return type.map(String).join('|')
  if (typeof type === 'string') return type
  if (schema.enum) return 'enum'
  if (schema.anyOf) return 'anyOf'
  if (schema.oneOf) return 'oneOf'
  return 'value'
}

function collectSchemaLines(schema: unknown, prefix = '', depth = 0, lines: string[] = []): string[] {
  if (lines.length >= MCP_SCHEMA_LINE_LIMIT || depth > 4) return lines
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return lines
  const obj = schema as Record<string, unknown>
  const properties = obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)
    ? obj.properties as Record<string, unknown>
    : null
  const required = Array.isArray(obj.required) ? new Set(obj.required.map(String)) : new Set<string>()

  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (lines.length >= MCP_SCHEMA_LINE_LIMIT) break
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const child = value as Record<string, unknown>
      const path = prefix ? `${prefix}.${key}` : key
      const type = normalizeSchemaType(child)
      const description = String(child.description || child.title || '').replace(/\s+/g, ' ').trim()
      lines.push(`${path}${required.has(key) ? ' required' : ''}: ${type}${description ? ` - ${description}` : ''}`)
      collectSchemaLines(value, path, depth + 1, lines)
    }
  }
  return lines
}

function readableInputSchema(schema: unknown): string {
  const lines = collectSchemaLines(schema)
  return lines.length > 0 ? lines.join('\n') : ''
}

function toSkillResource(doc: SkillResourceDocument): ResourceDocument<SkillResourceDocument> {
  const body = compactText(stripSkillFrontmatter(doc.content), SKILL_TEXT_CAP)
  const description = String(doc.description || '').trim()
  const text = [
    `Skill: ${doc.name}`,
    description,
    body,
  ].filter(Boolean).join('\n')
  return {
    kind: 'skill',
    id: doc.name,
    name: doc.name,
    description,
    text,
    fingerprint: sha256(`${doc.name}\0${doc.version}\0${description}\0${doc.content}`),
    payload: doc,
  }
}

function toMcpResource(tool: AgentMcpToolDescriptor): ResourceDocument<AgentMcpToolDescriptor> {
  const description = String(tool.description || '').trim()
  const schemaText = readableInputSchema(tool.inputSchema)
  const text = [
    `MCP Tool: ${tool.serverName}/${tool.toolName}`,
    tool.name,
    description,
    schemaText,
  ].filter(Boolean).join('\n')
  return {
    kind: 'mcp_tool',
    id: `${tool.serverName}/${tool.toolName}`,
    name: tool.name,
    description,
    text,
    fingerprint: sha256(`${tool.serverName}\0${tool.toolName}\0${tool.name}\0${description}\0${safeJsonStringify(tool.inputSchema)}`),
    payload: tool,
  }
}

export class AgentResourceVectorService {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getDbPath(): string {
    return join(getCacheBasePath(), VECTOR_DB_NAME)
  }

  private getDb(): Database.Database {
    const next = this.getDbPath()
    const base = getCacheBasePath()
    if (!existsSync(base)) mkdirSync(base, { recursive: true })
    if (this.db && this.dbPath === next) return this.db
    if (this.db) this.close()
    const db = new Database(next)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_resource_vectors (
        kind         TEXT NOT NULL,
        id           TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT,
        fingerprint  TEXT NOT NULL,
        model_key    TEXT NOT NULL,
        dim          INTEGER NOT NULL,
        embedding    BLOB NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS idx_arv_kind_model ON agent_resource_vectors(kind, model_key);
    `)
    this.db = db
    this.dbPath = next
    return db
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

  isReady(cfg = getEmbeddingConfig()): boolean {
    return isEmbeddingReady(cfg)
  }

  private countCurrent(kind: AgentResourceKind, resources: Array<ResourceDocument<unknown>>, key: string): number {
    if (resources.length === 0) return 0
    const db = this.getDb()
    const rows = db.prepare(
      'SELECT id, fingerprint, model_key FROM agent_resource_vectors WHERE kind = ?'
    ).all(kind) as Array<{ id: string; fingerprint: string; model_key: string }>
    const current = new Map(resources.map((resource) => [resource.id, resource]))
    let count = 0
    for (const row of rows) {
      const resource = current.get(row.id)
      if (resource && row.fingerprint === resource.fingerprint && row.model_key === key) count += 1
    }
    return count
  }

  getStatus(
    kind: AgentResourceKind,
    resources: Array<ResourceDocument<unknown>>,
    cfg = getEmbeddingConfig(),
  ): AgentResourceStatus {
    const db = this.getDb()
    const dbPath = this.dbPath || this.getDbPath()
    const stat = existsSync(dbPath) ? statSync(dbPath) : null
    const key = modelKey(cfg)
    const rows = db.prepare(
      'SELECT dim, COUNT(*) AS c FROM agent_resource_vectors WHERE kind = ? AND model_key = ? GROUP BY dim ORDER BY dim'
    ).all(kind, key) as Array<{ dim: number; c: number }>
    const stored = db.prepare(
      'SELECT COUNT(*) AS c FROM agent_resource_vectors WHERE kind = ?'
    ).get(kind) as { c: number }
    const currentCount = resources.length
    const count = this.countCurrent(kind, resources, key)
    return {
      enabled: this.isReady(cfg),
      kind,
      count,
      currentCount,
      staleCount: Math.max(0, currentCount - count),
      store: {
        dbPath,
        exists: !!stat,
        sizeBytes: stat?.size || 0,
        updatedAtMs: stat?.mtimeMs || null,
        count,
        storedCount: stored.c,
        currentCount,
        staleCount: Math.max(0, currentCount - count),
        dimensions: rows.map((row) => row.dim),
      },
    }
  }

  private async ensureResources<TPayload>(
    kind: AgentResourceKind,
    resources: Array<ResourceDocument<TPayload>>,
    cfg: EmbeddingConfig,
    onProgress?: (progress: AgentResourceBuildProgress) => void,
  ): Promise<number> {
    if (!this.isReady(cfg)) {
      throw new Error('未启用或未配置嵌入模型（请先在设置 → 嵌入中配置并启用）')
    }
    const db = this.getDb()
    const key = modelKey(cfg)
    onProgress?.({ kind, stage: 'loading', current: 0, total: resources.length, indexed: 0, message: '读取 Agent 资源' })

    const existingRows = db.prepare(
      'SELECT id, fingerprint, model_key FROM agent_resource_vectors WHERE kind = ?'
    ).all(kind) as Array<{ id: string; fingerprint: string; model_key: string }>
    const existing = new Map(existingRows.map((row) => [row.id, row]))
    const currentIds = new Set(resources.map((resource) => resource.id))
    const staleIds = existingRows.filter((row) => !currentIds.has(row.id)).map((row) => row.id)
    if (staleIds.length > 0) {
      const remove = db.prepare('DELETE FROM agent_resource_vectors WHERE kind = ? AND id = ?')
      const tx = db.transaction(() => {
        staleIds.forEach((id) => remove.run(kind, id))
      })
      tx()
    }

    const pending = resources.filter((resource) => {
      const row = existing.get(resource.id)
      return !row || row.fingerprint !== resource.fingerprint || row.model_key !== key
    })
    if (pending.length === 0) {
      const indexed = this.countCurrent(kind, resources, key)
      onProgress?.({ kind, stage: 'done', current: 0, total: 0, indexed, message: 'Agent 资源向量已是最新' })
      return indexed
    }

    onProgress?.({ kind, stage: 'embedding', current: 0, total: pending.length, indexed: this.countCurrent(kind, resources, key), message: '生成资源向量' })
    const insert = db.prepare(
      `INSERT OR REPLACE INTO agent_resource_vectors
       (kind, id, name, description, fingerprint, model_key, dim, embedding, payload_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH)
      const vectors = await embedTexts(batch.map((resource) => resource.text), cfg)
      const write = db.transaction(() => {
        batch.forEach((resource, index) => {
          const vector = vectors[index]
          if (!vector || vector.length === 0) return
          insert.run(
            resource.kind,
            resource.id,
            resource.name,
            resource.description,
            resource.fingerprint,
            key,
            vector.length,
            vectorToBuffer(vector),
            safeJsonStringify(resource.payload),
            nowMs(),
          )
        })
      })
      write()
      const current = Math.min(i + batch.length, pending.length)
      onProgress?.({
        kind,
        stage: current >= pending.length ? 'done' : 'embedding',
        current,
        total: pending.length,
        indexed: this.countCurrent(kind, resources, key),
        message: current >= pending.length ? 'Agent 资源向量已完成' : '生成资源向量',
      })
    }

    return this.countCurrent(kind, resources, key)
  }

  async buildSkills(
    documents: SkillResourceDocument[],
    cfg = getEmbeddingConfig(),
    onProgress?: (progress: AgentResourceBuildProgress) => void,
  ): Promise<number> {
    return this.ensureResources('skill', documents.map(toSkillResource), cfg, onProgress)
  }

  async buildMcpTools(
    tools: AgentMcpToolDescriptor[],
    cfg = getEmbeddingConfig(),
    onProgress?: (progress: AgentResourceBuildProgress) => void,
  ): Promise<number> {
    return this.ensureResources('mcp_tool', tools.map(toMcpResource), cfg, onProgress)
  }

  getSkillStatus(documents: SkillResourceDocument[], cfg = getEmbeddingConfig()): AgentResourceStatus {
    return this.getStatus('skill', documents.map(toSkillResource), cfg)
  }

  getMcpStatus(tools: AgentMcpToolDescriptor[], cfg = getEmbeddingConfig()): AgentResourceStatus {
    return this.getStatus('mcp_tool', tools.map(toMcpResource), cfg)
  }

  private async search<TPayload>(
    kind: AgentResourceKind,
    resources: Array<ResourceDocument<TPayload>>,
    cfg: EmbeddingConfig,
    query: string,
    limit: number,
    parseFallback: TPayload,
    opts: { requireCurrent?: boolean } = {},
  ): Promise<TPayload[]> {
    if (!query.trim() || resources.length === 0 || limit <= 0) return []
    if (opts.requireCurrent) {
      const status = this.getStatus(kind, resources, cfg)
      if (!status.enabled || status.count === 0 || status.staleCount > 0 || status.count < resources.length) return []
    } else {
      await this.ensureResources(kind, resources, cfg)
    }
    const db = this.getDb()
    const key = modelKey(cfg)
    const queryVec = await embedQuery(query, cfg)
    const current = new Map(resources.map((resource) => [resource.id, resource]))
    const rows = db.prepare(
      `SELECT id, name, description, fingerprint, model_key, dim, embedding, payload_json
       FROM agent_resource_vectors WHERE kind = ? AND model_key = ?`
    ).all(kind, key) as ResourceRow[]

    const scored: Array<{ row: ResourceRow; score: number }> = []
    for (const row of rows) {
      const resource = current.get(row.id)
      if (!resource || resource.fingerprint !== row.fingerprint || row.dim !== queryVec.length) continue
      const score = cosineSimilarity(queryVec, bufferToVector(row.embedding))
      if (Number.isFinite(score)) scored.push({ row, score })
    }
    return scored
      .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
      .slice(0, limit)
      .map(({ row }) => parsePayload<TPayload>(row.payload_json, parseFallback))
  }

  async searchSkills(query: string, documents: SkillResourceDocument[], limit = 20, cfg = getEmbeddingConfig(), opts: { requireCurrent?: boolean } = {}): Promise<SkillResourceDocument[]> {
    return this.search('skill', documents.map(toSkillResource), cfg, query, limit, {
      name: '',
      version: '0.0.0',
      description: '',
      content: '',
    }, opts)
  }

  async searchMcpTools(query: string, tools: AgentMcpToolDescriptor[], limit = 24, cfg = getEmbeddingConfig(), opts: { requireCurrent?: boolean } = {}): Promise<AgentMcpToolDescriptor[]> {
    return this.search('mcp_tool', tools.map(toMcpResource), cfg, query, limit, {
      name: '',
      serverName: '',
      toolName: '',
      description: '',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }, opts)
  }
}

export const agentResourceVectorService = new AgentResourceVectorService()
