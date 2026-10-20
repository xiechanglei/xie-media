// ================= 详情页 =================
// 根据内容自动判定浏览模式（全视频=播放器+列表；否则=平铺网格），可手动切换；
// 动作区：收藏/可见性/编辑信息/编辑文件/加专辑/裁剪/删除 + Lightbox
import { state } from './state.js'
import {
    $, $$, api, toast, fmtTime, fmtDur, resLabel, aggOfItems, escapeHtml,
    itemUrl, itemThumbUrl, markMediaStale,
} from './utils.js'
import { icon } from './icons.js'
import { openModal, closeModal, getStashedPlayer } from './player.js'
import { applyFavChange, applyVisChange, notifyList, markListDirty } from './list-sync.js'
import { removeItemFromList } from './list.js'
import { gotoList } from './router.js'
import { openAlbumModal } from './albums.js'
import { toggleItemEditor, exitItemEditor, buildItemEditor } from './item-editor.js'

/** 根据内容自动判定浏览模式：全部为视频→'list'（播放器+列表），否则→'grid'（平铺） */
function computeViewMode(items) {
    if (!items || !items.length) return 'grid'
    return items.every(it => it.mediaType === 'video') ? 'list' : 'grid'
}
export async function loadDetail(id) {
    $('#detailBody').innerHTML = '<div class="loading">加载中…</div>'
    $('#detailInfo').innerHTML = ''
    try {
        const j = await api(`/api/collections/${id}`)
        state.detail = j.data
        state.viewMode = computeViewMode(j.data.items)
        state.detailCurrentIdx = 0
        state.itemEditorOpen = false
        state.itemAppending = false
        state.itemEditor = null
        renderDetail()
    } catch (e) {
        $('#detailBody').innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`
    }
}
export function renderDetail() {
    renderDetailInfo()
    // 主体：文件列表/播放器（自带上方操作条：切换浏览 / 编辑文件 / 开放 / 删除）
    renderDetailBody()
}
/** 仅重渲顶部信息区：纯元信息变更时用它代替整页重建，避免播放器闪烁与移动端视频残影 */
function renderDetailInfo() {
    const d = state.detail; if (!d) return
    const canMutate = state.user && (d.ownerId === state.user.id || state.user.role === 'admin')

    // 顶部信息（不再区分 kind，改用视频/图片数量描述）
    const vCount = d.items.filter(it => it.mediaType === 'video').length
    const iCount = d.items.filter(it => it.mediaType === 'image').length
    const parts = []
    if (vCount) parts.push(vCount > 1 ? `${vCount} 个视频` : '1 个视频')
    if (iCount) parts.push(`${iCount} 张图片`)
    const kindLabel = parts.join(' · ') || `${d.items.length} 项`
    const agg = vCount ? aggOfItems(d.items.filter(it => it.mediaType === 'video')) : null
    const aggBits = []
    if (agg) {
        if (agg.durationSec) aggBits.push(`<span>⏱ ${fmtDur(agg.durationSec)}</span>`)
        const rl = resLabel(agg)
        if (rl) aggBits.push(`<span>${rl}${agg.width ? ` (${agg.width}×${agg.height})` : ''}</span>`)
        if (agg.codecs && agg.codecs.length) aggBits.push(`<span>${escapeHtml(agg.codecs.map(c => c.toUpperCase()).join('/'))}</span>`)
    }
    const infoBits = [
        // 标题后紧跟编辑小图标（仅所有者/管理员）：点击打开编辑信息弹层
        `<h2 class="title">${escapeHtml(d.title || '')}${canMutate ? ` <button class="icon-act" data-act="edit-meta" type="button" title="编辑信息">${icon('pencil', 15)}</button>` : ''}</h2>`,
        `<div class="meta">`,
        `<span class="badge ${d.visibility}">${d.visibility === 'public' ? '公开' : '私有'}</span>`,
        `<span>${kindLabel}</span>`,
        aggBits.join(''),
        d.category ? `<span>#${escapeHtml(d.category)}</span>` : '',
        d.ownerName ? `<span>@${escapeHtml(d.ownerName)}</span>` : '',
        `<span>${fmtTime(d.createdAt)}</span>`,
        // 描述信息末尾的收藏爱心
        `<button class="icon-act fav-heart ${d.favorited ? 'on' : ''}" data-act="fav" type="button" title="${d.favorited ? '取消收藏' : '收藏'}">${icon('heart', 18, d.favorited)}</button>`,
        `</div>`,
    ]
    $('#detailInfo').innerHTML = infoBits.join('')

    // 绑定信息区动作（fav / edit-meta）
    $('#detailInfo').querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', () => handleDetailAction(btn.dataset.act, btn))
    })
}
export function renderDetailBody() {
    const d = state.detail
    const body = $('#detailBody')
    // 清空 DOM 前先暂停旧播放器：销毁即停，防移动端鬼影视频层继续播放盖住弹层
    const oldV = body.querySelector('video')
    if (oldV && !oldV.paused) { try { oldV.pause() } catch { } }
    body.innerHTML = ''
    const canMutate = state.user && (d.ownerId === state.user.id || state.user.role === 'admin')
    // 文件列表上方操作条：编辑态放“完成编辑（保存并退出）”与“退出编辑（放弃并退出）”，浏览态放切换浏览 + 所有者操作
    const btns = []
    if (canMutate) {
        if (state.itemEditorOpen) {
            btns.push(`<button class="mini-btn" data-act="edit-items" type="button" title="保存改动并退出编辑">${icon('check', 13)} 完成编辑</button>`)
            btns.push(`<button class="mini-btn" data-act="exit-items" type="button" title="放弃未保存的改动并退出编辑">${icon('undo', 13)} 退出编辑</button>`)
        } else {
            btns.push(`<button class="mini-btn" data-act="edit-items" type="button">${icon('pencil', 13)} 编辑文件</button>`)
        }
    }
    if (!state.itemEditorOpen) {
        btns.push(`<button class="mini-btn" data-act="view" type="button" title="切换浏览方式">${icon(state.viewMode === 'list' ? 'grid' : 'list', 13)} ${state.viewMode === 'list' ? '平铺' : '列表'}</button>`)
        // 加专辑对所有可读者开放：收藏了别人公开资源的人，也能把它归进自己的册子
        btns.push(`<button class="mini-btn" data-act="album" type="button">${icon('layers', 13)} 加入专辑</button>`)
        if (canMutate) {
            btns.push(`<button class="mini-btn" data-act="vis" type="button">${d.visibility === 'public' ? `${icon('lock', 13)} 转私有` : `${icon('globe', 13)} 开放到广场`}</button>`)
            // 列表模式且当前项是视频：可掐头去尾（只保留连续一段），完成后原地替换旧文件
            const cur = d.items[state.detailCurrentIdx]
            if (state.viewMode === 'list' && cur && cur.mediaType === 'video') {
                btns.push(`<button class="mini-btn" data-act="trim" type="button" title="裁掉片头或片尾：只保留一段连续内容，不重编码，完成后替换旧文件">${icon('scissors', 13)} 裁剪</button>`)
            }
            btns.push(`<button class="mini-btn danger" data-act="del" type="button">${icon('trash', 13)} 删除</button>`)
        }
    }
    if (btns.length) {
        const bar = document.createElement('div'); bar.className = 'body-toolbar'
        bar.innerHTML = btns.join('')
        body.appendChild(bar)
    }
    if (state.itemEditorOpen) {
        body.appendChild(buildItemEditor())
    } else if (state.viewMode === 'list') {
        // 手动切到列表模式的含图资源：图片项在播放器区展示为图片（点图进 Lightbox）
        body.appendChild(buildVideoLayout())
    } else {
        body.appendChild(buildAlbumGrid())
    }
    // 绑定主体区动作（view / vis / edit-items / del）——仅限顶部操作条，
    // 避免波及 item 编辑器行内的同名 data-act="del" 按钮（否则删单个文件会误触发删整个资源）
    const barEl = body.querySelector('.body-toolbar')
    if (barEl) barEl.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', () => handleDetailAction(btn.dataset.act, btn))
    })
}

// ---- 列表布局：大播放器 + 播放列表（主要面向含视频的资源）----
function buildVideoLayout() {
    const d = state.detail
    const wrap = document.createElement('div'); wrap.className = 'video-layout'
    const stage = document.createElement('div'); stage.className = 'video-stage'
    wrap.appendChild(stage)

    const list = document.createElement('div'); list.className = 'video-playlist'
    const hasVideo = d.items.some(it => it.mediaType === 'video')
    list.innerHTML = `<header>${hasVideo ? '播放列表' : '文件列表'} · ${d.items.length} 个</header>`
    const ol = document.createElement('ol')
    d.items.forEach((it, i) => {
        const li = document.createElement('li')
        if (i === state.detailCurrentIdx) li.classList.add('active')
        // 文件信息只显示时长（无时长的图片项不显示徽章）
        const dur = it.meta && it.meta.durationSec ? fmtDur(it.meta.durationSec) : ''
        li.innerHTML = `<span class="idx">${i + 1}</span><span class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>${dur ? `<span class="type-badge">${dur}</span>` : ''}`
        li.addEventListener('click', () => playAt(i))
        ol.appendChild(li)
    })
    list.appendChild(ol)
    wrap.appendChild(list)

    // 首项放入播放器
    renderStage(d.items[state.detailCurrentIdx] || d.items[0], stage)
    return wrap
}

/** 在播放器区域渲染当前 item：视频→<video>（不默认静音，尝试自动播放）；图片→<img> */
function renderStage(it, stageEl) {
    const stage = stageEl || $('.video-stage'); if (!stage) return
    stage.innerHTML = ''
    if (!it) return
    if (it.mediaType === 'video') {
        const v = document.createElement('video'); v.id = 'detailPlayer'; v.controls = true; v.playsInline = true
        // X5类内核（微信/QQ/UC等）默认用“系统自带播放器”渲染 video，原生层盖住弹层且无视CSS；
        // h5属性强制页内播放器，正常参与层叠；配合 openModal 的 stash 兑底
        v.setAttribute('x5-video-player-type', 'h5')
        v.setAttribute('x5-video-player-fullscreen', 'true')
        v.setAttribute('x5-videofullscreen-video-plays-inline', 'true')
        v.src = itemUrl(it.id)
        stage.appendChild(v)
        // 不再默认静音；非用户手势下自动播放可能被浏览器拒绝，失败即停在封面等用户点
        const p = v.play(); if (p && p.catch) p.catch(() => { /* autoplay blocked */ })
        v.addEventListener('ended', () => {
            const next = state.detailCurrentIdx + 1
            if (next < state.detail.items.length) playAt(next)
        })
    } else {
        const im = document.createElement('img'); im.src = itemUrl(it.id); im.alt = it.name || ''
        im.addEventListener('click', () => openLightbox(state.detail.items, state.detailCurrentIdx))
        stage.appendChild(im)
    }
}
function playAt(i) {
    const d = state.detail; if (!d || !d.items[i]) return
    state.detailCurrentIdx = i
    renderStage(d.items[i])
    const lis = $$('.video-playlist li')
    lis.forEach((li, idx) => li.classList.toggle('active', idx === i))
}

// ---- 相册布局：图/视频网格 ----
function buildAlbumGrid() {
    const d = state.detail
    const grid = document.createElement('div'); grid.className = 'album-grid'
    d.items.forEach((it, i) => {
        const cell = document.createElement('div'); cell.className = 'cell' + (it.mediaType === 'video' ? ' video' : '')
        cell.style.setProperty('--d', (i % 18) * 40 + 'ms')
        const img = document.createElement('img'); img.loading = 'lazy'; img.src = itemThumbUrl(it.id); img.alt = it.name || ''
        cell.appendChild(img)
        const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = it.name || ''
        cell.appendChild(nm)
        cell.addEventListener('click', () => openLightbox(d.items, i))
        grid.appendChild(cell)
    })
    return grid
}

// ---- Lightbox ----
let lbItems = [], lbIndex = 0
function openLightbox(items, idx) {
    lbItems = items; lbIndex = idx; renderLb(); openModal('lightbox')
}
function renderLb() {
    const stage = $('#lbStage'); stage.innerHTML = ''
    const it = lbItems[lbIndex]; if (!it) { closeModal('lightbox'); return }
    const url = itemUrl(it.id)
    if (it.mediaType === 'video') {
        const v = document.createElement('video'); v.controls = true; v.src = url; v.autoplay = true; v.playsInline = true
        v.setAttribute('x5-video-player-type', 'h5')
        v.setAttribute('x5-video-player-fullscreen', 'true')
        v.setAttribute('x5-videofullscreen-video-plays-inline', 'true')
        stage.appendChild(v)
    } else {
        const im = document.createElement('img'); im.src = url; im.alt = it.name || ''
        stage.appendChild(im)
    }
    // 底部信息栏：计数 + 文件名
    const counter = $('#lbCounter'); if (counter) counter.textContent = `${lbIndex + 1} / ${lbItems.length}`
    const nameEl = $('#lbName'); if (nameEl) nameEl.textContent = it.name || ''
}
function lbGo(dir) { if (!lbItems.length) return; lbIndex = (lbIndex + dir + lbItems.length) % lbItems.length; renderLb() }
function lbPrev() { lbGo(-1) }
function lbNext() { lbGo(1) }
/** Lightbox 键盘与手势：移动端左右滑动切换，带跟手拖拽反馈（水平意图才拦截，不影响纵向滚动/播放控件） */
export function initLightbox() {
    document.addEventListener('keydown', e => {
        const lb = $('#lightbox')
        if (lb && !lb.classList.contains('hidden')) {
            if (e.key === 'Escape') closeModal('lightbox')
            else if (e.key === 'ArrowLeft') lbPrev()
            else if (e.key === 'ArrowRight') lbNext()
        }
    })
    $('#lbPrev').addEventListener('click', lbPrev)
    $('#lbNext').addEventListener('click', lbNext)
    const lb = $('#lightbox')
    let lbTx = 0, lbTy = 0, lbDrag = false
    lb.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return
        lbTx = e.touches[0].clientX; lbTy = e.touches[0].clientY; lbDrag = false
    }, { passive: true })
    lb.addEventListener('touchmove', e => {
        if (e.touches.length !== 1 || lbItems.length < 2) return
        const dx = e.touches[0].clientX - lbTx
        const dy = e.touches[0].clientY - lbTy
        if (!lbDrag && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) lbDrag = true
        if (lbDrag) {
            if (e.cancelable) e.preventDefault()
            const media = $('#lbStage').firstElementChild
            if (media) { media.style.transition = 'none'; media.style.transform = `translateX(${dx}px)` }
        }
    }, { passive: false })
    lb.addEventListener('touchend', e => {
        if (!lbDrag) return
        lbDrag = false
        const media = $('#lbStage').firstElementChild
        const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : lbTx) - lbTx
        const w = window.innerWidth || 1
        const thresh = Math.min(90, w * 0.18)
        if (lbItems.length >= 2 && Math.abs(dx) > thresh) {
            const dir = dx > 0 ? -1 : 1
            if (media) { media.style.transition = 'transform .18s ease'; media.style.transform = `translateX(${dir > 0 ? -w : w}px)` }
            setTimeout(() => lbGo(dir), 130)
        } else if (media) {
            media.style.transition = 'transform .2s ease'; media.style.transform = ''
        }
    })
    lb.addEventListener('touchcancel', () => {
        if (!lbDrag) return
        lbDrag = false
        const media = $('#lbStage').firstElementChild
        if (media) { media.style.transition = 'transform .2s ease'; media.style.transform = '' }
    })
}

// ---- 详情页动作 ----
function handleDetailAction(act, btn) {
    const d = state.detail; if (!d) return
    if (act === 'view') { state.viewMode = state.viewMode === 'list' ? 'grid' : 'list'; renderDetail(); return }
    if (act === 'fav') return toggleFav(d, btn)
    if (act === 'vis') return toggleVis(d)
    if (act === 'edit-meta') return openEditMeta()
    if (act === 'edit-items') return toggleItemEditor()
    if (act === 'exit-items') return exitItemEditor()
    if (act === 'album') return openAlbumModal([d.id])
    if (act === 'trim') return openTrimModal()
    if (act === 'del') return confirmDelete(d)
}
async function toggleFav(d, btn) {
    const wasFav = d.favorited
    try {
        if (wasFav) {
            const q = new URLSearchParams({ targetId: d.id })
            await api('/api/favorites?' + q, { method: 'DELETE' })
        } else {
            await api('/api/favorites', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetId: d.id }),
            })
        }
        d.favorited = !wasFav
        // 就地修补列表数据与卡片，不再标脏重拉（同页返回不刷新列表）
        applyFavChange(d.id, d.favorited)
        notifyList({ type: 'fav', id: d.id, favorited: d.favorited })
        if (btn) {
            btn.classList.toggle('on', d.favorited)
            btn.innerHTML = icon('heart', 18, d.favorited)
            btn.title = d.favorited ? '取消收藏' : '收藏'
        }
        toast(d.favorited ? '已收藏' : '已取消收藏')
    } catch (e) { toast('操作失败：' + e.message) }
}
async function toggleVis(d) {
    const next = d.visibility === 'public' ? 'private' : 'public'
    try {
        await api(`/api/collections/${d.id}/visibility`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visibility: next }),
        })
        toast(next === 'public' ? '已开放到广场' : '已设为私有')
        d.visibility = next
        applyVisChange(d.id, next)
        notifyList({ type: 'vis', id: d.id, visibility: next })
        // 可见性只影响徽章与操作条文案：局部更新，不重建播放器
        renderDetailInfo()
        const visBtn = $('#detailBody .body-toolbar button[data-act="vis"]')
        if (visBtn) visBtn.innerHTML = next === 'public' ? `${icon('lock', 13)} 转私有` : `${icon('globe', 13)} 开放到广场`
    } catch (e) { toast('操作失败：' + e.message) }
}
// ---- 视频裁剪：一个切点一刀两断，选保留前半还是后半；流拷贝不重编码，成功后原地替换旧文件 ----
const fmtClock = (sec) => {
    sec = Math.max(0, Math.round(sec || 0))
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
    const p = (n) => String(n).padStart(2, '0')
    return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
/** "HH:MM:SS" / "MM:SS" / 纯秒数 → 秒；空返回 null，非法返回 NaN（全角冒号与空格容错） */
function parseClock(str) {
    const s = String(str ?? '').replace(/：/g, ':').replace(/\s+/g, '').replace(/^:+|:+$/g, '')
    if (!s) return null
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s)
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
    if (!m) return NaN
    return (m[1] ? +m[1] * 3600 : 0) + (+m[2]) * 60 + parseFloat(m[3])
}
function openTrimModal() {
    const d = state.detail; if (!d) return
    const it = d.items[state.detailCurrentIdx]
    if (!it || it.mediaType !== 'video') { toast('当前项不是视频'); return }
    openModal('trimModal')
    // openModal 刚把详情页播放器暂存移出文档（移动端原生视频层会盖住弹层）；
    // 裁剪需要边播边取切点，故把它接进弹层内继续用，关弹层时 restoreDetailPlayer 会按记录的父节点插回原位
    const sp = getStashedPlayer()
    const v = sp ? sp.el : null
    const box = $('#trimPlayer')
    box.innerHTML = ''
    box.classList.toggle('hidden', !v)
    if (v) box.appendChild(v)
    const playhead = () => (v && Number.isFinite(v.currentTime)) ? v.currentTime : 0
    const dur = (it.meta && it.meta.durationSec) || 0
    const atEl = $('#trimAt')
    // 只有一个输入框：默认就是当前播放点（先在播放器上播到想剪的位置再开弹层）
    atEl.value = fmtClock(playhead())
    // 默认保留后半（剪片头），符合“干掉片头广告”这个主要用途
    $$('input[name="trimKeep"]').forEach(r => { r.checked = r.value === 'after' })
    const pickedKeep = () => ($$('input[name="trimKeep"]').find(r => r.checked) || {}).value || null
    // 把“保留哪一半 / 剪掉多少 / 新时长”算成一句话，用户不必自己脑内换算
    const renderHint = () => {
        const t = parseClock(atEl.value)
        const keep = pickedKeep()
        const hint = $('#trimHint')
        if (t == null) { hint.textContent = '请填一个切点时间：1:23:05（时:分:秒）/ 23:05（分:秒）/ 秒数'; return }
        if (Number.isNaN(t)) { hint.textContent = '时间格式不对：请按 1:23:05（时:分:秒）或 23:05（分:秒）或直接写秒数'; return }
        if (!keep) { hint.textContent = '请选保留切点之前还是之后'; return }
        const keepSec = keep === 'before' ? t : (dur ? Math.max(0, dur - t) : null)
        const bits = [keep === 'before'
            ? `保留开头 → ${fmtClock(t)}，剪掉后面的片尾`
            : `保留 ${fmtClock(t)} → 片尾，剪掉前面的片头`]
        if (keepSec != null) bits.push(`新时长约 ${fmtDur(keepSec)}`)
        if (dur) bits.push(`剪掉 ${fmtClock(keep === 'before' ? Math.max(0, dur - t) : t)}`)
        hint.textContent = bits.join(' · ')
    }
    // 切点跟随播放点自动同步：拖动进度条或直接播放，输入框都实时跟着走；
    // 处理器用赋值式挂在 video 元素上，关弹层后视频送回详情页时处理器仍在，
    // 故函数内先检查弹层是否开着；用户聚焦输入框手输时不抢写
    const syncAt = () => {
        if (!v || $('#trimModal').classList.contains('hidden')) return
        if (document.activeElement === atEl) return
        const t = fmtClock(playhead())
        if (atEl.value !== t) { atEl.value = t; renderHint() }
    }
    if (v) { v.ontimeupdate = syncAt; v.onseeked = syncAt }
    // 用 oninput/onchange 赋值而非 addEventListener：本函数每次打开弹层都会跑，监听器会叠加
    atEl.oninput = renderHint
    $$('input[name="trimKeep"]').forEach(r => { r.onchange = renderHint })
    renderHint()
    $('#trimSubmit').onclick = async () => {
        const t = parseClock(atEl.value)
        const keep = pickedKeep()
        if (t == null) { toast('请填写切点时间', 4000, 'error'); return }
        if (Number.isNaN(t)) { toast('时间格式不正确，请按 HH:MM:SS / MM:SS 或秒数填写', 5000, 'error'); return }
        if (!keep) { toast('请选保留切点之前还是之后', 4000, 'error'); return }
        const btn = $('#trimSubmit')
        btn.disabled = true; btn.textContent = '开始裁剪'
        try {
            const j = await api(`/api/collections/${d.id}/items/${it.id}/trim`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cutAt: t, keep }),
            })
            if (j && j.data && Array.isArray(j.data.items)) { d.items = j.data.items; d.itemCount = d.items.length }
            markMediaStale()           // 文件已原地替换：媒体 URL 加时间戳绕开浏览器缓存
            markListDirty()            // 时长/体积变了，列表卡片聚合信息也要重拉
            closeModal('trimModal')
            renderDetail()
            toast('已裁剪，旧文件已被替换')
        } catch (err) {
            toast('裁剪失败：' + err.message, 6000, 'error')
        } finally {
            btn.disabled = false; btn.textContent = '开始裁剪'
        }
    }
}
function openEditMeta() {
    const d = state.detail
    openModal('editModal')
    $('#editTitle').value = d.title || ''
    $('#editCategory').value = d.category || ''
    $('#editSubmit').onclick = async () => {
        try {
            const j = await api(`/api/collections/${d.id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: $('#editTitle').value, category: $('#editCategory').value }),
            })
            closeModal('editModal'); toast('已保存')
            markListDirty() // 标题/分类变了，列表卡片也要同步
            // 纯元信息变更：用服务端归一化结果就地更新，只重渲信息区（不重新拉取整页，避免播放器闪烁与移动端视频图层盖住弹层）
            const nd = (j && j.data) || {}
            d.title = nd.title ?? d.title
            d.category = nd.category !== undefined ? nd.category : d.category
            renderDetailInfo()
        } catch (e) { toast('保存失败：' + e.message) }
    }
}
function confirmDelete(d) {
    openModal('confirmModal')
    $('#confirmText').textContent = `确定要删除「${d.title || ''}」？此操作不可恢复。`
    $('#confirmOk').onclick = async () => {
        try {
            await api(`/api/collections/${d.id}`, { method: 'DELETE' })
            removeItemFromList(d.id)
            notifyList({ type: 'del', id: d.id })
            closeModal('confirmModal'); toast('已删除')
            if (window.opener) window.close(); else gotoList()
        } catch (e) { toast('删除失败：' + e.message) }
    }
}
