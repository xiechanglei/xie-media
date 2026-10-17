#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { createAuthServer } from "@xie-work/xie-auth"
import { resolveArgs } from "./src/args.js"
import {
    ALLOWED_EXTENSIONS,
    UPLOAD_MAX_FILES,
    UPLOAD_MAX_SIZE,
} from "./src/config.js"
import { initStoreDir } from "./src/work-dir.js"
import { initDb } from "./src/db.js"
import { assertFfmpegAvailable } from "./src/ffmpeg.js"
import { createMediaHandlers } from "./src/media.js"
import { createScanner } from "./src/scanner.js"

// 解析命令行参数
const { port, dir, title } = resolveArgs()

// 初始化工作目录
const workDir = initStoreDir(dir)

// 打开 SQLite + 建表迁移
initDb(workDir.dbFile)

// 检测 ffmpeg（强制）
assertFfmpegAvailable()

// 当前文件所在目录，用于将相对路径解析为绝对路径
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 用户与全局设置文件（xie-auth 写入，本工具只读：scan 归属 / 送人目标）
const usersFile = path.join(workDir.root, 'users.json')

const media = createMediaHandlers({
    storeDir: workDir.storeDir,
    thumbnailDir: workDir.thumbnailDir,
    usersFile,
})

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

// -------- items 维护（重命名 / 删除 / 排序 / 追加）--------
app.useAuth('/api/collections/:id/items', 'PATCH', media.patchItems)
app.useAuth('/api/collections/:id/items', 'POST', media.collectionAddItems)

// -------- 收藏 --------
app.useAuth('/api/favorites', 'POST', media.addFavorite)
app.useAuth('/api/favorites', 'DELETE', media.removeFavorite)

// -------- 文件与缩略图（流式 + Range）--------
app.useAuth('/media/items/:itemId', 'GET,HEAD', media.serveItemFile)
app.useAuth('/media/thumbnails/items/:itemId', 'GET,HEAD', media.serveItemThumbnail)
app.useAuth('/media/thumbnails/collections/:id', 'GET,HEAD', media.serveCollectionThumbnail)

// 启动
app.serve(port)

// scan 目录自动入库扫描器（每 10s 一轮）
const scanner = createScanner({
    storeDir: workDir.storeDir,
    scanDir: workDir.scanDir,
    usersFile,
})
scanner.start()

console.log(`\n  ${title}`)
console.log(`  dir   : ${workDir.root}`)
console.log(`  scan  : ${workDir.scanDir}`)
console.log(`  port  : ${port}`)
console.log(`  ➜  http://localhost:${port}\n`)
