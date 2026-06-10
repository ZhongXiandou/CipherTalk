import type { MainProcessContext } from '../context'
import { registerAccountHandlers } from './accountHandlers'
import { registerActivationHandlers } from './activationHandlers'
import { registerAiHandlers } from './aiHandlers'
import { registerAppHandlers } from './appHandlers'
import { registerAppUpdateHandlers } from './appUpdateHandlers'
import { registerAuthHandlers } from './authHandlers'
import { registerCacheHandlers } from './cacheHandlers'
import { registerChatHandlers } from './chatHandlers'
import { registerConfigHandlers } from './configHandlers'
import { registerDataManagementHandlers } from './dataManagementHandlers'
import { registerDataHandlers } from './dataHandlers'
import { registerDbPathHandlers } from './dbPathHandlers'
import { registerExportHandlers } from './exportHandlers'
import { registerHttpApiHandlers } from './httpApiHandlers'
import { registerLogHandlers } from './logHandlers'
import { registerMediaHandlers } from './mediaHandlers'
import { registerMcpHandlers } from './mcpHandlers'
import { registerNotifyHandlers } from './notifyHandlers'
import { registerPetHandlers } from './petHandlers'
import { registerSnsHandlers } from './snsHandlers'
import { registerSkillHandlers } from './skillHandlers'
import { registerSttHandlers } from './sttHandlers'
import { registerSystemHandlers } from './systemHandlers'
import { registerWcdbHandlers } from './wcdbHandlers'
import { registerWindowHandlers } from './windowHandlers'
import { registerWxKeyHandlers } from './wxKeyHandlers'

export function registerModularIpcHandlers(ctx: MainProcessContext): void {
  registerConfigHandlers(ctx)
  registerAccountHandlers(ctx)
  registerSkillHandlers(ctx)
  registerMcpHandlers()
  registerHttpApiHandlers(ctx)
  registerDataHandlers(ctx)
  registerSystemHandlers()
  registerAppHandlers(ctx)
  registerAppUpdateHandlers(ctx)
  registerAuthHandlers(ctx)
  registerWindowHandlers(ctx)
  registerWxKeyHandlers(ctx)
  registerDbPathHandlers(ctx)
  registerWcdbHandlers(ctx)
  registerDataManagementHandlers(ctx)
  registerMediaHandlers(ctx)
  registerChatHandlers(ctx)
  registerSnsHandlers(ctx)
  registerExportHandlers(ctx)
  registerActivationHandlers(ctx)
  registerCacheHandlers(ctx)
  registerLogHandlers(ctx)
  registerSttHandlers(ctx)
  registerAiHandlers(ctx)
  registerPetHandlers(ctx)
  registerNotifyHandlers(ctx)
}
