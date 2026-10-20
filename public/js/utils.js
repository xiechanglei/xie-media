// ================= 工具 =================
// DOM 查询、请求封装、提示条、格式化、媒体 URL 等全局基础件（叶子模块，仅依赖 icons）
import { icon } from './icons.js'

export const $ = (sel) => document.querySelector(sel)
export const $$ = (sel) => Array.from(document.querySelectorAll(sel))

export async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: 'same-origin', ...opts })
    let j = null
    try { j = await r.json() } catch { /* 可能被守卫重定向 */ }
    if (!r.ok || (j && j.success === false)) throw new Error((j && j.message) || ('HTTP ' + r.status))
    return j || { data: null }
}
export function toast(msg, ms, type) {
    // 未显式指定类型时按文案推断：失败/错误→error，已…/完成/成功→success，其余 info
    if (!type) type = /失败|错误|不可恢复/.test(msg) ? 'error' : (/^(已|完成)|成功/.test(msg) ? 'success' : 'info')
    const icName = { success: 'checkCircle', error: 'alert', info: 'info' }[type] || 'info'
    const el = $('#toast')
    el.querySelector('.toast-ic').innerHTML = icon(icName, 16)
    el.querySelector('.toast-msg').textContent = msg
    el.classList.remove('success', 'error', 'info')
    el.classList.add('show', type)
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms || 2200)
}
export const fmtTime = (ts) => { try { return new Date(ts).toLocaleString() } catch { return '' } }
export const fmtDate = (ts) => { try { return new Date(ts).toLocaleDateString() } catch { return '' } }
// 日期精确到分钟：YYYY-MM-DD HH:mm
export const fmtDateTime = (ts) => {
    const d = new Date(ts); if (isNaN(d)) return ''
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export function fmtSize(bytes) {
    if (!bytes) return ''
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = bytes
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i]
}
export const fmtSpeed = (bps) => bps > 0 ? `${fmtSize(bps)}/s` : ''
/** 上传测速器：由 xhr.upload.onprogress 逐次喂 loaded 字节数，返回平滑后的速度（字节/秒）；每个请求新建一个；
 *  至少 300ms 才刷新一次读数，避免高频抖动；EMA 平滑让瞬时忽高忽低不至于满屏乱跳 */
export function createSpeedMeter() {
    let lastT = 0, lastL = 0, ema = 0
    return {
        speed(loaded) {
            const t = performance.now()
            if (!lastT) { lastT = t; lastL = loaded; return ema }
            if (t - lastT < 300) return ema
            const dl = loaded - lastL, dt = (t - lastT) / 1000
            lastT = t; lastL = loaded
            if (dl <= 0 || dt <= 0) return ema
            const inst = dl / dt
            ema = ema ? ema * 0.7 + inst * 0.3 : inst
            return ema
        },
    }
}
export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
/** 文件 → base64：分块 String.fromCharCode 避免大种子文件爆栈 */
export async function fileToBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    const CH = 0x8000
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
    return btoa(bin)
}

// 媒体 URL：视频剪切原地替换文件后置时间戳，拼参数强制绕开浏览器缓存
let mediaStamp = 0
export const markMediaStale = () => { mediaStamp = Date.now() }
export const itemUrl = (id) => `/media/items/${id}${mediaStamp ? `?t=${mediaStamp}` : ''}`
export const itemThumbUrl = (id) => `/media/thumbnails/items/${id}${mediaStamp ? `?t=${mediaStamp}` : ''}`
export const coverUrl = (colId) => `/media/thumbnails/collections/${colId}${mediaStamp ? `?t=${mediaStamp}` : ''}`

// ---- 元数据展示小工具 ----
export function fmtDur(sec) {
    if (!sec && sec !== 0) return ''
    sec = Math.round(sec)
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
    const p = (n) => String(n).padStart(2, '0')
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}
export function resLabel(m) {
    if (!m || !m.height) return ''
    const h = m.height
    if (h >= 2160) return '4K'
    if (h >= 1440) return '2K'
    if (h >= 1080) return '1080p'
    if (h >= 720) return '720p'
    if (h >= 480) return '480p'
    return `${h}p`
}
// 从 items 聚合出 { durationSec, width, height, codecs:[] }
export function aggOfItems(items) {
    const metas = (items || []).map(it => it.meta).filter(Boolean)
    if (!metas.length) return null
    const dur = metas.reduce((s, m) => s + (m.durationSec || 0), 0)
    const maxH = Math.max(0, ...metas.map(m => m.height || 0))
    const maxW = Math.max(0, ...metas.map(m => m.width || 0))
    const codecs = [...new Set(metas.map(m => m.videoCodec).filter(Boolean))]
    return { durationSec: Math.round(dur), width: maxW || null, height: maxH || null, codecs }
}
