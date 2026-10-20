// ================= 多选批量（合并 / 公开 / 私有 / 送人 / 删除 / 收藏）=================
import { state } from './state.js'
import { $, $$, api, toast, escapeHtml } from './utils.js'
import { icon } from './icons.js'
import { openModal, closeModal } from './player.js'
import { reset, renderCard, syncEmptyState, fillViewport } from './list.js'
import { gotoList, gotoDetail } from './router.js'
import { notifyList } from './list-sync.js'
import { openAlbumModal, doAddToAlbum, removeSelectedFromAlbum, openAlbumForm, submitAlbumForm, confirmDeleteAlbum } from './albums.js'

/** 重绘整个当前列表网格（根据 selectMode 决定卡片行为）*/
function rerenderGrid() {
    const grid = $('#grid')
    grid.innerHTML = ''
    for (const it of state.list) grid.appendChild(renderCard(it))
}
/** 同步选择相关按钮/操作栏可见性 */
export function syncSelectUI() {
    const inList = state.view === 'list'
    // 专辑目录页卡片是“册子”而非资源，没有批量动作可用，隐藏选择入口
    $('#selectBtn').classList.toggle('hidden', state.selectMode || !inList || state.scope === 'albums')
    $('#selectBar').classList.toggle('hidden', !state.selectMode)
    document.body.classList.toggle('has-select-bar', state.selectMode)
    syncSelActions()
    updateSelectBar()
}
/** 底部栏动作按视图显隐：我的=合并/公开/私有/送人/删除，广场=收藏，收藏=取消收藏，专辑内=移出 */
function syncSelActions() {
    const mine = state.scope === 'mine'
    $('#selMerge').classList.toggle('hidden', !mine)
    $('#selPublic').classList.toggle('hidden', !mine)
    $('#selPrivate').classList.toggle('hidden', !mine)
    $('#selTransfer').classList.toggle('hidden', !mine)
    $('#selDelete').classList.toggle('hidden', !mine)
    $('#selFav').classList.toggle('hidden', state.scope !== 'plaza')
    $('#selUnfav').classList.toggle('hidden', state.scope !== 'favorites')
    // 加专辑：我的/广场/收藏都可加；专辑内页只留“移出”，一栏里不放两套归类语义
    $('#selAddAlbum').classList.toggle('hidden', !['mine', 'plaza', 'favorites'].includes(state.scope))
    $('#selRemoveAlbum').classList.toggle('hidden', state.scope !== 'album')
}
export function updateSelectBar() {
    const n = state.selected.size
    $('#selCount').textContent = `已选 ${n} 项`
    $('#selCountMini').textContent = `${n}`
    $('#selMerge').disabled = n < 2
    for (const sel of ['#selPublic', '#selPrivate', '#selTransfer', '#selDelete', '#selFav', '#selUnfav', '#selAddAlbum', '#selRemoveAlbum']) {
        const b = $(sel); if (b) b.disabled = n === 0
    }
    const allSel = state.list.length > 0 && state.list.every(x => state.selected.has(String(x.id)))
    $('#selSelectAll').textContent = allSel ? '清空' : '全选'
}
function enterSelectMode() {
    state.selectMode = true
    state.selected.clear()
    rerenderGrid()
    syncSelectUI()
}
/** 退出选择模式；rerender=false 时不重绘网格（留给 reset() 接手）*/
export function exitSelectMode(rerender = true) {
    state.selectMode = false
    state.selected.clear()
    if (rerender) rerenderGrid()
    syncSelectUI()
}
/**
 * 清掉卡片上的选中遗留：高亮描边 + 左上角对钩。
 * exitSelectMode(false) 只清内存不碰 DOM，凡是不重建网格的退路
 *（批量操作、加入专辑）都必须自己调一次，否则高亮会留在列表上。
 */
export function clearSelectionMarks() {
    $$('#grid .card').forEach(c => {
        c.classList.remove('selected')
        const chk = c.querySelector('.select-check'); if (chk) chk.remove()
    })
}
function toggleSelect(id) {
    const key = String(id)
    const card = $(`#grid .card[data-id="${id}"]`)
    if (state.selected.has(key)) {
        state.selected.delete(key)
        if (card) { card.classList.remove('selected'); const c = card.querySelector('.select-check'); if (c) c.remove() }
    } else {
        state.selected.add(key)
        if (card) {
            card.classList.add('selected')
            if (!card.querySelector('.select-check')) {
                const chk = document.createElement('span'); chk.className = 'select-check'
                card.appendChild(chk)
            }
        }
    }
    updateSelectBar()
}
function toggleSelectAll() {
    const allSel = state.list.length > 0 && state.list.every(x => state.selected.has(String(x.id)))
    state.selected.clear()
    if (!allSel) for (const it of state.list) state.selected.add(String(it.id))
    rerenderGrid()
    updateSelectBar()
}
/** 按列表展示顺序取选中的 id（非选择点击顺序，保证可预测的归并顺序）*/
export function selectedIdsInOrder() {
    return state.list.filter(x => state.selected.has(String(x.id))).map(x => x.id)
}
function openMergeModal() {
    const ids = selectedIdsInOrder()
    if (ids.length < 2) return toast('请至少选择 2 个资源')
    const picked = state.list.filter(x => ids.includes(x.id))
    $('#mergeSummary').innerHTML = `将合并以下 <b>${ids.length}</b> 个资源：<ul>` +
        picked.map(x => `<li>${escapeHtml(x.title || '')} · ${(x.itemCount || 0)} 项</li>`).join('') + `</ul>`
    $('#mergeTitle').value = ''
    $('#mergeCategory').value = ''
    openModal('mergeModal')
}
async function doMerge() {
    const ids = selectedIdsInOrder()
    if (ids.length < 2) return toast('请至少选择 2 个资源')
    const btn = $('#mergeSubmit'); btn.disabled = true
    try {
        await api('/api/collections/merge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, title: $('#mergeTitle').value, category: $('#mergeCategory').value }),
        })
        closeModal('mergeModal')
        exitSelectMode(false)
        toast(`已合并 ${ids.length} 个资源`)
        notifyList({ type: 'dirty' }) // 其它列表标签页同步刷新
        gotoList('mine'); reset()
    } catch (e) {
        toast('合并失败：' + e.message)
    } finally { btn.disabled = false }
}
export function initSelection() {
    // 网格事件委托：卡片点击按当前模式路由详情/切换选中
    $('#grid').addEventListener('click', e => {
        const card = e.target.closest('.card')
        if (!card || card.classList.contains('skeleton')) return
        if (state.selectMode) toggleSelect(card.dataset.id)
        else if (state.scope === 'albums') gotoList('album', card.dataset.id) // 专辑目录页：点卡片进册
        else gotoDetail(card.dataset.id)
    })
    $('#selectBtn').addEventListener('click', enterSelectMode)
    $('#selCancel').addEventListener('click', () => exitSelectMode())
    $('#selSelectAll').addEventListener('click', toggleSelectAll)
    $('#selMerge').addEventListener('click', openMergeModal)
    $('#mergeSubmit').addEventListener('click', doMerge)
    $('#selPublic').addEventListener('click', () => batchOp('public'))
    $('#selPrivate').addEventListener('click', () => batchOp('private'))
    $('#selTransfer').addEventListener('click', openTransferModal)
    $('#transferSubmit').addEventListener('click', doTransfer)
    $('#selFav').addEventListener('click', () => batchOp('fav'))
    $('#selUnfav').addEventListener('click', () => batchOp('unfav'))
    $('#selDelete').addEventListener('click', confirmBatchDelete)
    // 专辑相关：多选栏两个动作 + 弹层提交 + 目录页新建 + 册内重命名/删除
    $('#selAddAlbum').addEventListener('click', () => openAlbumModal())
    $('#selRemoveAlbum').addEventListener('click', removeSelectedFromAlbum)
    $('#albumSubmit').addEventListener('click', doAddToAlbum)
    $('#albumNewChk').addEventListener('change', e => {
        $('#albumNewRow').classList.toggle('hidden', !e.target.checked)
        // “新建”与“选已有”二选一：勾新建就清掉已选专辑，避免提交时歧义
        if (e.target.checked) { const s = $('#albumPick input:checked'); if (s) s.checked = false }
        else $('#albumNewName').value = ''
    })
    // radio 列表是异步生成的，用容器委托；选了已有专辑就反过去掉新建勾选
    $('#albumPick').addEventListener('change', () => {
        if (!$('#albumPick input:checked')) return
        $('#albumNewChk').checked = false
        $('#albumNewRow').classList.add('hidden')
    })
    $('#newAlbumBtn').addEventListener('click', () => openAlbumForm('create'))
    $('#albumFormSubmit').addEventListener('click', submitAlbumForm)
    $('#albumRename').addEventListener('click', () =>
        openAlbumForm('rename', { id: state.albumId, title: (state.albumHead || {}).title }))
    $('#albumDelete').addEventListener('click', confirmDeleteAlbum)
}

// ---- 批量操作： POST /api/collections/batch { ids, op } ----
const BATCH_LABELS = { public: '公开', private: '私有', delete: '删除', fav: '收藏', unfav: '取消收藏' }
async function batchOp(op, ids) {
    ids = ids || selectedIdsInOrder()
    if (!ids.length) return toast('请至少选择一个资源')
    try {
        const j = await api('/api/collections/batch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, op }),
        })
        const res = (j && j.data) || {}
        const done = res.done || 0, failed = res.failed || []
        closeModal('confirmModal')
        // 把结果同步到内存数据与卡片 DOM（不重新拉取、不重建网格）
        const failedSet = new Set(failed.map(String))
        applyBatchResult(op, ids.filter(id => !failedSet.has(String(id))))
        toast(failed.length
            ? `${BATCH_LABELS[op]}：成功 ${done}，失败 ${failed.length}`
            : `已${BATCH_LABELS[op]} ${done} 个资源`)
        exitSelectMode(false) // applyBatchResult 已就地清理选中态，无需重建
        notifyList({ type: 'dirty' }) // 本页已本地同步；通知其它列表标签页重拉
    } catch (e) { toast('操作失败：' + e.message) }
}
/** 批量操作结果本地化：更新 state.list 数据 + 精准修补对应卡片 */
export function applyBatchResult(op, okIds) {
    // 从当前列表移除的场景：删除、送人（已不属于自己）、移出专辑；在收藏范围取消收藏同样退出
    const remove = op === 'delete' || op === 'transfer' || op === 'remove-from-album'
        || (op === 'unfav' && state.scope === 'favorites')
    for (const id of okIds) {
        const it = state.list.find(x => String(x.id) === String(id))
        const card = $(`#grid .card[data-id="${id}"]`)
        if (remove) {
            if (card) card.remove()
            if (it) state.list = state.list.filter(x => x !== it)
            state.total = Math.max(0, (state.total || 1) - 1)
            continue
        }
        if (op === 'public' || op === 'private') {
            if (it) it.visibility = op
            const b = card && card.querySelector('.badge')
            if (b) { b.className = 'badge ' + op; b.textContent = op === 'public' ? '公开' : '私有' }
        } else if (op === 'fav' || op === 'unfav') {
            const fv = op === 'fav'
            if (it) it.favorited = fv
            const f = card && card.querySelector('.fav-ic')
            if (f) { f.classList.toggle('on', fv); f.innerHTML = icon('heart', 13, fv) }
        }
    }
    // 清除选中遗留：高亮描边与左上角对钩，卡片恢复普通浏览态
    clearSelectionMarks()
    $('#endMsg').classList.toggle('hidden', state.hasMore || state.list.length === 0)
    syncEmptyState()
    // 卡片变少后可能不再构成滚动条件，主动补位拉取
    requestAnimationFrame(fillViewport)
}
/** 批量删除前先查一遍这些资源在哪几个专辑里，把连带移出说清楚再确认 */
async function confirmBatchDelete() {
    const ids = selectedIdsInOrder()
    if (!ids.length) return toast('请至少选择一个资源')
    openModal('confirmModal')
    let note = ''
    try {
        const map = (await api('/api/albums/by-collections', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collectionIds: ids }),
        })).data || {}
        const names = new Set()
        for (const id of ids) for (const a of (map[id] || [])) names.add(a.title)
        if (names.size) note = `同时会从 ${names.size} 本专辑中移出：${[...names].join('、')}。`
    } catch { /* 只是附加提示，查不到不该拦住删除 */ }
    $('#confirmText').textContent = `确定删除选中的 ${ids.length} 个资源？文件将按引用计数清理，此操作不可恢复。` + note
    $('#confirmOk').onclick = () => batchOp('delete', ids)
}

// ---- 送人（转移所有权）：POST /api/collections/transfer { ids, to } ----
/** 打开弹层并拉取可选接收用户（接口已排除自己）；每次打开重拉，新注册用户能即时出现 */
async function openTransferModal() {
    const ids = selectedIdsInOrder()
    if (!ids.length) return toast('请至少选择一个资源')
    const picked = state.list.filter(x => state.selected.has(String(x.id)))
    $('#transferSummary').innerHTML = `将送出以下 <b>${ids.length}</b> 个资源：<ul>` +
        picked.map(x => `<li>${escapeHtml(x.title || '')} · ${(x.itemCount || 0)} 项</li>`).join('') + `</ul>`
    const sel = $('#transferUser')
    sel.innerHTML = '<option value="">加载中…</option>'
    openModal('transferModal')
    try {
        const j = await api('/api/users')
        const users = (j && j.data) || []
        sel.innerHTML = users.length
            ? '<option value="">请选择用户</option>' + users.map(u =>
                `<option value="${escapeHtml(u.id)}">${escapeHtml(u.username)}${u.role === 'admin' ? '（管理员）' : ''}</option>`).join('')
            : '<option value="">没有其他可选用户</option>'
    } catch (e) {
        sel.innerHTML = '<option value="">加载失败</option>'
        toast('用户列表加载失败：' + e.message)
    }
}
async function doTransfer() {
    const ids = selectedIdsInOrder()
    if (!ids.length) return toast('请至少选择一个资源')
    const sel = $('#transferUser')
    const to = sel.value
    if (!to) return toast('请选择接收的用户')
    const toName = sel.options[sel.selectedIndex].textContent
    const btn = $('#transferSubmit'); btn.disabled = true
    try {
        const j = await api('/api/collections/transfer', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, to }),
        })
        const res = (j && j.data) || {}
        const done = res.done || 0, failed = res.failed || []
        closeModal('transferModal')
        // 送成功的资源不再属于自己，从“我的”列表就地移除
        const failedSet = new Set(failed.map(f => String(f.id)))
        applyBatchResult('transfer', ids.filter(id => !failedSet.has(String(id))))
        toast(failed.length
            ? `送人：成功 ${done}，失败 ${failed.length}`
            : `已把 ${done} 个资源送给 ${toName}`)
        exitSelectMode(false) // applyBatchResult 已就地清理选中态，无需重建
        notifyList({ type: 'dirty' }) // 其它列表标签页同步刷新（接收方的广场/收藏同样受影响）
    } catch (e) {
        toast('送人失败：' + e.message)
    } finally { btn.disabled = false }
}
