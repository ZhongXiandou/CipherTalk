import { wcdbService } from './wcdbService'

type QueryResult = { success: boolean; rows?: any[]; error?: string }

const PARAMS_UNSUPPORTED = 'native 未支持参数化查询'

async function runQuery(
  kind: string,
  path: string,
  sql: string,
  params?: any[]
): Promise<QueryResult> {
  if (params && params.length > 0) {
    const svc = wcdbService as any
    if (typeof svc.execQueryWithParams !== 'function') {
      throw new Error('参数化查询不可用: execQueryWithParams 未实现')
    }
    const result: QueryResult = await svc.execQueryWithParams(kind, path, sql, params)
    if (!result.success && result.error && result.error.includes(PARAMS_UNSUPPORTED)) {
      throw new Error('参数化查询不可用: ' + result.error)
    }
    return result
  }
  return wcdbService.execQuery(kind, path, sql)
}

function ensureOk(result: QueryResult, sql: string): void {
  if (!result.success) {
    throw new Error(result.error || '数据库查询失败: ' + sql.slice(0, 80))
  }
}

export const dbAdapter = {
  async all<T = any>(kind: string, path: string, sql: string, params?: any[]): Promise<T[]> {
    const result = await runQuery(kind, path, sql, params)
    ensureOk(result, sql)
    return (result.rows ?? []) as T[]
  },

  async get<T = any>(kind: string, path: string, sql: string, params?: any[]): Promise<T | null> {
    const result = await runQuery(kind, path, sql, params)
    ensureOk(result, sql)
    const rows = result.rows ?? []
    return (rows[0] ?? null) as T | null
  },

  async exec(kind: string, path: string, sql: string, params?: any[]): Promise<number> {
    const result = await runQuery(kind, path, sql, params)
    ensureOk(result, sql)
    return 0
  }
}
