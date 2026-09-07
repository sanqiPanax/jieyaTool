// dsh-auto-extract / archive-core.js
// 纯解压引擎(无 DSH 依赖,可独立 node 测试):
//   - detectType(path):魔数识别 + exe 用 7z 探测(Type=PE 排除成品),返回类型
//   - isSplitSlave(name):分卷附属卷判定(.002/.part2.rar/.r00...)
//   - extractOne(file, dest, passwords[], sevenZip):逐个密码试解,成功返回 {password}
//   - scanPasswords(dir):从目录/文件名/密码txt 提取"密码:xxx"动态密码
//   - autoExtractTree(root, opts):递归解压主流程(队列 + 动态密码 + 中间包清理)
// 7-Zip 通过子进程调用;所有路径以 UTF-8/原生参数传递(Windows 下用 spawn 不经 shell)。

import { spawn } from 'node:child_process'
import { readFile, readdir, stat, mkdir, rename, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename, extname, parse, sep } from 'node:path'
import { createReadStream } from 'node:fs'

// ---------- 7z 定位 ----------
const SZ_CANDIDATES = [
  process.env.SEVENZIP_PATH,
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  process.env.LOCALAPPDATA + '\\Programs\\7-Zip\\7z.exe',
  'E:\\7-Zip\\7z.exe',
  'D:\\7-Zip\\7z.exe',
]
export function findSevenZip() {
  for (const c of SZ_CANDIDATES) if (c && existsSync(c)) return c
  return null
}

// ---------- 读文件头 ----------
async function headBytes(file, n = 8) {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(file, { start: 0, end: n - 1 })
    const chunks = []
    rs.on('data', (c) => chunks.push(c))
    rs.on('end', () => resolve(Buffer.concat(chunks)))
    rs.on('error', reject)
  })
}

function hex(b) { return b.toString('hex').toUpperCase() }

// ---------- 跑 7z(子进程,不经 shell 防中文损坏)----------
function run7z(sevenZip, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(sevenZip, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    // 立即关闭 stdin,防止 7z 在需密码时交互等待输入而挂起
    try { child.stdin.end() } catch {}
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('error', (e) => resolve({ code: -1, out: '', err: String(e) }))
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, out, err }))
  })
}

// ---------- 魔数识别 + exe 探测 ----------
const DOC_ZIP_EXTS = new Set(['.docx','.xlsx','.pptx','.docm','.xlsm','.pptm','.odt','.ods','.odp','.jar','.apk','.epub','.vsix','.nupkg'])
const PE_TYPES = new Set(['PE','PE32','PE32+','Mach-O','ELF'])

export async function detectType(file, { sevenZip = null, passwords = [], log = () => {} } = {}) {
  let b
  try { b = await headBytes(file, 8) } catch { return 'none' }
  if (b.length < 4) return 'none'
  const h = hex(b)
  const ext = extname(file).toLowerCase()
  if (h.startsWith('377ABCAF')) return '7z'
  if (h.startsWith('526172211A07')) return 'rar'
  if (h.startsWith('504B0304') || h.startsWith('504B0506') || h.startsWith('504B0708')) {
    return DOC_ZIP_EXTS.has(ext) ? 'none' : 'zip'
  }
  if (h.startsWith('1F8B')) return 'gz'
  if (h.startsWith('FD377A585A00')) return 'xz'
  if (h.startsWith('425A68')) return 'bz2'
  if (h.startsWith('28B52FFD')) return 'zst'
  if (h.startsWith('4D5A')) {
    // exe: 用 7z 带密码逐个 list 探测,Type 非 PE 才算 SFX
    if (ext !== '.exe' || !sevenZip) return 'none'
    const probePws = ['', ...passwords]
    for (const pw of probePws) {
      // 关键:无论有无密码都传 -p(空密码传 -p 不带值),否则 7z 会交互等 stdin 而挂起
      const args = pw ? ['l', '-p' + pw, file] : ['l', '-p', file]
      const r = await run7z(sevenZip, args)
      const m = /^Type\s*=\s*(\S+)/m.exec(r.out)
      const type = m ? m[1] : ''
      if (r.code === 0 && type && !PE_TYPES.has(type)) return 'sfx'
      if (r.code === 0 && type === 'PE') break // 普通程序
      if (r.code !== 2 && r.code !== 255) break // 非"需密码"错误 => 非归档
      // code 2/255:可能加密归档需对密码,继续试
    }
    return 'none'
  }
  return 'none'
}

// ---------- 分卷附属卷 ----------
export function isSplitSlave(name) {
  if (/\.(002|003|004|005|006|007|008|009|010)(\.|$)/i.test(name)) return true
  if (/\.(r00|r01|r02|r03|r04|r05|r06|r07|r08|r09)$/i.test(name)) return true
  if (/\.part(0*[2-9]|[1-9]\d+)\.(rar|7z|exe)$/i.test(name)) return true
  if (/\.sfxv$/i.test(name) && !/\.001\./i.test(name)) return true
  return false
}

// ---------- 解压单文件(逐个密码)----------
export async function extractOne(file, dest, sevenZip, passwords, { log = () => {} } = {}) {
  await mkdir(dest, { recursive: true })
  // 密码顺序:传入的候选(动态在前,全局在后)→ 最后空密码兜底
  // (绝不能空密码优先:大文件无密码试解会跑很久才失败)
  const pws = [...passwords, '']
  for (const pw of pws) {
    const args = ['x', '-y', '-o' + dest]
    if (pw) args.push('-p' + pw); else args.push('-p')
    args.push(file)
    const r = await run7z(sevenZip, args)
    if (r.code === 0) {
      return { ok: true, password: pw || null }
    }
    // 失败:清掉本次部分解压,试下一个密码
    try { await rm(dest, { recursive: true, force: true }); await mkdir(dest, { recursive: true }) } catch {}
  }
  return { ok: false, password: null }
}

// ---------- 密码线索提取 ----------
const PW_RE = /(?:密码|提取码|解压码|password|pwd|passwd|key)\s*[:：=]\s*([^\s,，;；、]+)/gi

export function passwordsFromText(text) {
  const found = []
  if (!text) return found
  let m
  PW_RE.lastIndex = 0
  while ((m = PW_RE.exec(text)) !== null) {
    const t = m[1].trim().replace(/["”'。.!！]+$/, '')
    if (t && t.length <= 100 && !found.includes(t)) found.push(t)
  }
  return found
}

// 递归收集目录里所有"密码:xxx"线索(子项名 + txt/log/md 内容)
export async function scanPasswords(dir, { log = () => {} } = {}) {
  const found = []
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return found }
  for (const e of entries) {
    for (const t of passwordsFromText(e.name)) {
      if (!found.includes(t)) { found.push(t); log(`[动态密码] ${e.name}: ${t}`) }
    }
    if (e.isFile() && /\.(txt|log|md)$/i.test(e.name)) {
      try {
        const content = await readFile(join(dir, e.name), 'utf8')
        for (const line of content.split(/\r?\n/)) {
          for (const t of passwordsFromText(line)) {
            if (!found.includes(t)) { found.push(t); log(`[动态密码] ${e.name}: ${t}`) }
          }
        }
      } catch {}
    }
  }
  return found
}

// ---------- 去掉压缩扩展名(循环)---------
// 处理真实世界怪后缀:.7z删除 / .7z删除删除 / .sfx.part1.exe / .jpg 伪装等
// 策略:持续剥离"看起来像压缩相关"的尾段,直到不再匹配。
const ARC_SEG_RE = /\.(7z(删除)*|rar(删除)*|zip(删除)*|删除+|exe(删除)*|sfx(删除)*|part\d+|001|002|003|gz|xz|bz2|jpg|jpeg|png|mp4|mp3|txt|pdf)$/i
export function stripArchiveExt(name) {
  let n = name
  for (let i = 0; i < 12; i++) {
    const idx = n.lastIndexOf('.')
    if (idx <= 0) break
    const tail = n.slice(idx)
    if (ARC_SEG_RE.test(tail)) {
      n = n.slice(0, idx)
    } else break
  }
  return n || 'extracted'
}

// ---------- 稳健目录合并:把 srcDir 内容并入 dstDir(处理文件/目录同名冲突)----------
async function mergeDir(srcDir, dstDir, { depth = 0 } = {}) {
  if (depth > 40) return
  await mkdir(dstDir, { recursive: true })
  let entries = []
  try { entries = await readdir(srcDir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const src = join(srcDir, e.name)
    const dst = join(dstDir, e.name)
    if (e.isDirectory()) {
      // 目录:目标同名存在
      let dstIsDir = false
      try { dstIsDir = (await stat(dst)).isDirectory() } catch {}
      if (dstIsDir) {
        // 递归合并
        await mergeDir(src, dst, { depth: depth + 1 })
        await rm(src, { recursive: true, force: true }).catch(() => {})
      } else {
        if (existsSync(dst)) await rm(dst, { recursive: true, force: true }).catch(() => {})
        await rename(src, dst).catch(async () => {
          // rename 失败(跨卷等)则复制
          await copyDir(src, dst)
          await rm(src, { recursive: true, force: true }).catch(() => {})
        })
      }
    } else {
      // 文件:目标同名已存在目录时,把它放进带后缀的路径避免冲突
      if (existsSync(dst)) {
        let dstIsDir = false
        try { dstIsDir = (await stat(dst)).isDirectory() } catch {}
        if (dstIsDir) {
          const alt = dst + ' (duplicate)'
          await rename(src, alt).catch(async () => { await copyFile(src, alt) })
          continue
        }
        // 同名文件:覆盖(解压重复内容,后解覆盖先解)
        await rm(dst, { force: true }).catch(() => {})
      }
      try { await rename(src, dst) } catch { await copyFile(src, dst) }
    }
  }
}

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const s = join(src, e.name)
    const d = join(dst, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else { await copyFile(s, d) }
  }
}


// opts: { outRoot, secretFile, sevenZip, maxDepth=50, deleteIntermediate=true, log }
// 返回: { success:[], failed:[], unsupported:[], products:[] }
export async function autoExtractTree(sourceDir, opts = {}) {
  const sevenZip = opts.sevenZip || findSevenZip()
  if (!sevenZip) throw new Error('找不到 7-Zip,请安装或设置 SEVENZIP_PATH')
  if (!existsSync(sourceDir)) throw new Error('源目录不存在: ' + sourceDir)

  const outRoot = opts.outRoot || join(sourceDir, '_extracted')
  await mkdir(outRoot, { recursive: true })
  const log = opts.log || (() => {})
  const maxDepth = opts.maxDepth || 50

  // 全局密码
  const globalPw = []
  if (opts.secretFile && existsSync(opts.secretFile)) {
    const raw = await readFile(opts.secretFile, 'utf8')
    for (const l of raw.split(/\r?\n/)) {
      const t = l.trim()
      if (t && !globalPw.includes(t)) globalPw.push(t)
    }
  }
  log(`全局密码池: [${globalPw.join(' | ')}] (${globalPw.length} 条)`)

  // 动态密码
  const dynPw = []
  const allPw = () => [...new Set([...dynPw, ...globalPw])]

  // 队列
  const queue = []
  const results = { success: [], failed: [], unsupported: [], products: [] }
  const seenFiles = new Set()

  const pushTask = (file, depth, baseDir) => {
    if (seenFiles.has(file)) return
    seenFiles.add(file)
    queue.push({ file, depth, baseDir })
  }

  // 初始扫描顶层(只收真压缩,跳过附属卷)
  let topEntries = []
  try { topEntries = await readdir(sourceDir, { withFileTypes: true }) } catch (e) { throw new Error('读源目录失败: ' + e.message) }
  for (const e of topEntries) {
    if (!e.isFile()) continue
    if (isSplitSlave(e.name)) { log(`跳过分卷附属: ${e.name}`); continue }
    const full = join(sourceDir, e.name)
    const t = await detectType(full, { sevenZip, passwords: allPw(), log })
    if (t !== 'none') { pushTask(full, 0, outRoot); log(`入队(初始, ${t}): ${e.name}`) }
  }

  // 复制普通非压缩文件(顶层辅助文件如 secret.txt 不必复制,但其它文件保留)
  // (策略:只解压,顶层普通文件不复制,避免污染输出)

  let round = 0
  while (queue.length > 0) {
    const task = queue.shift()
    const { file, depth, baseDir } = task
    round++
    if (depth > maxDepth) { log(`SKIP 超深: ${file}`); results.failed.push(file); continue }
    if (!existsSync(file)) { log(`SKIP 消失: ${file}`); continue }

    const type = await detectType(file, { sevenZip, passwords: allPw(), log })
    if (type === 'none') continue

    log(`\n[${round}] 深度${depth} 类型=${type}: ${file}`)
    // 临时目录解压,成功再归位(防失败误删源)
    const tmpDir = join(outRoot, '_work_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
    await mkdir(tmpDir, { recursive: true })

    let r
    try {
      r = await extractOne(file, tmpDir, sevenZip, allPw(), { log })
    } catch (e) {
      log(`✗ extractOne 异常: ${(e && e.stack) || e}`)
      r = { ok: false, password: null }
    }
    if (!r.ok) {
      log(`✗ 解压失败(密码均错/损坏): ${file}`)
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      results.failed.push(file)
      continue
    }
    log(`✓ 密码命中: ${r.password || '(无密码)'}`)
    results.success.push(file)

    // 归位:去掉扩展名当目录名
    let finalName = stripArchiveExt(basename(file))
    const finalDir = join(baseDir, finalName)
    await mkdir(finalDir, { recursive: true })

    // 上提冗余嵌套:tmpDir 内若是 单目录且名≈finalName,逐层上提
    let cursor = tmpDir
    for (let i = 0; i < 5; i++) {
      let kids = []
      try { kids = await readdir(cursor, { withFileTypes: true }) } catch { break }
      if (kids.length === 1 && kids[0].isDirectory() && (kids[0].name === finalName || kids[0].name.startsWith(finalName))) {
        cursor = join(cursor, kids[0].name)
      } else break
    }
    // cursor 内容并入 finalDir(稳健合并,处理同名冲突)
    try {
      await mergeDir(cursor, finalDir)
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      log(`→ 产物: ${finalDir}`)
    } catch (e) {
      log(`✗ 归位异常: ${(e && e.stack) || e}`)
      // 不致命:保留 tmpDir 内容,记录但继续
      results.failed.push(file)
    }

    // 吸收密码(子项名/txt)+ 扫描新压缩包
    const newPws = await scanPasswords(finalDir, { log })
    for (const p of newPws) if (!dynPw.includes(p)) dynPw.push(p)

    const walkStack = [finalDir]
    // 跳过这些目录(工具备份/存档/运行库/资源,非套娃压缩内容,避免误递归爆炸)
    const SKIP_DIR_RE = /(gameSaveBackup|save_backup|\.git|node_modules|locales|swiftshader|pnacl|www|loaders|_cache|Cache|backup|Backup)/i
    while (walkStack.length) {
      const cur = walkStack.pop()
      let entries = []
      try { entries = await readdir(cur, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const full = join(cur, e.name)
        if (e.isDirectory()) {
          // 跳过工具/存档/运行库目录(里面 zip 多为资源或存档备份,非内容套娃)
          if (SKIP_DIR_RE.test(e.name)) { log(`  [跳过目录] ${e.name}`); continue }
          walkStack.push(full)
        }
        else if (e.isFile() && !isSplitSlave(e.name)) {
          const t2 = await detectType(full, { sevenZip, passwords: allPw(), log })
          if (t2 !== 'none') {
            pushTask(full, depth + 1, dirname(full))
            log(`  发现新压缩包(深度${depth+1}, ${t2}): ${e.name}`)
          }
        }
      }
    }

    // 中间包清理:源在 outRoot 内且成功解压 => 删源(防残留中间层)
    if (opts.deleteIntermediate !== false && file.startsWith(outRoot) && existsSync(file)) {
      log(`[清理中间包] ${file}`)
      await rm(file, { force: true }).catch(() => {})
    }
  }

  // 报告产物 exe(成品游戏)
  const walk = async (d) => {
    let ents = []
    try { ents = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else if (/\.(exe)$/i.test(e.name)) results.products.push(full)
    }
  }
  await walk(outRoot)

  results.outRoot = outRoot
  return results
}

