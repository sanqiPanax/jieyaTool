// dsh-auto-extract / index.js (host 插件壳)
// 职责:
//   1. 注册 auto_extract_* 模型工具:让 agent 直接调批量递归解压
//   2. 探测/识别/密码池能力全部在 archive-core.js(纯 node,调 7-Zip)
// 依赖:仅 node 内置 + 外部 7-Zip(自动探测常见路径,可用设置覆盖)
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import {
  findSevenZip,
  detectType,
  isSplitSlave,
  extractOne,
  scanPasswords,
  autoExtractTree,
} from './archive-core.js'

export const name = 'dsh-auto-extract'
export const inject = ['tools']

const DEFAULT_OUT_MARK = '_extracted'

// 渲染工具返回
function textRender(_args, value) {
  return [{ type: 'text', text: String(value || '') }]
}

export function apply(ctx) {
  try {
    const tools = ctx.get('tools')
    if (!tools) {
      console.error('[dsh-auto-extract] tools 服务不可用,工具未注册')
      return
    }

    // ---- 工具1: 识别单文件真实格式 ----
    tools.register({
      name: 'auto_extract_probe',
      description:
        '识别一个文件的真实压缩格式(不信扩展名):通过魔数(magic bytes)判断 7z/rar/zip/gz 等,' +
        '对 exe 会用 7-Zip 探测是否为自解压(SFX)压缩包(普通程序 exe 会识别为普通文件,不会误判)。' +
        '用于"这个文件到底是压缩包还是普通文件/伪装的什么"。参数: path = 文件绝对路径。返回识别结果。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要识别的文件绝对路径' },
        },
        required: ['path'],
      },
      output: { schema: { type: 'string' }, render: textRender },
      async execute(args) {
        const { path } = args
        if (!path) return '缺少 path 参数'
        if (!existsSync(path)) return '文件不存在: ' + path
        const sevenZip = findSevenZip()
        const t = await detectType(path, {
          sevenZip,
          passwords: [],
          log: () => {},
        })
        const sz = sevenZip ? sevenZip : '(未找到 7-Zip)'
        const slave = isSplitSlave(path.split(/[\\/]/).pop())
        const lines = [
          `文件: ${path}`,
          `大小: ${(await statSize(path))}`,
          `真实类型: ${t === 'none' ? '非压缩包(普通文件)' : t}`,
          `分卷附属: ${slave ? '是(不应单独解,由主卷带出)' : '否'}`,
          `7-Zip: ${sz}`,
        ]
        if (t === 'none') {
          lines.push('提示: 若此文件来自下载资源且疑似伪装,可能为私有/加密自定义格式,通用工具无法识别。')
        }
        return lines.join('\n')
      },
    })

    // ---- 工具2: 批量递归解压 ----
    tools.register({
      name: 'auto_extract_run',
      description:
        '自动批量递归解压一个目录里的所有压缩包(核心工具):自动识别真实格式(伪装后缀 .jpg/.mp4/.7z删除/无后缀都行)、' +
        '跳过 SFX 分卷附属卷(.part2.rar/.002 等)、递归解压嵌套压缩包直到不再产出压缩包、' +
        '多密码自动尝试(secret 文件每行一个;解出内容里若出现"密码:xxx"或"第二层密码:xxx"(目录名/文件名/txt),自动学习并用于后续层)。' +
        '输出到 sourceDir 旁的 _extracted 目录,原文件只读不动,解压成功的中间压缩包自动清理。' +
        '适合:一次性下载了几十个包、改过后缀、多层套娃、密码可能分层的场景。' +
        '参数: sourceDir=源目录(必填); secretFile=密码文件路径(可选,每行一个密码); outRoot=输出目录(可选,默认 sourceDir/_extracted)。' +
        '执行可能耗时较长(GB 级),完成后返回成功/失败清单与发现的成品。',
      parameters: {
        type: 'object',
        properties: {
          sourceDir: { type: 'string', description: '要批量解压的源目录(绝对路径)' },
          secretFile: { type: 'string', description: '密码文件路径(可选,每行一个密码)' },
          outRoot: { type: 'string', description: '输出目录(可选,默认 sourceDir 旁的 _extracted)' },
          maxDepth: { type: 'number', description: '最大递归深度(可选,默认 50)' },
        },
        required: ['sourceDir'],
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          // 长输出折叠:只显示摘要 + 失败清单
          return [{ type: 'text', text: String(value || '') }]
        },
      },
      async execute(args, exec) {
        const { sourceDir, secretFile, outRoot, maxDepth } = args
        if (!sourceDir || !existsSync(sourceDir)) return '源目录不存在或未提供: ' + sourceDir
        const logLines = []
        const log = (m) => {
          logLines.push(m)
          if (exec && typeof exec.sendMessage === 'function') {
            try { exec.sendMessage({ type: 'progress', message: m }) } catch {}
          }
        }
        try {
          const r = await autoExtractTree(sourceDir, {
            outRoot,
            secretFile,
            maxDepth,
            log,
          })
          const lines = [
            `==== 自动解压完成 ====`,
            `源目录: ${sourceDir}`,
            `输出目录: ${r.outRoot}`,
            `成功解压: ${r.success.length} 个`,
            `失败: ${r.failed.length} 个`,
            `发现的成品 exe: ${r.products.length} 个`,
            '',
          ]
          if (r.failed.length) {
            lines.push('失败清单:')
            r.failed.forEach((f) => lines.push('  ✗ ' + f))
            lines.push('')
          }
          if (r.products.length) {
            lines.push('成品(exe):')
            r.products.slice(0, 20).forEach((p) => lines.push('  ✅ ' + p))
            if (r.products.length > 20) lines.push(`  ... 共 ${r.products.length} 个`)
          }
          lines.push('')
          lines.push('--- 执行日志(截断) ---')
          // 日志尾部 40 行
          lines.push(...logLines.slice(-40))
          return lines.join('\n')
        } catch (e) {
          return '解压失败: ' + ((e && e.message) || e)
        }
      },
    })

    // ---- 工具3: 环境检查 ----
    tools.register({
      name: 'auto_extract_status',
      description:
        '检查 dsh-auto-extract 插件的运行环境:7-Zip 是否可用(在哪)、默认密码文件约定等。' +
        '解压前可先调用确认环境就绪。',
      parameters: {
        type: 'object',
        properties: {},
      },
      output: { schema: { type: 'string' }, render: textRender },
      async execute() {
        const sz = findSevenZip()
        const lines = [
          'dsh-auto-extract 环境:',
          `7-Zip: ${sz ? '✅ ' + sz : '❌ 未找到(请安装 7-Zip 或设置 SEVENZIP_PATH 环境变量)'}`,
          `默认输出标记: ${DEFAULT_OUT_MARK}`,
          '能力: 魔数识别 / SFX 探测 / 分卷跳过 / 递归解压 / 多密码(全局+动态)',
        ]
        return lines.join('\n')
      },
    })
  } catch (e) {
    console.error('[dsh-auto-extract] apply failed:', (e && e.message) || e)
  }
}

async function statSize(p) {
  try {
    const { stat } = await import('node:fs/promises')
    const s = await stat(p)
    if (s.size > 1e9) return (s.size / 1e9).toFixed(2) + ' GB'
    if (s.size > 1e6) return (s.size / 1e6).toFixed(1) + ' MB'
    return s.size + ' B'
  } catch {
    return '?'
  }
}
