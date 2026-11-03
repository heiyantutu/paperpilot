/**
 * PaperPilot — browser half.
 *
 * A sidebar entry opens a full-height reading panel in the main column:
 *   - import a paper from pasted text, a local file (PDF/TXT/MD) or a URL
 *   - read it full width with adjustable type size and measure
 *   - translate paragraph by paragraph (or the whole paper) in place
 *   - ask questions in a floating card that lives inside the page,
 *     never a split view
 */
window.__ModuleLoader__.load({
  id: '@local/paperpilot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const PANEL_ID = 'paperpilot'
    const API = '/paperpilot/api'
    const STORAGE_KEY = 'paperpilot.v1'

    const DEFAULT_SETTINGS = {
      fontSize: 19,
      lineHeight: 1.9,
      measure: 74,
      bilingual: false,
      targetLang: 'zh',
    }

    /* ------------------------------------------------------------------ *
     * Persistence
     * ------------------------------------------------------------------ */

    function readStored() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return {}
        const value = JSON.parse(raw)
        return value && typeof value === 'object' ? value : {}
      } catch {
        return {}
      }
    }

    function writeStored(value) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
        return true
      } catch {
        return false
      }
    }

    function readJson(key) {
      try {
        return JSON.parse(localStorage.getItem(key) ?? 'null')
      } catch {
        return null
      }
    }

    function writeJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* quota — non fatal */
      }
    }

    /* ------------------------------------------------------------------ *
     * HTTP + SSE helpers
     * ------------------------------------------------------------------ */

    async function readJsonResponse(response) {
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 300) || `请求失败（HTTP ${response.status}）`)
      }
      if (!response.ok || payload?.error) throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`)
      return payload
    }

    async function postJson(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return readJsonResponse(response)
    }

    async function* readSse(response) {
      if (!response.ok) {
        const text = await response.text()
        let message = text.slice(0, 300)
        try {
          message = JSON.parse(text)?.error ?? message
        } catch {
          /* keep raw */
        }
        throw new Error(message || `请求失败（HTTP ${response.status}）`)
      }
      if (!response.body) throw new Error('当前浏览器不支持流式响应')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') return
            if (!data) continue
            let parsed
            try {
              parsed = JSON.parse(data)
            } catch {
              continue
            }
            if (parsed && parsed.error) throw new Error(parsed.error)
            yield parsed
          }
        }
      }
    }

    function streamTranslate(items, target, signal) {
      return fetch(API + '/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items, target }),
        signal,
      }).then((response) => readSse(response))
    }

    function streamChat(payload, signal) {
      return fetch(API + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      }).then((response) => readSse(response))
    }

    /* ------------------------------------------------------------------ *
     * Text utilities
     * ------------------------------------------------------------------ */

    const HEADING_RE =
      /^(?:(?:chapter|section|part)\s+[\divxlc]+[.:)]?\s*.{0,80}|[\divxlc]+(?:\.[\divxlc]+){0,3}[.)]?\s+[A-Z].{0,80}|(?:abstract|introduction|related work|background|method(?:s|ology)?|approach|experiments?|results?|discussion|conclusion|references|acknowledg(?:e)?ments?|appendix)\b.{0,60})$/i

    function looksLikeHeading(line) {
      const text = line.trim()
      if (text.length < 2 || text.length > 120) return false
      if (/[.。!?！？]$/.test(text)) return false
      if (HEADING_RE.test(text)) return true
      const upper = text.replace(/[^A-Za-z]/g, '')
      if (upper.length >= 4 && text === text.toUpperCase() && /^[A-Z0-9\s\-–—:.(),&/]+$/.test(text)) return true
      if (/^\d+(\.\d+)*\.?\s+\S/.test(text) && text.length <= 90) return true
      return false
    }

    function splitLongBlock(block, maxLen) {
      if (block.length <= maxLen) return [block]
      const pieces = []
      let rest = block
      while (rest.length > maxLen) {
        let cut = -1
        const window = rest.slice(0, maxLen)
        const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('? '), window.lastIndexOf('! '))
        if (stop > maxLen * 0.4) cut = stop + 1
        else cut = window.lastIndexOf(' ')
        if (cut <= 0) cut = maxLen
        pieces.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
      }
      if (rest) pieces.push(rest)
      return pieces
    }

    function textToParagraphs(text) {
      const normalized = String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
      const blocks = normalized.split(/\n{2,}/).flatMap((block) => {
        const trimmed = block.trim()
        if (!trimmed) return []
        if (trimmed.length > 2200) return splitLongBlock(trimmed, 1600)
        return [trimmed]
      })
      const paragraphs = []
      for (const block of blocks) {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
        if (lines.length === 1 && looksLikeHeading(lines[0]) && lines[0].length <= 100) {
          paragraphs.push({ text: lines[0], heading: true })
          continue
        }
        const joined = lines.join(' ').replace(/\s{2,}/g, ' ')
        if (!joined) continue
        if (joined.length <= 100 && looksLikeHeading(joined)) {
          paragraphs.push({ text: joined, heading: true })
          continue
        }
        paragraphs.push({ text: joined, heading: false })
      }
      return paragraphs.map((item, index) => ({ id: 'p' + index, text: item.text, heading: item.heading }))
    }

    function outlineOf(paragraphs) {
      const lines = []
      for (const paragraph of paragraphs) {
        if (paragraph.heading) lines.push('- ' + paragraph.text)
        if (lines.length >= 40) break
      }
      return lines.join('\n')
    }

    function titleOf(paragraphs, fallback) {
      const first = paragraphs.find((paragraph) => !paragraph.heading && paragraph.text.length > 12)
      const heading = paragraphs.find((paragraph) => paragraph.heading && paragraph.text.length > 6)
      const raw = (heading ?? first)?.text ?? fallback ?? '未命名论文'
      const title = raw.split('\n')[0].trim()
      return title.length > 140 ? title.slice(0, 140) + '…' : title
    }

    function compactPaper(paper) {
      if (!paper) return null
      return {
        title: paper.title ?? '',
        outline: paper.outline ?? '',
        paragraphs: (paper.paragraphs ?? []).map((paragraph) => paragraph.text),
      }
    }

    function formatCount(value) {
      return value >= 1000 ? (value / 1000).toFixed(1) + 'k' : String(value)
    }

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */

    const ICON_PATHS = {
      book: [
        'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5v-10Z',
        'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5v-10Z',
      ],
      chat: [
        'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z',
      ],
      translate: [
        'M4 5h10M9 3v2c0 4.5-2 7.5-5 9',
        'M6 11c1.5 2.5 4 4.5 7 5.5',
        'M13 21l4.5-11L22 21',
        'M15 17h5',
      ],
      close: ['M18 6 6 18', 'M6 6l12 12'],
      plus: ['M12 5v14', 'M5 12h14'],
      minus: ['M5 12h14'],
      upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
      link: [
        'M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1L11 5',
        'M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1L13 19',
      ],
      text: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
      send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4 20-7Z'],
      trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5'],
      more: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
      arrowLeft: ['M19 12H5', 'M12 19l-7-7 7-7'],
      spinner: ['M12 3a9 9 0 1 0 9 9'],
      spark: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M5.6 5.6l2.8 2.8', 'M15.6 15.6l2.8 2.8', 'M18.4 5.6l-2.8 2.8', 'M8.4 15.6l-2.8 2.8'],
      globe: [
        'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
        'M3.6 9h16.8',
        'M3.6 15h16.8',
        'M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z',
      ],
    }

    function Icon({ name, size = 18, strokeWidth = 1.8, style }) {
      const paths = ICON_PATHS[name] ?? []
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style,
        },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    /* ------------------------------------------------------------------ *
     * Small controls
     * ------------------------------------------------------------------ */

    function IconButton({ icon, label, onClick, active, disabled, size = 32, title }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'pr-icon-btn' + (active ? ' is-active' : ''),
          onClick,
          disabled,
          title: title ?? label,
          'aria-label': label,
          style: { width: size, height: size },
        },
        h(Icon, { name: icon, size: Math.round(size * 0.56) }),
      )
    }

    function Spinner({ size = 16 }) {
      return h(Icon, { name: 'spinner', size, style: { animation: 'pr-spin 0.9s linear infinite' } })
    }

    /* ------------------------------------------------------------------ *
     * Import surfaces
     * ------------------------------------------------------------------ */

    function EmptyState({ onOpenPaste, onOpenFile, onOpenUrl, busy, status }) {
      const cards = [
        { icon: 'text', title: '粘贴文本', desc: '把论文正文直接贴进来，立即开始阅读', action: onOpenPaste },
        { icon: 'upload', title: '打开文件', desc: '支持 PDF、Markdown、TXT、LaTeX 源文件', action: onOpenFile },
        { icon: 'link', title: '从链接导入', desc: 'arXiv 页面、期刊页或 PDF 直链', action: onOpenUrl },
      ]
      return h(
        'div',
        { className: 'pr-empty' },
        h(
          'div',
          { className: 'pr-empty-inner' },
          h('div', { className: 'pr-empty-mark' }, h(Icon, { name: 'book', size: 34, strokeWidth: 1.5 })),
          h('h1', { className: 'pr-empty-title' }, '沉浸式论文领读'),
          h(
            'p',
            { className: 'pr-empty-sub' },
            '铺满整个页面安静读完一篇论文：逐段翻译、划词追问、悬浮问答都不离开这一页。',
          ),
          h(
            'div',
            { className: 'pr-empty-cards' },
            cards.map((card) =>
              h(
                'button',
                {
                  key: card.title,
                  type: 'button',
                  className: 'pr-empty-card',
                  onClick: card.action,
                  disabled: busy,
                },
                h('span', { className: 'pr-empty-card-icon' }, busy ? h(Spinner, { size: 18 }) : h(Icon, { name: card.icon, size: 20 })),
                h('span', { className: 'pr-empty-card-title' }, card.title),
                h('span', { className: 'pr-empty-card-desc' }, card.desc),
              ),
            ),
          ),
          h(
            'p',
            { className: 'pr-empty-hint' },
            status && status.model
              ? `模型：${status.model} · 翻译与对话由本机 Harness 直接调用`
              : '尚未检测到默认模型：翻译与对话需要在「设置 → 模型」里选择一个默认模型',
          ),
        ),
      )
    }

    function ImportModal({ mode, onClose, onSubmitUrl, onSubmitText, busy, error }) {
      const [url, setUrl] = useState('')
      const [text, setText] = useState('')
      const textareaRef = useRef(null)
      useEffect(() => {
        if (mode === 'paste' && textareaRef.current) textareaRef.current.focus()
      }, [mode])
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      const submit = () => {
        if (mode === 'url') {
          const value = url.trim()
          if (value) onSubmitUrl(value)
        } else {
          const value = text.trim()
          if (value) onSubmitText(value)
        }
      }
      return h(
        'div',
        {
          className: 'pr-modal-mask',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'pr-modal', role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'pr-modal-head' },
            h('span', { className: 'pr-modal-title' }, mode === 'url' ? '从链接导入论文' : '粘贴论文文本'),
            h(IconButton, { icon: 'close', label: '关闭', onClick: onClose }),
          ),
          mode === 'url'
            ? h(
                'div',
                { className: 'pr-modal-body' },
                h('label', { className: 'pr-field-label' }, '论文链接'),
                h('input', {
                  className: 'pr-input',
                  type: 'text',
                  spellCheck: false,
                  placeholder: 'https://arxiv.org/abs/1706.03762 或 PDF 直链',
                  value: url,
                  onChange: (event) => setUrl(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submit()
                  },
                  autoFocus: true,
                }),
                h(
                  'p',
                  { className: 'pr-field-hint' },
                  '支持 arXiv 摘要页 / PDF 直链、OpenReview、ACL Anthology 以及大部分期刊页面。PDF 会在本机提取文本。',
                ),
                error ? h('p', { className: 'pr-error' }, error) : null,
              )
            : h(
                'div',
                { className: 'pr-modal-body' },
                h('label', { className: 'pr-field-label' }, '论文正文'),
                h('textarea', {
                  className: 'pr-textarea',
                  ref: textareaRef,
                  placeholder: '在这里粘贴论文正文：空行分段即可，标题行会自动识别。',
                  value: text,
                  onChange: (event) => setText(event.target.value),
                  spellCheck: false,
                }),
                h('p', { className: 'pr-field-hint' }, `${formatCount(text.length)} 字符 · 空行分段，短标题行会识别为小节标题`),
                error ? h('p', { className: 'pr-error' }, error) : null,
              ),
          h(
            'div',
            { className: 'pr-modal-foot' },
            h('button', { type: 'button', className: 'pr-btn pr-btn-ghost', onClick: onClose }, '取消'),
            h(
              'button',
              { type: 'button', className: 'pr-btn pr-btn-primary', onClick: submit, disabled: busy },
              busy ? h(Spinner, { size: 15 }) : null,
              busy ? '导入中…' : '开始阅读',
            ),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Reader surface
     * ------------------------------------------------------------------ */

    function ParagraphView({ paragraph, translation, fontSize, lineHeight, targetLang, onTranslate, pending }) {
      const isHeading = paragraph.heading
      const showTranslate = !translation && !pending
      return h(
        'div',
        {
          className: 'pr-para' + (isHeading ? ' is-heading' : '') + (translation ? ' has-tr' : ''),
          'data-pid': paragraph.id,
        },
        h('div', { className: 'pr-para-main' },
          isHeading
            ? h('h2', { className: 'pr-heading', style: { fontSize: Math.round(fontSize * 1.22) } }, paragraph.text)
            : h('p', { className: 'pr-text', style: { fontSize, lineHeight } }, paragraph.text),
          !isHeading && showTranslate
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'pr-para-translate',
                  title: `翻译这一段（${targetLang === 'en' ? '英文' : '中文'}）`,
                  onClick: () => onTranslate(paragraph.id, paragraph.text),
                },
                h(Icon, { name: 'translate', size: 14 }),
              )
            : null,
        ),
        pending
          ? h('div', { className: 'pr-tr pr-tr-pending' }, h(Spinner, { size: 13 }), h('span', null, '翻译中…'))
          : null,
        translation
          ? h(
              'div',
              { className: 'pr-tr' },
              h('span', { className: 'pr-tr-mark' }, targetLang === 'en' ? 'EN' : '译'),
              h('span', { className: 'pr-tr-text', style: { fontSize: Math.max(14, fontSize - 3), lineHeight: 1.75 } }, translation),
            )
          : null,
      )
    }

    function SelectionToolbar({ selection, onTranslate, onExplain, onAsk, onClose }) {
      const style = {
        left: Math.max(12, selection.x + selection.width / 2) + 'px',
        top: Math.max(12, selection.y - 46) + 'px',
      }
      return h(
        'div',
        { className: 'pr-selection', style },
        h(
          'button',
          {
            type: 'button',
            className: 'pr-selection-btn',
            onClick: () => onTranslate(selection.text),
          },
          h(Icon, { name: 'translate', size: 14 }),
          '翻译',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'pr-selection-btn',
            onClick: () => onExplain(selection.text),
          },
          h(Icon, { name: 'spark', size: 14 }),
          '解释',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'pr-selection-btn',
            onClick: () => onAsk(selection.text),
          },
          h(Icon, { name: 'chat', size: 14 }),
          '追问',
        ),
        h(IconButton, { icon: 'close', label: '关闭', onClick: onClose, size: 24 }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Floating chat
     * ------------------------------------------------------------------ */

    function ChatBubble({ message }) {
      const isUser = message.role === 'user'
      return h(
        'div',
        { className: 'pr-msg' + (isUser ? ' is-user' : ' is-assistant') },
        h('div', { className: 'pr-msg-avatar' }, isUser ? '我' : h(Icon, { name: 'book', size: 13 })),
        h(
          'div',
          { className: 'pr-msg-body' },
          message.pending && !message.content
            ? h('span', { className: 'pr-typing' }, h('i'), h('i'), h('i'))
            : renderRich(message.content),
          message.pending && message.content ? h('span', { className: 'pr-caret' }, '▍') : null,
        ),
      )
    }

    function renderRich(text) {
      const value = String(text ?? '')
      const lines = value.split('\n')
      const nodes = []
      let listBuffer = []
      const flushList = () => {
        if (listBuffer.length === 0) return
        nodes.push(
          h(
            'ul',
            { key: 'ul' + nodes.length, className: 'pr-msg-list' },
            listBuffer.map((item, index) => h('li', { key: index }, inline(item))),
          ),
        )
        listBuffer = []
      }
      for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '')
        if (/^\s*(?:[-*•]|\d+\.)\s+/.test(line)) {
          listBuffer.push(line.replace(/^\s*(?:[-*•]|\d+\.)\s+/, ''))
          continue
        }
        flushList()
        if (!line.trim()) {
          nodes.push(h('div', { key: 'br' + nodes.length, className: 'pr-msg-gap' }))
          continue
        }
        if (/^#{1,4}\s+/.test(line)) {
          nodes.push(h('div', { key: 'hd' + nodes.length, className: 'pr-msg-h' }, inline(line.replace(/^#{1,4}\s+/, ''))))
          continue
        }
        nodes.push(h('p', { key: 'p' + nodes.length, className: 'pr-msg-p' }, inline(line)))
      }
      flushList()
      return nodes
    }

    function inline(text) {
      const parts = []
      const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g
      let last = 0
      let match
      while ((match = regex.exec(text))) {
        if (match.index > last) parts.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) parts.push(h('strong', { key: parts.length }, token.slice(2, -2)))
        else parts.push(h('code', { key: parts.length, className: 'pr-code' }, token.slice(1, -1)))
        last = match.index + token.length
      }
      if (last < text.length) parts.push(text.slice(last))
      return parts
    }

    function FloatingChat({ open, onToggle, messages, onSend, streaming, onClear, onStop, suggestions, title, pos, onPos, panelRef }) {
      const [draft, setDraft] = useState('')
      const listRef = useRef(null)
      const dragRef = useRef(null)
      const textareaRef = useRef(null)

      useEffect(() => {
        if (open && textareaRef.current) textareaRef.current.focus()
      }, [open])

      useEffect(() => {
        const node = listRef.current
        if (!node) return
        node.scrollTop = node.scrollHeight
      }, [messages, open])

      const submit = () => {
        const value = draft.trim()
        if (!value || streaming) return
        setDraft('')
        onSend(value)
      }

      useEffect(() => {
        if (!open) return
        const onKey = (event) => {
          if (event.key === 'Escape') onToggle(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, onToggle])

      const startDrag = (event) => {
        if (!panelRef.current) return
        const rect = panelRef.current.getBoundingClientRect()
        const current = pos ?? { x: rect.width - 24 - 400, y: rect.height - 24 - 560 }
        dragRef.current = {
          offsetX: event.clientX - rect.left - current.x,
          offsetY: event.clientY - rect.top - current.y,
          rect,
        }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }

      const onDrag = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const width = 400
        const height = 560
        const x = Math.min(Math.max(8, event.clientX - drag.rect.left - drag.offsetX), drag.rect.width - width - 8)
        const y = Math.min(Math.max(8, event.clientY - drag.rect.top - drag.offsetY), drag.rect.height - 80)
        onPos({ x, y })
      }

      const endDrag = () => {
        dragRef.current = null
      }

      const cardStyle = pos
        ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' }
        : undefined

      return h(
        'div',
        { className: 'pr-chat-layer' },
        open
          ? h(
              'div',
              { className: 'pr-chat-card', style: cardStyle, onMouseDown: (event) => event.stopPropagation() },
              h(
                'div',
                {
                  className: 'pr-chat-head',
                  onPointerDown: startDrag,
                  onPointerMove: onDrag,
                  onPointerUp: endDrag,
                  onPointerCancel: endDrag,
                },
                h('div', { className: 'pr-chat-head-title' },
                  h('span', { className: 'pr-chat-dot' }),
                  h('span', null, '论文精读助手'),
                ),
                h('div', { className: 'pr-chat-head-actions' },
                  messages.length > 0 ? h(IconButton, { icon: 'trash', label: '清空对话', onClick: onClear, size: 26 }) : null,
                  h(IconButton, { icon: 'close', label: '收起', onClick: () => onToggle(false), size: 26 }),
                ),
              ),
              h(
                'div',
                { className: 'pr-chat-body', ref: listRef },
                messages.length === 0
                  ? h(
                      'div',
                      { className: 'pr-chat-blank' },
                      h('div', { className: 'pr-chat-blank-icon' }, h(Icon, { name: 'spark', size: 22 })),
                      h('h3', null, '边读边问'),
                      h('p', null, title ? `正在读《${title}》。` : '把论文导入后，我会结合上下文回答。'),
                      h(
                        'div',
                        { className: 'pr-chat-suggests' },
                        suggestions.map((item) =>
                          h(
                            'button',
                            { key: item, type: 'button', className: 'pr-chip', onClick: () => onSend(item) },
                            item,
                          ),
                        ),
                      ),
                    )
                  : messages.map((message, index) => h(ChatBubble, { key: index, message })),
              ),
              h(
                'div',
                { className: 'pr-chat-foot' },
                h('div', { className: 'pr-chat-input-wrap' },
                  h('textarea', {
                    ref: textareaRef,
                    className: 'pr-chat-input',
                    rows: 1,
                    placeholder: '问问这篇论文…  Enter 发送，Shift+Enter 换行',
                    value: draft,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                        event.preventDefault()
                        submit()
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pr-chat-send' + (streaming ? ' is-stop' : ''),
                      onClick: streaming ? onStop : submit,
                      disabled: !streaming && !draft.trim(),
                      title: streaming ? '停止生成' : '发送',
                    },
                    streaming ? h('span', { className: 'pr-stop-square' }) : h(Icon, { name: 'send', size: 16 }),
                  ),
                ),
                h('p', { className: 'pr-chat-tip' }, '回答基于论文原文与当前问题检索出的段落'),
              ),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'pr-chat-fab' + (open ? ' is-open' : ''),
            onClick: () => onToggle(!open),
            title: open ? '收起对话' : '和论文对话',
            'aria-label': open ? '收起对话' : '和论文对话',
          },
          open ? h(Icon, { name: 'close', size: 20 }) : h(Icon, { name: 'chat', size: 21 }),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Toolbar
     * ------------------------------------------------------------------ */

    function Toolbar({ paper, settings, onSettings, progress, onReimport, onClear, onTranslateAll, translating, translateProgress }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const menuRef = useRef(null)
      useEffect(() => {
        if (!menuOpen) return
        const onDown = (event) => {
          if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false)
        }
        window.addEventListener('mousedown', onDown)
        return () => window.removeEventListener('mousedown', onDown)
      }, [menuOpen])
      return h(
        'div',
        { className: 'pr-toolbar' },
        h(
          'div',
          { className: 'pr-toolbar-left' },
          h('div', { className: 'pr-toolbar-mark' }, h(Icon, { name: 'book', size: 17 })),
          h('div', { className: 'pr-toolbar-title' },
            h('span', { className: 'pr-toolbar-title-text' }, paper?.title ?? '论文领读'),
            h('span', { className: 'pr-toolbar-meta' },
              `${formatCount(paper?.paragraphs?.length ?? 0)} 段`,
              translating && translateProgress ? ` · 翻译 ${translateProgress.done}/${translateProgress.total}` : '',
            ),
          ),
        ),
        h(
          'div',
          { className: 'pr-toolbar-right' },
          h(
            'div',
            { className: 'pr-font-group' },
            h(IconButton, {
              icon: 'minus',
              label: '缩小字号',
              size: 28,
              disabled: settings.fontSize <= 15,
              onClick: () => onSettings({ fontSize: Math.max(15, settings.fontSize - 1) }),
            }),
            h('span', { className: 'pr-font-value' }, settings.fontSize),
            h(IconButton, {
              icon: 'plus',
              label: '放大字号',
              size: 28,
              disabled: settings.fontSize >= 28,
              onClick: () => onSettings({ fontSize: Math.min(28, settings.fontSize + 1) }),
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'pr-toggle' + (settings.bilingual ? ' is-on' : ''),
              onClick: () => onSettings({ bilingual: !settings.bilingual }),
              title: '开启后自动翻译进入视野的段落',
            },
            h(Icon, { name: 'translate', size: 15 }),
            h('span', null, '双语'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'pr-toggle pr-toggle-accent',
              onClick: onTranslateAll,
              disabled: translating,
              title: '逐段翻译整篇论文',
            },
            translating ? h(Spinner, { size: 14 }) : h(Icon, { name: 'spark', size: 15 }),
            h('span', null, translating ? '翻译中' : '全文翻译'),
          ),
          h(
            'div',
            { className: 'pr-menu-wrap', ref: menuRef },
            h(IconButton, { icon: 'more', label: '更多', onClick: () => setMenuOpen((value) => !value) }),
            menuOpen
              ? h(
                  'div',
                  { className: 'pr-menu' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pr-menu-item',
                      onClick: () => {
                        setMenuOpen(false)
                        onReimport()
                      },
                    },
                    h(Icon, { name: 'upload', size: 15 }),
                    '导入新论文',
                  ),
                  h(
                    'div',
                    { className: 'pr-menu-sep' },
                  ),
                  h(
                    'div',
                    { className: 'pr-menu-label' },
                    '字号与版心',
                  ),
                  h(
                    'div',
                    { className: 'pr-menu-row' },
                    ['紧凑', '标准', '宽松'].map((label, index) =>
                      h(
                        'button',
                        {
                          key: label,
                          type: 'button',
                          className:
                            'pr-seg' +
                            ([64, 74, 86][index] === settings.measure ? ' is-on' : ''),
                          onClick: () => onSettings({ measure: [64, 74, 86][index] }),
                        },
                        label,
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'pr-menu-sep' },
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pr-menu-item is-danger',
                      onClick: () => {
                        setMenuOpen(false)
                        onClear()
                      },
                    },
                    h(Icon, { name: 'trash', size: 15 }),
                    '清除当前论文',
                  ),
                )
              : null,
          ),
        ),
        h('div', { className: 'pr-progress' }, h('div', { className: 'pr-progress-fill', style: { width: (progress * 100).toFixed(2) + '%' } })),
      )
    }

    /* ------------------------------------------------------------------ *
     * Panel
     * ------------------------------------------------------------------ */

    function PaperReaderPanel() {
      const storedRef = useRef(readStored())
      const [paper, setPaper] = useState(() => storedRef.current.paper ?? null)
      const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...(storedRef.current.settings ?? {}) }))
      const [translations, setTranslations] = useState(() => storedRef.current.translations ?? {})
      const [chatMessages, setChatMessages] = useState(() => storedRef.current.chatMessages ?? [])
      const [chatOpen, setChatOpen] = useState(() => Boolean(storedRef.current.chatOpen))
      const [chatPos, setChatPos] = useState(() => storedRef.current.chatPos ?? null)
      const [busy, setBusy] = useState(false)
      const [importMode, setImportMode] = useState(null)
      const [importError, setImportError] = useState('')
      const [toast, setToast] = useState('')
      const [progress, setProgress] = useState(0)
      const [pendingIds, setPendingIds] = useState({})
      const [translating, setTranslating] = useState(false)
      const [translateProgress, setTranslateProgress] = useState(null)
      const [streaming, setStreaming] = useState(false)
      const [selection, setSelection] = useState(null)
      const [status, setStatus] = useState(null)

      const panelRef = useRef(null)
      const scrollRef = useRef(null)
      const fileInputRef = useRef(null)
      const abortRef = useRef(null)
      const translationsRef = useRef(translations)
      const inFlightRef = useRef(new Set())
      const autoQueueRef = useRef([])
      const autoTimerRef = useRef(null)
      const visibleRef = useRef(new Set())

      translationsRef.current = translations

      /* -------- persistence -------- */
      useEffect(() => {
        const timer = setTimeout(() => {
          const payload = { paper, settings, translations, chatMessages: chatMessages.slice(-40), chatOpen, chatPos }
          if (!writeStored(payload)) {
            writeStored({ paper: paper ? { ...paper, paragraphs: paper.paragraphs.slice(0, 1) } : null, settings, translations: {}, chatMessages: [], chatOpen: false })
          }
        }, 400)
        return () => clearTimeout(timer)
      }, [paper, settings, translations, chatMessages, chatOpen, chatPos])

      /* -------- model status -------- */
      useEffect(() => {
        let alive = true
        fetch(API + '/status')
          .then((response) => response.json())
          .then((value) => {
            if (alive) setStatus(value)
          })
          .catch(() => {
            if (alive) setStatus({ ok: false })
          })
        return () => {
          alive = false
        }
      }, [])

      useEffect(() => {
        if (!toast) return
        const timer = setTimeout(() => setToast(''), 4200)
        return () => clearTimeout(timer)
      }, [toast])

      // A freshly imported paper starts at the top.
      useEffect(() => {
        const node = scrollRef.current
        if (node) node.scrollTop = 0
      }, [paper?.importedAt])

      const notify = useCallback((message) => setToast(message), [])

      /* -------- paper import -------- */
      const applyPaper = useCallback((rawParagraphs, meta) => {
        const paragraphs = rawParagraphs.filter((paragraph) => paragraph && paragraph.text && paragraph.text.trim())
        if (paragraphs.length === 0) {
          setImportError('没有解析出可读的正文内容')
          return false
        }
        const normalized = paragraphs.map((paragraph, index) => ({
          id: 'p' + index,
          text: paragraph.text.trim(),
          heading: Boolean(paragraph.heading),
        }))
        const next = {
          title: meta?.title?.trim() || titleOf(normalized),
          source: meta?.source ?? 'unknown',
          sourceUrl: meta?.sourceUrl ?? '',
          paragraphs: normalized,
          outline: outlineOf(normalized),
          importedAt: Date.now(),
        }
        setPaper(next)
        setTranslations({})
        setChatMessages([])
        setChatOpen(false)
        setImportMode(null)
        setImportError('')
        setProgress(0)
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = 0
        })
        notify(`已导入《${next.title.slice(0, 40)}》，共 ${normalized.length} 段`)
        return true
      }, [notify])

      const importPastedText = useCallback(
        (text) => {
          setImportError('')
          setBusy(true)
          try {
            const paragraphs = textToParagraphs(text)
            applyPaper(paragraphs, { source: 'paste' })
          } catch (error) {
            setImportError(String(error?.message ?? error))
          } finally {
            setBusy(false)
          }
        },
        [applyPaper],
      )

      const importUrl = useCallback(
        async (url) => {
          setImportError('')
          setBusy(true)
          try {
            const result = await postJson('/fetch-url', { url })
            const paragraphs = Array.isArray(result.paragraphs)
              ? result.paragraphs.map((text) => ({ text: String(text) }))
              : []
            const withHeadings = textToParagraphs(paragraphs.map((item) => item.text).join('\n\n'))
            const applied = applyPaper(withHeadings.length > 0 ? withHeadings : paragraphs, {
              title: result.title,
              source: 'url',
              sourceUrl: result.sourceUrl || url,
            })
            if (applied && result.weak && result.hint) notify(result.hint)
          } catch (error) {
            setImportError(String(error?.message ?? error))
          } finally {
            setBusy(false)
          }
        },
        [applyPaper, notify],
      )

      const importFile = useCallback(
        async (file) => {
          if (!file) return
          setImportError('')
          setBusy(true)
          try {
            const name = file.name ?? ''
            const isPdf = /\.pdf$/i.test(name) || file.type === 'application/pdf'
            if (isPdf) {
              const buffer = await file.arrayBuffer()
              const response = await fetch(API + '/pdf', {
                method: 'POST',
                headers: { 'content-type': 'application/pdf' },
                body: buffer,
              })
              const result = await readJsonResponse(response)
              const paragraphs = (result.paragraphs ?? []).map((text) => ({ text: String(text) }))
              applyPaper(textToParagraphs(paragraphs.map((item) => item.text).join('\n\n')), {
                title: result.title,
                source: 'file',
              })
            } else {
              const text = await file.text()
              applyPaper(textToParagraphs(text), { title: name.replace(/\.[^.]+$/, ''), source: 'file' })
            }
          } catch (error) {
            setImportError(String(error?.message ?? error))
          } finally {
            setBusy(false)
          }
        },
        [applyPaper],
      )

      useEffect(() => {
        setImportError('')
        if (importMode !== 'file') return
        fileInputRef.current?.click()
        setImportMode(null)
      }, [importMode])

      /* -------- translation -------- */
      const requestTranslation = useCallback(
        async (ids, texts) => {
          const target = settings.targetLang === 'en' ? 'en' : 'zh'
          const fresh = ids.filter((id) => !translationsRef.current[id] && !inFlightRef.current.has(id))
          if (fresh.length === 0) return
          for (const id of fresh) inFlightRef.current.add(id)
          setPendingIds((current) => {
            const next = { ...current }
            for (const id of fresh) next[id] = true
            return next
          })
          try {
            const stream = await streamTranslate(texts, target)
            const buffers = {}
            for await (const event of stream) {
              if (typeof event.index === 'number' && typeof event.delta === 'string') {
                buffers[event.index] = (buffers[event.index] ?? '') + event.delta
                const id = fresh[event.index]
                if (id) {
                  setTranslations((current) => ({ ...current, [id]: buffers[event.index] }))
                }
              } else if (event.error && typeof event.index === 'number') {
                const id = fresh[event.index]
                if (id) notify(`第 ${event.index + 1} 段翻译失败：${event.error}`)
              }
            }
          } catch (error) {
            notify('翻译失败：' + String(error?.message ?? error))
          } finally {
            for (const id of fresh) inFlightRef.current.delete(id)
            setPendingIds((current) => {
              const next = { ...current }
              for (const id of fresh) delete next[id]
              return next
            })
          }
        },
        [settings.targetLang, notify],
      )

      const translateParagraph = useCallback(
        (id, text) => {
          requestTranslation([id], [text])
        },
        [requestTranslation],
      )

      const translateAll = useCallback(async () => {
        if (!paper || translating) return
        const items = paper.paragraphs.filter((paragraph) => !paragraph.heading && paragraph.text.length > 12)
        const todo = items.filter((paragraph) => !translationsRef.current[paragraph.id])
        if (todo.length === 0) {
          notify('整篇论文都已翻译完成')
          return
        }
        setTranslating(true)
        setTranslateProgress({ done: 0, total: todo.length })
        const target = settings.targetLang === 'en' ? 'en' : 'zh'
        const batchSize = 6
        let done = 0
        for (let index = 0; index < todo.length; index += batchSize) {
          const batch = todo.slice(index, index + batchSize)
          const ids = batch.map((paragraph) => paragraph.id)
          const texts = batch.map((paragraph) => paragraph.text)
          for (const id of ids) inFlightRef.current.add(id)
          setPendingIds((current) => {
            const next = { ...current }
            for (const id of ids) next[id] = true
            return next
          })
          try {
            const stream = await streamTranslate(texts, target)
            const buffers = {}
            for await (const event of stream) {
              if (typeof event.index === 'number' && typeof event.delta === 'string') {
                buffers[event.index] = (buffers[event.index] ?? '') + event.delta
                const id = ids[event.index]
                if (id) setTranslations((current) => ({ ...current, [id]: buffers[event.index] }))
              } else if (event.error) {
                notify('翻译出错：' + event.error)
              }
            }
          } catch (error) {
            notify('翻译失败：' + String(error?.message ?? error))
          } finally {
            for (const id of ids) inFlightRef.current.delete(id)
            setPendingIds((current) => {
              const next = { ...current }
              for (const id of ids) delete next[id]
              return next
            })
          }
          done += batch.length
          setTranslateProgress({ done: Math.min(done, todo.length), total: todo.length })
        }
        setTranslating(false)
        setTranslateProgress(null)
        notify('全文翻译完成')
      }, [paper, translating, settings.targetLang, notify])

      /* -------- auto translation for visible paragraphs (bilingual) -------- */
      useEffect(() => {
        if (!settings.bilingual || !paper) return
        const root = scrollRef.current
        if (!root) return
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const id = entry.target.getAttribute('data-pid')
              if (!id) continue
              if (entry.isIntersecting) visibleRef.current.add(id)
              else visibleRef.current.delete(id)
            }
            const queue = autoQueueRef.current
            for (const id of visibleRef.current) {
              if (!translationsRef.current[id] && !inFlightRef.current.has(id)) queue.push(id)
            }
          },
          { root, rootMargin: '320px 0px', threshold: 0.01 },
        )
        const nodes = root.querySelectorAll('.pr-para[data-pid]')
        for (const node of nodes) {
          if (node.querySelector('.pr-heading')) continue
          observer.observe(node)
        }
        const flush = () => {
          if (!paper) return
          const queue = autoQueueRef.current
          const ids = Array.from(new Set(queue)).slice(0, 6)
          autoQueueRef.current = []
          if (ids.length === 0) return
          const byId = new Map(paper.paragraphs.map((paragraph) => [paragraph.id, paragraph]))
          const chosen = ids.map((id) => byId.get(id)).filter(Boolean)
          if (chosen.length === 0) return
          requestTranslation(
            chosen.map((paragraph) => paragraph.id),
            chosen.map((paragraph) => paragraph.text),
          )
        }
        const timer = setInterval(flush, 700)
        return () => {
          observer.disconnect()
          clearInterval(timer)
          visibleRef.current.clear()
        }
      }, [settings.bilingual, paper, requestTranslation])

      /* -------- reading progress + selection -------- */
      const onScroll = useCallback(() => {
        const node = scrollRef.current
        if (!node) return
        const max = node.scrollHeight - node.clientHeight
        const next = max > 0 ? Math.min(1, Math.max(0, node.scrollTop / max)) : 0
        setProgress((current) => (Math.abs(current - next) > 0.004 ? next : current))
        setSelection((current) => (current ? null : current))
      }, [])

      const captureSelection = useCallback(() => {
        const node = scrollRef.current
        if (!node) return
        const sel = window.getSelection?.()
        if (!sel || sel.isCollapsed) {
          setSelection(null)
          return
        }
        const text = String(sel.toString() ?? '').trim()
        if (text.length < 2 || text.length > 1200) {
          setSelection(null)
          return
        }
        const range = sel.getRangeAt(0)
        if (!node.contains(range.commonAncestorContainer)) {
          setSelection(null)
          return
        }
        const rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) {
          setSelection(null)
          return
        }
        setSelection({ text, x: rect.left, y: rect.top, width: rect.width })
      }, [])

      useEffect(() => {
        const onDown = (event) => {
          if (!event.target.closest?.('.pr-selection')) {
            setSelection(null)
          }
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [])

      /* -------- chat -------- */
      const sendQuestion = useCallback(
        async (question) => {
          if (!question.trim() || streaming) return
          const history = chatMessages
            .filter((message) => !message.pending)
            .map((message) => ({ role: message.role, content: message.content }))
          const userMessage = { role: 'user', content: question }
          const placeholder = { role: 'assistant', content: '', pending: true }
          setChatMessages((current) => [...current, userMessage, placeholder])
          setStreaming(true)
          const controller = new AbortController()
          abortRef.current = controller
          try {
            const stream = await streamChat(
              {
                question,
                history,
                paper: compactPaper(paper),
              },
              controller.signal,
            )
            let accumulated = ''
            for await (const event of stream) {
              if (event.delta) {
                accumulated += event.delta
                setChatMessages((current) => {
                  const next = current.slice()
                  for (let index = next.length - 1; index >= 0; index -= 1) {
                    if (next[index].pending) {
                      next[index] = { role: 'assistant', content: accumulated, pending: true }
                      break
                    }
                  }
                  return next
                })
              }
            }
            setChatMessages((current) => {
              const next = current.slice()
              for (let index = next.length - 1; index >= 0; index -= 1) {
                if (next[index].pending) {
                  next[index] = { role: 'assistant', content: accumulated || '（没有返回内容）', pending: false }
                  break
                }
              }
              return next
            })
          } catch (error) {
            const message = String(error?.message ?? error)
            setChatMessages((current) => {
              const next = current.slice()
              for (let index = next.length - 1; index >= 0; index -= 1) {
                if (next[index].pending) {
                  next[index] = { role: 'assistant', content: `⚠ ${message}`, pending: false }
                  break
                }
              }
              return next
            })
          } finally {
            setStreaming(false)
            abortRef.current = null
          }
        },
        [chatMessages, paper, streaming],
      )

      const stopGeneration = useCallback(() => {
        abortRef.current?.abort()
      }, [])

      const clearChat = useCallback(() => {
        setChatMessages([])
        notify('对话已清空')
      }, [notify])

      /* -------- selection actions -------- */
      const translateSelection = useCallback(
        async (text) => {
          setSelection(null)
          try {
            const stream = await streamTranslate([text], settings.targetLang === 'en' ? 'en' : 'zh')
            let result = ''
            for await (const event of stream) {
              if (event.delta) result += event.delta
            }
            if (result) {
              setChatOpen(true)
              setChatMessages((current) => [
                ...current,
                { role: 'user', content: `翻译选中的这段：\n${text.slice(0, 60)}${text.length > 60 ? '…' : ''}` },
                { role: 'assistant', content: result },
              ])
            }
          } catch (error) {
            notify('翻译失败：' + String(error?.message ?? error))
          }
        },
        [settings.targetLang, notify],
      )

      const explainSelection = useCallback(
        (text) => {
          setSelection(null)
          setChatOpen(true)
          sendQuestion(`请用中文解释这段话的含义（尽量结合上下文）：\n\n${text}`)
        },
        [sendQuestion],
      )

      const askSelection = useCallback(
        (text) => {
          setSelection(null)
          setChatOpen(true)
          setChatMessages((current) => [
            ...current,
            { role: 'assistant', content: `已选中这段话：「${text.slice(0, 80)}${text.length > 80 ? '…' : ''}」\n你想怎么追问？直接输入问题即可。` },
          ])
        },
        [],
      )

      /* -------- render -------- */
      const paragraphs = paper?.paragraphs ?? []
      const suggestions = useMemo(() => {
        if (!paper) return ['这篇论文讲了什么？', '作者的核心贡献是什么？']
        const list = ['这篇论文用一句话概括是什么？', '作者的方法有什么创新？', '有哪些局限或未解决的问题？']
        return list
      }, [paper])

      const body = paper
        ? h(
            'div',
            { className: 'pr-reader', ref: scrollRef, onScroll, onMouseUp: captureSelection },
            h(
              'div',
              {
                className: 'pr-prose',
                style: {
                  '--pr-fs': settings.fontSize + 'px',
                  '--pr-lh': String(settings.lineHeight),
                  maxWidth: settings.measure + 'ch',
                },
              },
              h(
                'div',
                { className: 'pr-prose-head' },
                h('h1', { className: 'pr-doc-title', style: { fontSize: Math.round(settings.fontSize * 1.75) } }, paper.title),
                h(
                  'div',
                  { className: 'pr-doc-meta' },
                  h('span', null, `${formatCount(paragraphs.length)} 段`),
                  h('span', { className: 'pr-dot' }),
                  h('span', null, `${formatCount(paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0))} 字符`),
                  paper.sourceUrl ? h('span', { className: 'pr-dot' }) : null,
                  paper.sourceUrl ? h('span', { className: 'pr-doc-src' }, paper.sourceUrl) : null,
                ),
              ),
              paragraphs.map((paragraph, index) =>
                h(ParagraphView, {
                  key: paragraph.id + ':' + index,
                  paragraph,
                  translation: translations[paragraph.id],
                  pending: Boolean(pendingIds[paragraph.id]),
                  fontSize: settings.fontSize,
                  lineHeight: settings.lineHeight,
                  targetLang: settings.targetLang,
                  onTranslate: translateParagraph,
                }),
              ),
              h('div', { className: 'pr-prose-end' }, '· 全文完 ·'),
            ),
          )
        : h(EmptyState, {
            busy,
            status,
            onOpenPaste: () => {
              setImportError('')
              setImportMode('paste')
            },
            onOpenFile: () => setImportMode('file'),
            onOpenUrl: () => {
              setImportError('')
              setImportMode('url')
            },
          })

      return h(
        'div',
        { className: 'pr-root', ref: panelRef },
        h('style', null, STYLES),
        paper
          ? h(Toolbar, {
              paper,
              settings,
              onSettings: (patch) => setSettings((current) => ({ ...current, ...patch })),
              progress,
              onReimport: () => {
                setImportError('')
                setImportMode('paste')
              },
              onClear: () => {
                setPaper(null)
                setTranslations({})
                setChatMessages([])
                setChatOpen(false)
                setProgress(0)
                notify('已清除当前论文')
              },
              onTranslateAll: translateAll,
              translating,
              translateProgress,
            })
          : null,
        h('div', { className: 'pr-body' }, body),
        selection
          ? h(SelectionToolbar, {
              selection,
              onTranslate: translateSelection,
              onExplain: explainSelection,
              onAsk: askSelection,
              onClose: () => setSelection(null),
            })
          : null,
        paper
          ? h(FloatingChat, {
              open: chatOpen,
              onToggle: setChatOpen,
              messages: chatMessages,
              onSend: sendQuestion,
              streaming,
              onStop: stopGeneration,
              onClear: clearChat,
              suggestions,
              title: paper?.title ?? '',
              pos: chatPos,
              onPos: setChatPos,
              panelRef,
            })
          : null,
        importMode === 'paste' || importMode === 'url'
          ? h(ImportModal, {
              mode: importMode,
              busy,
              error: importError,
              onClose: () => {
                setImportMode(null)
                setImportError('')
              },
              onSubmitUrl: importUrl,
              onSubmitText: importPastedText,
            })
          : null,
        h('input', {
          ref: fileInputRef,
          type: 'file',
          accept: '.pdf,.txt,.md,.markdown,.tex,text/plain,application/pdf',
          style: { display: 'none' },
          onChange: (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) importFile(file)
          },
        }),
        importError && importMode === null
          ? h('div', { className: 'pr-toast is-error' }, importError)
          : null,
        toast ? h('div', { className: 'pr-toast' }, toast) : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Crash guard: a throwing panel must not blank the whole slot entry
     * ------------------------------------------------------------------ */

    class PaperReaderBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        try {
          console.error('[paperpilot] panel crashed', error)
        } catch {
          /* ignore */
        }
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'pr-root pr-crash' },
            h(
              'div',
              { className: 'pr-crash-box' },
              h('h2', null, '阅读器遇到问题'),
              h('p', null, String(this.state.error?.message ?? this.state.error)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'pr-btn pr-btn-primary',
                  onClick: () => this.setState({ error: null }),
                },
                '重试',
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    function PaperReaderRoot(props) {
      return h(PaperReaderBoundary, null, h(PaperReaderPanel, props))
    }

    /* ------------------------------------------------------------------ *
     * Styles (scoped by the pr- prefix, theme tokens only)
     * ------------------------------------------------------------------ */

    const STYLES = `
.pr-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;min-width:0;flex:1 1 auto;overflow:hidden;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:"Inter","PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.pr-root *{box-sizing:border-box}
.pr-root button{font-family:inherit}

/* ---------- toolbar ---------- */
.pr-toolbar{position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 20px;min-height:56px;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;z-index:5}
.pr-toolbar-left{display:flex;align-items:center;gap:10px;min-width:0}
.pr-toolbar-mark{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;
  background:linear-gradient(135deg,#4f7cff22,#8b5cf622);color:var(--dsw-alias-brand-primary);flex:0 0 auto}
.pr-toolbar-title{display:flex;flex-direction:column;min-width:0}
.pr-toolbar-title-text{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(46vw,620px)}
.pr-toolbar-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pr-toolbar-right{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.pr-font-group{display:flex;align-items:center;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.pr-font-value{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:18px;text-align:center;font-variant-numeric:tabular-nums}
.pr-icon-btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s}
.pr-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pr-icon-btn:disabled{opacity:.35;cursor:default}
.pr-icon-btn.is-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.pr-toggle{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:9px;font-size:12.5px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);transition:all .15s}
.pr-toggle:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.pr-toggle.is-on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.pr-toggle-accent{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.pr-toggle-accent:hover{background:var(--dsw-alias-bg-layer-2)}
.pr-toggle-accent:disabled{opacity:.55;cursor:default}
.pr-menu-wrap{position:relative}
.pr-menu{position:absolute;right:0;top:calc(100% + 8px);min-width:210px;padding:6px;border-radius:12px;z-index:30;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 16px 40px rgba(0,0,0,.18)}
.pr-menu-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer;text-align:left}
.pr-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.pr-menu-item.is-danger{color:var(--dsw-alias-state-error-primary)}
.pr-menu-sep{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l1)}
.pr-menu-label{padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.pr-menu-row{display:flex;gap:4px;padding:2px 6px 6px}
.pr-seg{flex:1;height:26px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;cursor:pointer;
  font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.pr-seg.is-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.pr-progress{position:absolute;left:0;right:0;bottom:-1px;height:2px;background:transparent}
.pr-progress-fill{height:100%;background:var(--dsw-alias-brand-primary);opacity:.55;transition:width .18s}

/* ---------- body ---------- */
.pr-body{position:relative;flex:1 1 auto;min-height:0;display:flex}
.pr-reader{flex:1;overflow-y:auto;overflow-x:hidden;scroll-behavior:smooth;padding:40px 24px 22vh}
.pr-prose{margin:0 auto;color:var(--dsw-alias-label-primary)}
.pr-prose-head{margin-bottom:34px;padding-bottom:22px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pr-doc-title{margin:0 0 12px;font-family:Georgia,"Noto Serif SC","Songti SC",serif;font-weight:650;letter-spacing:-.01em;line-height:1.32}
.pr-doc-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.pr-dot{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.5}
.pr-doc-src{max-width:60ch;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
.pr-para{position:relative;margin:0 0 22px;content-visibility:auto;contain-intrinsic-size:auto 120px}
.pr-para.is-heading{content-visibility:visible}
.pr-para-main{position:relative}
.pr-text{margin:0;font-family:Georgia,"Noto Serif SC","Songti SC","Source Han Serif SC",serif;text-align:justify;letter-spacing:.005em}
.pr-heading{margin:34px 0 14px;font-family:"Inter","PingFang SC",system-ui,sans-serif;font-weight:650;letter-spacing:-.01em}
.pr-para-translate{position:absolute;right:-38px;top:3px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  opacity:0;cursor:pointer;transition:opacity .15s,color .15s,transform .15s}
.pr-para:hover .pr-para-translate{opacity:1}
.pr-para-translate:hover{color:var(--dsw-alias-brand-primary);transform:translateY(-1px)}
.pr-tr{display:flex;gap:9px;margin-top:9px;padding:10px 12px 10px 11px;border-left:2px solid var(--dsw-alias-brand-primary);
  border-radius:0 8px 8px 0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.pr-tr-mark{flex:0 0 auto;font-size:10px;font-weight:700;letter-spacing:.06em;padding-top:2px;color:var(--dsw-alias-brand-primary);opacity:.9}
.pr-tr-text{font-family:"Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.pr-tr-pending{border-left-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);align-items:center;font-size:12.5px;gap:8px;opacity:.8}
.pr-prose-end{margin:48px 0 0;text-align:center;font-size:11.5px;letter-spacing:.3em;color:var(--dsw-alias-label-secondary);opacity:.55}

/* ---------- selection toolbar ---------- */
.pr-selection{position:fixed;z-index:60;display:flex;align-items:center;gap:2px;padding:4px;border-radius:11px;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 12px 32px rgba(0,0,0,.22);
  transform:translate(-50%,0);animation:pr-pop .12s ease-out}
.pr-selection-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:0;border-radius:7px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-primary);font-size:12px}
.pr-selection-btn:hover{background:var(--dsw-alias-bg-layer-2)}

/* ---------- chat ---------- */
.pr-chat-layer{position:absolute;inset:0;pointer-events:none;z-index:40}
.pr-chat-fab{position:absolute;right:24px;bottom:24px;width:52px;height:52px;border-radius:50%;border:0;cursor:pointer;pointer-events:auto;
  display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#4f7cff,#8b5cf6);
  box-shadow:0 10px 26px rgba(79,124,255,.38);transition:transform .18s,box-shadow .18s}
.pr-chat-fab:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 14px 32px rgba(79,124,255,.46)}
.pr-chat-fab.is-open{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 26px rgba(0,0,0,.2)}
.pr-chat-card{position:absolute;right:24px;bottom:88px;width:400px;max-width:calc(100% - 48px);height:560px;max-height:calc(100% - 120px);
  display:flex;flex-direction:column;pointer-events:auto;border-radius:16px;overflow:hidden;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);
  box-shadow:0 24px 64px rgba(0,0,0,.28);animation:pr-rise .18s ease-out;backdrop-filter:blur(12px)}
.pr-chat-head{display:flex;align-items:center;justify-content:space-between;padding:11px 12px 11px 15px;cursor:grab;
  border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;user-select:none;touch-action:none}
.pr-chat-head:active{cursor:grabbing}
.pr-chat-head-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.pr-chat-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px rgba(52,199,89,.16)}
.pr-chat-head-actions{display:flex;align-items:center;gap:2px}
.pr-chat-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:14px}
.pr-chat-blank{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:0 8px;gap:6px}
.pr-chat-blank-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:14px;margin-bottom:6px;
  background:linear-gradient(135deg,#4f7cff22,#8b5cf622);color:var(--dsw-alias-brand-primary)}
.pr-chat-blank h3{margin:0;font-size:14.5px;font-weight:650}
.pr-chat-blank p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:30ch;line-height:1.6}
.pr-chat-suggests{display:flex;flex-direction:column;gap:6px;margin-top:14px;width:100%}
.pr-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;border-radius:9px;padding:8px 11px;font-size:12px;
  color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;transition:background .15s,border-color .15s}
.pr-chip:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.pr-msg{display:flex;gap:9px;align-items:flex-start}
.pr-msg-avatar{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:8px;font-size:11px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pr-msg.is-user .pr-msg-avatar{background:var(--dsw-alias-brand-primary);color:#fff}
.pr-msg-body{min-width:0;font-size:13px;line-height:1.7;padding:9px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);word-break:break-word}
.pr-msg.is-user .pr-msg-body{background:var(--dsw-alias-brand-primary);color:#fff}
.pr-msg.is-assistant .pr-msg-body{background:var(--dsw-alias-bg-layer-2)}
.pr-msg-p{margin:0 0 7px;white-space:pre-wrap}
.pr-msg-p:last-child{margin-bottom:0}
.pr-msg-gap{height:6px}
.pr-msg-h{font-weight:650;margin:2px 0 5px}
.pr-msg-list{margin:0 0 7px;padding-left:17px}
.pr-msg-list li{margin:2px 0}
.pr-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:1px 5px;border-radius:5px;background:rgba(127,127,127,.16)}
.pr-typing{display:inline-flex;gap:4px;align-items:center;padding:3px 0}
.pr-typing i{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.45;animation:pr-blink 1.1s infinite}
.pr-typing i:nth-child(2){animation-delay:.15s}
.pr-typing i:nth-child(3){animation-delay:.3s}
.pr-caret{margin-left:2px;animation:pr-blink .9s steps(2) infinite;opacity:.65}
.pr-chat-foot{flex:0 0 auto;padding:10px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.pr-chat-input-wrap{display:flex;align-items:flex-end;gap:8px;padding:8px 8px 8px 12px;border-radius:12px;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}
.pr-chat-input{flex:1;border:0;outline:0;background:transparent;resize:none;color:var(--dsw-alias-label-primary);font-size:13px;
  line-height:1.6;max-height:120px;font-family:inherit;padding:2px 0}
.pr-chat-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.pr-chat-send{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;border:0;cursor:pointer;
  background:var(--dsw-alias-brand-primary);color:#fff;transition:opacity .15s,transform .15s}
.pr-chat-send:hover:not(:disabled){transform:translateY(-1px)}
.pr-chat-send:disabled{opacity:.35;cursor:default}
.pr-chat-send.is-stop{background:var(--dsw-alias-state-error-primary)}
.pr-stop-square{width:9px;height:9px;border-radius:2px;background:#fff}
.pr-chat-tip{margin:7px 2px 0;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.7;text-align:center}

/* ---------- empty state ---------- */
.pr-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:32px;overflow-y:auto}
.pr-empty-inner{max-width:760px;width:100%;text-align:center;display:flex;flex-direction:column;align-items:center}
.pr-empty-mark{display:flex;align-items:center;justify-content:center;width:66px;height:66px;border-radius:20px;margin-bottom:22px;
  background:linear-gradient(135deg,#4f7cff1f,#8b5cf61f);color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-border-l1)}
.pr-empty-title{margin:0 0 10px;font-size:27px;font-weight:680;letter-spacing:-.02em}
.pr-empty-sub{margin:0 0 30px;font-size:13.5px;color:var(--dsw-alias-label-secondary);max-width:52ch;line-height:1.7}
.pr-empty-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;width:100%}
.pr-empty-card{display:flex;flex-direction:column;align-items:flex-start;gap:7px;padding:18px 18px 20px;border-radius:15px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);text-align:left;transition:transform .16s,border-color .16s,box-shadow .16s}
.pr-empty-card:hover:not(:disabled){transform:translateY(-2px);border-color:var(--dsw-alias-border-l2);box-shadow:0 12px 28px rgba(0,0,0,.1)}
.pr-empty-card:disabled{opacity:.6;cursor:default}
.pr-empty-card-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px;margin-bottom:4px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.pr-empty-card-title{font-size:13.5px;font-weight:620}
.pr-empty-card-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.55}
.pr-empty-hint{margin:26px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.8}

/* ---------- modal ---------- */
.pr-modal-mask{position:absolute;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:28px;
  background:rgba(10,12,18,.42);backdrop-filter:blur(3px);animation:pr-fade .14s ease-out}
.pr-modal{width:min(700px,100%);max-height:100%;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 28px 80px rgba(0,0,0,.35);animation:pr-rise .16s ease-out}
.pr-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pr-modal-title{font-size:13.5px;font-weight:620}
.pr-modal-body{padding:18px;display:flex;flex-direction:column;gap:9px;min-height:0;overflow-y:auto}
.pr-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.pr-input,.pr-textarea{width:100%;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;outline:0;padding:11px 13px;transition:border-color .15s}
.pr-input:focus,.pr-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.pr-textarea{min-height:260px;resize:vertical;line-height:1.7}
.pr-field-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.pr-error{margin:0;font-size:11.5px;color:var(--dsw-alias-state-error-primary);line-height:1.6}
.pr-modal-foot{display:flex;justify-content:flex-end;gap:9px;padding:13px 18px;border-top:1px solid var(--dsw-alias-border-l1)}
.pr-btn{height:34px;padding:0 16px;border-radius:9px;font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.pr-btn-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.pr-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2)}
.pr-btn-primary{background:var(--dsw-alias-brand-primary);border:0;color:#fff}
.pr-btn-primary:hover:not(:disabled){filter:brightness(1.06)}
.pr-btn-primary:disabled{opacity:.6;cursor:default}

/* ---------- toast ---------- */
.pr-toast{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);z-index:80;max-width:70%;padding:9px 15px;border-radius:10px;
  font-size:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 14px 36px rgba(0,0,0,.24);
  animation:pr-rise .16s ease-out}
.pr-toast.is-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}

/* ---------- crash guard ---------- */
.pr-crash{align-items:center;justify-content:center;padding:24px}
.pr-crash-box{max-width:560px;padding:24px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);text-align:center}
.pr-crash-box h2{margin:0 0 10px;font-size:16px}
.pr-crash-box p{margin:0 0 16px;font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}

@keyframes pr-spin{to{transform:rotate(360deg)}}
@keyframes pr-fade{from{opacity:0}to{opacity:1}}
@keyframes pr-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pr-pop{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes pr-blink{0%,100%{opacity:.25}50%{opacity:1}}

@media (max-width:720px){
  .pr-empty-cards{grid-template-columns:1fr}
  .pr-toolbar-meta{display:none}
  .pr-chat-card{right:12px;left:12px;width:auto;bottom:80px}
  .pr-reader{padding:26px 18px 30vh}
  .pr-para-translate{right:-4px;opacity:1}
}
`

    /* ------------------------------------------------------------------ *
     * Plugin registration
     * ------------------------------------------------------------------ */

    function SidebarIcon({ size = 20, active = false } = {}) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          style: { display: 'block', opacity: active ? 1 : 0.92 },
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5v-10Z' }),
        h('path', { d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5v-10Z' }),
        h('path', { d: 'M7.5 9h3M7.5 12.5h3', strokeWidth: 1.4, opacity: 0.75 }),
      )
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: () => ({}),
            },
            PaperReaderRoot,
          ),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => '论文领读',
            },
            SidebarIcon,
          ),
        )
      },
    }
  },
})
