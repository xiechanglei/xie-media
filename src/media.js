// 媒体资源业务逻辑（v0.4 数据模型）：
// - collections 表达“一个资源集合”，items 表达其中的文件；不再区分 video/album，图片/视频可任意混装。
// - 上传不再选择模式：一次提交的 N 个文件（任意图片/视频组合）归为一个集合。
// - 浏览方式由前端根据内容自动判定（全视频=播放器+列表；否则=平铺），可在详情页手动切换。
// - 详情页承载收藏/可见性/编辑/删除；item 支持批量重命名/删除/排序 + 追加。
// - 文件按 md5 命名落 store/，同 md5 复用；删除按引用计数清理。
// - 缩略图首次访问时懒生成，图片直接原图返回。
import * as fs from 'node:fs'
import * as path from 'node:path'
import crypto from 'node:crypto'
import { all as dbAll, get as dbGet, run as dbRun, tx } from './db.js'
import { VIDEO_EXTENSIONS, IMAGE_EXTENSIONS } from './config.js'
import { ensureVideoThumbnail, probeVideoMeta } from './ffmpeg.js'

const PLACEHOLDER_SVG = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">\
<rect width="640" height="360" fill="#222"/>\
<text x="50%" y="50%" dy=".35em" fill="#888" font-family="sans-serif" font-size="28" text-anchor="middle">No Thumbnail</text>\
</svg>`, 'utf8')

const nowMs = () => Date.now()
const newId = () => crypto.randomUUID()

/** 依据文件名/扩展名判定媒体类型（导出供 scanner 复用） */
export function classifyFile(f) {
    const ext = (path.extname(f.filename || '').slice(1) || '').toLowerCase()
    if (VIDEO_EXTENSIONS.includes(ext)) return { type: 'video', ext }
    if (IMAGE_EXTENSIONS.includes(ext)) return { type: 'image', ext }
    return null
}

/** md5 前两位作为分片子目录，避免单目录文件过多；兜底 xx（导出供 scanner 复用） */
export function shardOf(md5) {
    return (/^[0-9a-f]{2}/i.test(md5 || '') ? md5.slice(0, 2).toLowerCase() : 'xx')
}

/** 资源可读性：public 或 owner 或 admin */
function canRead(user, row) {
    if (!user) return false
    if (user.role === 'admin') return true
    if (row.visibility === 'public') return true
    if (row.owner_id === user.id) return true
    return false
}

/** 写权限：owner 或 admin */
function canMutate(user, row) {
    if (!user) return false
    if (user.role === 'admin') return true
    return row.owner_id === user.id
}

/** DB item 行 → 对外 JSON（自动解析 meta_json） */
function mapItemRow(it) {
    let meta = null
    if (it.meta_json) { try { meta = JSON.parse(it.meta_json) } catch { /* ignore */ } }
    return {
        id: it.id,
        name: it.name || it.original_name,
        originalName: it.original_name,
        renamed: !!it.name,
        mime: it.mime, size: it.size,
        mediaType: it.media_type,
        sortOrder: it.sort_order,
        meta,
    }
}

/**
 * 创建业务处理器集合。
 * @param {{ storeDir: string, thumbnailDir: string }} cfg
 */
export function createMediaHandlers(cfg) {
    const { storeDir, thumbnailDir } = cfg

    /** 返回 md5 在 store/ 下的绝对路径（不保证存在）：store/<xx>/<md5> */
    const md5ToPath = (md5) => path.join(storeDir, shardOf(md5), md5)
    /** 缩略图同样分片：thumbnails/<xx>/<md5>.jpg */
    const thumbToPath = (md5) => path.join(thumbnailDir, shardOf(md5), `${md5}.jpg`)

    /** 将上传文件按 md5 落盘到 store/<xx>/；同 md5 已存在则跳过 transferTo 让临时文件自动清理 */
    function persistFile(f) {
        const target = md5ToPath(f.md5)
        if (fs.existsSync(target)) return target
        fs.mkdirSync(path.dirname(target), { recursive: true })
        return f.transferTo(target)
    }

    /** 统计 md5 在 items 中的引用数 */
    function countMd5Refs(md5) {
        return dbGet(`SELECT COUNT(*) AS c FROM items WHERE md5 = ?`, md5).c
    }

    /** 引用为 0 时清理 store 文件与缩略图 */
    function cleanupMd5IfUnreferenced(md5) {
        if (!md5) return
        if (countMd5Refs(md5) > 0) return
        try { const p = md5ToPath(md5); if (fs.existsSync(p)) fs.unlinkSync(p) } catch {}
        try { const t = thumbToPath(md5); if (fs.existsSync(t)) fs.unlinkSync(t) } catch {}
    }

    // ===================== 列表 =====================

    function listMedia(ctx) {
        const user = ctx.user
        const q = ctx.query || {}
        const scope = ['mine', 'plaza', 'favorites'].includes(q.scope) ? q.scope : 'mine'
        const page = Math.max(parseInt(q.page, 10) || 1, 1)
        const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 24, 1), 200)
        const keyword = (q.keyword || '').toString().trim().toLowerCase()

        let rows
        if (scope === 'mine') {
            rows = dbAll(`SELECT * FROM collections WHERE owner_id=? ORDER BY created_at DESC`, user.id)
        } else if (scope === 'plaza') {
            rows = dbAll(`SELECT * FROM collections WHERE visibility='public' ORDER BY created_at DESC`)
        } else { // favorites
            rows = dbAll(
                `SELECT c.* FROM collections c
                 JOIN favorites f ON f.target_id = c.id
                 WHERE f.user_id = ?
                 ORDER BY f.created_at DESC`,
                user.id)
        }

        if (keyword) {
            const kw = keyword
            rows = rows.filter(r =>
                (r.title || '').toLowerCase().includes(kw) ||
                (r.category || '').toLowerCase().includes(kw))
        }

        const total = rows.length
        const pageRows = rows.slice((page - 1) * pageSize, page * pageSize)

        const list = pageRows.map(r => {
            const cnt = dbGet(`SELECT COUNT(*) AS c FROM items WHERE collection_id=?`, r.id).c
            const fav = dbGet(`SELECT 1 AS x FROM favorites WHERE user_id=? AND target_id=?`,
                user.id, r.id)
            // 按媒体类型统计数量
            const typeRows = dbAll(
                `SELECT media_type, COUNT(*) AS c FROM items WHERE collection_id=? GROUP BY media_type`, r.id)
            let videoCount = 0, imageCount = 0
            for (const t of typeRows) {
                if (t.media_type === 'video') videoCount = t.c
                else if (t.media_type === 'image') imageCount = t.c
            }
            // 含视频则聚合元数据：总时长 + 最大分辨率（供卡片展示优化）
            let agg = null
            if (videoCount > 0) {
                const metas = dbAll(
                    `SELECT meta_json FROM items WHERE collection_id=? AND media_type='video'`, r.id)
                    .map(x => { try { return x.meta_json ? JSON.parse(x.meta_json) : null } catch { return null } })
                    .filter(Boolean)
                if (metas.length) {
                    const dur = metas.reduce((s, m) => s + (m.durationSec || 0), 0)
                    const maxH = Math.max(0, ...metas.map(m => m.height || 0))
                    const maxW = Math.max(0, ...metas.map(m => m.width || 0))
                    agg = {
                        durationSec: Math.round(dur),
                        width: maxW || null,
                        height: maxH || null,
                    }
                }
            }
            return {
                id: r.id,
                title: r.title,
                category: r.category,
                ownerId: r.owner_id,
                ownerName: r.owner_name,
                visibility: r.visibility,
                itemCount: cnt,
                videoCount,
                imageCount,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                favorited: !!fav,
                agg,
            }
        })

        return { list, total, page, pageSize }
    }

    // ===================== 上传（创建新 collection）=====================

    function upload(ctx) {
        const user = ctx.user
        const titleInput = (ctx.body.title || '').toString().trim()
        const categoryInput = (ctx.body.category || '').toString().trim() || null
        const files = ctx.files.files || []
        if (!Array.isArray(files) || files.length === 0) throw new Error('未收到文件')

        const classified = files.map(f => ({ f, info: classifyFile(f) }))
        for (const { f, info } of classified) {
            if (!info) throw new Error(`不允许的文件类型：${f.filename}`)
        }

        const collectionId = newId()
        const ts = nowMs()
        const title = titleInput || stripExt(files[0].filename)

        tx(() => {
            dbRun(
                `INSERT INTO collections (id,title,category,owner_id,owner_name,visibility,created_at,updated_at)
                 VALUES (?,?,?,?,?, 'private', ?, ?)`,
                collectionId, title, categoryInput, user.id, user.username, ts, ts)
            files.forEach((f, i) => {
                const { info } = classified[i]
                const finalPath = persistFile(f)
                const meta = info.type === 'video' ? probeVideoMeta(finalPath) : null
                dbRun(
                    `INSERT INTO items (id,collection_id,md5,ext,original_name,name,mime,size,media_type,sort_order,created_at,meta_json)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    newId(), collectionId, f.md5, info.ext, f.filename, null,
                    guessMime(info.ext), f.size, info.type, i, ts,
                    meta ? JSON.stringify(meta) : null)
            })
        })

        return {
            id: collectionId, title, category: categoryInput,
            visibility: 'private', itemCount: files.length,
        }
    }

    // ===================== 详情 =====================

    function getCollectionOrThrow(id) {
        const row = dbGet(`SELECT * FROM collections WHERE id = ?`, id)
        if (!row) throw new Error('资源不存在')
        return row
    }

    function getCollection(ctx) {
        const row = getCollectionOrThrow(ctx.params.id)
        if (!canRead(ctx.user, row)) throw new Error('无权访问')
        const items = dbAll(
            `SELECT id,md5,ext,original_name,name,mime,size,media_type,sort_order,meta_json
             FROM items WHERE collection_id=? ORDER BY sort_order ASC`, row.id)
        const fav = dbGet(
            `SELECT 1 AS x FROM favorites WHERE user_id=? AND target_id=?`,
            ctx.user.id, row.id)
        return {
            id: row.id, title: row.title, category: row.category,
            ownerId: row.owner_id, ownerName: row.owner_name, visibility: row.visibility,
            createdAt: row.created_at, updatedAt: row.updated_at,
            favorited: !!fav,
            items: items.map(mapItemRow),
        }
    }

    // ===================== 编辑：集合元信息 / 可见性 / 删除 =====================

    function updateCollection(ctx) {
        const row = getCollectionOrThrow(ctx.params.id)
        if (!canMutate(ctx.user, row)) throw new Error('无权修改')
        const title = (ctx.body.title ?? row.title).toString().trim() || row.title
        const category = ctx.body.category === undefined
            ? row.category
            : ((ctx.body.category || '').toString().trim() || null)
        dbRun(`UPDATE collections SET title=?, category=?, updated_at=? WHERE id=?`,
            title, category, nowMs(), row.id)
        return { id: row.id, title, category }
    }

    function updateCollectionVisibility(ctx) {
        const row = getCollectionOrThrow(ctx.params.id)
        if (!canMutate(ctx.user, row)) throw new Error('无权修改')
        const v = (ctx.body.visibility || '').toString()
        if (v !== 'public' && v !== 'private') throw new Error('visibility 必须为 public|private')
        dbRun(`UPDATE collections SET visibility=?, updated_at=? WHERE id=?`, v, nowMs(), row.id)
        return { id: row.id, visibility: v }
    }

    function deleteCollection(ctx) {
        const row = getCollectionOrThrow(ctx.params.id)
        if (!canMutate(ctx.user, row)) throw new Error('无权删除')
        const items = dbAll(`SELECT md5 FROM items WHERE collection_id=?`, row.id)
        tx(() => {
            dbRun(`DELETE FROM items WHERE collection_id=?`, row.id)
            dbRun(`DELETE FROM collections WHERE id=?`, row.id)
            dbRun(`DELETE FROM favorites WHERE target_id=?`, row.id)
        })
        for (const it of items) cleanupMd5IfUnreferenced(it.md5)
        return { deleted: row.id }
    }

    // ===================== items 批量编辑（重命名 / 删除 / 排序）=====================

    /**
     * 请求体：
     * {
     *   edits:    [{ id, name }, ...],         // 可选
     *   deletes:  [itemId, ...],                // 可选
     *   order:    [itemId, ...],                // 可选：删除之后剩余 item 的完整有序 id 列表
     * }
     */
    function patchItems(ctx) {
        const row = getCollectionOrThrow(ctx.params.id)
        if (!canMutate(ctx.user, row)) throw new Error('无权修改')
        const edits = Array.isArray(ctx.body.edits) ? ctx.body.edits : []
        const deletes = Array.isArray(ctx.body.deletes) ? ctx.body.deletes : []
        const order = Array.isArray(ctx.body.order) ? ctx.body.order : null

        tx(() => {
            const ts = nowMs()
            for (const e of edits) {
                if (!e || !e.id) continue
                const it = dbGet(`SELECT id,name,original_name FROM items WHERE id=? AND collection_id=?`,
                    e.id, row.id)
                if (!it) throw new Error(`item 不存在: ${e.id}`)
                const newName = (e.name ?? '').toString().trim()
                const finalName = newName && newName !== it.original_name ? newName : null
                dbRun(`UPDATE items SET name=? WHERE id=?`, finalName, it.id)
            }
            for (const id of deletes) {
                const it = dbGet(`SELECT md5 FROM items WHERE id=? AND collection_id=?`, id, row.id)
                if (!it) throw new Error(`item 不存在: ${id}`)
                dbRun(`DELETE FROM items WHERE id=?`, id)
            }
            if (order) {
                const existing = dbAll(`SELECT id FROM items WHERE collection_id=?`, row.id)
                const existingIds = new Set(existing.map(r => r.id))
                const orderSet = new Set(order)
                if (orderSet.size !== existingIds.size) throw new Error('order 必须覆盖剩余的全部 item')
                for (const id of orderSet) if (!existingIds.has(id)) throw new Error(`order 含未知 id: ${id}`)
                order.forEach((id, idx) => dbRun(`UPDATE items SET sort_order=? WHERE id=?`, idx, id))
            }
            dbRun(`UPDATE collections SET updated_at=? WHERE id=?`, nowMs(), row.id)
        })

        return { id: row.id, items: listItemsOf(row.id) }
    }

    function listItemsOf(collectionId) {
        const items = dbAll(
            `SELECT id,md5,ext,original_name,name,mime,size,media_type,sort_order,meta_json
             FROM items WHERE collection_id=? ORDER BY sort_order ASC`, collectionId)
        return items.map(mapItemRow)
    }

    // ===================== items 追加 =====================

    function collectionAddItems(ctx) {
        const row = getCollectionOrThrow(ctx.params.id)
        if (!canMutate(ctx.user, row)) throw new Error('无权修改')
        const files = ctx.files.files || []
        if (!Array.isArray(files) || files.length === 0) throw new Error('未收到文件')

        const classified = files.map(f => ({ f, info: classifyFile(f) }))
        for (const { f, info } of classified) {
            if (!info) throw new Error(`不允许的文件类型：${f.filename}`)
        }

        const max = dbGet(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE collection_id=?`, row.id).m
        const ts = nowMs()
        tx(() => {
            files.forEach((f, i) => {
                const { info } = classified[i]
                const finalPath = persistFile(f)
                const meta = info.type === 'video' ? probeVideoMeta(finalPath) : null
                dbRun(
                    `INSERT INTO items (id,collection_id,md5,ext,original_name,name,mime,size,media_type,sort_order,created_at,meta_json)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    newId(), row.id, f.md5, info.ext, f.filename, null,
                    guessMime(info.ext), f.size, info.type, max + 1 + i, ts,
                    meta ? JSON.stringify(meta) : null)
            })
            dbRun(`UPDATE collections SET updated_at=? WHERE id=?`, ts, row.id)
        })

        return { id: row.id, items: listItemsOf(row.id) }
    }

    // ===================== 收藏 =====================

    function addFavorite(ctx) {
        const targetId = (ctx.body.targetId || '').toString()
        if (!targetId) throw new Error('targetId 必填')
        const row = dbGet(`SELECT * FROM collections WHERE id=?`, targetId)
        if (!row) throw new Error('目标不存在')
        if (!canRead(ctx.user, row)) throw new Error('无权访问该资源')
        dbRun(
            `INSERT OR IGNORE INTO favorites (id,user_id,target_id,created_at) VALUES (?,?,?,?)`,
            newId(), ctx.user.id, targetId, nowMs())
        return { favorited: true, targetId }
    }

    function removeFavorite(ctx) {
        const targetId = (ctx.body.targetId ?? ctx.query.targetId ?? '').toString()
        if (!targetId) throw new Error('targetId 必填')
        dbRun(`DELETE FROM favorites WHERE user_id=? AND target_id=?`,
            ctx.user.id, targetId)
        return { favorited: false, targetId }
    }

    // ===================== 文件与缩略图 =====================

    /** 通过 items/:itemId 直接读取单个文件（不再依赖 collectionId 前缀，路由仍做权限校验） */
    function serveItemFile(ctx) {
        const item = dbGet(`SELECT * FROM items WHERE id=?`, ctx.params.itemId)
        if (!item) throw new Error('文件不存在')
        const row = getCollectionOrThrow(item.collection_id)
        if (!canRead(ctx.user, row)) throw new Error('无权访问')
        const p = md5ToPath(item.md5)
        if (!fs.existsSync(p)) throw new Error('文件不存在')
        return ctx.sendFile(p, {
            download: false, mimeType: item.mime || guessMime(item.ext),
            etag: true, lastModified: true, range: item.media_type === 'video',
        })
    }

    /** 集合封面：取 sort_order 最小的首项，再按媒体类型分派 */
    function serveCollectionThumbnail(ctx) {
        const row = getCollectionOrThrow(ctx.params.id)
        if (!canRead(ctx.user, row)) throw new Error('无权访问')
        const item = dbGet(
            `SELECT * FROM items WHERE collection_id=? ORDER BY sort_order ASC LIMIT 1`, row.id)
        if (!item) return sendPlaceholder(ctx)
        return sendItemThumb(ctx, item)
    }

    /** 单个 item 的缩略图路由入口（视频懒生成；图片直发） */
    function serveItemThumbnail(ctx) {
        const item = dbGet(`SELECT * FROM items WHERE id=?`, ctx.params.itemId)
        if (!item) throw new Error('文件不存在')
        const row = getCollectionOrThrow(item.collection_id)
        if (!canRead(ctx.user, row)) throw new Error('无权访问')
        return sendItemThumb(ctx, item)
    }

    /** 实际发送某个 item 对应的缩略图/原图（注意：不能与 serveItemThumbnail 同名，否则函数声明覆盖会丢失 ctx.params 解析逻辑） */
    function sendItemThumb(ctx, item) {
        const filePath = md5ToPath(item.md5)
        if (!fs.existsSync(filePath)) return sendPlaceholder(ctx)
        if (item.media_type === 'image') {
            return ctx.sendFile(filePath, {
                download: false, mimeType: item.mime || guessMime(item.ext),
                etag: true, lastModified: true, cacheControl: 'public, max-age=3600',
            })
        }
        const thumbPath = thumbToPath(item.md5)
        const ok = ensureVideoThumbnail({ videoPath: filePath, thumbPath })
        if (!ok) return sendPlaceholder(ctx)
        return ctx.sendFile(thumbPath, {
            download: false, mimeType: 'image/jpeg',
            etag: true, lastModified: true, cacheControl: 'public, max-age=3600',
        })
    }

    function sendPlaceholder(ctx) {
        ctx.status(200)
        return ctx.sendBuffer(PLACEHOLDER_SVG, { contentType: 'image/svg+xml' })
    }

    return {
        listMedia, upload,
        getCollection, updateCollection, updateCollectionVisibility, deleteCollection,
        patchItems, collectionAddItems,
        addFavorite, removeFavorite,
        serveItemFile, serveCollectionThumbnail, serveItemThumbnail,
    }
}

// ===================== 小工具 =====================

export function stripExt(name) {
    const i = name.lastIndexOf('.')
    return i > 0 ? name.slice(0, i) : name
}

const MIME_BY_EXT = {
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
}
export function guessMime(ext) {
    return MIME_BY_EXT[(ext || '').toLowerCase()] || 'application/octet-stream'
}
