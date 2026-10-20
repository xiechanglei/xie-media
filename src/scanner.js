// scan 目录自动入库扫描器（v0.5）
// - 工作目录下 scan/ 为"投递口"：每 SCAN_INTERVAL_MS 扫一次，一级深度。
// - 散文件 → 各自成一个资源（标题 = 文件名去扩展名）；一级文件夹 → 夹内白名单文件收进一个资源（标题 = 文件夹名）。
// - 文件流式算 md5：md5 已被 items 引用 → 视为重复，移入 scan/.duplicates/（不删用户数据）；
//   否则移入 store/<xx>/<md5>（同盘 rename，瞬间完成，scan 不留源文件）。
// - 半传输防护：mtime 距今 ≥ SCAN_MTIME_STABLE_MS 才处理，否则留待下轮。
// - 归属 users.json 中第一个 admin；可见性 private；category 空。单轮串行，busy 防重入。
import * as fs from 'node:fs'
import * as path from 'node:path'
import crypto from 'node:crypto'
import { get as dbGet, run as dbRun, tx } from './db.js'
import { probeVideoMeta } from './ffmpeg.js'
import { classifyFile, stripExt, guessMime, shardOf } from './media.js'
import { fileMd5Streaming, moveFile } from './files.js'
import { findAdmin } from './user-store.js'
import { SCAN_INTERVAL_MS, SCAN_MTIME_STABLE_MS } from './config.js'

const nowMs = () => Date.now()
const newId = () => crypto.randomUUID()

const DUPLICATE_SUBDIR = '.duplicates'

/**
 * 创建扫描器。
 * @param {{ storeDir: string, scanDir: string, usersFile: string }} cfg
 * @returns {{ start: () => void }}
 */
export function createScanner(cfg) {
    const { storeDir, scanDir, usersFile } = cfg

    let busy = false
    let timer = null
    let warnedNoAdmin = false

    /** 文件是否已过稳定期（写完） */
    const isStable = (p) => {
        try {
            return nowMs() - fs.statSync(p).mtimeMs >= SCAN_MTIME_STABLE_MS
        } catch {
            return false
        }
    }

    /** 将重复文件移入 scan/.duplicates/，保留相对结构，重名加时间戳 */
    function moveToDuplicates(src, dirPath) {
        const rel = dirPath
            ? path.join(path.basename(dirPath), path.basename(src))
            : path.basename(src)
        let dest = path.join(scanDir, DUPLICATE_SUBDIR, rel)
        if (fs.existsSync(dest)) {
            const ext = path.extname(rel)
            const base = rel.slice(0, rel.length - ext.length)
            dest = path.join(scanDir, DUPLICATE_SUBDIR, `${base}.${Date.now()}${ext}`)
        }
        moveFile(src, dest)
    }

    /** 若目录已空（忽略隐藏项）则删除 */
    function tryRemoveEmptyDir(dir) {
        try {
            const rest = fs.readdirSync(dir).filter((n) => !n.startsWith('.'))
            if (rest.length === 0) fs.rmdirSync(dir)
        } catch { /* ignore */ }
    }

    /**
     * 入库一个资源：逐个文件算 md5 → 重复移入 .duplicates / 新文件移入 store 并登记 item；
     * 至少一个新文件时在事务内建 collections(owner=admin)+items。
     * @returns {{ collections:number, files:number, dups:number }}
     */
    async function ingestResource({ title, files, dirPath }, admin) {
        const newItems = []
        let filesIngested = 0
        let dups = 0

        for (const f of files) {
            const cls = classifyFile({ filename: path.basename(f) })
            if (!cls) continue
            let size, md5
            try {
                size = fs.statSync(f).size
                md5 = await fileMd5Streaming(f)
            } catch (e) {
                console.error(`[scan] 读取失败 ${f}: ${e.message}`)
                continue
            }
            // md5 已被引用 → 重复，移入 .duplicates，不入库
            if (dbGet(`SELECT 1 AS x FROM items WHERE md5=?`, md5)) {
                try {
                    moveToDuplicates(f, dirPath)
                    dups++
                } catch (e) {
                    console.error(`[scan] 重复文件归档失败 ${f}: ${e.message}`)
                }
                continue
            }
            // 新内容 → 移入 store/<xx>/<md5>
            const target = path.join(storeDir, shardOf(md5), md5)
            try {
                moveFile(f, target)
            } catch (e) {
                console.error(`[scan] 移入 store 失败 ${f}: ${e.message}`)
                continue
            }
            const meta = cls.type === 'video' ? await probeVideoMeta(target) : null
            newItems.push({ md5, ext: cls.ext, originalName: path.basename(f), size, type: cls.type, meta })
            filesIngested++
        }

        // 无新内容（全是重复或全部失败）→ 不建资源
        if (newItems.length === 0) {
            if (dirPath) tryRemoveEmptyDir(dirPath)
            if (dups > 0) {
                console.log(`[scan] 跳过「${title || '未命名'}」：${dups} 个文件内容重复，未新建资源`)
            }
            return { collections: 0, files: 0, dups }
        }

        const collectionId = newId()
        const ts = nowMs()
        tx(() => {
            dbRun(
                `INSERT INTO collections (id,title,category,owner_id,owner_name,visibility,created_at,updated_at)
                 VALUES (?,?,?,?,?, 'private', ?, ?)`,
                collectionId, title || '未命名', null, admin.id, admin.username, ts, ts)
            newItems.forEach((it, i) => {
                dbRun(
                    `INSERT INTO items (id,collection_id,md5,ext,original_name,name,mime,size,media_type,sort_order,created_at,meta_json)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    newId(), collectionId, it.md5, it.ext, it.originalName, null,
                    guessMime(it.ext), it.size, it.type, i, ts,
                    it.meta ? JSON.stringify(it.meta) : null)
            })
        })

        if (dirPath) tryRemoveEmptyDir(dirPath)
        // 每入库一个资源即时打印（不待整轮结束）
        const kind = newItems.filter((it) => it.type === 'video').length
            ? '含视频' : '纯图片'
        console.log(`[scan] ✓ 已入库资源「${title || '未命名'}」：${newItems.length} 个文件（${kind}${dups > 0 ? `，另有 ${dups} 个重复已移入 .duplicates` : ''}）`)
        return { collections: 1, files: filesIngested, dups }
    }

    /** 遍历 scan 一级目录，收集并入库；返回本轮汇总 */
    async function scanOnce() {
        const admin = findAdmin(usersFile)
        if (!admin) {
            if (!warnedNoAdmin) {
                console.log('[scan] 未找到 admin 用户，暂缓自动入库（先注册首个账号）')
                warnedNoAdmin = true
            }
            return
        }
        warnedNoAdmin = false

        let entries
        try {
            entries = fs.readdirSync(scanDir, { withFileTypes: true })
        } catch (e) {
            console.error(`[scan] 读取 scan 目录失败: ${e.message}`)
            return
        }

        let nCollections = 0, nFiles = 0, nDups = 0

        for (const ent of entries) {
            if (ent.name.startsWith('.')) continue
            const full = path.join(scanDir, ent.name)

            if (ent.isFile()) {
                if (!classifyFile({ filename: ent.name })) continue
                if (!isStable(full)) continue
                const r = await ingestResource({ title: stripExt(ent.name), files: [full] }, admin)
                nCollections += r.collections; nFiles += r.files; nDups += r.dups
            } else if (ent.isDirectory()) {
                let memberNames
                try { memberNames = fs.readdirSync(full) } catch { continue }
                const memberFiles = []
                let nestedCount = 0
                for (const mn of memberNames.sort()) {
                    if (mn.startsWith('.')) continue
                    const mf = path.join(full, mn)
                    let st
                    try { st = fs.statSync(mf) } catch { continue }
                    if (st.isDirectory()) { nestedCount++; continue }
                    if (!classifyFile({ filename: mn })) continue
                    memberFiles.push(mf)
                }
                if (nestedCount) {
                    console.log(`[scan] 忽略 ${ent.name}/ 内 ${nestedCount} 个嵌套子目录（仅一级深度）`)
                }
                if (memberFiles.length === 0) continue
                // 目录整体稳定：取内部文件最新 mtime
                let latest = 0
                for (const mf of memberFiles) {
                    try { latest = Math.max(latest, fs.statSync(mf).mtimeMs) } catch { /* ignore */ }
                }
                if (nowMs() - latest < SCAN_MTIME_STABLE_MS) continue
                const r = await ingestResource({ title: ent.name, files: memberFiles, dirPath: full }, admin)
                nCollections += r.collections; nFiles += r.files; nDups += r.dups
            }
        }

        if (nCollections || nDups) {
            console.log(`[scan] 本轮入库 ${nCollections} 个资源 / ${nFiles} 个文件，跳过重复 ${nDups} 个`)
        }
    }

    return {
        start() {
            try { fs.mkdirSync(scanDir, { recursive: true }) } catch { /* ignore */ }
            timer = setInterval(() => {
                if (busy) return
                busy = true
                scanOnce()
                    .catch((e) => console.error('[scan] 扫描出错:', e && e.message ? e.message : e))
                    .finally(() => { busy = false })
            }, SCAN_INTERVAL_MS)
            if (timer && typeof timer.unref === 'function') timer.unref()
        },
    }
}
