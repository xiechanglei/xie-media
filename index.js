#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { createAuthServer } from "@xie-work/xie-auth"
import { resolveArgs } from "./src/args.js"
import {
    ALLOWED_EXTENSIONS,
    PENDING_DELETE_SWEEP_MS,
    SCAN_INTERVAL_MS,
    SCAN_MTIME_STABLE_MS,
    UPLOAD_MAX_FILES,
    UPLOAD_MAX_SIZE,
} from "./src/config.js"
import { initStoreDir } from "./src/work-dir.js"
import { initDb } from "./src/db.js"
import { assertFfmpegAvailable } from "./src/ffmpeg.js"
import { createMediaHandlers } from "./src/media.js"
import { createAlbumHandlers } from "./src/album.js"
import { createScanner } from "./src/scanner.js"
import { createAria2, aria2InstallHint } from "./src/aria2.js"
import { createOfflineHandlers } from "./src/offline.js"

// 启动日志降噪：node:sqlite 的 ExperimentalWarning 每次启动都刷两行，且会连带 --trace-warnings 提示；
// 这里接管默认输出只过滤它，其余警告（弃用等）仍照常显示。必须先于 initDb（db.js 懒加载 node:sqlite 才触发）
process.removeAllListeners('warning')
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(`(${w.name}) ${w.message}`) })

// 解析命令行参数
const { port, dir, title, maxDownloads, split, maxConnections, sources } = resolveArgs()

// 初始化工作目录
const workDir = initStoreDir(dir)

// 打开 SQLite + 建表迁移
await initDb(workDir.dbFile)

// 检测 ffmpeg（必须依赖）：缺失时友好报错退出，而不是抛异常刷屏堆栈
let ffmpegVersion
try {
    ffmpegVersion = assertFfmpegAvailable()
} catch (e) {
    console.error(`\n  ✗ 缺少必须依赖 ffmpeg，服务无法启动：\n${e.message}\n`)
    process.exit(1)
}

// 当前文件所在目录，用于将相对路径解析为绝对路径
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 用户与全局设置文件（xie-auth 写入，本工具只读：scan 归属 / 送人目标）
const usersFile = path.join(workDir.root, 'users.json')

const media = createMediaHandlers({
    storeDir: workDir.storeDir,
    thumbnailDir: workDir.thumbnailDir,
    usersFile,
    trimTempDir: workDir.trimTempDir,
})

// 专辑只读写数据库，不碰磁盘文件，故无需工作目录配置
const albums = createAlbumHandlers()

// 链式配置：静态资源、视图模板、上传、路由、守卫
const app = createAuthServer()
    .title(title)
    .userStore(path.join(workDir.root, 'users.json'))
    .static(path.join(__dirname, 'public'))
    .views(path.join(__dirname, 'views'))
    .upload(workDir.uploadTempDir, {
        maxSize: UPLOAD_MAX_SIZE,
        allowExtensions: ALLOWED_EXTENSIONS,
        maxFiles: UPLOAD_MAX_FILES,
    })

    // === 页面（未登录跳转登录页） ===
    .authGuard('/');

// -------- 主页 --------
app.use('/', (ctx) => ctx.sendView('index.html', { appTitle: title }))

// -------- 列表 / 上传 --------
app.useAuth('/api/media', 'GET', media.listMedia)
app.useAuth('/api/upload', 'POST', media.upload)

// -------- 集合合并（多选归并；须在 :id 之前注册，避免 merge 被当作 :id）--------
app.useAuth('/api/collections/merge', 'POST', media.mergeCollections)

// -------- 批量操作（多选公开/私有/删除/收藏/取消收藏；同样须在 :id 之前）--------
app.useAuth('/api/collections/batch', 'POST', media.batchCollections)

// -------- 送人（多选转移所有权并强制私有；须在 :id 之前）--------
app.useAuth('/api/collections/transfer', 'POST', media.transferCollections)

// -------- 可选接收用户（送人时挑选目标，已排除自己）--------
app.useAuth('/api/users', 'GET', media.listUsers)

// -------- 集合（视频/相册）CRUD --------
app.useAuth('/api/collections/:id', 'GET', media.getCollection)
app.useAuth('/api/collections/:id', 'PATCH', media.updateCollection)
app.useAuth('/api/collections/:id/visibility', 'PATCH', media.updateCollectionVisibility)
app.useAuth('/api/collections/:id', 'DELETE', media.deleteCollection)

// -------- items 维护（重命名 / 删除 / 排序 / 追加 / 视频裁剪）--------
app.useAuth('/api/collections/:id/items', 'PATCH', media.patchItems)
app.useAuth('/api/collections/:id/items', 'POST', media.collectionAddItems)
// 裁剪前的引用查询：同一文件（按 md5）还被其他多少处引用，供弹层告知风险
app.useAuth('/api/collections/:id/items/:itemId/md5-refs', 'GET', media.itemMd5Refs)
// 视频裁剪：只保留指定连续区间（掐头去尾），≤10 分钟重编码精剪、更长流拷贝（无效则报失败）；产物按新 md5 落盘并换 item 指向，
// 旧文件按引用计数处置（updateRefs 勾选则连带更新其他引用），被占用则进 pending_deletes 延迟清扫
app.useAuth('/api/collections/:id/items/:itemId/trim', 'POST', media.trimItemVideo)

// -------- 收藏 --------
app.useAuth('/api/favorites', 'POST', media.addFavorite)
app.useAuth('/api/favorites', 'DELETE', media.removeFavorite)

// -------- 专辑（仅创建者可见）--------
// 与 /api/collections 同一规矩：固定段 by-collections 与三段的 /:id/items 都先于两段的 /:id 注册
app.useAuth('/api/albums', 'GET', albums.listAlbums)                          // 我的专辑列表
app.useAuth('/api/albums', 'POST', albums.createAlbum)                        // 新建专辑
app.useAuth('/api/albums/by-collections', 'POST', albums.albumsOfCollections) // 这些资源在哪些专辑里
app.useAuth('/api/albums/:id/items', 'GET', albums.listAlbumItems)            // 专辑内资源列表
app.useAuth('/api/albums/:id/items', 'POST', albums.addAlbumItems)            // 批量加入专辑
app.useAuth('/api/albums/:id/items', 'DELETE', albums.removeAlbumItems)       // 批量移出专辑
app.useAuth('/api/albums/:id', 'PUT', albums.renameAlbum)                     // 重命名
app.useAuth('/api/albums/:id', 'DELETE', albums.deleteAlbum)                  // 删除专辑（仅解除引用，不动资源）

// -------- 文件与缩略图（流式 + Range）--------
app.useAuth('/media/items/:itemId', 'GET,HEAD', media.serveItemFile)
app.useAuth('/media/thumbnails/items/:itemId', 'GET,HEAD', media.serveItemThumbnail)
app.useAuth('/media/thumbnails/collections/:id', 'GET,HEAD', media.serveCollectionThumbnail)

// -------- 离线下载（接口始终注册，未装 aria2 时由 status.enabled 告知前端隐藏入口）--------
const aria2 = createAria2({ downloadDir: workDir.downloadDir, maxConcurrentDownloads: maxDownloads, split, maxConnectionPerServer: maxConnections })
const offline = createOfflineHandlers({
    aria2,
    downloadDir: workDir.downloadDir,
    storeDir: workDir.storeDir,
})
app.useAuth('/api/offline/status', 'GET', offline.status)
app.useAuth('/api/offline/tasks', 'POST', offline.addTask)
app.useAuth('/api/offline/tasks', 'GET', offline.listTasks)
app.useAuth('/api/offline/preview-torrent', 'POST', offline.previewTorrent)
app.useAuth('/api/offline/tasks/:id/preview', 'GET', offline.previewFiles)
app.useAuth('/api/offline/tasks/:id/select', 'POST', offline.selectFiles)
app.useAuth('/api/offline/tasks/:id/files', 'GET', offline.downloadedFiles)
app.useAuth('/api/offline/tasks/:id/ingest', 'POST', offline.ingestTask)
app.useAuth('/api/offline/tasks/:id/pause', 'POST', offline.pauseTask)
app.useAuth('/api/offline/tasks/:id/resume', 'POST', offline.resumeTask)
app.useAuth('/api/offline/tasks/:id', 'DELETE', offline.removeTask)

// 启动
app.serve(port)

// scan 目录自动入库扫描器（每 10s 一轮）
const scanner = createScanner({
    storeDir: workDir.storeDir,
    scanDir: workDir.scanDir,
    usersFile,
})
scanner.start()

// -------- 待删文件清扫：裁剪/删除时因播放器句柄占用（Windows）没删掉的旧文件与缩略图，
// 启动先扫一轮，之后定时重试；挂账在 pending_deletes 表，跨重启不丢 --------
try { media.cleanupPendingDeletes() } catch (e) { console.warn('[pending-deletes] 启动清扫失败:', e.message) }
setInterval(() => { try { media.cleanupPendingDeletes() } catch { /* 单轮失败下轮重试 */ } }, PENDING_DELETE_SWEEP_MS)

// -------- 裁剪过程文件：trim_temp/ 里的残留意味着上次没能收尾（崩溃/断电/强杀），启动即清空 --------
const trimLeftovers = media.cleanupTrimTemp()
if (trimLeftovers) console.log(`[trim_temp] 已清理上次残留的裁剪过程文件 ${trimLeftovers} 个`)

// -------- 离线下载：拉起 aria2 子进程（未安装则软降级，不影响主服务；状态在启动横幅依赖区展示）--------
const a2 = await aria2.start()
if (a2.ok) {
    // 会话恢复后 GID 全新，用 info_hash 认亲续传
    await offline.reconcile()
    // 进程退出时回收自拉的 daemon（SIGTERM 触发 aria2 落盘会话）
    const killAria2 = () => aria2.stop()
    process.on('exit', killAria2)
    process.on('SIGINT', () => { killAria2(); process.exit(0) })
    process.on('SIGTERM', () => { killAria2(); process.exit(0) })
}

// ===================== 启动横幅 =====================
// 三段式：启动参数 → 系统依赖 → 运行配置；不用分隔线框，靠 ANSI 加粗/颜色分层（终端与 WebStorm 控制台均支持）
// ANSI 序列不占显示宽度，列对齐不受着色影响
const B = (s) => `\x1b[1m${s}\x1b[0m`     // 加粗：标题、关键值
const DIM = (s) => `\x1b[2m${s}\x1b[0m`   // 淡化：用法说明、“（默认）”标注等次要信息
const C = (s) => `\x1b[36m${s}\x1b[0m`    // 青色：参数名与配置项标签
const OK = (s) => `\x1b[32m${s}\x1b[0m`   // 绿色：就绪/已启用
const ERR = (s) => `\x1b[31m${s}\x1b[0m`  // 红色：未就绪/未启用
const YEL = (s) => `\x1b[33m${s}\x1b[0m`  // 黄色：安装指引
const srcTag = (k) => sources[k] === 'default' ? DIM('（默认）') : ''
console.log(`\n  ${B(C(title))}`)
console.log()
console.log(`  ${B('启动参数')} ${DIM('用法：node index.js [options]')}`)
console.log(`    ${C('--port <端口>')}           监听端口          当前 ${B(port)}${srcTag('port')}`)
console.log(`    ${C('--dir <路径>')}            工作目录          当前 ${dir}${srcTag('dir')}`)
console.log(`    ${C('--title <名称>')}          系统名称          当前 ${B(`“${title}”`)}${srcTag('title')}`)
console.log(`    ${C('--max-downloads <个>')}    下载并发上限      当前 ${B(maxDownloads)}${srcTag('maxDownloads')}`)
console.log(`    ${C('--split <n>')}             单任务分段连接数  当前 ${B(split)}${srcTag('split')}`)
console.log(`    ${C('--max-connections <n>')}   同源并发连接数    当前 ${B(maxConnections)}${srcTag('maxConnections')}`)
console.log()
console.log(`  ${B('系统依赖')}`)
// 版本号放行尾：版本串长度不定，放中间会把说明列顶歪
console.log(`    ${OK('✓')} Node     运行环境 · 内置 SQLite，无需独立数据库服务 ${DIM(`(${process.version})`)}`)
console.log(`    ${OK('✓')} ffmpeg   必须 · 缩略图/视频裁剪 · 已就绪 ${DIM(`(${ffmpegVersion})`)}`)
if (a2.ok) {
    console.log(`    ${OK('✓')} aria2    可选 · 离线下载引擎 · 已就绪，不装不影响媒体功能 ${DIM(`(${a2.version})`)}`)
} else {
    console.log(`    ${ERR('✗')} aria2    可选 · 离线下载引擎 · ${ERR('未就绪')}，离线下载不可用`)
    console.log(`      ${YEL('↳ ' + aria2InstallHint())}`)
}
console.log()
console.log(`  ${B('运行配置')}`)
console.log(`    ${C('工作目录')}  ${workDir.root}`)
console.log(`    ${C('用户文件')}  ${usersFile}`)
console.log(`    ${C('扫描入库')}  ${workDir.scanDir} ${DIM(`（每 ${SCAN_INTERVAL_MS / 1000}s 一轮，文件 ${SCAN_MTIME_STABLE_MS / 1000}s 无变动才入库）`)}`)
console.log(`    ${C('上传')}      ≤${B(UPLOAD_MAX_FILES)} 个/请求 · 单文件 ≤${B(UPLOAD_MAX_SIZE)} · ${ALLOWED_EXTENSIONS.join('/')}`)
console.log(`    ${C('离线下载')}  ${a2.ok ? `${OK(B('已启用'))} · 同时最多 ${B(maxDownloads)} 个任务 · 单任务最多 ${B(split)} 段/同源 ${B(maxConnections)} 连接，超出的任务自动排队` : `${ERR(B('未启用'))}（缺 aria2，安装见上方系统依赖）`}`)
console.log(`    ${C('访问地址')}  ${B(OK(`http://localhost:${port}`))}\n`)
