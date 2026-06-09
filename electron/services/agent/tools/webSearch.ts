/**
 * web_search —— 联网搜索工具（Tavily 后端，见 services/ai/webSearchService）。
 * 仅在用户开启「联网搜索」且配了 key 时才挂进工具集（见 tools/index.ts buildTools）。
 * 用于本地聊天记录答不了、需要外部/实时信息的问题；结果带 url，模型须标注来源。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { tavilySearch } from '../../ai/webSearchService'

export const webSearch = tool({
  description:
    '联网搜索互联网获取外部/实时信息（新闻、公开数据、百科、行情等）。' +
    '仅当问题需要聊天记录之外的信息时才用；能用本地聊天记录工具回答的不要用。' +
    '返回若干网页结果（标题/链接/摘要），回答时必须标注来源链接。',
  inputSchema: z.object({
    query: z.string().min(1).describe('搜索关键词或问题，尽量具体'),
    maxResults: z.number().int().min(1).max(10).optional().describe('返回结果条数，默认 5'),
  }),
  execute: async ({ query, maxResults }, { abortSignal }) => {
    try {
      const res = await tavilySearch(query, { maxResults, signal: abortSignal })
      if (res.results.length === 0) {
        return { query, answer: res.answer || '', results: [], note: '没有搜到结果' }
      }
      return {
        query,
        answer: res.answer || '',
        results: res.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  },
})
