// 离线下载业务逻辑（aria2 路线）：
// - 任务模型：download_tasks 表为账本，aria2 为执行器；gid 是运行时句柄，info_hash 是跨重启对账锚点
// - 文件选择（aria2 1.37.0 实测钉死）：select-file 只能在 add 时传（1-based 索引逗号分隔，支持 2-5 范围）；
//   对已存在任务改选择必 400（changeOption 不接受 select-file，changeFileProgression 方法不存在）
// - 种子：服务端本地 bdecode 解析文件清单预览（不经 aria2、不建临时任务），确认后 addTorrent 带 select-file 一步建任务
// - 磁力：元数据只能来自网络（pause=true 下不解析，实测），用 pause-metadata 建"临时任务"预览；
//   选定后删临时任务 → 带 select-file 重加为官任务
// - 种子原文备份在 <任务目录>/.source.torrent（walkFiles 跳过点文件，不入任何清单），供"重新选择"与重启重放；
//   会话恢复不保留 select-file/pause（实测），对账靠删了重加
// - 入库时序（写死不可调换）：forceRemove 摘除 aria2 任务 → 选中文件算 md5 移入 store →
//   建 collections(owner=当前用户)+items → 整目录删除任务残存文件 → 删任务行
// - download/ 独立于 scan/，不被自动扫描器触碰；每任务一个子目录，删任务=删目录零误伤
import * as fs from 'node:fs'
import * as path from 'node:path'
import crypto from 'node:crypto'
import { all as dbAll, get as dbGet, run as dbRun, tx } from './db.js'
import { classifyFile, guessMime, shardOf } from './media.js'
import { probeVideoMeta } from './ffmpeg.js'
import { fileMd5Streaming, moveFile, walkFiles } from './files.js'

const nowMs = () => Date.now()
const newId = () => crypto.randomUUID()

// aria2 任务状态 → 本表状态（removed 视为 error，进度字段保留最后快照）
function mapAria2Status(s) {
    if (s === 'complete' || s === 'active' || s === 'waiting' || s === 'paused' || s === 'error') return s
    return 'error'
}

/**
 * bdecode 解码（仅用于服务端本地解析种子文件清单，真种子实测与 aria2 tellStatus.files 顺序/名称完全一致）。
 * 返回 [值, 新位置]；字典键按 binary 字符串存放。
 */
function bdecode(buf, pos = 0) {
    const c = buf[pos]
    if (c === 0x64) { // 'd'
        const dict = {}
        pos++
        while (buf[pos] !== 0x65) { // 'e'
            const [k, p1] = bdecode(buf, pos)
            const [v, p2] = bdecode(buf, p1)
            dict[k.toString('binary')] = v
            pos = p2
        }
        return [dict, pos + 1]
    }
    if (c === 0x6c) { // 'l'
        const arr = []
        pos++
        while (buf[pos] !== 0x65) {
            const [v, p] = bdecode(buf, pos)
            arr.push(v)
            pos = p
        }
        return [arr, pos + 1]
    }
    if (c === 0x69) { // 'i'
        const end = buf.indexOf(0x65, pos)
        return [parseInt(buf.slice(pos + 1, end).toString(), 10), end + 1]
    }
    const colon = buf.indexOf(0x3a, pos)
    if (colon < 0) throw new Error('bad bencode: 缺少长度分隔符')
    const len = parseInt(buf.slice(pos, colon).toString(), 10)
    return [buf.slice(colon + 1, colon + 1 + len), colon + 1 + len]
}

/** 解析种子字节 → { displayName, files:[{index(1-based), name, length}] }；非法输入返回 null */
function parseTorrent(buf) {
    try {
        const [meta] = bdecode(buf, 0)
        const info = meta && meta.info
        if (!info || !Buffer.isBuffer(info.pieces)) return null
        const name = info.name ? info.name.toString('utf8') : null
        if (!name) return null
        const list = Array.isArray(info.files)
            ? info.files.map(f => ({
                name: (f.path || []).map(p => Buffer.isBuffer(p) ? p.toString('utf8') : String(p)).join('/'),
                length: Number(f.length) || 0,
            }))
            : [{ name, length: Number(info.length) || 0 }] // 单文件种子
        return { displayName: name, files: list.map((f, i) => ({ index: i + 1, name: f.name, length: f.length })) }
    } catch { return null }
}

/**
 * 生成 aria2 select-file 值（1.37.0 实测格式）：1-based 索引去重升序后逗号分隔，如 '1,3,5'。
 * 全选或空选择返回 null（不加限制）；越界索引就地过滤。
 */
function selectSpecFor(total, selected) {
    const set = [...new Set((selected || []).map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= total)
    if (!set.length || set.length >= total) return null
    return set.sort((a, b) => a - b).join(',')
}

/** aria2 元数据未解析时，files 仅含一项且 path 是裸 info hash（40hex/32hex 文件名） */
function metadataReady(st) {
    const files = st.files || []
    if (files.length > 1) return true
    if (files.length === 0) return false
    const base = path.basename(files[0].path || '')
    return !/^[0-9a-f]{40}$/i.test(base) && !/^[0-9a-f]{32}$/i.test(base)
}

/**
 * 创建离线下载业务处理器。
 * @param {{ aria2: import('./aria2.js').createAria2 extends () => infer A ? A : any, downloadDir: string, storeDir: string }} cfg
 */
export function createOfflineHandlers({ aria2, downloadDir, storeDir }) {

    const taskDirOf = (id) => path.join(downloadDir, id)
    /** store 路径与 media.js/scanner.js 同一口径：store/<md5前2位>/<md5> */
    const md5ToPath = (md5) => path.join(storeDir, shardOf(md5), md5)

    function getTaskOrThrow(id, user) {
        const row = dbGet(`SELECT * FROM download_tasks WHERE id=?`, id)
        if (!row) throw new Error('下载任务不存在')
        if (user.role !== 'admin' && row.owner_id !== user.id) throw new Error('无权操作该任务')
        return row
    }

    /** DB 行 → 对外 JSON；st 为可选的 aria2 实时状态（有则以实时进度为准） */
    function toView(r, st) {
        const total = st ? Number(st.totalLength) || 0 : r.total_length || 0
        const done = st ? Number(st.completedLength) || 0 : r.completed_length || 0
        let error = r.error_message || null
        let status = r.status
        if (st) {
            status = mapAria2Status(st.status)
            if (st.errorMessage) error = `${st.errorMessage}（code ${st.errorCode}）`
            else if (status !== 'error') error = null
        }
        return {
            id: r.id,
            displayName: r.display_name,
            type: r.type,
            status,
            // 待选临时任务（磁力 pause-metadata 挂起中等选择）：'' 哨兵只在选前存在，选后落索引串或 'all'
            awaitingSelect: r.progression_mask === '',
            totalLength: total,
            completedLength: done,
            speed: st && st.status === 'active' ? Number(st.downloadSpeed) || 0 : 0,
            canIngest: status === 'complete',
            error,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }
    }

    /** 拉一次 aria2 状态并回写 DB 快照；gid 失效（重启换号/任务被清）时静默保留快照 */
    async function refreshRow(r) {
        if (!aria2.isRunning() || !r.gid || r.status === 'complete') return null
        try {
            const st = await aria2.tellStatus(r.gid)
            dbRun(
                `UPDATE download_tasks SET gid=?, status=?, total_length=?, completed_length=?, error_message=?,
                 info_hash=COALESCE(?, info_hash), updated_at=? WHERE id=?`,
                r.gid, mapAria2Status(st.status),
                Number(st.totalLength) || 0, Number(st.completedLength) || 0,
                st.errorMessage ? `${st.errorMessage}（code ${st.errorCode}）` : null,
                st.infoHash || null, nowMs(), r.id)
            r.status = mapAria2Status(st.status)
            return st
        } catch {
            return null
        }
    }

    // ===================== 功能开关 =====================

    function status(ctx) {
        return { enabled: aria2.isRunning() }
    }

    // ===================== 建任务 =====================

    /**
     * 创建真实下载任务（select-file 只能在此刻带上，之后不可变）。
     * 请求体：
     * { type: 'torrent', torrentBase64, fileName?, selectedIndexes? }  // 1-based 索引；空/全选=不限；默认建完即开下
     * { type: 'magnet',  magnet }  // pause-metadata 临时任务：只取元数据不盲下内容，交给 /select 删后重加为官任务
     * deferStart=true（仅种子兼容路径）：保持挂起不下载，等前端选完再走 /select 重加放行
     */
    async function addTask(ctx) {
        if (!aria2.isRunning()) throw new Error('离线下载服务不可用（aria2 未运行）')
        const body = ctx.body || {}
        const type = body.type
        if (type !== 'torrent' && type !== 'magnet') throw new Error('type 必须为 torrent|magnet')

        const id = newId()
        const dir = taskDirOf(id)
        fs.mkdirSync(dir, { recursive: true })

        let gid, infoHash = null, displayName = null, spec = null
        const deferStart = body.deferStart === true || body.deferStart === 'true'
        const sel = Array.isArray(body.selectedIndexes)
            ? [...new Set(body.selectedIndexes.map(Number).filter(n => Number.isInteger(n) && n >= 1))]
            : []
        try {
            if (type === 'torrent') {
                const b64 = String(body.torrentBase64 || '')
                if (!b64) throw new Error('未收到种子文件内容')
                const buf = Buffer.from(b64, 'base64')
                const parsed = parseTorrent(buf)
                if (!parsed) throw new Error('种子文件解析失败（可能损坏或不是 .torrent）')
                displayName = parsed.displayName
                spec = selectSpecFor(parsed.files.length, sel)
                // 备份原始种子（隐藏文件，任何清单/入库都不会收录）：供"重新选择"与重启重放时重新 addTorrent
                fs.writeFileSync(path.join(dir, '.source.torrent'), buf)
                const options = { dir, pause: 'true' }
                if (spec) options['select-file'] = spec
                gid = await aria2.rpcCall('aria2.addTorrent', [b64, [], options])
                if (!deferStart) await aria2.rpcCall('aria2.unpause', [gid])
                if (!displayName) {
                    const files = (await aria2.tellStatus(gid, ['files']).catch(() => null))?.files || []
                    if (files.length) displayName = path.relative(dir, files[0].path).split(path.sep)[0]
                }
            } else {
                const magnet = String(body.magnet || '').trim()
                if (!/^magnet:\?/i.test(magnet) || !/[?&]xt=urn:btih:/i.test(magnet)) {
                    throw new Error('请粘贴完整的磁力链接（magnet:?xt=urn:btih:... 开头）')
                }
                // 实测：pause=true 的磁力不会解析元数据（清单永远只有一项），必须 pause-metadata：
                // 允许网络交换元数据，拿到后自动暂停在内容下载之前
                gid = await aria2.rpcCall('aria2.addUri', [[magnet], { dir, 'pause-metadata': 'true' }])
                const dn = magnet.match(/[?&]dn=([^&]+)/)
                if (dn) { try { displayName = decodeURIComponent(dn[1].replace(/\+/g, ' ')) } catch { /* ignore */ } }
            }

            const st = await aria2.tellStatus(gid, ['status', 'infoHash'])
            infoHash = (st.infoHash || null)
        } catch (e) {
            // 注册失败不留孤儿目录
            try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
            throw e
        }

        const ts = nowMs()
        dbRun(
            `INSERT INTO download_tasks
             (id,owner_id,owner_name,gid,info_hash,type,source,display_name,dir,status,progression_mask,total_length,completed_length,error_message,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, ctx.user.id, ctx.user.username || null, gid, infoHash, type,
            type === 'torrent' ? String(body.fileName || 'manual.torrent') : String(body.magnet || ''),
            displayName, dir,
            (type === 'magnet' || deferStart) ? 'paused' : 'waiting',
            // 空串=等待用户选文件哨兵（重启落在这一阶段时 aria2 状态会漂移到 active，靠它才能认出）；已定选择则存索引串或 'all'
            (type === 'magnet' || deferStart) ? '' : spec, 0, 0, null, ts, ts)

        const row = dbGet(`SELECT * FROM download_tasks WHERE id=?`, id)
        return toView(row, await refreshRow(row))
    }

    // ===================== 列表（含进度）=====================

    async function listTasks(ctx) {
        const rows = ctx.user.role === 'admin'
            ? dbAll(`SELECT * FROM download_tasks ORDER BY created_at DESC`)
            : dbAll(`SELECT * FROM download_tasks WHERE owner_id=? ORDER BY created_at DESC`, ctx.user.id)
        const list = []
        for (const r of rows) list.push(toView(r, await refreshRow(r)))
        return { list, enabled: aria2.isRunning() }
    }

    // ===================== 创建时的文件清单预览 / 选文件 =====================

    /**
     * 种子文件清单预览（不建任何 aria2 任务）：服务端本地 bdecode 解析，实测与 aria2 视角的文件顺序/名称一致。
     * 请求体：{ torrentBase64 }
     */
    function previewTorrent(ctx) {
        const b64 = String((ctx.body && ctx.body.torrentBase64) || '')
        if (!b64) throw new Error('未收到种子文件内容')
        const parsed = parseTorrent(Buffer.from(b64, 'base64'))
        if (!parsed || !parsed.files.length) throw new Error('种子文件解析失败（可能损坏或不是 .torrent）')
        return {
            displayName: parsed.displayName,
            files: parsed.files.map(f => ({ ...f, selected: true, downloadable: mediaKind(f.name) !== null })),
        }
    }

    /** 预览 aria2 视角的文件列表（磁力临时任务轮询专用）；元数据未到时 needMetadata=true */
    async function previewFiles(ctx) {
        const r = getTaskOrThrow(ctx.params.id, ctx.user)
        if (!aria2.isRunning()) throw new Error('离线下载服务不可用（aria2 未运行）')
        if (r.status === 'complete') {
            // 已完成任务可能不在 aria2 结果集中，直接以磁盘为准给出文件清单
            return { needMetadata: false, files: diskFilesToPreview(r) }
        }
        const st = await aria2.tellStatus(r.gid, ['status', 'files', 'infoHash']).catch(() => null)
        if (!st) throw new Error('无法读取任务文件列表（aria2 中已无此任务）')
        if (!metadataReady(st)) return { needMetadata: true, files: [] }
        const files = (st.files || []).map(f => ({
            index: Number(f.index),
            name: path.relative(r.dir, f.path),
            length: Number(f.length) || 0,
            selected: f.selected === 'true',
            downloadable: mediaKind(f.path) !== null,
        }))
        return { needMetadata: false, files }
    }

    /**
     * 以 add 时带 select-file 的方式重新加入任务（1.37.0 中应用选择的唯一合法时机）。
     * 种子从 <dir>/.source.torrent 重加；磁力用账本里的 source 重加。
     * @param {object} r 任务行；{ spec 索引串|null, paused 是否以挂起态加入 }
     */
    async function reAdd(r, { spec = null, paused = false } = {}) {
        const options = { dir: r.dir }
        if (paused) {
            if (r.type === 'magnet') options['pause-metadata'] = 'true' // 重加的磁力同样先停在元数据阶段
            else options['pause'] = 'true'
        }
        if (spec) options['select-file'] = spec
        if (r.type === 'torrent') {
            const f = path.join(r.dir, '.source.torrent')
            if (!fs.existsSync(f)) throw new Error('缺少原始种子备份（.source.torrent），无法重新创建任务')
            return await aria2.rpcCall('aria2.addTorrent', [fs.readFileSync(f).toString('base64'), [], options])
        }
        return await aria2.rpcCall('aria2.addUri', [[r.source], options])
    }

    /**
     * 确认文件选择并开下（磁力主流程；种子的"重新选择"也走这里）。
     * 已存在任务无法改选择（changeOption select-file 实测必 400），因此：
     * 删掉预览用的临时任务 → 带 select-file 重新 add 为官任务（先删后加，同 info_hash 共存会被 aria2 拒）。
     * 请求体：{ selectedIndexes: number[] }  // 1-based，空数组=全选
     */
    async function selectFiles(ctx) {
        const r = getTaskOrThrow(ctx.params.id, ctx.user)
        // 设计：选文件只属于建任务之前的临时态；已按选择创建的任务文件集固定，改选会删任务重建丢进度
        if (r.progression_mask !== '') throw new Error('该任务已按选定文件创建，不能重新选择')
        if (!aria2.isRunning()) throw new Error('离线下载服务不可用（aria2 未运行）')
        const st = await aria2.tellStatus(r.gid, ['status', 'files']).catch(() => null)
        if (!st) throw new Error('无法读取任务文件列表（aria2 中已无此任务）')
        if (!metadataReady(st)) throw new Error('元数据尚未解析完成，请稍后再选择')

        const total = (st.files || []).length
        const sel = Array.isArray(ctx.body.selectedIndexes)
            ? [...new Set(ctx.body.selectedIndexes.map(Number).filter(n => Number.isInteger(n) && n >= 1))]
            : []
        const spec = selectSpecFor(total, sel)
        await aria2.rpcCall('aria2.forceRemove', [r.gid]).catch(() => { /* 临时任务可能已消失 */ })
        let newGid
        try {
            newGid = await reAdd(r, { spec })
        } catch (e) {
            dbRun(`UPDATE download_tasks SET status='error', error_message=?, updated_at=? WHERE id=?`,
                `选择后重建任务失败：${e.message}`, nowMs(), r.id)
            throw new Error(`选择后重建任务失败：${e.message}`)
        }
        dbRun(`UPDATE download_tasks SET gid=?, progression_mask=?, status='waiting', error_message=NULL, updated_at=? WHERE id=?`,
            newGid, spec || 'all', nowMs(), r.id)
        const row = dbGet(`SELECT * FROM download_tasks WHERE id=?`, r.id)
        return toView(row, await refreshRow(row))
    }

    // ===================== 暂停 / 恢复 / 删除 =====================

    async function pauseTask(ctx) {
        const r = getTaskOrThrow(ctx.params.id, ctx.user)
        if (r.gid) await aria2.rpcCall('aria2.pause', [r.gid]).catch(e => {
            if (!/RESOURCE_NOT_FOUND|No such/i.test(e.message)) throw e
        })
        dbRun(`UPDATE download_tasks SET status='paused', updated_at=? WHERE id=?`, nowMs(), r.id)
        return { id: r.id, status: 'paused' }
    }

    async function resumeTask(ctx) {
        const r = getTaskOrThrow(ctx.params.id, ctx.user)
        if (!aria2.isRunning()) throw new Error('离线下载服务不可用（aria2 未运行）')
        await aria2.rpcCall('aria2.unpause', [r.gid])
        dbRun(`UPDATE download_tasks SET status='waiting', updated_at=? WHERE id=?`, nowMs(), r.id)
        const row = dbGet(`SELECT * FROM download_tasks WHERE id=?`, r.id)
        return toView(row, await refreshRow(row))
    }

    /** 废弃任务：摘除 aria2 → 删任务目录（残存文件一并清）→ 删账本行 */
    async function removeTask(ctx) {
        const r = getTaskOrThrow(ctx.params.id, ctx.user)
        if (r.gid && aria2.isRunning()) {
            await aria2.rpcCall('aria2.forceRemove', [r.gid]).catch(() => { /* 已完成/已不存在 */ })
        }
        try { fs.rmSync(r.dir, { recursive: true, force: true }) } catch { /* ignore */ }
        dbRun(`DELETE FROM download_tasks WHERE id=?`, r.id)
        return { deleted: r.id }
    }

    // ===================== 入库 =====================

    function mediaKind(p) {
        return classifyFile({ filename: path.basename(p) })
    }

    /** 磁盘文件清单 → 预览结构（供 complete 任务的 preview 兜底） */
    function diskFilesToPreview(r) {
        return walkFiles(r.dir)
            .map((f) => {
                const cls = mediaKind(f)
                let size = 0
                try { size = fs.statSync(f).size } catch { /* ignore */ }
                return {
                    index: null, name: path.relative(r.dir, f), length: size,
                    selected: true, downloadable: cls !== null,
                }
            })
            .sort((a, b) => a.name.localeCompare(b.name))
    }

    /** 入库选择用：任务目录里已落盘且属于媒体白名单的文件 */
    function downloadedFiles(ctx) {
        const r = getTaskOrThrow(ctx.params.id, ctx.user)
        const files = walkFiles(r.dir)
            .map((f) => {
                const cls = mediaKind(f)
                if (!cls) return null
                let size = 0
                try { size = fs.statSync(f).size } catch { /* ignore */ }
                return { relPath: path.relative(r.dir, f), name: path.basename(f), size, mediaType: cls.type }
            })
            .filter(Boolean)
            .sort((a, b) => a.relPath.localeCompare(b.relPath))
        return { files }
    }

    /**
     * 入库：把选中文件按 md5 移入 store 并建资源（owner=当前用户，private），
     * 完成后清理任务残存文件与账本行。请求体：{ title?, files: relPath[] }
     */
    async function ingestTask(ctx) {
        const r = getTaskOrThrow(ctx.params.id, ctx.user)
        const rels = Array.isArray(ctx.body.files) ? ctx.body.files.map(String) : []
        if (!rels.length) throw new Error('请至少选择一个文件')
        const title = String(ctx.body.title || '').trim() || r.display_name || '未命名下载'

        // ① 先从 aria2 摘除任务：防止文件被移走后做种/复核错乱（forceRemove 对已消失任务报错是正常路径）
        if (r.gid && aria2.isRunning()) {
            await aria2.rpcCall('aria2.forceRemove', [r.gid]).catch(() => { /* ignore */ })
        }

        // ② 逐个选中文件：越界防护 → 白名单 → md5 → 去重（重复不入库，留待④统一清理）
        const dirPrefix = path.resolve(r.dir) + path.sep
        const prepared = []
        let skippedDuplicates = 0
        for (const rel of rels) {
            const abs = path.resolve(r.dir, rel)
            if (!abs.startsWith(dirPrefix)) throw new Error(`非法文件路径: ${rel}`)
            if (!fs.existsSync(abs)) continue
            const cls = mediaKind(abs)
            if (!cls) continue
            const size = fs.statSync(abs).size
            const md5 = await fileMd5Streaming(abs)
            if (dbGet(`SELECT 1 AS x FROM items WHERE md5=?`, md5)) { skippedDuplicates++; continue }
            const target = md5ToPath(md5)
            moveFile(abs, target)
            const meta = cls.type === 'video' ? await probeVideoMeta(target) : null
            prepared.push({ md5, ext: cls.ext, originalName: path.basename(abs), size, type: cls.type, meta })
        }

        // ③ 建资源（全部重复时不建空集合，与扫描器同一哲学）
        let collectionId = null
        if (prepared.length) {
            collectionId = newId()
            const ts = nowMs()
            tx(() => {
                dbRun(
                    `INSERT INTO collections (id,title,category,owner_id,owner_name,visibility,created_at,updated_at)
                     VALUES (?,?,?,?,?, 'private', ?, ?)`,
                    collectionId, title, null, ctx.user.id, ctx.user.username || null, ts, ts)
                prepared.forEach((it, i) => {
                    dbRun(
                        `INSERT INTO items (id,collection_id,md5,ext,original_name,name,mime,size,media_type,sort_order,created_at,meta_json)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                        newId(), collectionId, it.md5, it.ext, it.originalName, null,
                        guessMime(it.ext), it.size, it.type, i, ts,
                        it.meta ? JSON.stringify(it.meta) : null)
                })
            })
        }

        // ④ 清理任务残存（未选中文件、.aria2 控制文件、目录结构）与 ⑤ 账本行
        try { fs.rmSync(r.dir, { recursive: true, force: true }) } catch (e) {
            console.error(`[offline] 清理任务目录失败 ${r.dir}: ${e.message}`)
        }
        dbRun(`DELETE FROM download_tasks WHERE id=?`, r.id)

        return {
            collectionId, title,
            ingested: prepared.length, skippedDuplicates,
            message: prepared.length
                ? `已入库 ${prepared.length} 个文件` + (skippedDuplicates ? `，${skippedDuplicates} 个重复被跳过` : '')
                : `${skippedDuplicates} 个文件内容均已存在，未新建资源，任务已清理`,
        }
    }

    // ===================== 重启对账（续传）=====================

    /**
     * aria2 daemon 启动后调用：会话恢复的任务 GID 全新，用 info_hash 认亲。
     * 实测：会话落盘不保留 select-file 与 pause（恢复后默认全选且直接开跑），
     * 因此带选择或等待选文件的任务一律"删了重加"重放（select-file 只能在 add 时传，别无他途）。
     */
    async function reconcile() {
        if (!aria2.isRunning()) return
        const rows = dbAll(`SELECT * FROM download_tasks WHERE status IN ('waiting','active','paused','error')`)
        if (!rows.length) return
        const fields = ['gid', 'status', 'infoHash', 'totalLength', 'completedLength']
        let ariaTasks
        try {
            const active = await aria2.rpcCall('aria2.tellActive', [fields])
            const waiting = await aria2.rpcCall('aria2.tellWaiting', [0, 1000, fields])
            const stopped = await aria2.rpcCall('aria2.tellStopped', [0, 1000, fields]).catch(() => [])
            ariaTasks = [...active, ...waiting, ...stopped]
        } catch (e) {
            console.warn(`[offline] 续传对账失败: ${e.message}`)
            return
        }
        const byHash = new Map()
        for (const t of ariaTasks) if (t.infoHash) byHash.set(String(t.infoHash).toLowerCase(), t)

        for (const r of rows) {
            const t = r.info_hash ? byHash.get(r.info_hash.toLowerCase()) : null
            if (!t) {
                if (r.status !== 'error') {
                    dbRun(`UPDATE download_tasks SET status='error', error_message='aria2 重启后未能恢复该任务（会话中已丢失）', updated_at=? WHERE id=?`,
                        nowMs(), r.id)
                }
                continue
            }
            // progression_mask 口径：''=等待选文件（重加为挂起临时任务）；'all' 或旧位掩码=无需重放；索引串=重放选择
            const awaiting = r.progression_mask === ''
            const spec = r.progression_mask && /^[\d,]+$/.test(r.progression_mask) ? r.progression_mask : null
            const needReplay = awaiting || r.status === 'paused' || !!spec
            let gid = t.gid, status = mapAria2Status(t.status)
            if (needReplay) {
                try {
                    await aria2.rpcCall('aria2.forceRemove', [t.gid]).catch(() => { /* 可能已不存在 */ })
                    gid = await reAdd(r, { spec, paused: awaiting || r.status === 'paused' })
                    if (awaiting) dbRun(`UPDATE download_tasks SET status='paused' WHERE id=?`, r.id) // 状态漂移修正
                    else status = r.status === 'paused' ? 'paused' : 'waiting'
                } catch (e) {
                    dbRun(`UPDATE download_tasks SET gid=?, status='error', error_message=?, updated_at=? WHERE id=?`,
                        t.gid, `重启重放选择失败：${e.message}`, nowMs(), r.id)
                    continue
                }
            }
            dbRun(`UPDATE download_tasks SET gid=?, status=?, total_length=?, completed_length=?, updated_at=? WHERE id=?`,
                gid, status, Number(t.totalLength) || 0, Number(t.completedLength) || 0, nowMs(), r.id)
            console.log(`[offline] 已恢复任务「${r.display_name || r.id}」(gid ${gid}${needReplay ? '，删后重加重放选择' : ''})`)
        }
    }

    return {
        status, addTask, listTasks,
        previewTorrent, previewFiles, selectFiles,
        pauseTask, resumeTask, removeTask,
        downloadedFiles, ingestTask,
        reconcile,
    }
}
