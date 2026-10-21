// ================= 列表（含专辑目录/内页渲染与无限滚动）=================
import { state } from './state.js'
import { $, $$, api, toast, fmtDateTime, fmtDur, escapeHtml, coverUrl } from './utils.js'
import { icon } from './icons.js'
import { updateSelectBar } from './selection.js'

// 骨架屏：重置首页时先铺占位卡，数据到达后由 clearSkeleton 统一移除
function showSkeleton(n = 10) {
    $('#grid').innerHTML = Array.from({ length: n }, () => `
        <div class="card skeleton">
            <div class="sk-block sk-cover"></div>
            <div class="sk-body"><div class="sk-block sk-line w70"></div><div class="sk-block sk-line w40"></div></div>
        </div>`).join('')
}
function clearSkeleton() { $$('#grid .skeleton').forEach(el => el.remove()) }
/** 空态提示文案随 scope 变化；列表长度变动后都过一遍 */
export function syncEmptyState() {
    const emptyEl = $('#empty')
    if (state.list.length === 0) {
        emptyEl.classList.remove('hidden')
        emptyEl.textContent = {
            mine: '还没有内容，点击右上"＋ 上传"开始',
            favorites: '还没有收藏，去广场或我的里挑一个吧',
            albums: '还没有专辑，点击右上"＋ 新专辑"创建第一本',
            album: '这本专辑还是空的，去列表里多选资源点“加专辑”',
            plaza: '广场暂时是空的',
        }[state.scope] || '还没有内容'
    } else emptyEl.classList.add('hidden')
}
/** 补位拉取：哨兵仍在视口附近且还有更多时继续下一页。
 *  PC 大屏上一页 24 条撑不满屏幕时没有滚动条，IntersectionObserver 只在相交状态
 *  “变化”时触发，哨兵一直可见就不会再回调，必须主动续拉 */
export function fillViewport() {
    if (state.view !== 'list' || state.loading || !state.hasMore) return
    const r = $('#sentinel').getBoundingClientRect()
    if (r.top < window.innerHeight + 400) load()
}
export function reset() {
    state.page = 0; state.list = []; state.hasMore = true; state.total = 0
    showSkeleton()
    $('#endMsg').classList.add('hidden')
    $('#empty').classList.add('hidden')
    load()
}
/** 软刷新：不清不铺骨架，按已加载的页数重拉 1..N 后整体替换数据并就地重建网格，
 *  滚动位置保持不动；适用于裁剪/编辑这类“内容变了但结构基本稳定”的脏标记，
 *  避免 reset() 把列表打回从头加载 */
let pendingSoft = false
export async function softReload() {
    if (state.loading) { pendingSoft = true; return }
    state.loading = true
    $('#loading').classList.remove('hidden')
    // 目录页（albums）后端不分页，一次到底；其余按已加载页数原样重拉
    const pages = state.scope === 'albums' ? 1 : Math.max(1, Math.ceil(state.list.length / state.pageSize))
    try {
        const out = []
        let total = state.total, got = 1
        for (let p = 1; p <= pages; p++) {
            const j = await api(listUrl(p))
            const d = j.data || {}
            const part = d.list || []
            out.push(...part)
            total = d.total ?? total
            got = p
            if (state.scope === 'album') {
                state.albumHead = {
                    title: (d.album && d.album.title) || '',
                    entryCount: d.entryCount || 0,
                    invisibleCount: d.invisibleCount || 0,
                }
            }
            // 这一页没填满说明到底了，后面页不用再拉
            if (part.length < state.pageSize) break
        }
        state.list = out
        state.total = total
        state.page = got
        state.hasMore = out.length < total
        // 静默替换：重建期间禁用入场动画，否则每张卡重放 cardIn 错峰淡入，看起来像“全部重刷”
        const grid = $('#grid')
        grid.classList.add('no-anim')
        grid.innerHTML = ''
        renderAppend(state.list)
        grid.classList.remove('no-anim')
        renderAlbumHead()
        $('#endMsg').classList.toggle('hidden', state.hasMore || state.list.length === 0)
        if (state.selectMode) updateSelectBar()
        syncEmptyState()
    } catch (e) {
        toast('列表刷新失败，切页时将重新加载')
        state.listDirty = true // 本次没换成：退回硬重载，下次切回列表走 reset()
    } finally {
        state.loading = false
        $('#loading').classList.add('hidden')
        requestAnimationFrame(() => {
            if (pendingSoft) { pendingSoft = false; softReload() }
            else fillViewport()
        })
    }
}
/** 三种列表共用一套无限滚动，仅数据源不同：目录=专辑列表，内页=册内资源，其它=资源列表 */
function listUrl(page) {
    // 目录页后端不分页，拉一次到底；keyword 由后端按专辑名筛
    if (state.scope === 'albums') {
        return '/api/albums' + (state.keyword ? '?keyword=' + encodeURIComponent(state.keyword) : '')
    }
    const params = new URLSearchParams({ page, pageSize: state.pageSize })
    if (state.keyword) params.set('keyword', state.keyword)
    if (state.scope === 'album') return `/api/albums/${state.albumId}/items?` + params
    params.set('scope', state.scope)
    return '/api/media?' + params
}
export async function load() {
    if (state.loading || !state.hasMore) return
    state.loading = true
    $('#loading').classList.remove('hidden')
    const next = state.page + 1
    try {
        const j = await api(listUrl(next))
        const d = j.data || {}
        const newList = d.list || []
        state.page = next
        state.total = d.total || 0
        state.list = state.list.concat(newList)
        state.hasMore = state.list.length < state.total
        // 专辑内页的标题与条目数每页都刷一次（后端随数据一起返，不额外请求）
        if (state.scope === 'album') {
            state.albumHead = {
                title: (d.album && d.album.title) || '',
                entryCount: d.entryCount || 0,
                invisibleCount: d.invisibleCount || 0,
            }
        }
        renderAppend(newList)
        renderAlbumHead()
        $('#endMsg').classList.toggle('hidden', state.hasMore || state.list.length === 0)
        if (state.selectMode) updateSelectBar()
        syncEmptyState()
    } catch (e) { toast('加载失败：' + e.message); state.hasMore = false }
    finally { state.loading = false; clearSkeleton(); $('#loading').classList.add('hidden'); requestAnimationFrame(() => {
        // 分页请求进行中收到的软刷新请求先排队（pendingSoft），这里补做，不丢不叠
        if (pendingSoft) { pendingSoft = false; softReload() }
        else fillViewport()
    }) }
}
function renderAppend(items) {
    const grid = $('#grid')
    clearSkeleton()
    for (const it of items) {
        const card = renderCard(it)
        // 入场错峰：按当前列数循环递增延迟，首屏卡片像瀑布一样依次浮现
        card.style.setProperty('--d', (grid.children.length % 12) * 45 + 'ms')
        grid.appendChild(card)
    }
}
/** 专辑目录页卡片：封面跟随册内最新的可见资源，一册全不可见时用占位图 */
function renderAlbumCard(a) {
    const card = document.createElement('div'); card.className = 'card album-card'
    card.dataset.id = a.id
    const bits = [`<span class="badge private">私密</span>`]
    const rest = [`${a.entryCount} 个资源`]
    if (a.invisibleCount) rest.push(`${a.invisibleCount} 个暂不可见`)
    rest.push(fmtDateTime(a.createdAt))
    bits.push(`<span class="meta-text">${escapeHtml(rest.join(' · '))}</span>`)
    card.innerHTML = `
        <div class="cover-wrap">
            ${a.firstVisibleCollectionId
                ? `<img class="cover" loading="lazy" alt="" src="${coverUrl(a.firstVisibleCollectionId)}">`
                : `<div class="cover cover-empty">${icon('layers', 34)}</div>`}
        </div>
        <div class="card-body">
            <div class="card-title" title="${escapeHtml(a.title || '')}"><span class="kind-ic">📚</span> ${escapeHtml(a.title || '')}</div>
            <div class="card-meta">${bits.join('')}</div>
        </div>`
    return card
}
/** 专辑内页横幅：标题 + 条目统计（含“他人设为私有而暂不可见”的说明，避免以为丢了东西）*/
export function renderAlbumHead() {
    const bar = $('#albumBanner'), h = state.albumHead
    if (state.scope !== 'album' || !h) { bar.classList.add('hidden'); return }
    bar.classList.remove('hidden')
    $('#albumTitle').textContent = h.title || '专辑'
    const bits = [`共 ${h.entryCount} 个资源`]
    if (h.invisibleCount) bits.push(`${h.invisibleCount} 个因他人设为私有暂不可见`)
    if (state.keyword) bits.push(`搜索“${state.keyword}”命中 ${state.total} 个`)
    $('#albumSub').textContent = bits.join(' · ')
}
export function renderCard(it) {
    // 专辑目录页复用同一网格：卡片数据是专辑而不是资源
    if (state.scope === 'albums') return renderAlbumCard(it)
    // 卡片无操作按钮，点击仅跳转详情（收藏/编辑/删除/可见性都在详情页里）
    const card = document.createElement('div'); card.className = 'card'
    card.dataset.id = it.id
    const vCount = it.videoCount || 0, iCount = it.imageCount || 0
    // 图标：纯图片→🖼；含视频（无图）→单文件🎬/多文件🎞；图片+视频混装→📁
    let kindIcon
    if (vCount > 0 && iCount > 0) kindIcon = '📁'
    else if (vCount > 0) kindIcon = (vCount > 1 ? '🎞' : '🎬')
    else kindIcon = '🖼'
    const meta = []
    meta.push(`<span class="badge ${it.visibility}">${it.visibility === 'public' ? '公开' : '私有'}</span>`)
    const rest = []
    if (state.scope !== 'mine' && it.ownerName) rest.push(`<span class="meta-owner">@${escapeHtml(it.ownerName)}</span>`)
    rest.push(`<span class="meta-date">${fmtDateTime(it.createdAt)}</span>`)
    meta.push(`<span class="meta-text">${rest.join(' · ')}</span>`)
    // 文件数量（与徽章、文字纵向居中对齐）
    if (it.itemCount) meta.push(`<span class="count-seg">${it.itemCount} 个文件</span>`)
    // 收藏心形图标（与详情页一致）：固定描述行最右侧，未收藏灰空心/已收藏红实心
    meta.push(`<span class="fav-ic ${it.favorited ? 'on' : ''}">${icon('heart', 13, it.favorited)}</span>`)
    card.innerHTML = `
        <div class="cover-wrap">
            <img class="cover" loading="lazy" alt="" src="${coverUrl(it.id)}">
            ${it.agg && it.agg.durationSec ? `<span class="cover-badge dur">${fmtDur(it.agg.durationSec)}</span>` : ''}
        </div>
        <div class="card-body">
            <div class="card-title" title="${escapeHtml(it.title || '')}"><span class="kind-ic">${kindIcon}</span> ${escapeHtml(it.title || '')}${it.category ? ` <span class="title-cat">#${escapeHtml(it.category)}</span>` : ''}</div>
            <div class="card-meta">${meta.join('')}</div>
        </div>`
    if (state.selectMode) {
        const chk = document.createElement('span'); chk.className = 'select-check'
        card.appendChild(chk)
        if (state.selected.has(String(it.id))) card.classList.add('selected')
    }
    // 点击行为不在此绑定：由 #grid 事件委托按 selectMode 分流，
    // 这样批量操作后就地修补的卡片无需重建也能正确响应
    return card
}
/** 删除成功后同步当前列表：移除数据项与 DOM 卡片，避免返回后残留 */
export function removeItemFromList(id) {
    state.list = state.list.filter(x => String(x.id) !== String(id))
    state.total = Math.max(0, (state.total || 1) - 1)
    const el = $(`#grid .card[data-id="${id}"]`)
    if (el) el.remove()
    const emptyEl = $('#empty')
    if (state.list.length === 0) { emptyEl.classList.remove('hidden'); emptyEl.textContent = '内容已全部删除' }
}

// ================= 无限滚动 =================
export function initInfiniteScroll() {
    const sentinel = $('#sentinel')
    if (!('IntersectionObserver' in window)) {
        window.addEventListener('scroll', () => {
            if (state.view !== 'list') return
            if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 400) load()
        })
        return
    }
    const io = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting && state.view === 'list') load()
    }, { root: null, rootMargin: '400px', threshold: 0 })
    io.observe(sentinel)
    // 窗口拉大时哨兵可能本就可见但不会发生状态变化，随 resize 主动补位
    window.addEventListener('resize', () => requestAnimationFrame(fillViewport))
}
