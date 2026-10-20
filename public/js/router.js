// ================= 路由 =================
// hash 路由：#/list/<scope> 列表；#/list/album/<id> 专辑内页；#/c/<id> 详情；#/offline 离线下载
import { state } from './state.js'
import { $, $$ } from './utils.js'
import { clearStashedPlayer } from './player.js'
import { exitSelectMode, syncSelectUI } from './selection.js'
import { reset, renderAlbumHead } from './list.js'
import { loadDetail } from './detail.js'
import { syncSidebarActive, syncUploadBtnVisible, hideTopbarListOnly, showTopbarListOnly } from './chrome.js'
import { startOfflinePolling, stopOfflinePolling } from './offline.js'

export function parseHash() {
    const h = (location.hash || '').replace(/^#/, '')
    if (!h || h === '/') return { view: 'list', scope: 'mine' }
    if (h === '/offline') return { view: 'offline' }
    let m = h.match(/^\/c\/([0-9a-fA-F-]+)$/)
    if (m) return { view: 'detail', id: m[1] }
    // 专辑内页必须先试：后面的 (mine|plaza|favorites|albums)? 对 "album/<id>" 会匹配空串，误当成无 scope
    m = h.match(/^\/list\/album\/([0-9a-fA-F-]+)/)
    if (m) return { view: 'list', scope: 'album', albumId: m[1] }
    m = h.match(/^\/list\/(mine|plaza|favorites|albums)?/)
    if (m) return { view: 'list', scope: m[1] || state.scope || 'mine' }
    return { view: 'list', scope: state.scope }
}
export function buildListHash(scope, albumId) {
    if (scope === 'album') return `#/list/album/${albumId || state.albumId}`
    return `#/list/${scope || state.scope}`
}
/** 离开详情页时销毁播放区：仅 hidden 不会暂停 video，移动端会在后台继续出声 */
function stopDetailPlayback() {
    $$('#detailBody video').forEach(v => { try { v.pause(); v.removeAttribute('src'); v.load() } catch { } })
    $('#detailBody').innerHTML = ''
    clearStashedPlayer() // 暂存的播放器随页面销毁一起丢弃
}
export function applyRoute(route) {
    if (route.view === 'detail') {
        if (state.selectMode) exitSelectMode(false) // 进详情前先退出多选态
        state.view = 'detail'
        document.body.classList.add('detail-mode') // 详情为沉浸模式：隐藏侧栏与汉堡，顶栏亮出用户胶囊
        if (!$('#detailView').classList.contains('hidden')) stopDetailPlayback() // 详情 A → 详情 B 也先销毁旧播放器
        $('#listView').classList.add('hidden')
        $('#offlineView').classList.add('hidden'); stopOfflinePolling()
        $('#detailView').classList.remove('hidden')
        hideTopbarListOnly()
        syncSelectUI() // 详情页需隐藏“选择”按钮（state.view 已置为 detail）
        loadDetail(route.id)
    } else if (route.view === 'offline') {
        if (state.selectMode) exitSelectMode(false)
        if (state.view === 'detail') stopDetailPlayback()
        state.view = 'offline'
        document.body.classList.remove('detail-mode')
        $('#listView').classList.add('hidden')
        $('#detailView').classList.add('hidden')
        $('#offlineView').classList.remove('hidden')
        hideTopbarListOnly()
        syncSidebarActive()
        syncSelectUI()
        startOfflinePolling()
    } else {
        // 专辑 A → 专辑 B 是同一 scope 换 albumId，所以两者都要纳入变更判定
        const scopeChanged = (route.scope && route.scope !== state.scope) ||
            (route.albumId !== undefined && route.albumId !== state.albumId)
        if (state.view === 'detail') stopDetailPlayback() // 详情 A → 详情 B 也先销毁旧播放器
        state.view = 'list'
        document.body.classList.remove('detail-mode')
        state.scope = route.scope || state.scope
        state.albumId = state.scope === 'album' ? (route.albumId || state.albumId) : null
        if (state.scope !== 'album') state.albumHead = null
        if (scopeChanged && state.selectMode) exitSelectMode(false) // 切范围时清理选择态
        $('#detailView').classList.add('hidden')
        $('#offlineView').classList.add('hidden'); stopOfflinePolling()
        $('#listView').classList.remove('hidden')
        showTopbarListOnly()
        syncSidebarActive()
        syncUploadBtnVisible()
        syncSelectUI()
        if (scopeChanged || state.listDirty || state.list.length === 0) { state.listDirty = false; reset() }
        else renderAlbumHead() // 同专辑返回：不重拉，但横幅要随 scope 切换回到正确显示状态
    }
}
export function gotoList(scope, albumId) {
    const target = buildListHash(scope || state.scope, albumId)
    if (location.hash === target) applyRoute(parseHash()); else location.hash = target
}
/** 详情打开方式：桌面端新标签页（列表标签页的数据与滚动位置原封不动保留），
 *  移动端沿用页内 hash 路由（手机上新标签体验差，列表变更由就地修补兑底） */
export function gotoDetail(id) {
    const hash = '#/c/' + id
    if (window.matchMedia('(max-width: 768px)').matches) { location.hash = hash; return }
    window.open(location.pathname + location.search + hash, '_blank')
}
