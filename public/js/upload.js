// ================= 上传（列表页时可用）=================
import { $, toast, escapeHtml, fmtSize, createSpeedMeter, fmtSpeed } from './utils.js'
import { icon } from './icons.js'
import { attachDragSort } from './drag-sort.js'
import { openModal, closeModal } from './player.js'
import { gotoList } from './router.js'
import { reset } from './list.js'

export function initUpload() {
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
        const meter = createSpeedMeter()
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/upload', true)
        xhr.withCredentials = true
        xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return
            const p = e.loaded / e.total
            setProgress(p)
            // 字节传完后服务端还要算 MD5/落盘/探元数据，明确告知用户在等后端（此时已无传输速度可显示）
            if (p >= 1) prog.textContent = '上传完成，服务器处理中…'
            else { const sp = fmtSpeed(meter.speed(e.loaded)); if (sp) prog.textContent += ` · ${sp}` }
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
            const meter = createSpeedMeter() // 每个文件单独测速：串行发送，同时只有一个在传
            xhr.upload.onprogress = (e) => {
                if (!e.lengthComputable) return
                const p = e.loaded / e.total
                setStatus(i, p >= 1 ? '服务器处理中…' : Math.round(p * 100) + '%', 'doing')
                fill.style.width = Math.round(((k + Math.min(p, 1)) / total) * 100) + '%'
                const sp = fmtSpeed(meter.speed(e.loaded))
                prog.textContent = p >= 1
                    ? `${verb} ${k}/${total} 已完成，服务器处理中…`
                    : `${verb} ${k}/${total} 已完成${sp ? ` · ${sp}` : ''}`
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
