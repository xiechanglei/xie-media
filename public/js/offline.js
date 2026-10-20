// ================= 离线下载（aria2）=================
// 新建任务弹层状态机：种子 → 本地解析预览（不建任务）→ 勾选后一步建任务；
// 磁力 → 先建“待选”临时任务取元数据（后端列表接口不展示它），勾选后删临时任务重加为官任务；
// 弹层带着未提交的临时任务关闭时直接废弃，不留“未命名”垃圾任务
import { state } from './state.js'
import {
    $, $$, api, toast, fmtSize, fmtSpeed, fmtDateTime, escapeHtml, fileToBase64,
} from './utils.js'
import { openModal, closeModal } from './player.js'
import { markListDirty, notifyList } from './list-sync.js'

const OFFLINE_POLL_MS = 3000 // 任务列表轮询间隔，与后端 config 同名常量保持独立（前端不共享后端模块）
const DL_STATUS_TEXT = { waiting: '队列中', active: '下载中', paused: '已暂停', complete: '已完成', error: '失败' }
const dlCreate = { type: 'torrent', file: null, torrentB64: null, taskId: null, step: 1, poller: null }
// 离线任务行缓存：key=任务 id（字符串），轮询时按 id 复用行 DOM，避免整表重建
const dlRowEls = new Map()

export async function checkOfflineStatus() {
    try {
        const j = await api('/api/offline/status')
        state.offlineEnabled = !!(j.data && j.data.enabled)
    } catch { state.offlineEnabled = false }
    $('#offlineNavItem').classList.toggle('hidden', !state.offlineEnabled)
}
export function startOfflinePolling() {
    stopOfflinePolling()
    loadOfflineTasks()
    state.offlineTimer = setInterval(loadOfflineTasks, OFFLINE_POLL_MS)
}
export function stopOfflinePolling() {
    if (state.offlineTimer) { clearInterval(state.offlineTimer); state.offlineTimer = null }
}
async function loadOfflineTasks() {
    if (state.view !== 'offline') return
    try {
        const j = await api('/api/offline/tasks')
        state.offlineTasks = (j.data && j.data.list) || []
        renderOfflineTasks()
    } catch { /* 轮询失败不打扰，下一轮再试 */ }
}
const dlTaskById = (id) => state.offlineTasks.find(t => String(t.id) === String(id))
function dlPct(t) {
    if (t.status === 'complete') return 100
    if (!t.totalLength) return 0
    return Math.min(99, Math.round(t.completedLength / t.totalLength * 100))
}
// 剩余时间：按 剩下字节 / 当前速度 估算；只有下载中且速度、总大小齐全时才可算
function dlEta(t) {
    if (t.status !== 'active' || !t.speed || !t.totalLength) return ''
    const left = t.totalLength - (t.completedLength || 0)
    if (left <= 0) return ''
    const sec = Math.max(1, Math.round(left / t.speed))
    if (sec < 60) return `剩余 ${sec} 秒`
    const m = Math.round(sec / 60)
    if (m < 60) return `剩余 ${m} 分钟`
    return `剩余 ${Math.floor(m / 60)} 小时 ${m % 60} 分`
}
// 动作按钮集：仅由 status + 待选态决定
function dlActionsOf(t) {
    const actions = []
    if (t.status === 'complete') {
        actions.push(`<button class="mini-btn ingest" data-act="ingest" type="button">入库</button>`)
    } else if (t.status === 'paused') {
        actions.push(`<button class="mini-btn" data-act="resume" type="button">继续</button>`)
    } else if (t.status === 'active' || t.status === 'waiting') {
        actions.push(`<button class="mini-btn" data-act="pause" type="button">暂停</button>`)
    }
    actions.push(`<button class="mini-btn danger" data-act="del" type="button">删除</button>`)
    return actions.join('')
}
// 行骨架：建一次，后续只更新其中动态字段
function createDlRow(t) {
    const row = document.createElement('div'); row.className = 'dl-row'; row.dataset.id = t.id
    row.innerHTML = `
        <div class="dl-top">
            <span class="dl-kind"></span>
            <span class="dl-name"></span>
            <span class="dl-status"></span>
            <div class="grow"></div>
            <span class="dl-actions"></span>
        </div>
        <div class="dl-err hidden"></div>
        <div class="dl-bar"><div class="dl-bar-fill" style="width:0%"></div></div>
        <div class="dl-sub">
            <span class="dl-pct"></span>
            <span class="dl-size"></span>
            <span class="dl-speed"></span>
            <span class="dl-eta"></span>
            <span class="dl-time"></span>
        </div>`
    row._c = {
        kind: row.querySelector('.dl-kind'), name: row.querySelector('.dl-name'),
        status: row.querySelector('.dl-status'), actions: row.querySelector('.dl-actions'),
        err: row.querySelector('.dl-err'), bar: row.querySelector('.dl-bar-fill'),
        pct: row.querySelector('.dl-pct'), size: row.querySelector('.dl-size'),
        speed: row.querySelector('.dl-speed'), eta: row.querySelector('.dl-eta'), time: row.querySelector('.dl-time'),
    }
    row._sig = ''
    return row
}
// 只在值真变时写 DOM，空 span 靠 CSS :empty 自收起，不留 flex gap
function setText(el, s) { if (el.textContent !== s) el.textContent = s }
function updateDlRow(row, t) {
    const c = row._c
    const kind = t.type === 'torrent' ? '种子' : '磁力'
    setText(c.kind, kind)
    const nm = t.displayName || '未命名任务'
    if (c.name.textContent !== nm) { c.name.textContent = nm; c.name.title = t.displayName || '' }
    setText(c.status, DL_STATUS_TEXT[t.status] || t.status)
    const stCls = 'dl-status ' + t.status
    if (c.status.className !== stCls) c.status.className = stCls
    if (t.error) { c.err.classList.remove('hidden'); if (c.err.textContent !== t.error) { c.err.textContent = t.error; c.err.title = t.error } }
    else if (!c.err.classList.contains('hidden')) c.err.classList.add('hidden')
    const pct = dlPct(t)
    const w = pct + '%'
    if (c.bar.style.width !== w) c.bar.style.width = w   // 既有元素改宽度→触发 transition 动画
    setText(c.pct, w)
    setText(c.size, `${fmtSize(t.completedLength) || '0 B'} / ${t.totalLength ? fmtSize(t.totalLength) : '未知大小'}`)
    setText(c.speed, t.speed ? fmtSpeed(t.speed) : '')
    setText(c.eta, dlEta(t))
    setText(c.time, fmtDateTime(t.createdAt))
    const sig = t.status + '|' + (t.awaitingSelect ? '1' : '0')
    if (row._sig !== sig) { row._sig = sig; c.actions.innerHTML = dlActionsOf(t) }
}
function renderOfflineTasks() {
    const wrap = $('#dlList')
    $('#dlEmpty').classList.toggle('hidden', state.offlineTasks.length > 0)
    let speed = 0, active = 0
    // 按数组顺序做 keyed reorder：行已就位则指针前移，否则 insertBefore 挪到游标处（稳定顺序下零 DOM 写）
    let cursor = wrap.firstElementChild
    for (const t of state.offlineTasks) {
        speed += t.speed || 0
        if (t.status === 'active' || t.status === 'waiting') active++
        const key = String(t.id)
        let row = dlRowEls.get(key)
        if (!row) { row = createDlRow(t); dlRowEls.set(key, row) }
        updateDlRow(row, t)
        if (row === cursor) cursor = cursor.nextElementSibling
        else wrap.insertBefore(row, cursor)
    }
    // 游标及其后残留的都是本轮已不存在的旧行，逐个删除
    while (cursor) {
        const next = cursor.nextElementSibling
        dlRowEls.delete(String(cursor.dataset.id))
        cursor.remove()
        cursor = next
    }
    $('#dlSummary').textContent = state.offlineTasks.length
        ? `共 ${state.offlineTasks.length} 个任务${active ? ` · ${active} 个下载中${speed ? ` · ${fmtSpeed(speed)}` : ''}` : ''}`
        : ''
}
async function dlAction(id, act) {
    const t = dlTaskById(id); if (!t) return
    if (act === 'ingest') { openDlIngest(t); return }
    if (act === 'del') {
        // 与删资源同一习惯：危险操作先进确认弹层
        openModal('confirmModal')
        $('#confirmText').textContent = `确定删除下载任务「${t.displayName || ''}」？已下载但未入库的文件将一并删除，不可恢复。`
        $('#confirmOk').onclick = async () => {
            try {
                await api(`/api/offline/tasks/${id}`, { method: 'DELETE' })
                closeModal('confirmModal'); toast('已删除')
                loadOfflineTasks()
            } catch (e) { toast('删除失败：' + e.message, 4000, 'error') }
        }
        return
    }
    try {
        if (act === 'pause') {
            await api(`/api/offline/tasks/${id}/pause`, { method: 'POST' })
            // 乐观回显：aria2 收下暂停后下载槽状态还有短暂滞后，立即拉会拿到旧态“闪回下载中”
            patchLocalTask(id, { status: 'paused', speed: 0 })
        } else if (act === 'resume') {
            await api(`/api/offline/tasks/${id}/resume`, { method: 'POST' })
            patchLocalTask(id, { status: 'waiting', speed: 0 })
        }
        setTimeout(loadOfflineTasks, 1500) // aria2 落定后再用权威状态对齐（失败/漂移以轮询为准）
    } catch (e) { toast('操作失败：' + e.message, 4000, 'error') }
}
/** 暂停/继续成功后先改本地副本并重渲染，不等后端往返 */
function patchLocalTask(id, patch) {
    const t = dlTaskById(id); if (!t) return
    Object.assign(t, patch)
    renderOfflineTasks()
}

// ---- 新建下载弹层 ----
function switchDlTab(type) {
    dlCreate.type = type
    $$('.dl-tab').forEach(b => b.classList.toggle('active', b.dataset.dltab === type))
    $('#dlPaneTorrent').classList.toggle('hidden', type !== 'torrent')
    $('#dlPaneMagnet').classList.toggle('hidden', type !== 'magnet')
    updateDlSubmit()
}
/** 任务建好但尚未放行：先预览文件再勾选，磁力元数据未到时持续轮询 */
function openDlCreate() {
    stopDlPreviewPolling()
    dlCreate.type = 'torrent'; dlCreate.file = null; dlCreate.torrentB64 = null
    dlCreate.taskId = null
    dlCreate.step = 1
    $('#dlTorrentFile').value = ''
    $('#dlTorrentName').textContent = ''
    $('#dlMagnet').value = ''
    $('#dlFileList').innerHTML = ''
    $('#dlSelSummary').textContent = ''
    $('#dlPreviewHint').textContent = '正在获取文件列表…'
    $('#dlStep1').classList.remove('hidden')
    $('#dlStep2').classList.add('hidden')
    $('#dlCreateTitle').textContent = '新建下载'
    $('#dlCreateTaskName').textContent = ''
    switchDlTab('torrent')
    updateDlSubmit()
    openModal('dlCreateModal')
}
function updateDlSubmit() {
    const btn = $('#dlSubmit'); if (!btn) return
    if (dlCreate.step === 1) {
        const ok = dlCreate.type === 'torrent'
            ? !!dlCreate.file
            : /^magnet:\?/i.test(($('#dlMagnet').value || '').trim())
        btn.disabled = !ok
        btn.textContent = '下一步'
    } else {
        btn.disabled = $$('#dlFileList input[type=checkbox]:checked').length === 0
        btn.textContent = '开始下载'
    }
}
async function dlSubmitAction() {
    const btn = $('#dlSubmit')
    if (dlCreate.step === 1) {
        btn.disabled = true
        try {
            if (dlCreate.type === 'torrent') {
                // 种子：后端本地解析清单，此时根本不建 aria2 任务/账本行，选完才一次性建任务
                if (!dlCreate.file) throw new Error('请选择种子文件')
                dlCreate.torrentB64 = await fileToBase64(dlCreate.file)
                const j = await api('/api/offline/preview-torrent', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ torrentBase64: dlCreate.torrentB64 }),
                })
                dlEnterStep2(j.data.displayName || '')
                renderDlFileList(j.data.files || [])
            } else {
                const j = await api('/api/offline/tasks', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'magnet', magnet: ($('#dlMagnet').value || '').trim() }),
                })
                dlCreate.taskId = j.data.id
                dlEnterStep2(j.data.displayName || '')
                $('#dlPreviewHint').textContent = '正在解析磁力元数据，拿到文件列表后即可选择…'
                startDlPreviewPolling(dlCreate.taskId)
            }
        } catch (e) { toast(e.message, 5000, 'error') }
        finally { btn.disabled = false; updateDlSubmit() }
    } else {
        const sel = $$('#dlFileList input:checked').map(i => Number(i.dataset.idx))
        if (!sel.length) { toast('请至少勾选一个文件'); return }
        if (!dlCreate.taskId && !dlCreate.torrentB64) return
        btn.disabled = true
        try {
            if (dlCreate.taskId) {
                // 磁力临时任务（或已存在任务改选）：后端删旧任务→带 select-file 重加
                await api(`/api/offline/tasks/${dlCreate.taskId}/select`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selectedIndexes: sel }),
                })
            } else {
                // 种子首次创建：选择随 add 一次性生效
                if (!dlCreate.torrentB64) throw new Error('种子数据已失效，请重新选择文件')
                await api('/api/offline/tasks', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'torrent', torrentBase64: dlCreate.torrentB64, fileName: (dlCreate.file && dlCreate.file.name) || 'manual.torrent', selectedIndexes: sel }),
                })
            }
            stopDlPreviewPolling()
            // 先清 taskId 再关窗：避免关窗废弃逻辑误删刚建好的正式任务
            dlCreate.taskId = null
            closeModal('dlCreateModal'); toast('已开始下载')
            loadOfflineTasks()
        } catch (e) { toast('启动失败：' + e.message, 5000, 'error') }
        finally { btn.disabled = false; updateDlSubmit() }
    }
}
/** 进入选文件步骤（种子本地解析/磁力临时任务两条路共用） */
function dlEnterStep2(taskName) {
    dlCreate.step = 2
    $('#dlCreateTitle').textContent = '选择下载文件'
    $('#dlCreateTaskName').textContent = taskName
    $('#dlStep1').classList.add('hidden')
    $('#dlStep2').classList.remove('hidden')
    $('#dlFileList').innerHTML = ''
    $('#dlSelSummary').textContent = ''
}
function startDlPreviewPolling(taskId) {
    stopDlPreviewPolling()
    const tick = async () => {
        if (dlCreate.taskId !== taskId) return
        try {
            const j = await api(`/api/offline/tasks/${taskId}/preview`)
            const d = j.data || {}
            if (d.needMetadata) {
                $('#dlPreviewHint').textContent = '正在解析磁力元数据，拿到文件列表后即可选择…'
                updateDlSubmit(); return
            }
            renderDlFileList(d.files || [])
            stopDlPreviewPolling() // 列表到手，停止轮询
        } catch (e) {
            $('#dlPreviewHint').textContent = '获取文件列表失败：' + e.message
        }
    }
    tick()
    dlCreate.poller = setInterval(tick, 2500)
}
function stopDlPreviewPolling() {
    if (dlCreate.poller) { clearInterval(dlCreate.poller); dlCreate.poller = null }
}
function renderDlFileList(files) {
    const wrap = $('#dlFileList')
    wrap.innerHTML = ''
    const media = files.filter(f => f.downloadable)
    $('#dlPreviewHint').textContent = files.length
        ? `共 ${files.length} 个文件，其中 ${media.length} 个为可入库媒体（默认全部勾选）；不勾选的文件不会下载`
        : '没有可下载的文件'
    for (const f of files) {
        const lab = document.createElement('label'); lab.className = 'dl-file' + (f.downloadable ? '' : ' skip')
        lab.innerHTML = `<input type="checkbox" data-idx="${f.index}" data-size="${f.length || 0}" ${f.downloadable ? 'checked' : 'disabled'}>
            <span class="fname">${escapeHtml(f.name)}</span>
            ${f.downloadable ? '' : '<span class="ftag">非媒体·不下载</span>'}
            <span class="fsize">${fmtSize(f.length)}</span>`
        wrap.appendChild(lab)
    }
    wrap.onchange = () => dlSelRefresh('dlFileList')
    dlSelRefresh('dlFileList')
}
/** 选文件统计：已选 N 个 · 总大小，同时联动提交按钮可用性（预览与入库两个弹层共用） */
function dlSelRefresh(wrapId) {
    const wrap = document.getElementById(wrapId); if (!wrap) return
    const boxes = [...wrap.querySelectorAll('input[type=checkbox]:not(:disabled)')]
    const checked = boxes.filter(b => b.checked)
    const sizeOf = (list) => list.reduce((s, b) => s + (Number(b.dataset.size) || 0), 0)
    const sum = wrapId === 'dlFileList' ? $('#dlSelSummary') : $('#dlIngestSelSummary')
    if (sum) sum.innerHTML = checked.length
        ? `已选 <b>${checked.length}</b> 个 · ${fmtSize(sizeOf(checked))}（可选 ${boxes.length} 个 · ${fmtSize(sizeOf(boxes))}）`
        : `未选择（可选 ${boxes.length} 个 · ${fmtSize(sizeOf(boxes))}）`
    if (wrapId === 'dlFileList') updateDlSubmit()
    else { const btn = $('#dlIngestSubmit'); if (btn) btn.disabled = checked.length === 0 }
}
/** 全选/取消全选：只作用于可用勾选项（非媒体 disabled 项始终跳过） */
function dlSetAll(wrapId, val) {
    const wrap = document.getElementById(wrapId); if (!wrap) return
    wrap.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(b => { b.checked = val })
    dlSelRefresh(wrapId)
}

// ---- 入库弹层 ----
async function openDlIngest(t) {
    state.dlIngestId = t.id
    $('#dlIngestTitle').value = t.displayName || ''
    $('#dlIngestFiles').innerHTML = '<div class="muted">加载中…</div>'
    $('#dlIngestSelSummary').textContent = ''
    $('#dlIngestSubmit').disabled = true
    openModal('dlIngestModal')
    try {
        const j = await api(`/api/offline/tasks/${t.id}/files`)
        const files = (j.data && j.data.files) || []
        const wrap = $('#dlIngestFiles')
        wrap.innerHTML = ''
        if (!files.length) {
            wrap.innerHTML = '<div class="muted">任务目录里没有可入库的媒体文件（可能类型都不支持）；可直接删除该任务</div>'
            return
        }
        $('#dlIngestSubmit').disabled = false
        for (const f of files) {
            const lab = document.createElement('label'); lab.className = 'dl-file'
            lab.innerHTML = `<input type="checkbox" value="${escapeHtml(f.relPath)}" data-size="${f.size || 0}" checked>
                <span class="fname">${escapeHtml(f.name)}</span>
                <span class="ftag">${f.mediaType === 'video' ? '视频' : '图片'}</span>
                <span class="fsize">${fmtSize(f.size)}</span>`
            wrap.appendChild(lab)
        }
        wrap.onchange = () => dlSelRefresh('dlIngestFiles')
        dlSelRefresh('dlIngestFiles')
    } catch (e) {
        $('#dlIngestFiles').innerHTML = `<div class="muted">加载失败：${escapeHtml(e.message)}</div>`
    }
}

export function initOffline() {
    $('#dlNewBtn').addEventListener('click', () => openDlCreate())
    $('#dlList').addEventListener('click', e => {
        const b = e.target.closest('[data-act]'); if (!b) return
        const row = b.closest('.dl-row'); if (!row) return
        dlAction(row.dataset.id, b.dataset.act)
    })
    // 新建弹层：tab / 种子选择 / 磁力输入 / 提交
    $$('.dl-tab').forEach(b => b.addEventListener('click', () => switchDlTab(b.dataset.dltab)))
    const fileInput = $('#dlTorrentFile'), drop = $('#dlTorrentDrop')
    const setTorrent = (f) => {
        dlCreate.file = f || null
        $('#dlTorrentName').textContent = f ? `已选择：${f.name}（${fmtSize(f.size)}）` : ''
        updateDlSubmit()
    }
    fileInput.addEventListener('change', () => setTorrent(fileInput.files[0]))
    drop.addEventListener('click', () => fileInput.click())
    ;['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag') }))
    ;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag') }))
    drop.addEventListener('drop', e => {
        const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []).find(x => /\.torrent$/i.test(x.name))
        if (!f) { toast('请拖入 .torrent 种子文件'); return }
        setTorrent(f)
    })
    $('#dlMagnet').addEventListener('input', updateDlSubmit)
    $('#dlSubmit').addEventListener('click', dlSubmitAction)
    // 选文件底栏：全选/取消全选（预览与入库两个弹层共用一套委托）
    $$('.dl-sel-bar [data-dlsel]').forEach(b =>
        b.addEventListener('click', () => dlSetAll(b.dataset.dlwrap, b.dataset.dlsel === 'all')))
    // 弹层关闭时停止预览轮询；若还挂着未提交的待选临时任务（磁力取元数据用），直接废弃，
    // 它本就不该出现在列表里，留着只会变成“未命名任务”垃圾
    new MutationObserver(() => {
        if ($('#dlCreateModal').classList.contains('hidden')) {
            stopDlPreviewPolling()
            if (dlCreate.taskId) {
                const id = dlCreate.taskId; dlCreate.taskId = null
                api(`/api/offline/tasks/${id}`, { method: 'DELETE' })
                    .then(() => loadOfflineTasks())
                    .catch(() => { /* 已选完被后端删掉/已不存在，重启对账会兜底清理 */ })
            }
        }
    }).observe($('#dlCreateModal'), { attributes: true, attributeFilter: ['class'] })
    // 入库
    $('#dlIngestSubmit').addEventListener('click', async () => {
        const rels = $$('#dlIngestFiles input:checked').map(i => i.value)
        if (!rels.length) { toast('请至少选择一个文件'); return }
        const btn = $('#dlIngestSubmit'); btn.disabled = true; btn.textContent = '入库中…'
        try {
            const j = await api(`/api/offline/tasks/${state.dlIngestId}/ingest`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: $('#dlIngestTitle').value, files: rels }),
            })
            closeModal('dlIngestModal')
            const d = j.data || {}
            toast(d.message || '已入库')
            if (d.collectionId) { markListDirty(); notifyList({ type: 'dirty' }) }
            loadOfflineTasks()
        } catch (e) { toast('入库失败：' + e.message, 5000, 'error') }
        finally { btn.disabled = false; btn.textContent = '入库' }
    })
}
