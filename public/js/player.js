// ================= 弹层与播放器暂存 =================
// 移动端/X5类内核会把播放中的 video 提升为独立原生播放器层，凌驾于页面CSS层叠与z-index之上，
// pause()/visibility 均无法拆除该层；故弹层期间将详情页视频元素整体移出文档（移除元素必毁层），
// 关闭弹层后原位插回并恢复进度与播放态
import { $ } from './utils.js'

let stashedPlayer = null
export function stashDetailPlayer() {
    const v = $('#detailBody video'); if (!v || stashedPlayer) return
    stashedPlayer = { el: v, parent: v.parentElement, next: v.nextElementSibling, time: v.currentTime || 0, playing: !v.paused }
    try { v.pause() } catch { }
    v.remove()
}
export function restoreDetailPlayer() {
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
/** 弹层内需要借用被暂存的播放器时（如裁剪弹层内嵌播放）只读取，不转移所有权 */
export const getStashedPlayer = () => stashedPlayer
/** 详情页整体销毁时，随页面丢弃暂存播放器（所有权回归页面） */
export function clearStashedPlayer() { stashedPlayer = null }

export function openModal(id) {
    stashDetailPlayer()
    $('#' + id).classList.remove('hidden'); document.body.style.overflow = 'hidden'
}
export function closeModal(id) {
    $('#' + id).classList.add('hidden'); document.body.style.overflow = ''
    restoreDetailPlayer()
    if (id === 'lightbox') {
        const v = $('#lbStage').querySelector('video'); if (v) try { v.pause() } catch { }
        $('#lbStage').innerHTML = ''
    }
}

// ================= 弹层通用（关闭按钮 / 遮罩点击）=================
// Lightbox 的键盘与手势在 detail 模块 initLightbox() 里绑定（要访问其私有状态）
export function initModalCommon() {
    document.addEventListener('click', e => {
        const c = e.target.closest('[data-close]'); if (c) { closeModal(c.dataset.close); return }
        const m = e.target.closest('.modal-mask')
        if (m && m.parentElement?.id) closeModal(m.parentElement.id)
    })
}
