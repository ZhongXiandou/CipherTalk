import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { getUserDataPath } from './runtimePaths'

export interface ConversationSummary {
  id: number
  title: string
  preview: string
  updatedAt: number
}

export interface MessageRecord {
  id: number
  conversationId: number
  role: string
  content: string
  blocksJson?: string | null
  createdAt: number
}

class AgentConversationDb {
  private db: Database.Database | null = null

  init(): void {
    const dbPath = join(getUserDataPath(), 'agent_conversations.db')
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    this.db = new Database(dbPath)
    this.db.pragma('foreign_keys = ON')
    this.createTables()
  }

  isInitialized(): boolean {
    return this.db !== null
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('[AgentConversationDb] 数据库未初始化')
    return this.db
  }

  private createTables(): void {
    const db = this.getDb()
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL DEFAULT '新对话',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        blocks_json     TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_conv ON agent_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_conversations_updated ON agent_conversations(updated_at DESC);
    `)
  }

  createConversation(title?: string): number {
    const db = this.getDb()
    const now = Date.now()
    const result = db.prepare(
      'INSERT INTO agent_conversations (title, created_at, updated_at) VALUES (?, ?, ?)'
    ).run(title || '新对话', now, now)
    return result.lastInsertRowid as number
  }

  appendMessage(conversationId: number, role: string, content: string, blocksJson?: string): number {
    const db = this.getDb()
    const now = Date.now()
    const result = db.prepare(
      'INSERT INTO agent_messages (conversation_id, role, content, blocks_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(conversationId, role, content, blocksJson ?? null, now)
    db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    return result.lastInsertRowid as number
  }

  getMessages(conversationId: number): MessageRecord[] {
    const db = this.getDb()
    const rows = db.prepare(
      'SELECT id, conversation_id, role, content, blocks_json, created_at FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as any[]
    return rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      blocksJson: r.blocks_json,
      createdAt: r.created_at
    }))
  }

  listConversations(): ConversationSummary[] {
    const db = this.getDb()
    const rows = db.prepare(`
      SELECT
        c.id,
        c.title,
        c.updated_at,
        (
          SELECT m.content FROM agent_messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as last_content
      FROM agent_conversations c
      ORDER BY c.updated_at DESC
    `).all() as any[]
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      preview: r.last_content ? String(r.last_content).slice(0, 60) : '',
      updatedAt: r.updated_at
    }))
  }

  deleteConversation(id: number): void {
    this.getDb().prepare('DELETE FROM agent_conversations WHERE id = ?').run(id)
  }

  updateTitle(id: number, title: string): void {
    this.getDb().prepare('UPDATE agent_conversations SET title = ? WHERE id = ?').run(title, id)
  }
}

export const agentConversationDb = new AgentConversationDb()
