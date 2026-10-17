// 专辑（albums）业务逻辑：
// - 专辑是“资源的收藏册”：album_entries 只引用 collections.id，既不持有文件也不复制标题，
//   所以资源改名/换封面后专辑里自动是新内容，无需任何同步。
// - 仅创建者可见：albums.visibility 恒为 private（字段留着，将来放开到广场时不必改表）。
// - 同步职责划分（与 src/media.js 的约定）：
//   存在性变动（资源被删除 / 被合并）→ media.js 物理同步条目；
//   可见性变动（他人转私有、换 owner）→ 本模块只在读取时过滤，条目保留，重新公开后自动回来；
//   收藏与否完全不影响专辑条目——资源是加进专辑的，不是从收藏里来的。
import crypto from 'node:crypto'
import { all as dbAll, get as dbGet, run as dbRun, tx } from './db.js'
import { canRead, mapCollectionCard } from './media.js'

const nowMs = () => Date.now()
const newId = () => crypto.randomUUID()

/**
 * 创建专辑业务处理器。
 * 专辑不读写 users.json：接收方展示用的是 collections.owner_name 冗余字段，故无跨用户配置。
 */
export function createAlbumHandlers() {
    /** 取专辑行，不存在即抛错（由 xie-auth 统一转成错误响应） */
    function getAlbumOrThrow(id) {
        const row = dbGet(`SELECT * FROM albums WHERE id=?`, id)
        if (!row) throw new Error('专辑不存在')
        return row
    }

    /** 专辑是个人的整理册：仅创建者本人可增删改查，admin 例外（与资源一致，便于管理） */
    function canMutateAlbum(user, row) {
        if (!user) return false
        if (user.role === 'admin') return true
        return row.owner_id === user.id
    }

    /** 归一化资源 id 列表：去空、去重、保序（前端点选顺序即加入顺序） */
    function normalizeIds(raw) {
        if (!Array.isArray(raw)) throw new Error('collectionIds 必须为数组')
        return [...new Set(raw.map(x => String(x || '').trim()).filter(Boolean))]
    }

    /** 专辑条目的 collections 行，按 added_at 倒序（新加入的在前） */
    function albumCollections(albumId) {
        return dbAll(
            `SELECT c.* FROM album_entries e JOIN collections c ON c.id = e.collection_id
             WHERE e.album_id=? ORDER BY e.added_at DESC`, albumId)
    }

    /** 存在但当前读不到的他人资源不再展示：admin 视为全部可读（与 canRead 同口径） */
    function visibleFor(user, rows) {
        if (user.role === 'admin') return rows
        return rows.filter(r => r.visibility === 'public' || r.owner_id === user.id)
    }

    // ---------- 专辑本体 ----------

    /** GET /api/albums?keyword= 我的专辑列表（带条目数与当前可见数，供“少了”的提示） */
    function listAlbums(ctx) {
        const user = ctx.user
        const keyword = ((ctx.query || {}).keyword || '').toString().trim().toLowerCase()
        let rows = dbAll(`SELECT * FROM albums WHERE owner_id=? ORDER BY created_at DESC`, user.id)
        if (keyword) rows = rows.filter(r => (r.title || '').toLowerCase().includes(keyword))
        const list = rows.map(r => {
            const all = albumCollections(r.id)
            const visible = visibleFor(user, all)
            return {
                id: r.id,
                title: r.title,
                visibility: r.visibility,
                entryCount: all.length,
                visibleCount: visible.length,
                invisibleCount: all.length - visible.length,
                // 封面与统计跟随最新一条可见资源：不单独存封面，省掉一套同步逻辑
                firstVisibleCollectionId: visible[0]?.id || null,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            }
        })
        return { list, total: list.length }
    }

    /** POST /api/albums  body: { title } */
    function createAlbum(ctx) {
        const title = ((ctx.body || {}).title || '').toString().trim()
        if (!title) throw new Error('专辑名称不能为空')
        const id = newId()
        const ts = nowMs()
        dbRun(
            `INSERT INTO albums (id,title,owner_id,owner_name,visibility,created_at,updated_at)
             VALUES (?,?,?,?,'private',?,?)`, id, title, ctx.user.id, ctx.user.username, ts, ts)
        return { id, title, visibility: 'private', entryCount: 0, visibleCount: 0, invisibleCount: 0 }
    }

    /** PUT /api/albums/:id  body: { title } 仅改名 */
    function renameAlbum(ctx) {
        const row = getAlbumOrThrow(ctx.params.id)
        if (!canMutateAlbum(ctx.user, row)) throw new Error('无权修改该专辑')
        const title = ((ctx.body || {}).title || '').toString().trim()
        if (!title) throw new Error('专辑名称不能为空')
        dbRun(`UPDATE albums SET title=?, updated_at=? WHERE id=?`, title, nowMs(), row.id)
        return { id: row.id, title }
    }

    /**
     * DELETE /api/albums/:id
     * 红线：本函数只清 albums 与 album_entries 两张表，绝不触碰 collections / items / 磁盘文件。
     * 专辑里的资源可能是用户自己的作品或他人的作品本体，删册子不等于烧书。
     */
    function deleteAlbum(ctx) {
        const row = getAlbumOrThrow(ctx.params.id)
        if (!canMutateAlbum(ctx.user, row)) throw new Error('无权删除该专辑')
        tx(() => {
            dbRun(`DELETE FROM album_entries WHERE album_id=?`, row.id)
            dbRun(`DELETE FROM albums WHERE id=?`, row.id)
        })
        return { deleted: row.id }
    }

    // ---------- 专辑内容 ----------

    /** GET /api/albums/:id/items?keyword=&page=&pageSize= 专辑内资源列表 */
    function listAlbumItems(ctx) {
        const user = ctx.user
        const album = getAlbumOrThrow(ctx.params.id)
        if (!canMutateAlbum(user, album)) throw new Error('无权查看该专辑')
        const q = ctx.query || {}
        const page = Math.max(parseInt(q.page, 10) || 1, 1)
        const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 24, 1), 200)
        const keyword = (q.keyword || '').toString().trim().toLowerCase()

        const all = albumCollections(album.id)
        const readable = visibleFor(user, all)
        let rows = readable
        if (keyword) {
            rows = rows.filter(r =>
                (r.title || '').toLowerCase().includes(keyword) ||
                (r.category || '').toLowerCase().includes(keyword))
        }
        const total = rows.length
        const pageRows = rows.slice((page - 1) * pageSize, page * pageSize)

        return {
            album: { id: album.id, title: album.title, visibility: album.visibility },
            list: pageRows.map(r => mapCollectionCard(r, user.id)),
            total, page, pageSize,
            entryCount: all.length,
            // 卡片少于条目数的原因在此暴露，避免用户以为专辑丢了东西
            invisibleCount: all.length - readable.length,
        }
    }

    /**
     * POST /api/albums/:id/items  body: { collectionIds: [...] }
     * 逐项执行不中断：added 实际新增、skipped 已在该专辑、failed 不存在或不可读。
     * 只允许加入当前可读的资源——否则用户可以拿他人私有资源的 id 塞进专辑，
     * 再借封面/条目数变化探测那个资源是否存在。
     */
    function addAlbumItems(ctx) {
        const user = ctx.user
        const album = getAlbumOrThrow(ctx.params.id)
        if (!canMutateAlbum(user, album)) throw new Error('无权修改该专辑')
        const ids = normalizeIds((ctx.body || {}).collectionIds)
        if (!ids.length) throw new Error('请至少选择一个资源')
        const ts = nowMs()
        const skipped = [], failed = []
        let added = 0
        for (const id of ids) {
            const row = dbGet(`SELECT * FROM collections WHERE id=?`, id)
            if (!row) { failed.push({ id, reason: '资源不存在' }); continue }
            if (!canRead(user, row)) { failed.push({ id, title: row.title, reason: '无权访问该资源' }); continue }
            const hit = dbGet(
                `SELECT 1 AS x FROM album_entries WHERE album_id=? AND collection_id=?`, album.id, id)
            if (hit) { skipped.push(id); continue }
            dbRun(
                `INSERT INTO album_entries (id,album_id,collection_id,added_at,added_by,added_by_name)
                 VALUES (?,?,?,?,?,?)`, newId(), album.id, id, ts, user.id, user.username)
            added++
        }
        if (added) dbRun(`UPDATE albums SET updated_at=? WHERE id=?`, nowMs(), album.id)
        return { albumId: album.id, added, skipped, failed }
    }

    /** DELETE /api/albums/:id/items  body: { collectionIds: [...] }（也兼容 ?collectionIds=a,b）：仅解除引用 */
    function removeAlbumItems(ctx) {
        const user = ctx.user
        const album = getAlbumOrThrow(ctx.params.id)
        if (!canMutateAlbum(user, album)) throw new Error('无权修改该专辑')
        const body = ctx.body || {}
        const raw = body.collectionIds !== undefined ? body.collectionIds : (ctx.query || {}).collectionIds
        const ids = typeof raw === 'string'
            ? raw.split(',').map(s => s.trim()).filter(Boolean)
            : normalizeIds(raw)
        if (!ids.length) throw new Error('请选择要移出的资源')
        let removed = 0
        for (const id of ids) {
            removed += dbRun(
                `DELETE FROM album_entries WHERE album_id=? AND collection_id=?`, album.id, id).changes
        }
        dbRun(`UPDATE albums SET updated_at=? WHERE id=?`, nowMs(), album.id)
        return { albumId: album.id, removed }
    }

    /**
     * POST /api/albums/by-collections  body: { collectionIds: [...] }
     * 返回 { [collectionId]: [{ albumId, title }] }：
     * “加入专辑”弹层用它回显勾选，“删除资源”用它提示会连带移出哪几个专辑。
     * 只返回当前用户自己的专辑，别人的专辑构成隐私泄露。
     */
    function albumsOfCollections(ctx) {
        const user = ctx.user
        const ids = normalizeIds((ctx.body || {}).collectionIds)
        const map = {}
        for (const id of ids) map[id] = []
        if (!ids.length) return map
        const marks = ids.map(() => '?').join(',')
        const rows = dbAll(
            `SELECT e.collection_id, a.id AS album_id, a.title
             FROM album_entries e JOIN albums a ON a.id = e.album_id
             WHERE e.collection_id IN (${marks}) AND a.owner_id=?
             ORDER BY a.created_at DESC`, ...ids, user.id)
        for (const r of rows) (map[r.collection_id] ||= []).push({ albumId: r.album_id, title: r.title })
        return map
    }

    return {
        listAlbums, createAlbum, renameAlbum, deleteAlbum,
        listAlbumItems, addAlbumItems, removeAlbumItems, albumsOfCollections,
    }
}
