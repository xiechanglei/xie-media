// ---- 通用拖拽排序：Pointer Events · 鼠标与触屏均可用 ----
// 要点：指针捕获必须设在“永不被移动”的容器上（捕获目标离开 DOM 会自动释放捕获）；
// 命中判断用行矩形比对 Y 坐标；被拖行 fixed 脱流成浮卡跟随指针，其余行用 FLIP 平滑让位，
// 松手后浮卡飞回槽位再提交。鼠标/笔：按住行任意非交互区即可拖；触屏：仅从把手起步。
export function attachDragSort({ container, rowSel, handleSel, disabled, onReorder }) {
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
