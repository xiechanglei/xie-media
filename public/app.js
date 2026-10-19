// xie-media 前端交互 v0.4：
// - 列表页卡片仅承担跳转，操作全部集中在详情页；不再按视频/相册分类
// - hash 路由：#/list/<scope> 列表；#/c/<collectionId> 详情
// - 无限滚动使用 IntersectionObserver
// - 详情页：根据内容自动判定浏览模式（全视频=播放器+列表；否则=平铺网格），可手动切换
// - item 支持批量重命名/删除/排序 + 追加；上传显示总进度与逐文件状态
// - 列表多选：桌面底部横栏放动作，移动端改为靠右浮动竖向 dock；动作含合并/公开/私有/送人/删除/收藏/加专辑
// - 专辑：#/list/albums 目录页，#/list/album/<id> 内页；条目只存资源引用，资源改名换封面自动同步
;(function () {
    const state = {
        // 列表
        scope: 'mine',
        page: 0, pageSize: 24, keyword: '',
        total: 0, list: [], hasMore: true, loading: false,
        listDirty: false,        // 详情页发生变更后置 true，返回列表时重新拉取
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
        // 多选合并（仅列表页·我的）
        selectMode: false,
        selected: new Set(),    // Set<String(collectionId)>
        // 专辑：scope='albums' 为目录页，scope='album' + albumId 为内页
        albumId: null,
        albumHead: null,        // 当前专辑头部信息 { title, entryCount, invisibleCount }
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
    function toast(msg, ms, type) {
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
    const fmtTime = (ts) => { try { return new Date(ts).toLocaleString() } catch { return '' } }
    const fmtDate = (ts) => { try { return new Date(ts).toLocaleDateString() } catch { return '' } }
    // 日期精确到分钟：YYYY-MM-DD HH:mm
    const fmtDateTime = (ts) => {
        const d = new Date(ts); if (isNaN(d)) return ''
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    function fmtSize(bytes) {
        if (!bytes) return ''
        const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = bytes
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
        return n.toFixed(i ? 1 : 0) + ' ' + u[i]
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
    }
    // 移动端/X5类内核会把播放中的 video 提升为独立原生播放器层，凌驾于页面CSS层叠与z-index之上，
    // pause()/visibility 均无法拆除该层；故弹层期间将详情页视频元素整体移出文档（移除元素必毁层），
    // 关闭弹层后原位插回并恢复进度与播放态
    let stashedPlayer = null
    function stashDetailPlayer() {
        const v = $('#detailBody video'); if (!v || stashedPlayer) return
        stashedPlayer = { el: v, parent: v.parentElement, next: v.nextElementSibling, time: v.currentTime || 0, playing: !v.paused }
        try { v.pause() } catch { }
        v.remove()
    }
    function restoreDetailPlayer() {
        if (!stashedPlayer) return
        const s = stashedPlayer; stashedPlayer = null
        if (!s.parent || !document.body.contains(s.parent)) return // 主体已被重建，丢弃旧播放器
        const v = s.el
        s.parent.insertBefore(v, s.next)
        const resume = () => {
            try { if (s.time > 0) v.currentTime = s.time } catch { }
            if (s.playing) { const p = v.play(); if (p && p.catch) p.catch(() => { }) }
        }
        if (v.readyState >= 1) resume()
        else v.addEventListener('loadedmetadata', resume, { once: true })
    }
    function openModal(id) {
        stashDetailPlayer()
        $('#' + id).classList.remove('hidden'); document.body.style.overflow = 'hidden'
    }
    function closeModal(id) {
        $('#' + id).classList.add('hidden'); document.body.style.overflow = ''
        restoreDetailPlayer()
        if (id === 'lightbox') {
            const v = $('#lbStage').querySelector('video'); if (v) try { v.pause() } catch { }
            $('#lbStage').innerHTML = ''
        }
    }
    let mediaStamp = 0 // 视频剪切原地替换文件后置时间戳：媒体 URL 拼参数强制绕开浏览器缓存
    const itemUrl = (id) => `/media/items/${id}${mediaStamp ? `?t=${mediaStamp}` : ''}`
    const itemThumbUrl = (id) => `/media/thumbnails/items/${id}${mediaStamp ? `?t=${mediaStamp}` : ''}`
    const coverUrl = (colId) => `/media/thumbnails/collections/${colId}${mediaStamp ? `?t=${mediaStamp}` : ''}`

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
            // 用户卡片：名字 + 首字母头像；管理员额外亮出角色徽章与管理入口
            const name = state.user.username || ''
            $('#userName').textContent = name
            $('#userAvatar').textContent = name.slice(0, 1) || '·'
            if (state.user.role === 'admin') {
                $('#userRole').classList.remove('hidden')
                $('#adminLink').classList.remove('hidden')
            }
        }
    }

    // ================= SVG 图标（线性风 · stroke 跟随 currentColor）=================
    const ICON_PATHS = {
        pencil: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
        heart: '<path d="M20.84 4.66a5.5 5.5 0 0 0-7.78 0L12 5.7l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.79 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
        globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
        lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
        list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
        trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        check: '<polyline points="20 6 9 17 4 12"/>',
        up: '<polyline points="18 15 12 9 6 15"/>',
        down: '<polyline points="6 9 12 15 18 9"/>',
        undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
        grip: '<circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/>',
        play: '<polygon points="5 3 19 12 5 21 5 3"/>',
        scissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
        checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
        info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
        layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    }
    /** filled：爱心等需要“已选中实心”态的图标 */
    function icon(name, size, filled) {
        const s = size || 16
        return `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`
    }

    // ---- 通用拖拽排序：Pointer Events · 鼠标与触屏均可用 ----
    // 要点：指针捕获必须设在“永不被移动”的容器上（捕获目标离开 DOM 会自动释放捕获）；
    // 命中判断用行矩形比对 Y 坐标；被拖行 fixed 脱流成浮卡跟随指针，其余行用 FLIP 平滑让位，
    // 松手后浮卡飞回槽位再提交。鼠标/笔：按住行任意非交互区即可拖；触屏：仅从把手起步。
    function attachDragSort({ container, rowSel, handleSel, disabled, onReorder }) {
        container.addEventListener('pointerdown', e => {
            if (disabled && disabled()) return
            const row = e.target.closest(rowSel)
            if (!row || row.dataset.nosort || !container.contains(row)) return
            const fromHandle = !!e.target.closest(handleSel)
            if (!fromHandle) {
                if (e.pointerType === 'touch') return
                if (e.target.closest('input,button,select,textarea,a,label')) return
            }
            e.preventDefault()
            container.setPointerCapture(e.pointerId)
            const sortableRows = () => Array.from(container.children).filter(el => el.matches(rowSel) && el !== row && !el.dataset.nosort)
            // FLIP：先记旧位置 → 改 DOM → 对位移的行反向 transform 后过渡回 0
            const flip = (mutate) => {
                const rows = sortableRows()
                // 先清掉未播完的让位动画，避免残留 transform 污染本次位置测量
                rows.forEach(el => { el.style.transition = 'none'; el.style.transform = '' })
                const first = new Map(rows.map(el => [el, el.getBoundingClientRect().top]))
                mutate()
                rows.forEach(el => {
                    const dy = first.get(el) - el.getBoundingClientRect().top
                    if (Math.abs(dy) < 1) return
                    el.style.transition = 'none'
                    el.style.transform = `translateY(${dy}px)`
                    requestAnimationFrame(() => {
                        el.style.transition = 'transform .18s ease'
                        el.style.transform = ''
                    })
                })
            }
            const sr = row.getBoundingClientRect()
            const offX = e.clientX - sr.left
            const offY = e.clientY - sr.top
            row.style.width = sr.width + 'px'
            row.style.left = sr.left + 'px'
            row.style.top = sr.top + 'px'
            flip(() => row.classList.add('is-dragging')) // 脱流抬起，其余行平滑闭合
            let moved = false
            const insert = (refChild) => { moved = true; flip(() => container.insertBefore(row, refChild)) }
            const onMove = ev => {
                row.style.left = (ev.clientX - offX) + 'px'
                row.style.top = (ev.clientY - offY) + 'px'
                const y = ev.clientY
                const rows = sortableRows()
                for (const target of rows) {
                    const r = target.getBoundingClientRect()
                    if (y < r.top || y > r.bottom) continue
                    const before = y < r.top + r.height / 2
                    if (before ? target.previousElementSibling === row : target.nextElementSibling === row) return
                    insert(before ? target : target.nextElementSibling)
                    return
                }
                if (rows.length) {
                    if (y < rows[0].getBoundingClientRect().top) {
                        if (container.firstElementChild !== row) insert(rows[0])
                    } else if (y > rows[rows.length - 1].getBoundingClientRect().bottom) {
                        if (container.lastElementChild !== row) { moved = true; flip(() => container.appendChild(row)) }
                    }
                }
            }
            const finish = () => {
                container.removeEventListener('pointermove', onMove)
                const commit = () => onReorder(Array.from(container.children).filter(el => el.matches(rowSel)))
                if (!moved) { row.classList.remove('is-dragging'); row.style.cssText = ''; return }
                // 浮卡飞回槽位：去掉 fixed 后行已在最终位置，从浮动视觉位置 FLIP 过渡回去
                const floatTop = row.getBoundingClientRect().top
                row.classList.remove('is-dragging')
                row.style.cssText = ''
                const dy = floatTop - row.getBoundingClientRect().top
                if (Math.abs(dy) > 1) {
                    row.style.transition = 'none'
                    row.style.transform = `translateY(${dy}px)`
                    requestAnimationFrame(() => {
                        row.style.transition = 'transform .2s ease'
                        row.style.transform = ''
                    })
                    setTimeout(() => { row.style.transition = ''; row.style.transform = ''; commit() }, 210)
                } else commit()
            }
            container.addEventListener('pointermove', onMove)
            container.addEventListener('pointerup', finish, { once: true })
            container.addEventListener('pointercancel', finish, { once: true })
        })
    }

    // ================= 路由 =================
    function parseHash() {
        const h = (location.hash || '').replace(/^#/, '')
        if (!h || h === '/') return { view: 'list', scope: 'mine' }
        let m = h.match(/^\/c\/([0-9a-fA-F-]+)$/)
        if (m) return { view: 'detail', id: m[1] }
        // 专辑内页必须先试：后面的 (mine|plaza|favorites|albums)? 对 "album/<id>" 会匹配空串，误当成无 scope
        m = h.match(/^\/list\/album\/([0-9a-fA-F-]+)/)
        if (m) return { view: 'list', scope: 'album', albumId: m[1] }
        m = h.match(/^\/list\/(mine|plaza|favorites|albums)?/)
        if (m) return { view: 'list', scope: m[1] || state.scope || 'mine' }
        return { view: 'list', scope: state.scope }
    }
    function buildListHash(scope, albumId) {
        if (scope === 'album') return `#/list/album/${albumId || state.albumId}`
        return `#/list/${scope || state.scope}`
    }
    /** 离开详情页时销毁播放区：仅 hidden 不会暂停 video，移动端会在后台继续出声 */
    function stopDetailPlayback() {
        $$('#detailBody video').forEach(v => { try { v.pause(); v.removeAttribute('src'); v.load() } catch { } })
        $('#detailBody').innerHTML = ''
        stashedPlayer = null // 暂存的播放器随页面销毁一起丢弃
    }
    function applyRoute(route) {
        if (route.view === 'detail') {
            if (state.selectMode) exitSelectMode(false) // 进详情前先退出多选态
            state.view = 'detail'
            document.body.classList.add('detail-mode') // 详情为沉浸模式：隐藏侧栏与汉堡，顶栏亮出用户胶囊
            if (!$('#detailView').classList.contains('hidden')) stopDetailPlayback() // 详情 A → 详情 B 也先销毁旧播放器
            $('#listView').classList.add('hidden')
            $('#detailView').classList.remove('hidden')
            hideTopbarListOnly()
            syncSelectUI() // 详情页需隐藏“选择”按钮（state.view 已置为 detail）
            loadDetail(route.id)
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
            $('#listView').classList.remove('hidden')
            showTopbarListOnly()
            syncSidebarActive()
            syncUploadBtnVisible()
            syncSelectUI()
            if (scopeChanged || state.listDirty || state.list.length === 0) { state.listDirty = false; reset() }
            else renderAlbumHead() // 同专辑返回：不重拉，但横幅要随 scope 切换回到正确显示状态
        }
    }
    function gotoList(scope, albumId) {
        const target = buildListHash(scope || state.scope, albumId)
        if (location.hash === target) applyRoute(parseHash()); else location.hash = target
    }
    /** 详情打开方式：桌面端新标签页（列表标签页的数据与滚动位置原封不动保留），
     *  移动端沿用页内 hash 路由（手机上新标签体验差，列表变更由就地修补兑底） */
    function gotoDetail(id) {
        const hash = '#/c/' + id
        if (window.matchMedia('(max-width: 768px)').matches) { location.hash = hash; return }
        window.open(location.pathname + location.search + hash, '_blank')
    }
    function hideTopbarListOnly() {
        $('#searchInput').classList.add('hidden')
        $('#uploadBtn').classList.add('hidden')
        // 详情为无顶栏沉浸模式（detail-mode 下顶栏整体隐藏），不再提供页内返回按钮：
        // 桌面端在新标签页打开、关标签即回；移动端同页路由用浏览器返回
    }
    function showTopbarListOnly() {
        $('#searchInput').classList.remove('hidden')
        syncUploadBtnVisible()
    }

    // ================= 主题（深色/浅色）=================
    // 首帧主题由 views/index.html 头部内联脚本提前写入 data-theme，这里只负责切换与持久化
    function initTheme() {
        const btn = $('#themeToggle'); if (!btn) return
        btn.addEventListener('click', () => {
            const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
            document.documentElement.dataset.theme = next
            try { localStorage.setItem('xm-theme', next) } catch { }
        })
    }

    // ================= 跨标签页 / 视图间列表同步 =================
    // 详情在新标签页操作后，通过 BroadcastChannel 把变更实时应用到列表标签页；
    // 不支持 BC 的老内核降级为 localStorage + storage 事件（同样不回流发送页）
    const listBC = 'BroadcastChannel' in window ? new BroadcastChannel('xm-list-sync') : null
    function notifyList(msg) {
        if (listBC) { listBC.postMessage(msg); return }
        try { localStorage.setItem('xm-list-sync', JSON.stringify(Object.assign({ _t: Date.now() }, msg))) } catch { }
    }
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
    function applyFavChange(id, fv) {
        if (state.scope === 'favorites' && !fv) removeItemFromList(id)
        else syncCardFav(id, fv)
    }
    /** 可见性变更：广场只显示公开项，转私有即退出广场列表 */
    function applyVisChange(id, vis) {
        if (state.scope === 'plaza' && vis !== 'public') removeItemFromList(id)
        else syncCardVis(id, vis)
    }
    let pendingDirty = false // 列表页隐藏时收到“结构变更”，推迟到切回前台再重拉
    function initListSync() {
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

    // ================= 侧栏 / 抽屉 =================
    function syncSidebarActive() {
        // 专辑内页的 scope 是 'album'，侧栏无此项：高亮到“专辑”入口上
        const nav = state.scope === 'album' ? 'albums' : state.scope
        $$('.side-item').forEach(x => x.classList.toggle('active', x.dataset.scope === nav))
    }
    function syncUploadBtnVisible() {
        const inList = state.view === 'list'
        $('#uploadBtn').classList.toggle('hidden', state.scope !== 'mine' || !inList || state.selectMode)
        // 新建专辑只在专辑目录页提供；进册后的重命名/删除入口在页内横幅上
        $('#newAlbumBtn').classList.toggle('hidden', state.scope !== 'albums' || !inList || state.selectMode)
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
    async function doLogout() {
        try { await fetch('/auth/api/logout', { method: 'POST', credentials: 'same-origin' }) } catch { }
        if (window.XieAuth?.logout) window.XieAuth.logout(); else location.href = '/auth/login.html'
    }
    function initTopbar() {
        let kwTimer
        $('#searchInput').addEventListener('input', e => {
            clearTimeout(kwTimer)
            kwTimer = setTimeout(() => { state.keyword = e.target.value.trim(); reset() }, 300)
        })
        $('#logoutBtn').addEventListener('click', doLogout)
        // 回到顶部
        const back = $('#backToTop')
        window.addEventListener('scroll', () => {
            back.classList.toggle('hidden', window.scrollY < 400)
        }, { passive: true })
        back.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))
    }

    // ================= 列表 =================
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
    function syncEmptyState() {
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
    function fillViewport() {
        if (state.view !== 'list' || state.loading || !state.hasMore) return
        const r = $('#sentinel').getBoundingClientRect()
        if (r.top < window.innerHeight + 400) load()
    }
    function reset() {
        state.page = 0; state.list = []; state.hasMore = true; state.total = 0
        showSkeleton()
        $('#endMsg').classList.add('hidden')
        $('#empty').classList.add('hidden')
        load()
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
    async function load() {
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
        finally { state.loading = false; clearSkeleton(); $('#loading').classList.add('hidden'); requestAnimationFrame(fillViewport) }
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
    function renderAlbumHead() {
        const bar = $('#albumBanner'), h = state.albumHead
        if (state.scope !== 'album' || !h) { bar.classList.add('hidden'); return }
        bar.classList.remove('hidden')
        $('#albumTitle').textContent = h.title || '专辑'
        const bits = [`共 ${h.entryCount} 个资源`]
        if (h.invisibleCount) bits.push(`${h.invisibleCount} 个因他人设为私有暂不可见`)
        if (state.keyword) bits.push(`搜索“${state.keyword}”命中 ${state.total} 个`)
        $('#albumSub').textContent = bits.join(' · ')
    }
    function renderCard(it) {
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

    // ================= 多选批量（合并 / 公开 / 私有 / 送人 / 删除 / 收藏）=================
    /** 重绘整个当前列表网格（根据 selectMode 决定卡片行为）*/
    function rerenderGrid() {
        const grid = $('#grid')
        grid.innerHTML = ''
        for (const it of state.list) grid.appendChild(renderCard(it))
    }
    /** 同步选择相关按钮/操作栏可见性 */
    function syncSelectUI() {
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
    function updateSelectBar() {
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
    function exitSelectMode(rerender = true) {
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
    function clearSelectionMarks() {
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
    function selectedIdsInOrder() {
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
    function initSelection() {
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
    function applyBatchResult(op, okIds) {
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

    // ---- 专辑：加入 / 移出 / 新建 / 重命名 / 删除 ----
    let albumModalIds = []      // 当前弹层要处理的资源 id（多选或详情页单个）
    let albumFormMode = 'create', albumFormId = null
    const jsonPost = (body) => ({
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    /**
     * 打开“加入专辑”弹层。ids 不传取当前多选结果，详情页传单个资源 id。
     * 一次只选一个目标专辑（radio），“新建专辑并加入”是另一条路径，不在一次提交里混两套动作。
     */
    async function openAlbumModal(ids) {
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
    async function doAddToAlbum() {
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
    async function removeSelectedFromAlbum() {
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
    function openAlbumForm(mode, album) {
        albumFormMode = mode
        albumFormId = album ? album.id : null
        $('#albumFormTitle').textContent = mode === 'rename' ? '重命名专辑' : '新建专辑'
        $('#albumFormName').value = mode === 'rename' ? (album.title || '') : ''
        openModal('albumFormModal')
        $('#albumFormName').focus()
    }
    async function submitAlbumForm() {
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
    function confirmDeleteAlbum() {
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
        // 窗口拉大时哨兵可能本就可见但不会发生状态变化，随 resize 主动补位
        window.addEventListener('resize', () => requestAnimationFrame(fillViewport))
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
    function renderDetailBody() {
        const d = state.detail
        const body = $('#detailBody')
        // 清空 DOM 前先暂停旧播放器：销毁即停，防移动端鬼影视频层继续播放盖住弹层
        const oldV = body.querySelector('video')
        if (oldV && !oldV.paused) { try { oldV.pause() } catch { } }
        body.innerHTML = ''
        const canMutate = state.user && (d.ownerId === state.user.id || state.user.role === 'admin')
        // 文件列表上方操作条：编辑态只留“完成编辑”，浏览态放切换浏览 + 所有者操作
        const btns = []
        if (canMutate) {
            btns.push(`<button class="mini-btn" data-act="edit-items" type="button">${icon(state.itemEditorOpen ? 'check' : 'pencil', 13)} ${state.itemEditorOpen ? '完成编辑' : '编辑文件'}</button>`)
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

    // ---- 详情页动作 ----
    function handleDetailAction(act, btn) {
        const d = state.detail; if (!d) return
        if (act === 'view') { state.viewMode = state.viewMode === 'list' ? 'grid' : 'list'; renderDetail(); return }
        if (act === 'fav') return toggleFav(d, btn)
        if (act === 'vis') return toggleVis(d)
        if (act === 'edit-meta') return openEditMeta()
        if (act === 'edit-items') return toggleItemEditor()
        if (act === 'album') return openAlbumModal([d.id])
        if (act === 'trim') return openTrimModal()
        if (act === 'del') return confirmDelete(d)
    }
    /** 详情页操作后标记列表脏（同页路由返回时重拉），并通知其它列表标签页；
     *  仅“难以局部模拟”的变更用（元信息/文件增删）；收藏/可见性/删除走就地修补，不经过这里 */
    function markListDirty() { state.listDirty = true; notifyList({ type: 'dirty' }) }
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
        const v = stashedPlayer ? stashedPlayer.el : null
        const box = $('#trimPlayer')
        box.innerHTML = ''
        box.classList.toggle('hidden', !v)
        if (v) box.appendChild(v)
        const playhead = () => (v && Number.isFinite(v.currentTime)) ? v.currentTime : 0
        const dur = (it.meta && it.meta.durationSec) || 0
        const atEl = $('#trimAt')
        $('#trimSummary').textContent = `${it.name || ''}${dur ? ` · 时长 ${fmtDur(dur)}` : ''}`
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
        $('#trimUsePlayhead').onclick = () => { atEl.value = fmtClock(playhead()); renderHint() }
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
            btn.disabled = true; btn.textContent = '裁剪中…'
            try {
                const j = await api(`/api/collections/${d.id}/items/${it.id}/trim`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cutAt: t, keep }),
                })
                if (j && j.data && Array.isArray(j.data.items)) { d.items = j.data.items; d.itemCount = d.items.length }
                mediaStamp = Date.now() // 文件已原地替换：媒体 URL 加时间戳绕开浏览器缓存
                markListDirty()        // 时长/体积变了，列表卡片聚合信息也要重拉
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
    /** 删除成功后同步当前列表：移除数据项与 DOM 卡片，避免返回后残留 */
    function removeItemFromList(id) {
        state.list = state.list.filter(x => String(x.id) !== String(id))
        state.total = Math.max(0, (state.total || 1) - 1)
        const el = $(`#grid .card[data-id="${id}"]`)
        if (el) el.remove()
        const emptyEl = $('#empty')
        if (state.list.length === 0) { emptyEl.classList.remove('hidden'); emptyEl.textContent = '内容已全部删除' }
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
            markListDirty() // 文件数量/封面可能变化
            closeItemEditor()
            renderDetail()
        } catch (e) { toast('保存失败：' + e.message) }
    }

    function buildItemEditor() {
        const d = state.detail
        const wrap = document.createElement('div'); wrap.className = 'item-editor'

        const head = document.createElement('div'); head.className = 'item-editor-foot'
        head.innerHTML = `<span class="hint">修改显示名 · 删除 · 按住左侧把手拖动排序（或用上下按钮）· 保存后写回服务器</span>`
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
                markListDirty() // 文件数量/封面变了
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
        // 与 files 同下标的上传结果：'' 待上传 | 'done' 成功 | 'fail' 失败。
        // 批量模式靠它实现“只重试失败项”：已成功的文件再传一遍会重复建资源（后端 /api/upload 无幂等）
        const results = []
        const drop = $('#dropArea'), input = $('#upFiles'), listEl = $('#fileList')
        const bar = $('#upBar'), fill = $('#upBarFill'), prog = $('#upProgress')
        const sepChk = $('#upSeparate')
        let submitting = false // 上传进行中：锁定拖拽排序，避免索引错位
        // 逐文件状态：每个文件对应一行，行末一个状态 span
        const statusView = (r) => (r === 'done' ? ['完成', 'done'] : r === 'fail' ? ['失败', 'fail'] : ['待上传', ''])
        // 重绘时按 results 回显状态，不然 addFiles / 拖拽排序会把已成功的行抹回“待上传”
        function refreshList() {
            listEl.innerHTML = files.map((f, i) => {
                const [text, cls] = statusView(results[i])
                return `<div class="up-row" data-i="${i}"><span class="up-handle">${icon('grip', 14, true)}</span><span class="up-name">${escapeHtml(f.name)} · ${fmtSize(f.size)}</span>` +
                    `<span class="up-status${cls ? ' ' + cls : ''}" data-i="${i}">${text}</span></div>`
            }).join('')
        }
        function setStatus(i, text, cls) {
            const el = listEl.querySelector(`.up-status[data-i="${i}"]`)
            if (el) { el.textContent = text; el.className = 'up-status' + (cls ? ' ' + cls : '') }
            // “上传中”不能清空原结果，否则重试时不知道哪些已经传成过
            if (cls === 'done' || cls === 'fail') results[i] = cls === 'done' ? 'done' : 'fail'
            if (text === '待上传' && !cls) results[i] = ''
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
        const todoIdxs = () => files.map((_, i) => i).filter(i => results[i] !== 'done')
        const doneCount = () => results.filter(r => r === 'done').length
        // 部分成功后按钮直说“只传未成功的”，免得用户以为会全量重传
        // 统计的是“未成功”而非“失败”：重试前又拖进来的新文件也在本轮范围内
        function syncSubmitLabel() {
            const todo = todoIdxs().length, done = doneCount()
            $('#upSubmit').textContent = sepChk.checked && todo && done ? `重试未成功的 ${todo} 个` : '上传'
        }
        function addFiles(fs) {
            for (const f of fs) { files.push(f); results.push('') }
            refreshList(); syncSubmitLabel()
        }
        // 提交前可拖拽调整文件顺序 → items 按此顺序入库（首个文件决定封面）
        attachDragSort({
            container: listEl,
            rowSel: '.up-row',
            handleSel: '.up-handle',
            disabled: () => submitting,
            onReorder: rows => {
                const byIdx = new Map(files.map((f, i) => [i, { f, r: results[i] || '' }]))
                files.length = 0; results.length = 0
                for (const row of rows) { const e = byIdx.get(Number(row.dataset.i)); files.push(e.f); results.push(e.r) }
                refreshList(); syncSubmitLabel()
            },
        })
        input.addEventListener('change', () => { addFiles(Array.from(input.files || [])); input.value = '' })
        ;['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag') }))
        ;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag') }))
        drop.addEventListener('drop', e => { if (e.dataTransfer?.files) addFiles(Array.from(e.dataTransfer.files)) })

        $('#uploadBtn').addEventListener('click', () => {
            files.length = 0; results.length = 0; refreshList()
            $('#upTitle').value = ''; $('#upCategory').value = ''
            sepChk.checked = false; $('#upTitle').disabled = false
            setProgress(null); syncSubmitLabel()
            openModal('uploadModal')
        })
        // 批量模式下每个文件各自建资源，共用标题无意义 → 禁用标题输入
        sepChk.addEventListener('change', () => {
            $('#upTitle').disabled = sepChk.checked
            $('#upTitle').placeholder = sepChk.checked ? '批量模式：各资源使用各文件名' : '留空使用首个文件名'
            syncSubmitLabel()
        })

        $('#upSubmit').addEventListener('click', () => {
            if (!files.length) return toast('请先选择文件')
            const btn = $('#upSubmit'); btn.disabled = true; submitting = true
            if (sepChk.checked) uploadSeparate(btn)
            else uploadCombined(btn)
        })

        // 常规：全部文件归为一个资源，单次请求 + 总进度条（一个整体，不沿用批量模式的重试记忆）
        function uploadCombined(btn) {
            files.forEach((_, i) => { results[i] = '' })
            const fd = new FormData()
            if ($('#upTitle').value) fd.append('title', $('#upTitle').value)
            if ($('#upCategory').value) fd.append('category', $('#upCategory').value)
            for (const f of files) fd.append('files', f)
            setAllStatus('上传中', 'doing'); setProgress(0)
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/upload', true)
            xhr.withCredentials = true
            xhr.upload.onprogress = (e) => {
                if (!e.lengthComputable) return
                const p = e.loaded / e.total
                setProgress(p)
                // 字节传完后服务端还要算 MD5/落盘/探元数据，明确告知用户在等后端
                if (p >= 1) prog.textContent = '上传完成，服务器处理中…'
            }
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
                submitting = false
            }
            xhr.onerror = () => {
                setAllStatus('失败', 'fail'); prog.textContent = ''
                toast('上传失败：网络错误'); btn.disabled = false; submitting = false
            }
            xhr.send(fd)
        }

        // 批量模式：逐个文件各发一次 /api/upload，每个文件独立成一个资源；
        // 只跑未成功的行（已成功的再传一遍会重复建资源），失败行保留在列表里可反复重试；
        // 每行显示各自真实进度，总进度 = (本轮已完成 + 当前文件比例) / 本轮待传数
        function uploadSeparate(btn) {
            const todo = todoIdxs()
            if (!todo.length) {
                btn.disabled = false; submitting = false
                return toast(doneCount() ? '全部文件都已上传成功' : '请先选择文件')
            }
            const category = $('#upCategory').value
            const total = todo.length
            const retried = doneCount() > 0 // 上一轮已有成功项：本轮是重试而非首次全量
            let k = 0, okCount = 0, failCount = 0
            todo.forEach(i => setStatus(i, '待上传', ''))
            bar.classList.remove('hidden')
            fill.style.width = '0%'
            const verb = retried ? '重试上传' : '批量上传'
            prog.textContent = `${verb} 0/${total}`

            const next = () => {
                if (k >= total) {
                    btn.disabled = false; submitting = false
                    fill.style.width = '100%'
                    prog.textContent = `本次完成 ${okCount}/${total}` + (failCount ? `，失败 ${failCount}` : '')
                    if (okCount > 0) {
                        toast(okCount === total
                            ? (retried ? `已重试成功 ${total} 个资源` : `已上传 ${total} 个资源`)
                            : `本次成功 ${okCount}/${total}，仍有失败`)
                        gotoList('mine'); reset()
                    }
                    // 整张列表都成功才关弹层；仍有失败就留着，便于看清哪行标红后继续重试
                    if (!todoIdxs().length) closeModal('uploadModal')
                    syncSubmitLabel()
                    return
                }
                const i = todo[k]
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
                    setStatus(i, p >= 1 ? '服务器处理中…' : Math.round(p * 100) + '%', 'doing')
                    fill.style.width = Math.round(((k + Math.min(p, 1)) / total) * 100) + '%'
                    prog.textContent = p >= 1 ? `${verb} ${k}/${total} 已完成，服务器处理中…` : `${verb} ${k}/${total} 已完成`
                }
                xhr.onload = () => {
                    let j = null
                    try { j = JSON.parse(xhr.responseText) } catch { /* ignore */ }
                    const ok = xhr.status >= 200 && xhr.status < 300 && (!j || j.success !== false)
                    if (ok) { okCount++; setStatus(i, '完成', 'done') }
                    else { failCount++; setStatus(i, '失败', 'fail') }
                    k++; next()
                }
                xhr.onerror = () => { failCount++; setStatus(i, '失败', 'fail'); k++; next() }
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
        // Lightbox 手势：移动端左右滑动切换，带跟手拖拽反馈（水平意图才拦截，不影响纵向滚动/播放控件）
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

    // ================= 入口 =================
    document.addEventListener('DOMContentLoaded', async () => {
        initTheme()
        initListSync()
        await loadUser()
        initSidebar()
        initTopbar()
        initUpload()
        initSelection()
        initModals()
        initInfiniteScroll()
        window.addEventListener('hashchange', () => applyRoute(parseHash()))
        applyRoute(parseHash())
    })
})()
