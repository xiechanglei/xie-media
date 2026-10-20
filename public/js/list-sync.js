// ================= 跨标签页 / 视图间列表同步 =================
// 详情在新标签页操作后，通过 BroadcastChannel 把变更实时应用到列表标签页；
// 不支持 BC 的老内核降级为 localStorage + storage 事件（同样不回流发送页）
import { state } from './state.js'
import { $ } from './utils.js'
import { icon } from './icons.js'
import { reset, removeItemFromList } from './list.js'

const listBC = 'BroadcastChannel' in window ? new BroadcastChannel('xm-list-sync') : null

export function notifyList(msg) {
    if (listBC) { listBC.postMessage(msg); return }
    try { localStorage.setItem('xm-list-sync', JSON.stringify(Object.assign({ _t: Date.now() }, msg))) } catch { }
}
/** 详情页操作后标记列表脏（同页路由返回时重拉），并通知其它列表标签页；
 *  仅“难以局部模拟”的变更用（元信息/文件增删）；收藏/可见性/删除走就地修补，不经过这里 */
export function markListDirty() { state.listDirty = true; notifyList({ type: 'dirty' }) }

/** 就地修补列表卡片：收藏心形 / 可见性徽章（数据 + DOM 同步） */
function syncCardFav(id, fv) {
    const it = state.list.find(x => String(x.id) === String(id)); if (it) it.favorited = fv
    const f = $(`#grid .card[data-id="${id}"] .fav-ic`)
    if (f) { f.classList.toggle('on', !!fv); f.innerHTML = icon('heart', 13, fv) }
}
function syncCardVis(id, vis) {
    const it = state.list.find(x => String(x.id) === String(id)); if (it) it.visibility = vis
    const b = $(`#grid .card[data-id="${id}"] .badge`)
    if (b) { b.className = 'badge ' + vis; b.textContent = vis === 'public' ? '公开' : '私有' }
}
/** 收藏变更在当前列表范围内的完整语义：收藏页取消收藏→卡片退出列表 */
export function applyFavChange(id, fv) {
    if (state.scope === 'favorites' && !fv) removeItemFromList(id)
    else syncCardFav(id, fv)
}
/** 可见性变更：广场只显示公开项，转私有即退出广场列表 */
export function applyVisChange(id, vis) {
    if (state.scope === 'plaza' && vis !== 'public') removeItemFromList(id)
    else syncCardVis(id, vis)
}

let pendingDirty = false // 列表页隐藏时收到“结构变更”，推迟到切回前台再重拉
export function initListSync() {
    const apply = msg => {
        if (!msg) return
        if (msg.type === 'del') return removeItemFromList(msg.id)
        if (msg.type === 'fav') return applyFavChange(msg.id, msg.favorited)
        if (msg.type === 'vis') return applyVisChange(msg.id, msg.visibility)
        if (msg.type === 'dirty') {
            if (state.view !== 'list') return
            if (document.hidden) { pendingDirty = true; return }
            reset()
        }
    }
    if (listBC) listBC.addEventListener('message', e => apply(e.data))
    else window.addEventListener('storage', e => {
        if (e.key === 'xm-list-sync' && e.newValue) { try { apply(JSON.parse(e.newValue)) } catch { } }
    })
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && pendingDirty) { pendingDirty = false; reset() }
    })
}
