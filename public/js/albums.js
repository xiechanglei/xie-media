// ================= 专辑：加入 / 移出 / 新建 / 重命名 / 删除 =================
import { state } from './state.js'
import { $, $$, api, toast, escapeHtml } from './utils.js'
import { openModal, closeModal } from './player.js'
import { selectedIdsInOrder, exitSelectMode, clearSelectionMarks, applyBatchResult } from './selection.js'
import { reset, renderAlbumHead } from './list.js'
import { gotoList } from './router.js'
import { notifyList } from './list-sync.js'

let albumModalIds = []      // 当前弹层要处理的资源 id（多选或详情页单个）
let albumFormMode = 'create', albumFormId = null
const jsonPost = (body) => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
/**
 * 打开“加入专辑”弹层。ids 不传取当前多选结果，详情页传单个资源 id。
 * 一次只选一个目标专辑（radio），“新建专辑并加入”是另一条路径，不在一次提交里混两套动作。
 */
export async function openAlbumModal(ids) {
    ids = ids || selectedIdsInOrder()
    if (!ids.length) return toast('请至少选择一个资源')
    albumModalIds = ids
    // 详情页可能开在新标签页，列表里没有这条数据，用当前详情兼容回显
    const picked = state.list.filter(x => ids.some(id => String(id) === String(x.id)))
    const shown = picked.length ? picked
        : (state.detail ? [{ title: state.detail.title, itemCount: state.detail.items?.length }] : [])
    $('#albumSummary').innerHTML = `将把以下 <b>${ids.length}</b> 个资源加入专辑：<ul>` +
        shown.map(x => `<li>${escapeHtml(x.title || '')}${x.itemCount ? ` · ${x.itemCount} 项` : ''}</li>`).join('') + '</ul>'
    $('#albumNewChk').checked = false
    $('#albumNewRow').classList.add('hidden')
    $('#albumNewName').value = ''
    const box = $('#albumPick')
    box.innerHTML = '<div class="muted">加载中…</div>'
    openModal('albumModal')
    try {
        const albums = ((await api('/api/albums')).data || {}).list || []
        box.innerHTML = albums.length
            ? albums.map(a => `<label class="album-opt">` +
                `<input type="radio" name="albumPick" value="${escapeHtml(a.id)}">` +
                `<span class="ao-name">${escapeHtml(a.title)}</span>` +
                `<span class="ao-count">${a.entryCount} 个资源</span></label>`).join('')
            : '<div class="muted">还没有专辑，勾选下面“新建专辑并加入”创建一本</div>'
        // 回显：已全部包含所选资源的专辑标出来，避免重复归类
        const map = (await api('/api/albums/by-collections', jsonPost({ collectionIds: ids }))).data || {}
        $$('#albumPick input[type="radio"]').forEach(r => {
            const full = ids.every(id => (map[id] || []).some(x => x.albumId === r.value))
            if (full) r.closest('.album-opt').querySelector('.ao-count').textContent = '已全部包含'
        })
    } catch (e) {
        box.innerHTML = `<div class="muted">加载失败：${escapeHtml(e.message)}</div>`
    }
}
export async function doAddToAlbum() {
    const ids = albumModalIds
    if (!ids.length) return toast('请先选择资源')
    const btn = $('#albumSubmit'); btn.disabled = true
    try {
        let albumId = '', albumTitle = ''
        if ($('#albumNewChk').checked) {
            albumTitle = $('#albumNewName').value.trim()
            if (!albumTitle) { toast('请填写新专辑名称'); return }
            albumId = (await api('/api/albums', jsonPost({ title: albumTitle }))).data.id
        } else {
            const sel = $('#albumPick input[name="albumPick"]:checked')
            if (!sel) { toast('请选择一个专辑，或勾上“新建专辑并加入”'); return }
            albumId = sel.value
            albumTitle = sel.closest('.album-opt').querySelector('.ao-name').textContent
        }
        const res = (await api(`/api/albums/${albumId}/items`, jsonPost({ collectionIds: ids }))).data || {}
        closeModal('albumModal')
        const tail = res.skipped.length ? `，${res.skipped.length} 个已在其中` : ''
        toast(res.added
            ? `已把 ${res.added} 个资源加入「${albumTitle}」${tail}`
            : `所选资源都已在「${albumTitle}」中`)
        // 加专辑不改卡片内容也不重建网格，所以选中态必须在这里手动清掉
        // （exitSelectMode(false) 只清内存，直接用会把高亮描边与对钩留在列表上）
        if (state.selectMode) { clearSelectionMarks(); exitSelectMode(false) }
        if (state.scope === 'albums') reset()  // 目录页封面与计数变了
        notifyList({ type: 'dirty' })          // 其它标签页的专辑计数随之重拉
    } catch (e) {
        toast('加入专辑失败：' + e.message)
    } finally { btn.disabled = false }
}
/** 移出专辑：只解除引用，资源本体不动，故就地移除卡片并修正计数，不整页重拉 */
export async function removeSelectedFromAlbum() {
    const ids = selectedIdsInOrder()
    if (!ids.length) return toast('请至少选择一个资源')
    if (!state.albumId) return
    try {
        const res = (await api(`/api/albums/${state.albumId}/items`, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collectionIds: ids }),
        })).data || {}
        applyBatchResult('remove-from-album', ids)
        exitSelectMode(false)
        if (state.albumHead) {
            state.albumHead.entryCount = Math.max(0, state.albumHead.entryCount - (res.removed || 0))
        }
        renderAlbumHead()
        toast(`已从专辑移出 ${res.removed || 0} 个资源，资源本体未受影响`)
        notifyList({ type: 'dirty' })
    } catch (e) { toast('移出失败：' + e.message) }
}
/** 新建与重命名共用一个弹层：rename 时预填当前名称 */
export function openAlbumForm(mode, album) {
    albumFormMode = mode
    albumFormId = album ? album.id : null
    $('#albumFormTitle').textContent = mode === 'rename' ? '重命名专辑' : '新建专辑'
    $('#albumFormName').value = mode === 'rename' ? (album.title || '') : ''
    openModal('albumFormModal')
    $('#albumFormName').focus()
}
export async function submitAlbumForm() {
    const name = $('#albumFormName').value.trim()
    if (!name) return toast('请填写专辑名称')
    const btn = $('#albumFormSubmit'); btn.disabled = true
    try {
        if (albumFormMode === 'rename') {
            await api(`/api/albums/${albumFormId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: name }),
            })
            closeModal('albumFormModal')
            if (state.albumHead) state.albumHead.title = name
            renderAlbumHead()
            toast('已重命名')
        } else {
            await api('/api/albums', jsonPost({ title: name }))
            closeModal('albumFormModal')
            toast('专辑已创建')
            gotoList('albums'); reset()
        }
        notifyList({ type: 'dirty' })
    } catch (e) {
        toast('保存失败：' + e.message)
    } finally { btn.disabled = false }
}
/** 删专辑：只删整理册。文案里把“资源不会没”说明白，这是用户最怕的一点 */
export function confirmDeleteAlbum() {
    const h = state.albumHead
    if (!h || !state.albumId) return
    openModal('confirmModal')
    $('#confirmText').textContent =
        `确定删除专辑「${h.title}」？只会删除这本册子，里面的 ${h.entryCount} 个资源不会受影响。`
    $('#confirmOk').onclick = async () => {
        try {
            await api(`/api/albums/${state.albumId}`, { method: 'DELETE' })
            closeModal('confirmModal')
            toast('专辑已删除，资源都在')
            notifyList({ type: 'dirty' })
            gotoList('albums'); reset()
        } catch (e) { toast('删除失败：' + e.message) }
    }
}
