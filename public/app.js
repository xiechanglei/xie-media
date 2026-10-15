// xie-media 前端交互 v0.4：
// - 列表页卡片仅承担跳转，操作全部集中在详情页；不再按视频/相册分类
// - hash 路由：#/list/<scope> 列表；#/c/<collectionId> 详情
// - 无限滚动使用 IntersectionObserver
// - 详情页：根据内容自动判定浏览模式（全视频=播放器+列表；否则=平铺网格），可手动切换
// - item 支持批量重命名/删除/排序 + 追加；上传显示总进度与逐文件状态
;(function () {
    const state = {
        // 列表
        scope: 'mine',
        page: 0, pageSize: 24, keyword: '',
        total: 0, list: [], hasMore: true, loading: false,
        // 用户
        user: null,
        // 视图
        view: 'list',           // 'list' | 'detail'
        // 详情
        detail: null,           // 后端返回的 collection 数据
        viewMode: 'grid',       // 'list' | 'grid'：当前生效的浏览模式
        detailCurrentIdx: 0,    // 视频集当前播放索引
        itemEditor: null,       // { [itemId]: { name, deleted } } — 仅编辑态使用
        itemEditorOpen: false,
        itemAppending: false,
    }

    const $ = (sel) => document.querySelector(sel)
    const $$ = (sel) => Array.from(document.querySelectorAll(sel))

    // ================= 工具 =================
    async function api(path, opts = {}) {
        const r = await fetch(path, { credentials: 'same-origin', ...opts })
        let j = null
        try { j = await r.json() } catch { /* 可能被守卫重定向 */ }
        if (!r.ok || (j && j.success === false)) throw new Error((j && j.message) || ('HTTP ' + r.status))
        return j || { data: null }
    }
    function toast(msg, ms = 1800) {
        const el = $('#toast'); el.textContent = msg; el.classList.add('show')
        clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms)
    }
    const fmtTime = (ts) => { try { return new Date(ts).toLocaleString() } catch { return '' } }
    const fmtDate = (ts) => { try { return new Date(ts).toLocaleDateString() } catch { return '' } }
    function fmtSize(bytes) {
        if (!bytes) return ''
        const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = bytes
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
        return n.toFixed(i ? 1 : 0) + ' ' + u[i]
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
    }
    function openModal(id) { $('#' + id).classList.remove('hidden'); document.body.style.overflow = 'hidden' }
    function closeModal(id) {
        $('#' + id).classList.add('hidden'); document.body.style.overflow = ''
        if (id === 'lightbox') {
            const v = $('#lbStage').querySelector('video'); if (v) try { v.pause() } catch { }
            $('#lbStage').innerHTML = ''
        }
    }
    const itemUrl = (id) => `/media/items/${id}`
    const itemThumbUrl = (id) => `/media/thumbnails/items/${id}`
    const coverUrl = (colId) => `/media/thumbnails/collections/${colId}`

    // ---- 元数据展示小工具 ----
    function fmtDur(sec) {
        if (!sec && sec !== 0) return ''
        sec = Math.round(sec)
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
        const p = (n) => String(n).padStart(2, '0')
        return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
    }
    function resLabel(m) {
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
    function aggOfItems(items) {
        const metas = (items || []).map(it => it.meta).filter(Boolean)
        if (!metas.length) return null
        const dur = metas.reduce((s, m) => s + (m.durationSec || 0), 0)
        const maxH = Math.max(0, ...metas.map(m => m.height || 0))
        const maxW = Math.max(0, ...metas.map(m => m.width || 0))
        const codecs = [...new Set(metas.map(m => m.videoCodec).filter(Boolean))]
        return { durationSec: Math.round(dur), width: maxW || null, height: maxH || null, codecs }
    }

    // ================= 用户 =================
    async function loadUser() {
        try {
            const j = await api('/auth/api/me')
            state.user = j.data
        } catch (e) { console.warn('loadUser failed', e); return }
        if (state.user) {
            $('#whoami').textContent = state.user.username + (state.user.role === 'admin' ? ' (管理员)' : '')
            if (state.user.role === 'admin') $('#adminLink').classList.remove('hidden')
        }
    }

    // ================= 路由 =================
    function parseHash() {
        const h = (location.hash || '').replace(/^#/, '')
        if (!h || h === '/') return { view: 'list', scope: 'mine' }
        let m = h.match(/^\/c\/([0-9a-fA-F-]+)$/)
        if (m) return { view: 'detail', id: m[1] }
        m = h.match(/^\/list\/(mine|plaza|favorites)?/)
        if (m) return { view: 'list', scope: m[1] || state.scope || 'mine' }
        return { view: 'list', scope: state.scope }
    }
    function buildListHash(scope) { return `#/list/${scope || state.scope}` }
    function applyRoute(route) {
        if (route.view === 'detail') {
            state.view = 'detail'
            $('#listView').classList.add('hidden')
            $('#detailView').classList.remove('hidden')
            hideTopbarListOnly()
            loadDetail(route.id)
        } else {
            const scopeChanged = route.scope && route.scope !== state.scope
            state.view = 'list'
            state.scope = route.scope || state.scope
            $('#detailView').classList.add('hidden')
            $('#listView').classList.remove('hidden')
            showTopbarListOnly()
            syncSidebarActive()
            syncUploadBtnVisible()
            if (scopeChanged || state.list.length === 0) reset()
        }
    }
    function gotoList(scope) {
        const target = buildListHash(scope || state.scope)
        if (location.hash === target) applyRoute(parseHash()); else location.hash = target
    }
    function gotoDetail(id) { location.hash = `#/c/${id}` }
    function hideTopbarListOnly() {
        $('#searchInput').classList.add('hidden')
        $('#uploadBtn').classList.add('hidden')
    }
    function showTopbarListOnly() {
        $('#searchInput').classList.remove('hidden')
        syncUploadBtnVisible()
    }

    // ================= 侧栏 / 抽屉 =================
    function syncSidebarActive() {
        $$('.side-item').forEach(x => x.classList.toggle('active', x.dataset.scope === state.scope))
    }
    function syncUploadBtnVisible() {
        $('#uploadBtn').classList.toggle('hidden', state.scope !== 'mine' || state.view !== 'list')
    }
    function closeDrawer() { $('#sidebar').classList.remove('open'); $('#overlay').classList.remove('show') }
    function openDrawer() { $('#sidebar').classList.add('open'); $('#overlay').classList.add('show') }
    function initSidebar() {
        $$('.side-item').forEach(b => b.addEventListener('click', () => gotoList(b.dataset.scope)))
        $('#menuToggle').addEventListener('click', () => {
            if ($('#sidebar').classList.contains('open')) closeDrawer(); else openDrawer()
        })
        $('#overlay').addEventListener('click', closeDrawer)
    }

    // ================= 顶栏（搜索 / 登出 / 回顶）=================
    function initTopbar() {
        let kwTimer
        $('#searchInput').addEventListener('input', e => {
            clearTimeout(kwTimer)
            kwTimer = setTimeout(() => { state.keyword = e.target.value.trim(); reset() }, 300)
        })
        $('#logoutBtn').addEventListener('click', async () => {
            try { await fetch('/auth/api/logout', { method: 'POST', credentials: 'same-origin' }) } catch { }
            if (window.XieAuth?.logout) window.XieAuth.logout(); else location.href = '/auth/login.html'
        })
        // 回到顶部
        const back = $('#backToTop')
        window.addEventListener('scroll', () => {
            back.classList.toggle('hidden', window.scrollY < 400)
        }, { passive: true })
        back.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))
    }

    // ================= 列表 =================
    function reset() {
        state.page = 0; state.list = []; state.hasMore = true; state.total = 0
        $('#grid').innerHTML = ''
        $('#endMsg').classList.add('hidden')
        $('#empty').classList.add('hidden')
        load()
    }
    async function load() {
        if (state.loading || !state.hasMore) return
        state.loading = true
        $('#loading').classList.remove('hidden')
        const next = state.page + 1
        const params = new URLSearchParams({ scope: state.scope, page: next, pageSize: state.pageSize })
        if (state.keyword) params.set('keyword', state.keyword)
        try {
            const j = await api('/api/media?' + params)
            const newList = j.data.list || []
            state.page = next
            state.total = j.data.total || 0
            state.list = state.list.concat(newList)
            state.hasMore = state.list.length < state.total
            renderAppend(newList)
            $('#endMsg').classList.toggle('hidden', state.hasMore || state.list.length === 0)
            const emptyEl = $('#empty')
            if (state.list.length === 0) {
                emptyEl.classList.remove('hidden')
                emptyEl.textContent = state.scope === 'mine'
                    ? '还没有内容，点击右上"＋ 上传"开始'
                    : (state.scope === 'favorites' ? '还没有收藏，去广场或我的里挑一个吧' : '广场暂时是空的')
            } else emptyEl.classList.add('hidden')
        } catch (e) { toast('加载失败：' + e.message); state.hasMore = false }
        finally { state.loading = false; $('#loading').classList.add('hidden') }
    }
    function renderAppend(items) {
        const grid = $('#grid')
        for (const it of items) grid.appendChild(renderCard(it))
    }
    function renderCard(it) {
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
        if (vCount > 1) meta.push(`<span>${vCount} 视频</span>`)
        if (iCount > 0) meta.push(`<span>${iCount} 图</span>`)
        if (state.scope !== 'mine' && it.ownerName) meta.push(`<span>@${escapeHtml(it.ownerName)}</span>`)
        if (it.category) meta.push(`<span>#${escapeHtml(it.category)}</span>`)
        meta.push(`<span>${fmtDate(it.createdAt)}</span>`)
        if (it.favorited) meta.push(`<span>★</span>`)
        card.innerHTML = `
            <div class="cover-wrap">
                <img class="cover" loading="lazy" alt="" src="${coverUrl(it.id)}">
                ${it.agg && it.agg.durationSec ? `<span class="cover-badge dur">${fmtDur(it.agg.durationSec)}</span>` : ''}
            </div>
            <div class="card-body">
                <div class="card-title" title="${escapeHtml(it.title || '')}">${kindIcon} ${escapeHtml(it.title || '')}</div>
                <div class="card-meta">${meta.join('')}</div>
            </div>`
        card.addEventListener('click', () => gotoDetail(it.id))
        return card
    }

    // ================= 无限滚动 =================
    function initInfiniteScroll() {
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
    }

    // ================= 详情页 =================
    /** 根据内容自动判定浏览模式：全部为视频→'list'（播放器+列表），否则→'grid'（平铺） */
    function computeViewMode(items) {
        if (!items || !items.length) return 'grid'
        return items.every(it => it.mediaType === 'video') ? 'list' : 'grid'
    }
    async function loadDetail(id) {
        $('#detailBody').innerHTML = '<div class="loading">加载中…</div>'
        $('#detailInfo').innerHTML = ''
        $('#detailActions').innerHTML = ''
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
    function renderDetail() {
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
            `<h2 class="title">${escapeHtml(d.title || '')}</h2>`,
            `<div class="meta">`,
            `<span class="badge ${d.visibility}">${d.visibility === 'public' ? '公开' : '私有'}</span>`,
            `<span>${kindLabel}</span>`,
            aggBits.join(''),
            d.category ? `<span>#${escapeHtml(d.category)}</span>` : '',
            d.ownerName ? `<span>@${escapeHtml(d.ownerName)}</span>` : '',
            `<span>${fmtTime(d.createdAt)}</span>`,
            `</div>`,
        ]
        $('#detailInfo').innerHTML = infoBits.join('')

        // 顶部动作按钮（浏览模式切换任何人都可用，故先于权限判断加入）
        const acts = []
        acts.push(`<button class="mini-btn" data-act="view" type="button" title="切换浏览方式">${state.viewMode === 'list' ? '▦ 平铺' : '☰ 列表'}</button>`)
        acts.push(`<button class="mini-btn fav ${d.favorited ? 'fav-active' : ''}" data-act="fav" type="button">${d.favorited ? '★ 已收藏' : '☆ 收藏'}</button>`)
        if (canMutate) {
            acts.push(`<button class="mini-btn" data-act="vis" type="button">${d.visibility === 'public' ? '转私有' : '开放到广场'}</button>`)
            acts.push(`<button class="mini-btn" data-act="edit-meta" type="button">编辑信息</button>`)
            acts.push(`<button class="mini-btn" data-act="edit-items" type="button">编辑文件</button>`)
            acts.push(`<button class="mini-btn danger" data-act="del" type="button">删除</button>`)
        }
        $('#detailActions').innerHTML = acts.join('')

        // 主体：按当前浏览模式
        renderDetailBody()

        // 绑定动作
        $('#detailActions').querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', () => handleDetailAction(btn.dataset.act, btn))
        })
        $('#detailBack').onclick = () => gotoList()
    }
    function renderDetailBody() {
        const d = state.detail
        const body = $('#detailBody')
        body.innerHTML = ''
        if (state.itemEditorOpen) {
            body.appendChild(buildItemEditor())
            return
        }
        // list 模式仅在“含至少一个视频”时有意义；纯图片强制用平铺
        if (state.viewMode === 'list' && d.items.some(it => it.mediaType === 'video')) {
            body.appendChild(buildVideoLayout())
        } else {
            body.appendChild(buildAlbumGrid())
        }
    }

    // ---- 列表布局：大播放器 + 播放列表（主要面向含视频的资源）----
    function buildVideoLayout() {
        const d = state.detail
        const wrap = document.createElement('div'); wrap.className = 'video-layout'
        const stage = document.createElement('div'); stage.className = 'video-stage'
        wrap.appendChild(stage)

        const list = document.createElement('div'); list.className = 'video-playlist'
        list.innerHTML = `<header>播放列表 · ${d.items.length} 个</header>`
        const ol = document.createElement('ol')
        d.items.forEach((it, i) => {
            const li = document.createElement('li')
            if (i === state.detailCurrentIdx) li.classList.add('active')
            const m = it.meta
            const tags = []
            if (it.mediaType === 'image') tags.push('图片')
            if (m) {
                if (m.durationSec) tags.push(fmtDur(m.durationSec))
                const rl = resLabel(m); if (rl) tags.push(rl)
                if (m.videoCodec) tags.push(m.videoCodec.toUpperCase())
            }
            tags.push(fmtSize(it.size))
            li.innerHTML = `<span class="idx">${i + 1}</span><span class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span><span class="type-badge">${tags.join(' · ')}</span>`
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
    let lbItems = [], lbIndex = 0, touchStartX = 0
    function openLightbox(items, idx) {
        lbItems = items; lbIndex = idx; renderLb(); openModal('lightbox')
    }
    function renderLb() {
        const stage = $('#lbStage'); stage.innerHTML = ''
        const it = lbItems[lbIndex]; if (!it) { closeModal('lightbox'); return }
        const url = itemUrl(it.id)
        if (it.mediaType === 'video') {
            const v = document.createElement('video'); v.controls = true; v.src = url; v.autoplay = true; v.playsInline = true
            stage.appendChild(v)
        } else {
            const im = document.createElement('img'); im.src = url; im.alt = it.name || ''
            stage.appendChild(im)
        }
        $('#lbCaption').textContent = `${lbIndex + 1} / ${lbItems.length} · ${it.name || ''}` +
            (it.meta && it.meta.durationSec ? ` · ${fmtDur(it.meta.durationSec)}` : '')
    }
    function lbPrev() { if (!lbItems.length) return; lbIndex = (lbIndex - 1 + lbItems.length) % lbItems.length; renderLb() }
    function lbNext() { if (!lbItems.length) return; lbIndex = (lbIndex + 1) % lbItems.length; renderLb() }

    // ---- 详情页动作 ----
    function handleDetailAction(act, btn) {
        const d = state.detail; if (!d) return
        if (act === 'view') { state.viewMode = state.viewMode === 'list' ? 'grid' : 'list'; renderDetail(); return }
        if (act === 'fav') return toggleFav(d, btn)
        if (act === 'vis') return toggleVis(d)
        if (act === 'edit-meta') return openEditMeta()
        if (act === 'edit-items') return toggleItemEditor()
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
            if (btn) {
                btn.classList.toggle('fav-active', d.favorited)
                btn.textContent = d.favorited ? '★ 已收藏' : '☆ 收藏'
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
            renderDetail()
        } catch (e) { toast('操作失败：' + e.message) }
    }
    function openEditMeta() {
        const d = state.detail
        openModal('editModal')
        $('#editTitle').value = d.title || ''
        $('#editCategory').value = d.category || ''
        $('#editSubmit').onclick = async () => {
            try {
                await api(`/api/collections/${d.id}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: $('#editTitle').value, category: $('#editCategory').value }),
                })
                closeModal('editModal'); toast('已保存')
                await loadDetail(d.id)
            } catch (e) { toast('保存失败：' + e.message) }
        }
    }
    function confirmDelete(d) {
        openModal('confirmModal')
        $('#confirmText').textContent = `确定要删除「${d.title || ''}」？此操作不可恢复。`
        $('#confirmOk').onclick = async () => {
            try {
                await api(`/api/collections/${d.id}`, { method: 'DELETE' })
                closeModal('confirmModal'); toast('已删除'); gotoList()
            } catch (e) { toast('删除失败：' + e.message) }
        }
    }

    // ================= item 编辑器（重命名 / 删除 / 排序 / 追加）=================
    function toggleItemEditor() {
        if (state.itemEditorOpen) closeItemEditor()
        else openItemEditor()
    }
    function openItemEditor() {
        const d = state.detail; if (!d) return
        state.itemEditorOpen = true
        state.itemEditor = {}
        d.items.forEach(it => { state.itemEditor[it.id] = { name: it.name, deleted: false } })
        renderDetailBody()
    }
    function closeItemEditor() {
        state.itemEditorOpen = false
        state.itemEditor = null
        state.itemAppending = false
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
            closeItemEditor()
            renderDetail()
        } catch (e) { toast('保存失败：' + e.message) }
    }

    function buildItemEditor() {
        const d = state.detail
        const wrap = document.createElement('div'); wrap.className = 'item-editor'

        const head = document.createElement('div'); head.className = 'item-editor-foot'
        head.innerHTML = `<span class="hint">📝 修改显示名 · 🗑 删除 · ↕ 排序 · 保存后写回服务器</span>`
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
                <img class="thumb" loading="lazy" src="${itemThumbUrl(it.id)}" alt="">
                <input class="name-input" type="text" value="${escapeHtml(st.name ?? '')}" placeholder="${escapeHtml(it.originalName)}" ${st.deleted ? 'disabled' : ''}>
                <span class="media-badge">${mediaTags.join(' · ')}</span>
                <button class="icon-btn" data-act="up" title="上移" ${st.deleted ? 'disabled' : ''}>↑</button>
                <button class="icon-btn" data-act="down" title="下移" ${st.deleted ? 'disabled' : ''}>↓</button>
                ${st.deleted
                    ? `<button class="icon-btn restore" data-act="restore" title="撤销删除">↺</button>`
                    : `<button class="icon-btn danger" data-act="del" title="删除">🗑</button>`}
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
            row.querySelector('[data-act=del]').addEventListener('click', () => {
                const ok = window.confirm(`删除「${st.name || it.originalName}」？保存后不可恢复。`)
                if (!ok) return
                st.deleted = true; rerender()
            })
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
        appendBtn.addEventListener('click', async () => {
            const files = Array.from(appendInput.files || [])
            if (!files.length) return toast('请先选择要追加的文件')
            appendBtn.disabled = true; appendHint.textContent = '上传中…'
            const fd = new FormData()
            for (const f of files) fd.append('files', f)
            try {
                const r = await fetch(`/api/collections/${d.id}/items`, { method: 'POST', body: fd, credentials: 'same-origin' })
                const j = await r.json().catch(() => ({}))
                if (!r.ok || j.success === false) throw new Error(j.message || ('HTTP ' + r.status))
                appendInput.value = ''
                toast('已追加')
                await loadDetail(d.id)
                // 追加后自动回到编辑态方便继续处理
                openItemEditor()
            } catch (e) { toast('追加失败：' + e.message) }
            finally { appendBtn.disabled = false; appendHint.textContent = '' }
        })
        append.appendChild(appendInput); append.appendChild(appendBtn); append.appendChild(appendHint)
        wrap.appendChild(append)

        // 底部：保存 / 取消
        const foot = document.createElement('div'); foot.className = 'item-editor-foot'
        const saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.className = 'primary'
        saveBtn.textContent = '保存'
        saveBtn.addEventListener('click', saveItemEditor)
        const cancelBtn = document.createElement('button'); cancelBtn.type = 'button'; cancelBtn.className = 'ghost'
        cancelBtn.textContent = '取消'
        cancelBtn.addEventListener('click', closeItemEditor)
        foot.appendChild(saveBtn); foot.appendChild(cancelBtn)
        wrap.appendChild(foot)
        return wrap
    }

    // ================= 上传（列表页时可用）=================
    function initUpload() {
        const files = []
        const drop = $('#dropArea'), input = $('#upFiles'), listEl = $('#fileList')
        const bar = $('#upBar'), fill = $('#upBarFill'), prog = $('#upProgress')
        const sepChk = $('#upSeparate')
        // 逐文件状态：每个文件对应一行，行末一个状态 span
        function refreshList() {
            listEl.innerHTML = files.map((f, i) =>
                `<div class="up-row"><span class="up-name">${escapeHtml(f.name)} · ${fmtSize(f.size)}</span>` +
                `<span class="up-status" data-i="${i}">待上传</span></div>`).join('')
        }
        function setStatus(i, text, cls) {
            const el = listEl.querySelector(`.up-status[data-i="${i}"]`)
            if (el) { el.textContent = text; el.className = 'up-status' + (cls ? ' ' + cls : '') }
        }
        function setAllStatus(text, cls) {
            files.forEach((_, i) => setStatus(i, text, cls))
        }
        function setProgress(pct) {
            if (pct == null) { bar.classList.add('hidden'); prog.textContent = ''; return }
            bar.classList.remove('hidden')
            fill.style.width = Math.round(pct * 100) + '%'
            prog.textContent = '上传中 ' + Math.round(pct * 100) + '%'
        }
        function addFiles(fs) { for (const f of fs) files.push(f); refreshList() }
        input.addEventListener('change', () => { addFiles(Array.from(input.files || [])); input.value = '' })
        ;['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag') }))
        ;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag') }))
        drop.addEventListener('drop', e => { if (e.dataTransfer?.files) addFiles(Array.from(e.dataTransfer.files)) })

        $('#uploadBtn').addEventListener('click', () => {
            files.length = 0; refreshList()
            $('#upTitle').value = ''; $('#upCategory').value = ''
            sepChk.checked = false; $('#upTitle').disabled = false
            setProgress(null)
            openModal('uploadModal')
        })
        // 批量模式下每个文件各自建资源，共用标题无意义 → 禁用标题输入
        sepChk.addEventListener('change', () => {
            $('#upTitle').disabled = sepChk.checked
            $('#upTitle').placeholder = sepChk.checked ? '批量模式：各资源使用各文件名' : '留空使用首个文件名'
        })

        $('#upSubmit').addEventListener('click', () => {
            if (!files.length) return toast('请先选择文件')
            const btn = $('#upSubmit'); btn.disabled = true
            if (sepChk.checked) uploadSeparate(btn)
            else uploadCombined(btn)
        })

        // 常规：全部文件归为一个资源，单次请求 + 总进度条
        function uploadCombined(btn) {
            const fd = new FormData()
            if ($('#upTitle').value) fd.append('title', $('#upTitle').value)
            if ($('#upCategory').value) fd.append('category', $('#upCategory').value)
            for (const f of files) fd.append('files', f)
            setAllStatus('上传中', 'doing'); setProgress(0)

            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/upload', true)
            xhr.withCredentials = true
            xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(e.loaded / e.total) }
            xhr.onload = () => {
                let j = null
                try { j = JSON.parse(xhr.responseText) } catch { /* ignore */ }
                const ok = xhr.status >= 200 && xhr.status < 300 && (!j || j.success !== false)
                if (ok) {
                    setProgress(1); setAllStatus('完成', 'done')
                    closeModal('uploadModal'); toast('上传成功')
                    gotoList('mine'); reset()
                } else {
                    setAllStatus('失败', 'fail')
                    prog.textContent = ''
                    toast('上传失败：' + ((j && j.message) || ('HTTP ' + xhr.status)))
                }
                btn.disabled = false
            }
            xhr.onerror = () => {
                setAllStatus('失败', 'fail'); prog.textContent = ''
                toast('上传失败：网络错误'); btn.disabled = false
            }
            xhr.send(fd)
        }

        // 批量模式：逐个文件各发一次 /api/upload，每个文件独立成一个资源；
        // 每行显示各自真实进度，总进度 = (已完成数 + 当前文件比例) / 总数
        function uploadSeparate(btn) {
            const category = $('#upCategory').value
            const total = files.length
            let idx = 0, okCount = 0, failCount = 0
            bar.classList.remove('hidden')
            fill.style.width = '0%'
            prog.textContent = `批量上传 0/${total}`

            const next = () => {
                if (idx >= total) {
                    btn.disabled = false
                    fill.style.width = '100%'
                    prog.textContent = `完成 ${okCount}/${total}` + (failCount ? `，失败 ${failCount}` : '')
                    if (okCount > 0) {
                        toast(okCount === total ? `已上传 ${total} 个资源` : `成功 ${okCount}/${total}，部分失败`)
                        gotoList('mine'); reset()
                    }
                    // 全部成功才关弹层；有失败时保留，便于看清哪行标红后重试
                    if (!failCount) closeModal('uploadModal')
                    return
                }
                const i = idx
                const f = files[i]
                const fd = new FormData()
                if (category) fd.append('category', category)
                fd.append('files', f)
                const xhr = new XMLHttpRequest()
                xhr.open('POST', '/api/upload', true)
                xhr.withCredentials = true
                xhr.upload.onprogress = (e) => {
                    if (!e.lengthComputable) return
                    const p = e.loaded / e.total
                    setStatus(i, Math.round(p * 100) + '%', 'doing')
                    fill.style.width = Math.round(((idx + p) / total) * 100) + '%'
                    prog.textContent = `批量上传 ${idx}/${total} 已完成`
                }
                xhr.onload = () => {
                    let j = null
                    try { j = JSON.parse(xhr.responseText) } catch { /* ignore */ }
                    const ok = xhr.status >= 200 && xhr.status < 300 && (!j || j.success !== false)
                    if (ok) { okCount++; setStatus(i, '完成', 'done') }
                    else { failCount++; setStatus(i, '失败', 'fail') }
                    idx++; next()
                }
                xhr.onerror = () => { failCount++; setStatus(i, '失败', 'fail'); idx++; next() }
                xhr.send(fd)
            }
            next()
        }
    }

    // ================= 弹层通用 =================
    function initModals() {
        document.addEventListener('click', e => {
            const c = e.target.closest('[data-close]'); if (c) { closeModal(c.dataset.close); return }
            const m = e.target.closest('.modal-mask')
            if (m && m.parentElement?.id) closeModal(m.parentElement.id)
        })
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
        lb.addEventListener('touchstart', e => { if (e.touches[0]) touchStartX = e.touches[0].clientX }, { passive: true })
        lb.addEventListener('touchend', e => {
            const t = e.changedTouches[0]; if (!t) return
            const dx = t.clientX - touchStartX
            if (Math.abs(dx) > 60) { if (dx > 0) lbPrev(); else lbNext() }
        })
    }

    // ================= 入口 =================
    document.addEventListener('DOMContentLoaded', async () => {
        await loadUser()
        initSidebar()
        initTopbar()
        initUpload()
        initModals()
        initInfiniteScroll()
        window.addEventListener('hashchange', () => applyRoute(parseHash()))
        applyRoute(parseHash())
    })
})()
