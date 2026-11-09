/**
 * JiuLi 启动入口
 *
 * 启动模式：
 *   node .            internal（默认）→ 守护进程 + 主进程，同一终端；#重启 不会开新窗口
 *   node . daemon     与 internal 相同（保留兼容）
 *   node . start      external：单进程运行，重启交给外部守护（如 systemd/supervisor）
 *   node . pm2        由 pm2 管理（pnpm start）
 *   node . stop       请求正在运行的实例退出
 */
import fs from 'node:fs'

/** lib/core 是编译产物（不入库）：新克隆的机器上还没编译，这里给出明确指引而不是模块找不到 */
if (!fs.existsSync(new URL('./lib/core/start.js', import.meta.url))) {
  console.error(
    [
      '',
      '  lib/core 不存在：内核还没编译（编译产物不入库，克隆后需要先构建）。',
      '',
      '  任选其一：',
      '    node jiuli b     # 只编译内核',
      '    node jiuli i     # 装依赖 + 编译 + 生成配置（首次部署推荐）',
      '    node jiuli m     # 启动进 tmux（会自动完成上面的前置步骤）',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

switch (process.env.app_type || process.argv[2]) {
  case 'stop': {
    const cfg = (await import('./lib/core/config/index.js')).default
    await fetch(`http://localhost:${cfg.server.port}/exit`, {
      headers: cfg.server.auth || undefined,
    }).catch(() => {})
    process.exit()
  }
  case 'pm2':
    global.start_type = 'pm2'
    break
  case 'external':
  case 'start':
    global.start_type = 'external'
    break
  default:
    global.start_type = 'internal'
}

if (global.start_type === 'internal' && process.env.JIULI_CHILD !== '1') {
  /** 内部模式：守护进程负责拉起主进程（同一终端、支持 #重启 不开新窗口） */
  const { supervise } = await import('./lib/core/start.js')
  await supervise()
} else {
  /** JIULI_CHILD=1 时是守护进程拉起的子进程，直接运行主程序 */
  const { start } = await import('./lib/core/start.js')
  await start()
}
