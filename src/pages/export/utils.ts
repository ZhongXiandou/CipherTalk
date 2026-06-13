export function getAvatarLetter(name: string) {
  if (!name) return '?'
  return [...name][0] || '?'
}

// 微信系统 / 通知类特殊账号（非真人、非群聊）
const SYSTEM_ACCOUNTS = new Set([
  'weixin', 'fmessage', 'medianote', 'floatbottle', 'qmessage', 'tmessage',
  'qqmail', 'qqsync', 'newsapp', 'blogapp', 'facebookapp', 'masssendapp',
  'meishiapp', 'feedsapp', 'voipapp', 'officialaccounts', 'notification_messages',
  'brandsessionholder', 'opencustomerservicemsg', 'notifymessage', 'helper_entry',
  'voicevoipnotify', 'qqfriend', 'lbsapp', 'readerapp', 'exmail_tool', 'mphelper'
])

// 是否为公众号/服务号/系统账号等「杂七杂八」的会话（仅保留群聊与真人私聊）
export function isExcludedSession(username: string): boolean {
  if (!username) return true
  if (username.startsWith('gh_')) return true // 公众号 / 服务号 / 订阅号
  return SYSTEM_ACCOUNTS.has(username)
}
