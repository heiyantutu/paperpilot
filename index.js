/**
 * Host half of the PaperPilot bundle.
 *
 * Registers a small same-origin HTTP API used by the browser panel:
 *   GET  /paperpilot/api/status      — model / capability probe
 *   POST /paperpilot/api/chat        — streaming chat about the paper
 *   POST /paperpilot/api/translate   — streaming paragraph translation
 *   POST /paperpilot/api/fetch-url   — pull a paper from a URL (HTML or PDF)
 *   POST /paperpilot/api/pdf         — extract text from raw PDF bytes
 *
 * The endpoints never touch the Session log; they are a read-only side channel
 * for the reading UI.
 */

const API_PREFIX = '/paperpilot/api'
const MAX_BODY_BYTES = 48 * 1024 * 1024
const MAX_TRANSLATE_CHARS = 8000
const FETCH_TIMEOUT_MS = 60_000

/** Host-side sentence about the paper used to steer model answers. */
const CHAT_SYSTEM = [
  '你是一位严谨、耐心的论文精读助手，正在陪用户阅读一篇论文。',
  '规则：',
  '1. 只依据下面给出的论文内容与通用学术常识作答，绝不编造论文中不存在的实验、数字或结论。',
  '2. 用简洁的简体中文回答；专有名词、模型名、数据集名首次出现时保留英文原名。',
  '3. 回答尽量短，必要时用短列表；不要整段复制原文。',
  '4. 若给出的论文内容不足以回答，直接说明缺少什么信息，并建议用户翻到哪一部分。',
].join('\n')

const TRANSLATE_SYSTEM_ZH = [
  '你是一个专业的学术论文翻译引擎。',
  '把用户给出的英文段落翻译成准确、通顺的简体中文。',
  '要求：保留专业术语（可加英文原名）、公式、数字、引用编号与图表编号；',
  '保持原文的段落结构；只输出译文本身，不要任何解释、前言、后缀或引号。',
].join('\n')

const TRANSLATE_SYSTEM_EN = [
  'You are a professional academic translator.',
  'Translate the Chinese paragraph the user provides into fluent, precise English.',
  'Keep technical terms, formulas, numbers, citation markers and figure/table numbers intact.',
  'Output only the translation: no explanations, no preamble, no quotes.',
].join('\n')

export const inject = ['webServer']

export function apply(ctx) {
  const logger = ctx.logger
  const register = (path, handler) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: API_PREFIX + path, handler }),
      'paperpilot: route ' + path,
    )

  register('/status', (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const target = readModelTarget(ctx)
    json(res, 200, {
      ok: true,
      provider: target?.provider ?? null,
      model: target?.model ?? null,
      llm: Boolean(ctx.get('llm')),
      web: typeof globalThis.fetch === 'function',
    })
  })

  register('/chat', async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const abort = clientAbort(res)
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const question = String(body.question ?? '').trim()
      if (!question) return json(res, 400, { error: '问题为空' })
      const paper = normalizePaper(body.paper)
      const history = Array.isArray(body.history) ? body.history : []
      const system = buildChatSystem(paper, question)
      const prompt = buildChatPrompt(history, question)
      const out = sseStart(res)
      await pipeLlm(ctx, {
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 2200,
        signal: abort.signal,
        onText: (text) => out.send({ delta: text }),
      })
      out.done()
      abort.dispose()
    } catch (error) {
      failStream(res, error, logger)
    }
  })

  register('/translate', async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const abort = clientAbort(res)
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const items = Array.isArray(body.items) ? body.items : []
      const target = body.target === 'en' ? 'en' : 'zh'
      if (items.length === 0) return json(res, 400, { error: '没有需要翻译的文本' })
      const system = target === 'en' ? TRANSLATE_SYSTEM_EN : TRANSLATE_SYSTEM_ZH
      const out = sseStart(res)
      // Translate a few paragraphs at a time: one paragraph per call keeps the
      // output aligned, while a small worker pool keeps the wall clock sane.
      let cursor = 0
      const worker = async () => {
        while (cursor < items.length && !abort.signal.aborted) {
          const index = cursor
          cursor += 1
          const raw = String(items[index] ?? '')
          const text = raw.length > MAX_TRANSLATE_CHARS ? raw.slice(0, MAX_TRANSLATE_CHARS) : raw
          if (!text.trim()) {
            out.send({ index, translation: '' })
            continue
          }
          out.send({ index, start: true })
          try {
            await pipeLlm(ctx, {
              system,
              messages: [{ role: 'user', content: [{ type: 'text', text }] }],
              maxTokens: 2400,
              signal: abort.signal,
              onText: (delta) => out.send({ index, delta }),
            })
            out.send({ index, done: true })
          } catch (error) {
            out.send({ index, error: messageOf(error) })
          }
        }
      }
      const workers = Array.from({ length: Math.min(4, items.length) }, () => worker())
      await Promise.all(workers)
      out.done()
      abort.dispose()
    } catch (error) {
      failStream(res, error, logger)
    }
  })

  register('/fetch-url', async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const url = String(body.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: '请提供一个 http(s) 链接' })
      let best = await loadPaperFromUrl(url)
      const weak = totalChars(best.paragraphs) < 3000
      if (weak) {
        const alternate = arxivHtmlVariant(url)
        if (alternate && alternate !== url) {
          try {
            const second = await loadPaperFromUrl(alternate)
            if (totalChars(second.paragraphs) > totalChars(best.paragraphs)) best = second
          } catch {
            /* keep the first result */
          }
        }
      }
      const chars = totalChars(best.paragraphs)
      json(res, 200, {
        ...best,
        requestedUrl: url,
        weak: chars < 3000,
        hint:
          chars < 3000
            ? '这个页面只有摘要级别的正文。试试论文的 HTML 全文页（如果是 arXiv，把 /abs/ 换成 /html/）或 PDF 直链。'
            : '',
      })
    } catch (error) {
      json(res, 500, { error: messageOf(error) })
    }
  })

  register('/pdf', async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    try {
      const bytes = new Uint8Array(await readBody(req))
      if (bytes.length === 0) return json(res, 400, { error: 'PDF 内容为空' })
      if (!looksLikePdf(bytes)) return json(res, 400, { error: '这个文件不是有效的 PDF' })
      const parsed = await extractPdf(bytes)
      json(res, 200, { ...parsed, kind: 'pdf' })
    } catch (error) {
      json(res, 500, { error: messageOf(error) })
    }
  })
}

/* ------------------------------------------------------------------ *
 * LLM plumbing
 * ------------------------------------------------------------------ */

/** Read the current default model selection, or undefined when unset. */
function readModelTarget(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* fall through */
  }
  return undefined
}

/**
 * Stream one model call, forwarding visible text deltas.
 * Throws a readable Error when chat is unavailable or the call fails.
 */
async function pipeLlm(ctx, options) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('当前 Host 没有启用 llm 服务，无法调用模型')
  }
  const target = readModelTarget(ctx)
  if (!target) {
    throw new Error('没有可用的默认模型，请先在「设置 → 模型」里配置默认模型')
  }
  const request = {
    provider: target.provider,
    model: target.model,
    messages: options.messages,
    ...(options.system ? { system: options.system } : {}),
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
  let sawText = false
  for await (const chunk of llm.stream(request)) {
    if (chunk.type === 'text-delta') {
      sawText = true
      options.onText(chunk.text)
      continue
    }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        const detail = chunk.reason?.failure?.message ?? (kind === 'aborted' ? '请求已取消' : '模型调用失败')
        throw new Error(detail)
      }
      if (kind === 'max-tokens' && !sawText) {
        throw new Error('模型没有返回可见内容（可能被 max tokens 截断）')
      }
    }
  }
}

function buildChatSystem(paper, question) {
  const parts = [CHAT_SYSTEM]
  parts.push('')
  parts.push(`【论文标题】${paper.title || '（未命名）'}`)
  partLines(parts, '【论文结构】', paper.outline)
  const context = selectContext(paper.paragraphs, question, 24000)
  if (context) {
    parts.push('【与问题最相关的论文片段】')
    parts.push(context)
  }
  return parts.join('\n')
}

function buildChatPrompt(history, question) {
  const lines = []
  const recent = history.slice(-8).filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
  if (recent.length > 0) {
    lines.push('以下是此前的对话：')
    for (const item of recent) {
      const who = item.role === 'user' ? '用户' : '助手'
      const text = String(item.content ?? '').slice(0, 2000)
      lines.push(`${who}：${text}`)
    }
    lines.push('')
  }
  lines.push('用户现在的问题：')
  lines.push(question)
  return lines.join('\n')
}

function partLines(parts, label, value) {
  if (!value) return
  parts.push(label)
  parts.push(String(value).slice(0, 4000))
}

/**
 * Pick the paragraphs most relevant to a question, preserving document order.
 * Falls back to the paper opening (title/abstract usually live there).
 */
function selectContext(paragraphs, question, budget) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) return ''
  const texts = paragraphs.map((p) => String(typeof p === 'string' ? p : p?.text ?? ''))
  const total = texts.reduce((sum, text) => sum + text.length, 0)
  if (total <= budget) return texts.map((text, i) => `[${i + 1}] ${text}`).join('\n')
  const keys = keywordsOf(question)
  const scored = texts.map((text, index) => {
    const lowered = text.toLowerCase()
    let score = 0
    for (const key of keys) {
      if (!key) continue
      if (lowered.includes(key)) score += key.length > 3 ? 3 : 2
    }
    if (index < 3) score += 2
    return { index, score, text }
  })
  scored.sort((a, b) => b.score - a.score)
  const picked = []
  let used = 0
  for (const item of scored) {
    if (used + item.text.length > budget && picked.length > 0) continue
    picked.push(item)
    used += item.text.length
    if (used >= budget * 0.9) break
  }
  picked.sort((a, b) => a.index - b.index)
  return picked.map((item) => `[${item.index + 1}] ${item.text}`).join('\n')
}

function keywordsOf(question) {
  const text = String(question ?? '')
  const latin = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []
  const cjk = Array.from(text).filter((ch) => /[\u4e00-\u9fff]/.test(ch))
  const grams = []
  for (let i = 0; i + 1 < cjk.length; i += 1) grams.push(cjk[i] + cjk[i + 1])
  return Array.from(new Set([...latin.slice(0, 12), ...grams.slice(0, 30)]))
}

function normalizePaper(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    title: typeof source.title === 'string' ? source.title : '',
    outline: typeof source.outline === 'string' ? source.outline : '',
    paragraphs: Array.isArray(source.paragraphs) ? source.paragraphs : [],
  }
}

/* ------------------------------------------------------------------ *
 * PDF / HTML extraction
 * ------------------------------------------------------------------ */

let pdfModule
let htmlModule

async function loadPdfModule() {
  if (pdfModule !== undefined) return pdfModule
  try {
    pdfModule = await import('./lib/pdf.js')
  } catch (error) {
    pdfModule = null
    throw new Error('PDF 解析模块不可用：' + messageOf(error))
  }
  return pdfModule
}

async function loadHtmlModule() {
  if (htmlModule !== undefined) return htmlModule
  try {
    htmlModule = await import('./lib/html-text.js')
  } catch {
    htmlModule = null
  }
  return htmlModule
}

async function extractPdf(bytes) {
  const mod = await loadPdfModule()
  const result = await mod.extractPdfText(bytes)
  const paragraphs = (result?.paragraphs ?? []).map(cleanParagraph).filter(Boolean)
  if (paragraphs.length === 0) throw new Error('PDF 中没有提取到可读文本（可能是扫描件或加密文档）')
  return { title: result?.title || titleFromParagraphs(paragraphs), paragraphs }
}

async function extractHtml(html) {
  const mod = await loadHtmlModule()
  if (mod && typeof mod.extractHtmlText === 'function') {
    const result = mod.extractHtmlText(html)
    const paragraphs = (result?.paragraphs ?? []).map(cleanParagraph).filter(Boolean)
    if (paragraphs.length > 0) return { title: result?.title || titleFromParagraphs(paragraphs), paragraphs }
  }
  return fallbackHtml(html)
}

function fallbackHtml(html) {
  const body = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
  const paragraphs = body
    .split(/\n{1,}/)
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 30)
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim()
  if (paragraphs.length === 0) throw new Error('没有从页面中提取到正文')
  return { title: decodeEntities(title) || titleFromParagraphs(paragraphs), paragraphs }
}

function cleanParagraph(text) {
  const value = String(text ?? '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
  return value
}

function titleFromParagraphs(paragraphs) {
  const first = paragraphs.find((text) => text.length > 6) ?? '未命名论文'
  return first.length > 120 ? first.slice(0, 120) + '…' : first
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
}

function looksLikePdf(bytes) {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
}

function decodeText(bytes, contentType) {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase()
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DSH-PaperReader/1.0)',
        accept: 'text/html,application/pdf;q=0.9,*/*;q=0.8',
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Fetch one URL and turn it into { title, paragraphs, kind, sourceUrl }. */
async function loadPaperFromUrl(url) {
  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new Error(`抓取失败：HTTP ${response.status}`)
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (contentType.includes('pdf') || looksLikePdf(bytes)) {
    const parsed = await extractPdf(bytes)
    return { ...parsed, kind: 'pdf', sourceUrl: url }
  }
  const html = decodeText(bytes, contentType)
  const parsed = await extractHtml(html)
  return { ...parsed, kind: 'html', sourceUrl: url }
}

/** Map an arXiv abstract link to its HTML full-text variant. */
function arxivHtmlVariant(url) {
  const match = /^https?:\/\/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(url)
  if (!match) return ''
  const id = match[1].replace(/v\d+$/, '')
  return `https://arxiv.org/html/${id}`
}

function totalChars(paragraphs) {
  return (paragraphs ?? []).reduce((sum, text) => sum + String(text ?? '').length, 0)
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过大小上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', (error) => reject(error))
  })
}

function requireMethod(req, res, method) {
  if ((req.method ?? '').toUpperCase() === method) return true
  res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: method })
  res.end(JSON.stringify({ error: `只支持 ${method}` }))
  return false
}

function json(res, status, value) {
  if (res.writableEnded) return
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()
  return {
    send(value) {
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify(value)}\n\n`)
    },
    done() {
      if (res.writableEnded) return
      res.write('data: [DONE]\n\n')
      res.end()
    },
  }
}

function failStream(res, error, logger) {
  logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
  const message = messageOf(error)
  if (res.headersSent) {
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`)
        res.end()
      } catch {
        res.destroy()
      }
    }
    return
  }
  json(res, 500, { error: message })
}

function clientAbort(res) {
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)
  return {
    signal: controller.signal,
    dispose() {
      res.off?.('close', onClose)
    },
  }
}

function messageOf(error) {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
