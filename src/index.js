import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { speakEdge, voiceCatalog } from './engine-edge.js'

export const name = 'dsh-voice-fish'
// webServer 用来找到本机 DSH 端口（朗读桥）和挂设置页的接口；timer 给轮询用。
export const inject = ['webServer', 'timer']

const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const STATE_DIR = join(LOCAL, 'dsh-voice-fish')
const STATE_FILE = join(STATE_DIR, 'state.json')
const LOG_FILE = join(STATE_DIR, 'voice.log')

const BRIDGE_SAY = '/dsh-tts-bridge/say'
const BRIDGE_STATE = '/dsh-tts-bridge/state'

const PHRASES = {
  SUCCESS: ['搞定啦', '成啦', '做好了哦'],
  ERROR: ['出岔子了，来看看', '卡住了哦', '这里没跑通'],
  APPROVAL: ['有个操作等你点一下', '要你点个确认哦'],
  HELLO: ['鱼鱼上线啦'],
  // 每轮开始动脑子之前先说一句（点名要的，原话不改）
  THINK: ['让我思考一下~'],
}

// 把技术性的任务名收拾成人话：去掉路径、代码片段、反引号，最长 12 字
// 洗不干净的（英文标识符、函数名、残留路径）干脆不提，别让语音里蹦出乱码一样的东西
function cleanTaskName(value) {
  const text = String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[A-Za-z]:\\[^\s，。；]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？!?；;：:]+$/u, '')
  if (!text) return ''
  if (/[A-Za-z]{4,}/.test(text)) return ''
  if (/^的|^和|^与|^ \+|[\s]的|的[\s]/.test(text)) return ''
  return text.length > 12 ? text.slice(0, 12) + '…' : text
}

// 这句里有没有不该念的东西（文件名、多级路径、下划线/驼峰标识符）
function looksTechnical(sentence) {
  if (/[A-Za-z0-9_\-]+\.(?:js|ts|tsx|jsx|mjs|cjs|json|md|py|css|scss|html|yml|yaml|txt|log|bat|ps1|exe|dll)\b/i.test(sentence)) return true
  if (/(?:^|[\s(（])(?:[A-Za-z]:)?(?:[\/\\][\w.\-]+){2,}/.test(sentence)) return true
  if (/[A-Za-z]+_[A-Za-z]+/.test(sentence)) return true
  if (/\b[a-z]+[A-Z][A-Za-z]+\b/.test(sentence)) return true
  if (/\b[a-z]+\.[a-z]+\b/i.test(sentence)) return true
  return false
}

// 把一条回复收拾成能念的摘要：代码块、表格、路径、链接、markdown 标记全扔掉，
// 只留前几句人话（要的是「结果概括」，不是整段正文）。
function summarizeSpeech(raw, limit = 80) {
  const max = clamp(limit, 20, 400, 80)
  const text = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s，。；、）)]+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/[*_~]/g, ' ')
    .replace(/\r/g, '\n')
    .trim()
  const flat = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  // 冒号也断句：中文里常用它引出下一段，不然「详见 src/index.js 里：……」会整句被拖下水
  const sentences = flat.split(/(?<=[。！？!?；;：:])/u).map((s) => s.trim()).filter(Boolean)
  // 带路径 / 文件名的句子整句跳过，别把 src/index.js 念成字母汤
  const spoken = sentences.filter((sentence) => !looksTechnical(sentence))
  const pool = spoken.length ? spoken : sentences
  if (flat.length <= max && spoken.length === sentences.length) return flat
  let out = ''
  for (const sentence of pool) {
    if (out && (out + sentence).length > max) break
    out += sentence
  }
  if (!out) out = flat.slice(0, max)
  if (out.length > max) out = out.slice(0, max)
  return out + (out.length < flat.length ? '…' : '')
}

function buildPhrase(kind, seed, task, owner = '菲') {
  const variants = PHRASES[kind] ?? PHRASES.SUCCESS
  const tail = variants[Math.abs(Math.trunc(Number(seed) || 0)) % variants.length]
  const name = cleanTaskName(task)
  const prefix = `${owner}，`
  if (name && kind === 'SUCCESS') return `${prefix}「${name}」${tail}`
  if (name && kind === 'ERROR') return `${prefix}「${name}」${tail}`
  return `${prefix}${tail}`
}

const DEFAULTS = Object.freeze({
  enabled: true,
  // 鱼鱼怎么称呼你
  ownerName: '菲',
  // edge = 用用户挑的神经音色（默认）；auto = 桥→edge→系统；bridge = 只用桥；sapi = 只用系统语音
  engine: 'edge',
  // 系统语音（仅作兜底）
  voice: 'Microsoft Huihui Desktop',
  rate: 0,
  volume: 100,
  // Edge 神经音色：用户自己挑的那副嗓子（engine = edge 时生效）
  // 晓伊 = 活泼俏皮的小姑娘，比晓晓更有「鱼鱼」那股劲儿
  edgeVoice: 'zh-CN-XiaoyiNeural',
  // 语速（%）和音调（Hz）：调音调用，-50 ~ +50
  edgeRate: 5,
  edgePitch: 12,
  // 神经音色连不上时，用系统语音兜一句（不然就是干等）
  edgeFallbackSapi: true,
  states: ['SUCCESS', 'ERROR', 'APPROVAL'],
  greeting: true,
  // 每轮开始思考时先说一句「让我思考一下~」
  thinking: true,
  // 每轮完成时念这一轮的「结果概括」，而不是干巴巴一句「搞定啦」
  readSummary: true,
  // 概括最多念几个字（太长会念很久）
  summaryMaxChars: 80,
  // 朗读桥的「自动朗读」开着时，我的整条回复本来就会被念出来，就不再念完成语，免得复读
  skipSuccessWhenBridgeAuto: true,
  // 朗读桥的「自动朗读」会把整段回复念出来（含代码），默认关掉，只念本插件的一句话
  bridgeAutoRead: false,
  // 新会话出现时自动加进朗读桥的「听谁」列表（默认关闭：太频繁）
  autoWatch: false,
  toolErrorCooldownMs: 15000,
  successCooldownMs: 2000,
})

function log(kind, message) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${kind} ${message}\n`, 'utf8')
  } catch {
    // 日志失败不能影响宿主
  }
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function sanitizeVoice(value) {
  return String(value ?? '').replace(/[^\w\s.\-]/g, '').trim()
}

// 只认长得像微软音色名的：zh-CN-XiaoxiaoNeural / zh-CN-liaoning-XiaobeiNeural
function sanitizeEdgeVoice(value) {
  const text = String(value ?? '').trim()
  return /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,12})+-[A-Za-z]+Neural$/.test(text) ? text : ''
}

function readOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function resolveConfig(base) {
  const merged = { ...DEFAULTS, ...(base && typeof base === 'object' ? base : {}), ...readOverrides() }
  const engine = ['auto', 'bridge', 'edge', 'sapi'].includes(merged.engine) ? merged.engine : DEFAULTS.engine
  return {
    enabled: merged.enabled !== false,
    engine,
    voice: sanitizeVoice(merged.voice) || DEFAULTS.voice,
    rate: clamp(merged.rate, -10, 10, DEFAULTS.rate),
    volume: clamp(merged.volume, 0, 100, DEFAULTS.volume),
    ownerName: String(merged.ownerName ?? DEFAULTS.ownerName).replace(/\s+/g, ' ').trim().slice(0, 20) || DEFAULTS.ownerName,
    edgeVoice: sanitizeEdgeVoice(merged.edgeVoice) || DEFAULTS.edgeVoice,
    edgeRate: clamp(merged.edgeRate, -50, 50, DEFAULTS.edgeRate),
    edgePitch: clamp(merged.edgePitch, -50, 50, DEFAULTS.edgePitch),
    edgeFallbackSapi: merged.edgeFallbackSapi !== false,
    states: Array.isArray(merged.states) ? merged.states.map(String) : [...DEFAULTS.states],
    greeting: merged.greeting === true,
    thinking: merged.thinking !== false,
    readSummary: merged.readSummary !== false,
    summaryMaxChars: clamp(merged.summaryMaxChars, 20, 400, DEFAULTS.summaryMaxChars),
    skipSuccessWhenBridgeAuto: merged.skipSuccessWhenBridgeAuto !== false,
    autoWatch: merged.autoWatch === true,
    bridgeAutoRead: merged.bridgeAutoRead === true,
    toolErrorCooldownMs: clamp(merged.toolErrorCooldownMs, 0, 600000, DEFAULTS.toolErrorCooldownMs),
    successCooldownMs: clamp(merged.successCooldownMs, 0, 60000, DEFAULTS.successCooldownMs),
  }
}

// ---------- 朗读桥（DeepSeek 网页端的声音）----------

function bridgeOrigin(ctx) {
  try {
    const origin = typeof ctx.webServer?.getOrigin === 'function' ? ctx.webServer.getOrigin() : undefined
    if (origin) return String(origin).replace(/\/+$/, '')
    const port = ctx.webServer?.port
    if (Number.isFinite(Number(port)) && Number(port) > 0) return `http://127.0.0.1:${Number(port)}`
  } catch {
    // 忽略：退回系统语音
  }
  return undefined
}

async function bridgeSay(origin, text) {
  const res = await fetch(origin + BRIDGE_SAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(2500),
  })
  if (!res.ok) return false
  const body = await res.json().catch(() => ({}))
  return body?.ok !== false
}

async function bridgeSetAuto(origin, value) {
  try {
    const res = await fetch(origin + '/dsh-tts-bridge/auto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auto: value === true }),
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return false
    const body = await res.json().catch(() => ({}))
    log('INFO', `bridge auto-read = ${String(body?.auto)}`)
    return body?.auto === (value === true)
  } catch (error) {
    log('WARN', `bridge set auto failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function bridgeAutoPlaying(origin) {
  try {
    const res = await fetch(origin + BRIDGE_STATE, { signal: AbortSignal.timeout(1200) })
    if (!res.ok) return false
    const body = await res.json()
    const watching = Array.isArray(body?.watching) ? body.watching.length : 0
    return body?.auto === true && watching > 0
  } catch {
    return false
  }
}

// ---------- 系统语音（兜底）----------

function speakScript(text, config) {
  const encoded = Buffer.from(String(text), 'utf8').toString('base64')
  return [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `try { $s.SelectVoice('${config.voice}') } catch { }`,
    `$s.Rate = ${config.rate}`,
    `$s.Volume = ${config.volume}`,
    `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    '$s.Speak($text)',
    '$s.Dispose()',
  ].join('; ')
}

function speakSapi(text, config) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', speakScript(text, config)],
        { windowsHide: true, stdio: 'ignore' },
      )
    } catch (error) {
      log('ERROR', `sapi spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      resolve(false)
      return
    }
    child.on('exit', () => resolve(true))
    child.on('error', (error) => {
      log('ERROR', `sapi failed: ${error instanceof Error ? error.message : String(error)}`)
      resolve(false)
    })
  })
}

// ---------- 事件 ----------

function isSubagent(session) {
  return session?.header?.origin === 'subagent' || Number(session?.header?.delegationDepth ?? 0) > 0
}

function sessionIdOf(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown-session')
}

export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console
  try {
    mount(ctx, config, logger)
  } catch (error) {
    logger.error?.(`dsh-voice-fish failed to activate: ${error instanceof Error ? error.message : String(error)}`)
    log('ERROR', `activate failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function mount(ctx, config, logger) {
  let queue = []
  let busy = false
  let disposed = false
  let lastApprovalKey
  let lastToolErrorAt = 0
  let lastSuccessAt = 0
  let lastText = ''
  let lastTextAt = 0
  let lastTask = ''

  const current = () => resolveConfig(config)

  const pump = async () => {
    if (busy || disposed) return
    const next = queue.shift()
    if (!next) return
    const cfg = current()
    if (!cfg.enabled) {
      queue = []
      return
    }
    busy = true
    try {
      const origin = bridgeOrigin(ctx)
      let spokenBy = 'none'
      // 试听可以强制走 edge；平时按配置来
      const wanted = next.forceEngine || cfg.engine
      const canBridge = wanted === 'auto' || wanted === 'bridge'
      const canEdge = wanted === 'auto' || wanted === 'edge'
      let canSapiFallback = false
      const canSapi = wanted === 'auto' || wanted === 'sapi'

      if (canBridge && origin) {
        try {
          if (await bridgeSay(origin, next.text)) spokenBy = 'bridge'
        } catch (error) {
          log('WARN', `bridge say failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (spokenBy === 'none' && canEdge) {
        try {
          await speakEdge({
            text: next.text,
            voice: next.voice || cfg.edgeVoice,
            rate: next.rate ?? cfg.edgeRate,
            pitch: next.pitch ?? cfg.edgePitch,
            volume: next.volume ?? cfg.volume,
            dir: STATE_DIR,
          })
          spokenBy = 'edge'
        } catch (error) {
          log('WARN', `edge say failed: ${error instanceof Error ? error.message : String(error)}`)
          // 网络抽风时别让她什么都听不到：退一步用系统语音
          if (wanted === 'edge' && cfg.edgeFallbackSapi !== false) canSapiFallback = true
        }
      }
      if (spokenBy === 'none' && (canSapi || canSapiFallback)) {
        await speakSapi(next.text, cfg)
        spokenBy = 'sapi'
      }
      log('INFO', `speak(${spokenBy}): ${next.text}`)
    } catch (error) {
      log('ERROR', `speak failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy = false
      if (queue.length > 0) void pump()
    }
  }

  const say = (text, extra) => {
    if (!text || disposed) return
    const now = Date.now()
    if (text === lastText && now - lastTextAt < 5000) return
    lastText = text
    lastTextAt = now
    if (queue.length >= 3) queue.shift()
    queue.push({ text, ...(extra && typeof extra === 'object' ? extra : null) })
    void pump()
  }

  let lastThinkKey = ''
  // 每一轮助手说了什么，收尾时拿来概括
  const turnTexts = new Map()

  const enabledFor = (kind) => {
    const cfg = current()
    return cfg.enabled && cfg.states.includes(kind)
  }

  const onEvent = (session, event) => {
    if (disposed || !event || typeof event.type !== 'string') return
    if (isSubagent(session)) return
    try {
      const seq = Number(event.seq ?? 0)
      const sessionId = sessionIdOf(session)

      // 每轮一开始动脑子，先说一句
      if (event.type === 'turn/start') {
        const key = `${sessionId}:${String(event.data?.turn ?? '')}`
        if (key === lastThinkKey) return
        lastThinkKey = key
        const cfg = current()
        if (!cfg.enabled || cfg.thinking === false) return
        say(PHRASES.THINK[0])
        return
      }

      // 攒这一轮助手说的话，收尾时概括成一句
      if (event.type === 'assistant/message') {
        const turn = String(event.data?.turn ?? '')
        if (!turn) return
        const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
        const text = blocks
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n\n')
          .trim()
        if (!text) return
        const key = `${sessionId}:${turn}`
        const list = turnTexts.get(key) || []
        list.push(text)
        if (list.length > 12) list.shift()
        turnTexts.set(key, list)
        if (turnTexts.size > 30) turnTexts.delete(turnTexts.keys().next().value)
        return
      }

      // 记一下当前在做什么，播报时带上一句人话；代码/路径由 cleanTaskName 洗掉
      if (event.type === 'todo/write') {
        const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
        const now = todos.find((todo) => todo?.status === 'in_progress')
          ?? todos.find((todo) => todo?.status === 'pending')
        if (now?.content) lastTask = String(now.content)
        return
      }

      if (event.type === 'approval/asked') {
        const key = `${sessionId}:${String(event.data?.id ?? '')}`
        if (key === lastApprovalKey) return
        lastApprovalKey = key
        if (enabledFor('APPROVAL')) say(buildPhrase('APPROVAL', seq, lastTask, current().ownerName))
        return
      }

      if (event.type === 'approval/decided') {
        lastApprovalKey = undefined
        return
      }

      if (event.type === 'tool/result' && event.data?.error) {
        const now = Date.now()
        if (now - lastToolErrorAt < current().toolErrorCooldownMs) return
        lastToolErrorAt = now
        if (enabledFor('ERROR')) say(buildPhrase('ERROR', seq, lastTask, current().ownerName))
        return
      }

      if (event.type === 'turn/end') {
        const kind = String(event.data?.reason?.kind ?? 'completed')
        const turnKey = `${sessionId}:${String(event.data?.turn ?? '')}`
        const pieces = turnTexts.get(turnKey) || []
        turnTexts.delete(turnKey)
        if (kind === 'completed') {
          const cfg = current()
          const now = Date.now()
          if (now - lastSuccessAt < cfg.successCooldownMs) return
          lastSuccessAt = now
          if (!enabledFor('SUCCESS')) return
          // 结果概括：只念这一轮最后说的那几句人话
          const summary = cfg.readSummary === false
            ? ''
            : summarizeSpeech(pieces.slice(-2).join('\n\n'), cfg.summaryMaxChars)
          const line = summary ? `${cfg.ownerName}，${summary}` : buildPhrase('SUCCESS', seq, lastTask, cfg.ownerName)
          const origin = bridgeOrigin(ctx)
          if (cfg.skipSuccessWhenBridgeAuto && origin && (cfg.engine === 'auto' || cfg.engine === 'bridge')) {
            void bridgeAutoPlaying(origin).then((auto) => {
              if (!auto) say(line)
            })
            return
          }
          say(line)
          lastTask = ''
          return
        }
        if (kind === 'aborted' || kind === 'blocked') return
        if (enabledFor('ERROR')) say(buildPhrase('ERROR', seq, lastTask, current().ownerName))
      }
    } catch (error) {
      logger.warn?.(`dsh-voice-fish failed to handle session event: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const offEvent = typeof ctx.on === 'function'
    ? ctx.on('session/event', onEvent, { global: true })
    : undefined

  // ---------- 新会话自动加入朗读桥的「听谁」----------
  const SEEN_FILE = join(STATE_DIR, 'seen-sessions.json')
  const readSeen = () => {
    try {
      const parsed = JSON.parse(readFileSync(SEEN_FILE, 'utf8'))
      return new Set(Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [])
    } catch {
      // 文件不存在 = 第一次运行：只记录现状，不去补加她已有的选择
      return undefined
    }
  }
  let seen = readSeen()
  const saveSeen = () => {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(SEEN_FILE, JSON.stringify({ ids: [...seen] }, null, 2), 'utf8')
    } catch {
      // 写不进去就下次再试
    }
  }

  const autoWatch = async () => {
    if (disposed || !current().autoWatch) return
    const origin = bridgeOrigin(ctx)
    if (!origin) return
    try {
      const res = await fetch(origin + '/dsh-tts-bridge/sessions', { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return
      const body = await res.json()
      const list = Array.isArray(body?.sessions) ? body.sessions : []
      if (!list.length) return
      if (!seen) {
        seen = new Set(list.map((session) => String(session?.id ?? '')).filter(Boolean))
        saveSeen()
        log('INFO', `auto-watch: 初始化 ${seen.size} 个会话`)
        return
      }
      let changed = false
      for (const session of list) {
        const id = String(session?.id ?? '')
        if (!id) continue
        if (session.watching) {
          if (!seen.has(id)) {
            seen.add(id)
            changed = true
          }
          continue
        }
        if (seen.has(id)) continue
        const watched = await fetch(origin + '/dsh-tts-bridge/watch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(2000),
        }).catch(() => undefined)
        if (watched?.ok) {
          seen.add(id)
          changed = true
          log('INFO', `auto-watch: 加入「${String(session.title ?? id)}」`)
        }
      }
      if (changed) saveSeen()
    } catch (error) {
      log('WARN', `auto-watch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      // 用原生定时器：cordis 的 ctx.interval 要 inject 'timer'，不该为这点事冒险
      const timer = setInterval(autoWatch, 20000)
      timer?.unref?.()
      const kickoff = setTimeout(() => void autoWatch(), 4000)
      kickoff.unref?.()
      return () => {
        clearInterval(timer)
        clearTimeout(kickoff)
      }
    })
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposed = true
      queue = []
      offEvent?.()
    })
  }

  // ---------- 设置页：挑音色、调语速、什么时候说话 ----------
  const PUBLIC_KEYS = [
    'enabled', 'ownerName', 'engine', 'voice', 'edgeVoice', 'edgeRate', 'edgePitch',
    'rate', 'volume', 'states', 'greeting', 'thinking', 'readSummary',
    'summaryMaxChars', 'bridgeAutoRead', 'autoWatch', 'skipSuccessWhenBridgeAuto',
  ]

  const publicConfig = (cfg) => {
    const out = {}
    for (const key of PUBLIC_KEYS) out[key] = cfg[key]
    return out
  }

  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 200000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const reply = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }

  // 只接受设置页会改的那几个键，别的一律不落盘
  const saveOverrides = (patch) => {
    const next = { ...readOverrides() }
    for (const key of PUBLIC_KEYS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
    }
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      log('ERROR', `save state failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return resolveConfig(config)
  }

  const route = (path, handler) => {
    if (typeof ctx.webServer?.register !== 'function') return
    const register = () =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' })
            res.end()
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            log('ERROR', `route ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
            try {
              reply(res, 500, { ok: false, error: '出错了' })
            } catch {}
          }
        },
      })
    if (typeof ctx.effect === 'function') ctx.effect(register)
    else register()
  }

  route('/dsh-voice-fish/config', async (req, res) => {
    if (req.method === 'POST') {
      const body = await readJson(req)
      const saved = saveOverrides(body && body.patch ? body.patch : body || {})
      log('INFO', `config saved: engine=${saved.engine} edgeVoice=${saved.edgeVoice} rate=${saved.edgeRate} pitch=${saved.edgePitch}`)
      reply(res, 200, { ok: true, config: publicConfig(saved) })
      return
    }
    const cfg = current()
    const catalog = await voiceCatalog(join(STATE_DIR, 'voices-cache.json'))
    reply(res, 200, { ok: true, config: publicConfig(cfg), catalog })
  })

  // 试听：永远用 Edge 音色（音色是这里挑的），插队播一句
  route('/dsh-voice-fish/preview', async (req, res) => {
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false })
      return
    }
    const body = await readJson(req)
    const cfg = current()
    const text = String((body && body.text) || `${cfg.ownerName}，我是鱼鱼，这个声音好听吗`).slice(0, 200)
    say(text, {
      forceEngine: 'edge',
      voice: sanitizeEdgeVoice(body && body.voice) || cfg.edgeVoice,
      rate: clamp(body && body.rate, -50, 50, cfg.edgeRate),
      pitch: clamp(body && body.pitch, -50, 50, cfg.edgePitch),
      volume: clamp(body && body.volume, 0, 100, cfg.volume),
    })
    reply(res, 200, { ok: true })
  })

  const initial = current()
  log('INFO', `activated: engine=${initial.engine} voice=${initial.voice} edgeVoice=${initial.edgeVoice} states=${initial.states.join(',')}`)
  logger.info?.('dsh-voice-fish activated')

  // 朗读桥的「自动朗读」会把我整段回复（含代码、表格、路径）都念出来。
  // 用户要的是简短生动的播报，所以这里把它关掉，改由本插件念一句人话。
  if (initial.enabled && initial.bridgeAutoRead === false) {
    const off = setTimeout(() => {
      const origin = bridgeOrigin(ctx)
      if (origin && !disposed) void bridgeSetAuto(origin, false)
    }, 3000)
    off.unref?.()
  }

  if (initial.enabled && initial.greeting) {
    const timer = setTimeout(() => {
      if (!disposed) say(buildPhrase('HELLO', Date.now(), '', initial.ownerName))
    }, 1200)
    timer.unref?.()
  }
}
