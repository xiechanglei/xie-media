// xie-media 前端交互入口（ES Module）：
// - 列表页卡片仅承担跳转，操作全部集中在详情页；不再按视频/相册分类
// - hash 路由：#/list/<scope> 列表；#/c/<collectionId> 详情；#/offline 离线下载
// - 代码按功能拆分在 js/ 下：state 共享状态 · utils 基础工具 · icons 图标 · player 弹层/播放器暂存 ·
//   drag-sort 拖拽排序 · chrome 侧栏顶栏主题 · router 路由 · list 列表 · list-sync 跨标签页同步 ·
//   selection 多选批量 · albums 专辑 · detail 详情页 · item-editor 文件编辑器 · upload 上传 · offline 离线下载
import { initTheme, loadUser, initSidebar, initTopbar } from './js/chrome.js'
import { initListSync } from './js/list-sync.js'
import { initInfiniteScroll } from './js/list.js'
import { initSelection } from './js/selection.js'
import { initUpload } from './js/upload.js'
import { initModalCommon } from './js/player.js'
import { initLightbox } from './js/detail.js'
import { checkOfflineStatus, initOffline } from './js/offline.js'
import { parseHash, applyRoute } from './js/router.js'

document.addEventListener('DOMContentLoaded', async () => {
    initTheme()
    initListSync()
    await loadUser()
    initSidebar()
    initTopbar()
    initUpload()
    initSelection()
    initModalCommon()
    initLightbox()
    initInfiniteScroll()
    await checkOfflineStatus()
    initOffline()
    window.addEventListener('hashchange', () => applyRoute(parseHash()))
    applyRoute(parseHash())
})
