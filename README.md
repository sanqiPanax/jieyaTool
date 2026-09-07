# dsh-auto-extract（原 jieyaTool v2）

> 从 **jieyaTool v1.0**（GUI 手动改后缀解压）进化为 **DSH 插件**：对 Agent 说一句话，全自动批量递归解压。

一个 DeepSeek Harness (DSH) 自动解压插件。解决「一次性下载几十个压缩包、后缀被改、多层嵌套、每层密码不同、带分卷/SFX」的批量解压痛点——**零人工右键、零手动选后缀**。

## ✨ 核心能力

| 能力 | 说明 |
|---|---|
| 🧬 **魔数识别真实格式** | 不信扩展名。伪装成 `.jpg` / `.mp4` / `.7z删除` / `.7删除z` / `.是7z` / 无后缀,按文件头判断真实格式(7z/rar/zip/gz/xz/sfx) |
| 🔍 **exe 智能探测** | 用 7-Zip 探测 exe 是否为 SFX 自解压;`Type=PE` 的普通程序 exe(游戏成品)绝不误解压 |
| 🔁 **递归下钻** | 解出的新压缩包自动入队继续解,直到不再产出压缩包(实测 4 层套娃全自动) |
| 🔑 **多密码自动尝试** | 全局密码文件(每行一个)+ 动态密码:解出内容出现「第二层密码:xxx」(目录名/文件名/txt)自动学习用于后续层;顺序=动态→全局→空 |
| 📦 **SFX/分卷处理** | `.part2.rar`/`.002`/`.r00` 等附属卷自动跳过,由主卷(`.part1.exe`/`.001`)带出;成功解压的中间压缩包自动清理 |
| 🛡️ **安全** | 输出到源目录旁 `_extracted`,原始文件只读不动;解压先进临时目录,失败只清临时目录;工具运行库目录(`gameSaveBackup`/`node_modules`/`locales`)自动跳过防误递归 |
| 🚫 **私有格式归类** | 7z/WinRAR 都不识别的自定义封装(如 RC-SFX `.sfxv`)识别为普通文件不动,不误删不卡死 |

## 🚀 安装

```bash
# 本地开发安装(file 指向仓库目录)
cd ~/.dsh/profiles/web
# package.json 的 dependencies 加:
#   "dsh-auto-extract": "file:F:/ownWork/jieyaTool"
# dsh.profile.bundles 加:
#   "dsh-auto-extract"
pnpm install

# 重启 dsh 生效
```

## 🎮 使用(对 Agent 说一句即可)

```
用户: 我下载了一堆包在 E:\downloads\batch1,后缀都乱七八糟,密码在 secret.txt 里,帮我全解了
Agent: auto_extract_run(sourceDir="E:\downloads\batch1", secretFile="E:\downloads\batch1\secret.txt")
```

## 🛠 工具

| 工具 | 作用 |
|---|---|
| `auto_extract_run` | 批量递归解压一个目录(核心) |
| `auto_extract_probe` | 识别单文件真实格式(是压缩包还是普通文件) |
| `auto_extract_status` | 检查 7-Zip 环境 |

## 📊 实战验证

两个真实测试场全自动解压,0 人工干预:

**E:\Hgame\39**(5/6 链):
- `22222.7z删除` → 3 层 7z 套娃 → hero_legend.exe 游戏
- `飞天小女警.jpg`(伪装)→ Kendo.exe 游戏
- `Over·Empir`(无后缀)→ Game.exe 游戏(5.2GB)
- `C097999.jpg`(伪装 Rar5)→ 魔術師『恵』游戏
- `AL2695.sfx.part1+2`(RAR5 SFX 分卷)→ **自动发现「白菜」动态密码** → Goodbye_Eternity 游戏

**E:\Hgame\40**(6/6 链,12 个压缩包):
- `87.7z删` → 2 层 → C157000 Game.exe(跳过 MTool 存档目录)
- `黑手.7删除z` → 多层 → 被黑手浸染的玫瑰与百合 Game.exe
- `神之血.txt`(伪装 rar)→ The Blood of Yidhra.exe(4.1GB)
- `C142666_分卷`(part1-3)→ zip→rar→zip **4 层套娃** → ウミノイエ Game.exe
- `Guilty Hell Ⅱ_2.是7z` → GuiltyHell2_alpha.exe(12.6GB)
- `PCC153444.7z` → 私の雇い主は変態店長 Game.exe

## 📁 结构

```
jieyaTool/
├── package.json          ← 插件清单(dsh.bundle.patch)
├── cordis.patch.yml      ← bundle 激活行
├── lib/
│   ├── index.js          ← 插件壳(注册 auto_extract_* 工具)
│   └── archive-core.js   ← 纯 Node 解压引擎(无第三方依赖)
└── README.md
```

## ⚙️ 依赖

- Node ≥ 18
- 7-Zip(自动探测 `C:\Program Files\7-Zip\7z.exe` / `E:\7-Zip\7z.exe` 等,或设 `SEVENZIP_PATH`)

## 🧩 与 v1.0 对比

| | jieyaTool v1.0(GUI) | 本插件 v2.0 |
|---|---|---|
| 识别格式 | 手动选后缀强制改名 | 魔数自动识别(伪装/无后缀都行) |
| 嵌套 | 单层 | 自动递归到尽头 |
| 密码 | 单密码记忆 | 多密码列表 + 层内动态发现 |
| 分卷 | 手动 | 自动配对跳过附属卷 |
| SFX | 不支持 | 自动探测(排除成品 exe) |
| 调用方式 | 手动拖文件 | 对 Agent 说一句即可 |

## ⚠️ 已知边界

- **私有自解压格式**(RC 自定义 SFX、`.sfxv` 加密分卷)7-Zip 不识别,无法命令行自动化,需双击 exe 图形解压
- 需本机装 7-Zip
