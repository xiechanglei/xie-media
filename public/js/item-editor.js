// ================= item 编辑器（重命名 / 删除 / 排序 / 追加）=================
import { state } from './state.js'
import {
    $, api, toast, fmtDur, fmtSize, resLabel, escapeHtml,
    itemThumbUrl, createSpeedMeter, fmtSpeed,
} from './utils.js'
import { icon } from './icons.js'
import { openModal, closeModal } from './player.js'
import { attachDragSort } from './drag-sort.js'
import { markListDirty } from './list-sync.js'
import { renderDetail, renderDetailBody, loadDetail } from './detail.js'

function toggleItemEditor() {
    // “完成编辑”必须带保存：曾经这里只关编辑态，标删/改名全被静默丢弃（用户以为删了，服务端其实没动）
    if (state.itemEditorOpen) finishItemEditor()
    else openItemEditor()
}
/** 编辑器里是否有标删 / 改名 / 拖序的未保存改动 */
function itemEditorDirty() {
    const d = state.detail; if (!d || !state.itemEditor) return false
    if (d.items.map(it => String(it.id)).join(',') !== (state.itemEditorOrder0 || '')) return true
    return d.items.some(it => {
        const st = state.itemEditor[it.id] || {}
        return st.deleted || (st.name ?? '') !== (it.name ?? '')
    })
}
/** “完成编辑”：有改动走保存（成功自动关、失败保持编辑态并提示），无改动直接关，也免得空发一次 PATCH */
function finishItemEditor() {
    if (itemEditorDirty()) saveItemEditor()
    else closeItemEditor()
}
/** “退出编辑”：有未保存改动先确认再丢弃，无改动直接关 */
function exitItemEditor() {
    if (!itemEditorDirty()) { closeItemEditor(); return }
    openModal('confirmModal')
    $('#confirmText').textContent = '当前有未保存的修改（改名 / 删除 / 排序），退出编辑将丢弃这些改动，确定退出？'
    $('#confirmOk').onclick = () => { closeModal('confirmModal'); closeItemEditor() }
}
function openItemEditor() {
    const d = state.detail; if (!d) return
    state.itemEditorOpen = true
    state.itemEditor = {}
    d.items.forEach(it => { state.itemEditor[it.id] = { name: it.name, deleted: false } })
    state.itemEditorOrder0 = d.items.map(it => String(it.id)).join(',') // 开局快照，退出时比对是否拖过序
    renderDetailBody()
}
function closeItemEditor() {
    state.itemEditorOpen = false
    state.itemEditor = null
    state.itemAppending = false
    state.itemEditorOrder0 = ''
    renderDetailBody()
}
async function saveItemEditor() {
    const d = state.detail; if (!d) return
    // 直接以当前 d.items 数组作为可见顺序（上移/下移时已就地交换）
    const visible = d.items.filter(it => !state.itemEditor[it.id]?.deleted)
    const deleted = d.items.filter(it => state.itemEditor[it.id]?.deleted).map(it => it.id)
    const currentOrder = visible.map(it => it.id)
    const edits = []
    for (const it of visible) {
        const st = state.itemEditor[it.id] || {}
        const newName = (st.name ?? '').toString().trim()
        if (newName !== it.name) edits.push({ id: it.id, name: newName })
    }
    const payload = { edits, deletes: deleted, order: currentOrder }
    try {
        const j = await api(`/api/collections/${d.id}/items`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        toast('已保存')
        // 用服务器返回的最新 items 覆盖（保留其余字段）
        d.items = j.data.items
        d.itemCount = d.items.length
        markListDirty() // 文件数量/封面可能变化
        closeItemEditor()
        renderDetail()
    } catch (e) { toast('保存失败：' + e.message) }
}

function buildItemEditor() {
    const d = state.detail
    const wrap = document.createElement('div'); wrap.className = 'item-editor'

    const head = document.createElement('div'); head.className = 'item-editor-foot'
    head.innerHTML = `<span class="hint">修改显示名 · 删除 · 按住左侧把手拖动排序（或用上下按钮）· 点上方「完成编辑」写回服务器</span>`
    wrap.appendChild(head)

    const rowsEl = document.createElement('div')
    const renderRows = () => {
        rowsEl.innerHTML = ''
        // 过滤掉已 deleted 的行（用户点删除只是标记；也可撤销，见 restore 按钮）
        d.items.forEach((it, i) => {
            const st = state.itemEditor[it.id]
            rowsEl.appendChild(buildItemRow(it, i, st, renderRows))
        })
        // 更新 idx 显示（对未删除才编号）
        let visibleIdx = 0
        rowsEl.querySelectorAll('.item-row').forEach(row => {
            if (row.classList.contains('is-deleted')) { row.querySelector('.idx').textContent = '×' }
            else { visibleIdx++; row.querySelector('.idx').textContent = String(visibleIdx) }
        })
    }

    function buildItemRow(it, idxInArray, st, rerender) {
        const row = document.createElement('div'); row.className = 'item-row' + (st.deleted ? ' is-deleted' : '')
        row.dataset.id = String(it.id)
        if (st.deleted) row.dataset.nosort = '1'
        const m = it.meta
        const mediaTags = [it.mediaType === 'video' ? '视频' : '图片']
        if (m) {
            if (m.durationSec) mediaTags.push(fmtDur(m.durationSec))
            const rl = resLabel(m); if (rl) mediaTags.push(rl)
            if (m.videoCodec) mediaTags.push(m.videoCodec.toUpperCase())
        }
        mediaTags.push(fmtSize(it.size))
        row.innerHTML = `
            <span class="idx"></span>
            ${st.deleted ? '' : `<span class="icon-btn drag-handle" title="按住拖动排序">${icon('grip', 14, true)}</span>`}
            <img class="thumb" loading="lazy" src="${itemThumbUrl(it.id)}" alt="">
            <input class="name-input" type="text" value="${escapeHtml(st.name ?? '')}" placeholder="${escapeHtml(it.originalName)}" ${st.deleted ? 'disabled' : ''}>
            <span class="media-badge">${mediaTags.join(' · ')}</span>
            <button class="icon-btn" data-act="up" title="上移" ${st.deleted ? 'disabled' : ''}>${icon('up', 14)}</button>
            <button class="icon-btn" data-act="down" title="下移" ${st.deleted ? 'disabled' : ''}>${icon('down', 14)}</button>
            ${st.deleted
                ? `<button class="icon-btn restore" data-act="restore" title="撤销删除">${icon('undo', 14)}</button>`
                : `<button class="icon-btn danger" data-act="del" title="删除">${icon('trash', 14)}</button>`}
        `
        const inp = row.querySelector('.name-input')
        inp.addEventListener('input', () => { st.name = inp.value })
        row.querySelector('[data-act=up]').addEventListener('click', () => {
            if (st.deleted) return
            const prev = findAdjacentVisibleIdx(idxInArray, -1)
            if (prev < 0) return
            ;[d.items[idxInArray], d.items[prev]] = [d.items[prev], d.items[idxInArray]]
            rerender()
        })
        row.querySelector('[data-act=down]').addEventListener('click', () => {
            if (st.deleted) return
            const next = findAdjacentVisibleIdx(idxInArray, +1)
            if (next < 0) return
            ;[d.items[idxInArray], d.items[next]] = [d.items[next], d.items[idxInArray]]
            rerender()
        })
        const delBtn = row.querySelector('[data-act=del]')
        if (delBtn) delBtn.addEventListener('click', () => { st.deleted = true; rerender() })
        const restoreBtn = row.querySelector('[data-act=restore]')
        if (restoreBtn) restoreBtn.addEventListener('click', () => { st.deleted = false; rerender() })
        return row
    }
    function findAdjacentVisibleIdx(fromIdx, dir) {
        for (let k = fromIdx + dir; k >= 0 && k < d.items.length; k += dir) {
            if (!state.itemEditor[d.items[k].id].deleted) return k
        }
        return -1
    }

    renderRows()
    // 拖拽排序：拖完把 DOM 顺序同步回 d.items 并重建行（修复上下按钮闭包索引）
    attachDragSort({
        container: rowsEl,
        rowSel: '.item-row',
        handleSel: '.drag-handle',
        onReorder: rows => {
            const order = rows.map(r => r.dataset.id)
            d.items.sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)))
            renderRows()
        },
    })
    wrap.appendChild(rowsEl)

    // 追加区域
    const append = document.createElement('div'); append.className = 'append-area'
    const appendInput = document.createElement('input')
    appendInput.type = 'file'; appendInput.multiple = true
    appendInput.accept = '.mp4,.webm,.mov,.mkv,.jpg,.jpeg,.png,.webp,.gif'
    const appendBtn = document.createElement('button')
    appendBtn.type = 'button'; appendBtn.className = 'primary'
    appendBtn.textContent = '追加并保存'
    const appendHint = document.createElement('span'); appendHint.className = 'hint'
    // fetch 拿不到请求体的上传进度，改 XHR：追加大文件时能看百分比与速度
    appendBtn.addEventListener('click', () => {
        const files = Array.from(appendInput.files || [])
        if (!files.length) return toast('请先选择要追加的文件')
        appendBtn.disabled = true; appendHint.textContent = '上传中 0%'
        const fd = new FormData()
        for (const f of files) fd.append('files', f)
        const meter = createSpeedMeter()
        const reset = () => { appendBtn.disabled = false; appendHint.textContent = '' }
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `/api/collections/${d.id}/items`, true)
        xhr.withCredentials = true
        xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return
            const p = e.loaded / e.total
            // 字节传完后服务端还要算 MD5/落盘/探元数据，此时已无传输速度可显示
            const sp = fmtSpeed(meter.speed(e.loaded))
            appendHint.textContent = p >= 1 ? '上传完成，服务器处理中…' : `上传中 ${Math.round(p * 100)}%${sp ? ` · ${sp}` : ''}`
        }
        xhr.onload = async () => {
            let j = null; try { j = JSON.parse(xhr.responseText) } catch { /* ignore */ }
            const ok = xhr.status >= 200 && xhr.status < 300 && (!j || j.success !== false)
            reset()
            if (!ok) return toast('追加失败：' + ((j && j.message) || ('HTTP ' + xhr.status)), 5000, 'error')
            appendInput.value = ''
            toast('已追加')
            markListDirty() // 文件数量/封面变了
            await loadDetail(d.id)
            // 追加后自动回到编辑态方便继续处理（编辑器重建，按钮态随之复原）
            openItemEditor()
        }
        xhr.onerror = () => { reset(); toast('追加失败：网络错误', 5000, 'error') }
        xhr.send(fd)
    })
    append.appendChild(appendInput); append.appendChild(appendBtn); append.appendChild(appendHint)
    wrap.appendChild(append)

    // 尾部保存/取消已去掉：提交与放弃统一由顶部操作条的“完成编辑 / 退出编辑”承担，避免两套语义重复
    return wrap
}

// 供 detail 模块分发详情页动作与渲染编辑器（导出放末尾，与上方声明同义）
export { toggleItemEditor, exitItemEditor, buildItemEditor }
