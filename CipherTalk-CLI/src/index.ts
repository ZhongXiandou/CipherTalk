import { createProgram } from './cli.js'
import { createCommandContext } from './commandRunner.js'
import { startInteractiveShell } from './interactiveShell.js'
import { createDefaultServices } from './services/index.js'
import { processOutput } from './output.js'

const argv = process.argv.slice(2)

// 无子命令 + TTY → 自动进入交互模式
const hasSubcommand = argv.length > 0 && !argv[0]?.startsWith('-')
const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY)

if (!hasSubcommand && isTty && !argv.includes('--quiet') && !argv.includes('-V') && !argv.includes('--version')) {
  const context = createCommandContext({
    output: processOutput,
    interactive: true
  })
  const globals: Record<string, any> = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=', 2)
      globals[key.replace(/-/g, '')] = val || true
    }
  }
  await startInteractiveShell(context, globals as any, {})
} else {
  createProgram().parseAsync(process.argv).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
