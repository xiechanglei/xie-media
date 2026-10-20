// ================= 页面外框：用户卡片 / 主题 / 侧栏抽屉 / 顶栏 =================
import { state } from './state.js'
import { $, $$, api } from './utils.js'
import { gotoList } from './router.js'
import { reset } from './list.js'

// ================= 用户 =================
export async function loadUser() {
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

// ================= 主题（深色/浅色）=================
// 首帧主题由 views/index.html 头部内联脚本提前写入 data-theme，这里只负责切换与持久化
export function initTheme() {
    const btn = $('#themeToggle'); if (!btn) return
    btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
        document.documentElement.dataset.theme = next
        try { localStorage.setItem('xm-theme', next) } catch { }
    })
}

// ================= 侧栏 / 抽屉 =================
export function syncSidebarActive() {
    // 专辑内页的 scope 是 'album'，侧栏无此项：高亮到“专辑”入口上；离线下载按 view 高亮
    if (state.view === 'offline') {
        $$('.side-item').forEach(x => x.classList.toggle('active', x.dataset.scope === 'offline'))
        return
    }
    const nav = state.scope === 'album' ? 'albums' : state.scope
    $$('.side-item').forEach(x => x.classList.toggle('active', x.dataset.scope === nav))
}
export function syncUploadBtnVisible() {
    const inList = state.view === 'list'
    $('#uploadBtn').classList.toggle('hidden', state.scope !== 'mine' || !inList || state.selectMode)
    // 新建专辑只在专辑目录页提供；进册后的重命名/删除入口在页内横幅上
    $('#newAlbumBtn').classList.toggle('hidden', state.scope !== 'albums' || !inList || state.selectMode)
}
function closeDrawer() { $('#sidebar').classList.remove('open'); $('#overlay').classList.remove('show') }
function openDrawer() { $('#sidebar').classList.add('open'); $('#overlay').classList.add('show') }
export function initSidebar() {
    $$('.side-item').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.scope === 'offline') { location.hash = '#/offline'; return }
        gotoList(b.dataset.scope)
    }))
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
export function initTopbar() {
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
export function hideTopbarListOnly() {
    $('#searchInput').classList.add('hidden')
    $('#uploadBtn').classList.add('hidden')
    // 新专辑按钮与上传按钮同属列表态专属，进离线/详情前必须一并收起（专辑页亮起后进离线会残留）
    $('#newAlbumBtn').classList.add('hidden')
    // 列表态按钮全部收起后顶栏已无内容：桌面端整体隐藏；移动端汉堡菜单还在顶栏里，必须保留
    $('.topbar').classList.toggle('hidden', !window.matchMedia('(max-width: 768px)').matches)
    // 详情为无顶栏沉浸模式（detail-mode 下顶栏整体隐藏），不再提供页内返回按钮：
    // 桌面端在新标签页打开、关标签即回；移动端同页路由用浏览器返回
}
export function showTopbarListOnly() {
    $('.topbar').classList.remove('hidden')
    $('#searchInput').classList.remove('hidden')
    syncUploadBtnVisible()
}
