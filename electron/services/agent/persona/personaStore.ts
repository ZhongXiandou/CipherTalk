/**
 * 画像持久化 —— agent_personas.db（better-sqlite3，cachePath 下，按账号隔离）。
 * 路径与连接管理照 conversationStore：cachePath 变更时自动换库。
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../../config'
import type { PersonaCard, PersonaFewShot, PersonaRecord, PersonaStats } from './personaTypes'

const DB_NAME = 'agent_personas.db'

interface PersonaRow {
  id: number
  account_id: string
  session_id: string
  display_name: string
  card_json: string
  few_shots_json: string
  stats_json: string
  model_provider: string
  model_id: string
  created_at: number
  updated_at: number
}

export interface PersonaUpsertInput {
  sessionId: string
  displayName: string
  card: PersonaCard
  fewShots: PersonaFewShot[]
  stats: PersonaStats
  modelProvider: string
  modelId: string
}

function rowToRecord(row: PersonaRow): PersonaRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    sessionId: row.session_id,
    displayName: row.display_name,
    card: JSON.parse(row.card_json) as PersonaCard,
    fewShots: JSON.parse(row.few_shots_json) as PersonaFewShot[],
    stats: JSON.parse(row.stats_json) as PersonaStats,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PersonaStore {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getCacheBasePath(): string {
    const config = new ConfigService()
    try {
      const cachePath = String(config.get('cachePath') || '').trim()
      return cachePath || join(process.cwd(), 'cache')
    } finally {
      config.close()
    }
  }

  private getAccountId(): string {
    const config = new ConfigService()
    try {
      const active = config.getActiveAccount()
      const wxid = String(config.get('myWxid') || '').trim()
      return active?.id || wxid || 'default'
    } finally {
      config.close()
    }
  }

  private getDb(): Database.Database {
    const basePath = this.getCacheBasePath()
    if (!existsSync(basePath)) mkdirSync(basePath, { recursive: true })

    const nextDbPath = join(basePath, DB_NAME)
    if (this.db && this.dbPath === nextDbPath) return this.db

    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
    }

    const db = new Database(nextDbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        card_json TEXT NOT NULL,
        few_shots_json TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        model_provider TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(account_id, session_id)
      )
    `)
    this.db = db
    this.dbPath = nextDbPath
    return db
  }

  get(sessionId: string): PersonaRecord | null {
    const row = this.getDb()
      .prepare('SELECT * FROM personas WHERE account_id = ? AND session_id = ?')
      .get(this.getAccountId(), sessionId) as PersonaRow | undefined
    return row ? rowToRecord(row) : null
  }

  list(): PersonaRecord[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM personas WHERE account_id = ? ORDER BY updated_at DESC')
      .all(this.getAccountId()) as PersonaRow[]
    return rows.map(rowToRecord)
  }

  upsert(input: PersonaUpsertInput): PersonaRecord {
    const now = Date.now()
    this.getDb()
      .prepare(`
        INSERT INTO personas (account_id, session_id, display_name, card_json, few_shots_json, stats_json, model_provider, model_id, created_at, updated_at)
        VALUES (@accountId, @sessionId, @displayName, @cardJson, @fewShotsJson, @statsJson, @modelProvider, @modelId, @now, @now)
        ON CONFLICT(account_id, session_id) DO UPDATE SET
          display_name = excluded.display_name,
          card_json = excluded.card_json,
          few_shots_json = excluded.few_shots_json,
          stats_json = excluded.stats_json,
          model_provider = excluded.model_provider,
          model_id = excluded.model_id,
          updated_at = excluded.updated_at
      `)
      .run({
        accountId: this.getAccountId(),
        sessionId: input.sessionId,
        displayName: input.displayName,
        cardJson: JSON.stringify(input.card),
        fewShotsJson: JSON.stringify(input.fewShots),
        statsJson: JSON.stringify(input.stats),
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        now,
      })
    const record = this.get(input.sessionId)
    if (!record) throw new Error('画像写入后读取失败')
    return record
  }

  remove(sessionId: string): boolean {
    const result = this.getDb()
      .prepare('DELETE FROM personas WHERE account_id = ? AND session_id = ?')
      .run(this.getAccountId(), sessionId)
    return result.changes > 0
  }

  close(): void {
    if (!this.db) return
    try { this.db.close() } catch { /* ignore */ }
    this.db = null
    this.dbPath = null
  }
}

export const personaStore = new PersonaStore()
