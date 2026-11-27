// Edge 神经语音（微软 Edge 网页端那套声音）
// 零依赖：WebSocket 帧和 Sec-MS-GEC v2 令牌都在这里自己算，不用装 python 包、不用 npm 依赖。
import { randomBytes, randomUUID } from 'node:crypto'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM = '143.0.3650.75'
const SEC_MS_GEC_VERSION = '2-' + CHROMIUM
const VOICES_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=' + TRUSTED

// ---------- Sec-MS-GEC v2（移植自 edge-tts 的 drm.py）----------
const U32 = 0xffffffff
const WIN_EPOCH = 11644473600

const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const SHA256_STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2]
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0,
  0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
]
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const SHA256_ADJUSTMENT = 0xc9dc06a7
const SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.slice(0, 14).concat([SHA256_ADJUSTMENT], SHA256_ROUND_CONSTANTS.slice(15))
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0
const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038], [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c], [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da], [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
]
const CS64_FACTOR = 0x82893933
const CS64_ADJUSTMENT0 = 0xf2f90b1a
const CS64_ADJUSTMENT1 = 0x0b1a0000

const mul = (a, b) => Math.imul(a | 0, b | 0) >>> 0
const add = (...xs) => {
  let s = 0
  for (const x of xs) s = (s + (x >>> 0)) % 0x100000000
  return s >>> 0
}
const rol16 = (v) => (((v >>> 0) << 16) | ((v >>> 0) >>> 16)) >>> 0
const rotr = (v, n) => (((v >>> 0) >>> n) | ((v >>> 0) << (32 - n))) >>> 0

function wordsLe4Even(bytes) {
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4)
  bytes.copy(padded)
  const words = []
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i))
  if (words.length % 2) words.push(0)
  return words
}

function sigma0(v) {
  v = v >>> 0
  return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0
}
function sigma1(v) {
  v = v >>> 0
  return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0
}

function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state.map((x) => x >>> 0)
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS
  const aligned = Math.min(64, Math.ceil((firstRound + 7) / 8) * 8)
  for (let i = firstRound; i < aligned; i++) {
    const t1 = add(h, rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), g ^ (e & (f ^ g)), constants[i], words[i])
    const t2 = add((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0, ((a & b) | (c & (a | b))) >>> 0)
    const nextA = add(t1, t2)
    h = g; g = f; f = e; e = add(d, t1); d = c; c = b; b = a; a = nextA
  }
  for (let i = aligned; i < 64; i += 8) {
    let t1
    t1 = add(h, rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), g ^ (e & (f ^ g)), constants[i], words[i])
    d = add(d, t1)
    h = add(t1, (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0, ((a & b) | (c & (a | b))) >>> 0)
    t1 = add(g, rotr(d, 6) ^ rotr(d, 11) ^ rotr(d, 25), f ^ (d & (e ^ f)), constants[i + 1], words[i + 1])
    c = add(c, t1)
    g = add(t1, (rotr(h, 2) ^ rotr(h, 13) ^ rotr(h, 22)) >>> 0, ((h & a) | (b & (h | a))) >>> 0)
    t1 = add(f, rotr(c, 6) ^ rotr(c, 11) ^ rotr(c, 25), e ^ (c & (d ^ e)), constants[i + 2], words[i + 2])
    b = add(b, t1)
    f = add(t1, (rotr(g, 2) ^ rotr(g, 13) ^ rotr(g, 22)) >>> 0, ((g & h) | (a & (g | h))) >>> 0)
    t1 = add(e, rotr(b, 6) ^ rotr(b, 11) ^ rotr(b, 25), d ^ (b & (c ^ d)), constants[i + 3], words[i + 3])
    a = add(a, t1)
    e = add(t1, (rotr(f, 2) ^ rotr(f, 13) ^ rotr(f, 22)) >>> 0, ((f & g) | (h & (f | g))) >>> 0)
    t1 = add(d, rotr(a, 6) ^ rotr(a, 11) ^ rotr(a, 25), c ^ (a & (b ^ c)), constants[i + 4], words[i + 4])
    h = add(h, t1)
    d = add(t1, (rotr(e, 2) ^ rotr(e, 13) ^ rotr(e, 22)) >>> 0, ((e & f) | (g & (e | f))) >>> 0)
    t1 = add(c, rotr(h, 6) ^ rotr(h, 11) ^ rotr(h, 25), b ^ (h & (a ^ b)), constants[i + 5], words[i + 5])
    g = add(g, t1)
    c = add(t1, (rotr(d, 2) ^ rotr(d, 13) ^ rotr(d, 22)) >>> 0, ((d & e) | (f & (d | e))) >>> 0)
    t1 = add(b, rotr(g, 6) ^ rotr(g, 11) ^ rotr(g, 25), a ^ (g & (h ^ a)), constants[i + 6], words[i + 6])
    f = add(f, t1)
    b = add(t1, (rotr(c, 2) ^ rotr(c, 13) ^ rotr(c, 22)) >>> 0, ((c & d) | (e & (c | d))) >>> 0)
    t1 = add(a, rotr(f, 6) ^ rotr(f, 11) ^ rotr(f, 25), h ^ (f & (g ^ h)), constants[i + 7], words[i + 7])
    e = add(e, t1)
    a = add(t1, (rotr(b, 2) ^ rotr(b, 13) ^ rotr(b, 22)) >>> 0, ((b & c) | (d & (b | c))) >>> 0)
  }
  return [a, b, c, d, e, f, g, h]
}

function expandSchedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2], y = words[i - 15]
    const s1 = ((x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10)) >>> 0
    const s0 = ((y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3)) >>> 0
    words.push(add(s1, words[i - 7], s0, words[i - 16]))
  }
}

function sha256Init(data) {
  const words = new Array(14).fill(0)
  words.push(data.readUIntBE(0, 3))
  words.push(data.readUIntBE(3, 4))
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16]
    if (i - 2 >= 14) {
      value = add(value, (i === 16 ? sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT : sigma1(words[i - 2])) >>> 0)
    }
    if (i - 7 >= 14) value = add(value, words[i - 7])
    if (i - 15 >= 14) {
      value = add(value, (i === 29 ? sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT : sigma0(words[i - 15])) >>> 0)
    }
    words.push(value & U32)
  }
  words.push(
    add(sigma1(words[28]), words[23], sigma0(words[15]), words[14], SHA256_ADJUSTMENT, add(0, -SHA256_ROUND_CONSTANTS[14])),
  )
  expandSchedule(words, 31)
  const working = sha256Rounds(SHA256_STATE, words, 14)
  return SHA256_INITIAL.map((x, i) => add(x, working[i]))
}

function sha256Digest(data) {
  const length = 57 + data.length
  const padLen = (((55 - length) % 64) + 64) % 64
  const tail = Buffer.alloc(8)
  tail.writeUInt32BE(Math.floor((length * 8) / 0x100000000), 0)
  tail.writeUInt32BE((length * 8) >>> 0, 4)
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(padLen), tail])
  let state = sha256Init(data.subarray(0, 7))
  for (let off = 0; off < padded.length; off += 64) {
    const words = []
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(off + i * 4))
    expandSchedule(words)
    const working = sha256Rounds(state, words)
    state = state.map((x, i) => add(x, working[i]))
  }
  const out = Buffer.alloc(32)
  state.forEach((x, i) => out.writeUInt32BE(x >>> 0, i * 4))
  return out
}

function cs64Digest(data, digest) {
  const keyA = digest.readUInt32LE(0) | 1
  const keyB = digest.readUInt32LE(4) | 1
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)]
  const terms = []
  const offsets = []
  CS64_COEFFICIENTS.forEach(([coef, off], index) => {
    terms.push(mul(coef, factors[index % 2]))
    offsets.push(off >>> 0)
  })
  const words = wordsLe4Even(Buffer.concat([Buffer.from([0]), data]))
  words.forEach((word, index) => {
    const even = index % 2 === 0
    let term = mul(word, even ? keyA : keyB)
    let offset = mul(rol16(word), even ? 0xef0569fb : 0xc31713db)
    if (index === 0) {
      term = add(term, mul(CS64_ADJUSTMENT0, factors[0]))
      offset = add(offset, CS64_ADJUSTMENT1)
    }
    terms.push(term)
    offsets.push(offset)
  })
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1]
    let t = rol16(add(offsets[i], x))
    let q = mul(t, 0x76f50f34)
    swapAcc = add(swapAcc, mul(rol16(q), 0xc3efea97), q)
    t = rol16(add(offsets[i + 1], y))
    q = mul(t, 0x1881ce3c)
    swapLast = add(mul(rol16(q), 0x35bd1ec9), q)
    swapAcc = add(swapAcc, swapLast)

    state = add(mul(state, keyA), x)
    state = mul(rol16(state), 0xcf98b111)
    state = mul(rol16(state), 0x87085b9f)
    state = mul(rol16(state), 0x12ceb96d)
    state = mul(rol16(state), 0x257e1d83)
    acc = add(acc, state)
    t = add(mul(state, keyB), y)
    t = mul(rol16(t), 0xa27416f5)
    t = mul(rol16(t), 0xd38396ff)
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69)
    acc = add(acc, state)
  }
  return [swapLast ^ state, swapAcc ^ acc]
}

export function secMsGecV2(unixTimestamp = Date.now() / 1000) {
  let ticks = Math.floor(unixTimestamp + WIN_EPOCH)
  ticks -= ticks % 300
  ticks *= 1e7
  const data = Buffer.from(String(ticks) + TRUSTED, 'ascii')
  const digest = sha256Digest(data)
  const [a, b] = cs64Digest(data, digest)
  const packed = Buffer.alloc(8)
  packed.writeUInt32LE(a >>> 0, 0)
  packed.writeUInt32LE(b >>> 0, 4)
  return packed.toString('hex').toUpperCase() + '-' + digest.toString('hex').toUpperCase()
}

// ---------- WebSocket 帧 ----------
function buildFrame(opcode, payload) {
  const len = payload.length
  const mask = randomBytes(4)
  let head
  if (len < 126) {
    head = Buffer.alloc(2)
    head[1] = 0x80 | len
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[1] = 0x80 | 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[1] = 0x80 | 127
    head.writeUInt32BE(Math.floor(len / 0x100000000), 2)
    head.writeUInt32BE(len >>> 0, 6)
  }
  head[0] = 0x80 | opcode
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, masked])
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cleanText(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .slice(0, 3000)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 合成一句话，返回 mp3 Buffer。网络抖一下会自己重试两回。 */
export async function synthesize(options) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await synthesizeOnce(options)
    } catch (error) {
      lastError = error
      if (attempt < 2) await sleep(250 * (attempt + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function synthesizeOnce({ text, voice, rate = 0, pitch = 0, volume = 0, timeoutMs = 20000 }) {
  const body = cleanText(text)
  const rateStr = (rate >= 0 ? '+' : '') + Math.round(rate) + '%'
  const pitchStr = (pitch >= 0 ? '+' : '') + Math.round(pitch) + 'Hz'
  const volumeStr = (volume >= 0 ? '+' : '') + Math.round(volume) + '%'

  return new Promise((resolve, reject) => {
    const path = '/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + TRUSTED
      + '&ConnectionId=' + randomUUID().replace(/-/g, '')
      + '&Sec-MS-GEC=' + secMsGecV2()
      + '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION
    const req = https.request({
      host: 'speech.platform.bing.com',
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: 'muid=' + randomUUID().replace(/-/g, '').toUpperCase() + ';',
      },
    })

    let settled = false
    const audio = []
    const finish = (err, buf) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { req.destroy() } catch {}
      if (err) reject(err)
      else resolve(buf)
    }
    const timer = setTimeout(() => finish(new Error('合成超时')), timeoutMs)

    req.on('response', (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => finish(new Error('握手被拒：HTTP ' + res.statusCode + ' ' + raw.slice(0, 160))))
    })
    req.on('error', (error) => finish(error))

    req.on('upgrade', (res, socket) => {
      if (res.statusCode !== 101) {
        socket.destroy()
        finish(new Error('握手被拒：HTTP ' + res.statusCode))
        return
      }
      socket.setNoDelay(true)
      let buf = Buffer.alloc(0)
      let frags = []
      let fragOpcode = 0

      const sendText = (str) => socket.write(buildFrame(0x1, Buffer.from(str, 'utf8')))

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) return
          const b0 = buf[0]
          const b1 = buf[1]
          const fin = (b0 & 0x80) !== 0
          const opcode = b0 & 0x0f
          const masked = (b1 & 0x80) !== 0
          let len = b1 & 0x7f
          let offset = 2
          if (len === 126) {
            if (buf.length < 4) return
            len = buf.readUInt16BE(2)
            offset = 4
          } else if (len === 127) {
            if (buf.length < 10) return
            len = Number(buf.readBigUInt64BE(2))
            offset = 10
          }
          let maskKey = null
          if (masked) {
            if (buf.length < offset + 4) return
            maskKey = buf.subarray(offset, offset + 4)
            offset += 4
          }
          if (buf.length < offset + len) return
          let payload = buf.subarray(offset, offset + len)
          if (maskKey) {
            const copy = Buffer.from(payload)
            for (let i = 0; i < copy.length; i++) copy[i] ^= maskKey[i & 3]
            payload = copy
          }
          buf = buf.subarray(offset + len)

          if (opcode === 0x9) {
            socket.write(buildFrame(0xa, payload))
            continue
          }
          if (opcode === 0x8) {
            finish(audio.length ? null : new Error('连接被服务端关闭'))
            return
          }
          if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
            if (opcode !== 0x0) fragOpcode = opcode
            frags.push(payload)
            if (!fin) continue
            const full = Buffer.concat(frags)
            frags = []
            if (fragOpcode === 0x1) {
              const head = full.toString('utf8')
              if (head.indexOf('Path:turn.end') >= 0) {
                finish(audio.length ? null : new Error('没有收到音频'), Buffer.concat(audio))
                return
              }
            } else if (fragOpcode === 0x2) {
              if (full.length < 2) continue
              const headerLen = full.readUInt16BE(0)
              const header = full.subarray(2, 2 + headerLen).toString('utf8')
              if (header.indexOf('Path:audio') >= 0) audio.push(full.subarray(2 + headerLen))
            }
          }
        }
      })
      socket.on('error', (error) => finish(error))
      socket.on('close', () => finish(audio.length ? null : new Error('连接断开了'), Buffer.concat(audio)))

      setTimeout(() => {
        const stamp = new Date().toUTCString()
        sendText(
          'X-Timestamp:' + stamp + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
          + JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                  outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
                },
              },
            },
          }),
        )
        const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
          + "<voice name='" + escapeXml(voice) + "'>"
          + "<prosody pitch='" + pitchStr + "' rate='" + rateStr + "' volume='" + volumeStr + "'>"
          + escapeXml(body)
          + '</prosody></voice></speak>'
        sendText(
          'X-RequestId:' + randomUUID().replace(/-/g, '') + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:'
          + stamp + 'Z\r\nPath:ssml\r\n\r\n' + ssml,
        )
      }, 40)
    })

    req.end()
  })
}

// ---------- 播放 ----------
// PowerShell 的 MediaPlayer 播 mp3，路径走环境变量，免去引号转义
const PLAY_SCRIPT = [
  'Add-Type -AssemblyName PresentationCore',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  '$p.Open([uri]$env:DSH_VOICE_MP3)',
  '$p.Volume = [double]$env:DSH_VOICE_VOL',
  '$p.Play()',
  '$t = 0',
  'while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 4000) { Start-Sleep -Milliseconds 60; $t += 60 }',
  '$ms = if ($p.NaturalDuration.HasTimeSpan) { [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds } else { 5000 }',
  'Start-Sleep -Milliseconds ($ms + 220)',
  '$p.Close()',
].join('; ')

let playChain = Promise.resolve()

/** 播放一个 mp3 文件，播完才 resolve。多次调用会排队，不会叠在一起。 */
export function playMp3(file, volumePercent = 100) {
  const run = () => new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PLAY_SCRIPT], {
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          DSH_VOICE_MP3: file,
          DSH_VOICE_VOL: String(Math.max(0, Math.min(100, Number(volumePercent) || 0)) / 100),
        },
      })
    } catch {
      resolve(false)
      return
    }
    const cap = setTimeout(() => { try { child.kill() } catch {} }, 120000)
    child.on('exit', () => { clearTimeout(cap); resolve(true) })
    child.on('error', () => { clearTimeout(cap); resolve(false) })
  })
  playChain = playChain.then(run, run)
  return playChain
}

// ---------- 音色目录 ----------
// 中文名 + 一句话风格（微软列表里没有这些，自己标注；没标到的就显示英文名）
export const VOICE_NOTES = {
  'zh-CN-XiaoxiaoNeural': { name: '晓晓', note: '温柔亲切，最像日常说话' },
  'zh-CN-XiaoyiNeural': { name: '晓伊', note: '活泼俏皮，小姑娘' },
  'zh-CN-XiaochenNeural': { name: '晓辰', note: '知性温和' },
  'zh-CN-XiaohanNeural': { name: '晓涵', note: '柔声细语' },
  'zh-CN-XiaomengNeural': { name: '晓梦', note: '软糯可爱' },
  'zh-CN-XiaomoNeural': { name: '晓墨', note: '清冷文气' },
  'zh-CN-XiaoqiuNeural': { name: '晓秋', note: '沉稳耐听' },
  'zh-CN-XiaoruiNeural': { name: '晓睿', note: '成熟一点的女声' },
  'zh-CN-XiaoshuangNeural': { name: '晓双', note: '童声，小女孩' },
  'zh-CN-XiaoxuanNeural': { name: '晓萱', note: '清亮爽利' },
  'zh-CN-XiaoyanNeural': { name: '晓颜', note: '温柔偏成熟' },
  'zh-CN-XiaoyouNeural': { name: '晓悠', note: '童声，奶声奶气' },
  'zh-CN-XiaozhenNeural': { name: '晓甄', note: '干练知性' },
  'zh-CN-YunxiNeural': { name: '云希', note: '阳光少年' },
  'zh-CN-YunxiaNeural': { name: '云夏', note: '小男孩' },
  'zh-CN-YunyangNeural': { name: '云扬', note: '正经播音腔' },
  'zh-CN-YunjianNeural': { name: '云健', note: '激情解说腔' },
  'zh-CN-YunfengNeural': { name: '云枫', note: '低沉磁性' },
  'zh-CN-YunhaoNeural': { name: '云皓', note: '商务干练' },
  'zh-CN-YunyeNeural': { name: '云野', note: '沉稳讲故事' },
  'zh-CN-YunzeNeural': { name: '云泽', note: '厚实温和' },
  'zh-CN-liaoning-XiaobeiNeural': { name: '晓北（东北话）', note: '东北口音，逗' },
  'zh-CN-shaanxi-XiaoniNeural': { name: '晓妮（陕西话）', note: '陕西口音' },
  'zh-HK-HiuMaanNeural': { name: '曉曼（粤语）', note: '粤语女声' },
  'zh-HK-HiuGaaiNeural': { name: '曉佳（粤语）', note: '粤语女声' },
  'zh-HK-WanLungNeural': { name: '雲龍（粤语）', note: '粤语男声' },
  'zh-TW-HsiaoChenNeural': { name: '曉臻（台湾）', note: '台湾腔女声' },
  'zh-TW-HsiaoYuNeural': { name: '曉雨（台湾）', note: '台湾腔女声' },
  'zh-TW-YunJheNeural': { name: '雲哲（台湾）', note: '台湾腔男声' },
}

const FALLBACK_CATALOG = Object.keys(VOICE_NOTES).map((id) => ({
  id,
  name: VOICE_NOTES[id].name,
  note: VOICE_NOTES[id].note,
  gender: id.indexOf('Yun') >= 0 || id.indexOf('Wan') >= 0 || id.indexOf('YunJhe') >= 0 ? '男' : '女',
  locale: id.slice(0, 5),
}))

const CACHE_MS = 24 * 3600 * 1000

/** 拉一份音色清单（带 1 天缓存，网络不通就用内置那几款）。 */
export async function voiceCatalog(cacheFile) {
  try {
    if (cacheFile) {
      const stat = statSync(cacheFile)
      if (Date.now() - stat.mtimeMs < CACHE_MS) {
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
        if (Array.isArray(cached?.voices) && cached.voices.length) return cached.voices
      }
    }
  } catch {}

  const fromBuiltin = () => FALLBACK_CATALOG
  try {
    const res = await fetch(VOICES_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return fromBuiltin()
    const list = await res.json()
    const mine = (Array.isArray(list) ? list : [])
      .filter((item) => /^zh-(CN|HK|TW)/.test(String(item?.ShortName || '')))
      .map((item) => {
        const id = String(item.ShortName)
        const note = VOICE_NOTES[id]
        return {
          id,
          name: note?.name || String(item.FriendlyName || id).replace(/^Microsoft\s*/, '').replace(/\s*-?\s*Chinese.*$/, ''),
          note: note?.note || '',
          gender: item.Gender === 'Male' ? '男' : item.Gender === 'Female' ? '女' : '',
          locale: String(item.Locale || id.slice(0, 5)),
        }
      })
    if (!mine.length) return fromBuiltin()
    if (cacheFile) {
      try {
        mkdirSync(dirname(cacheFile), { recursive: true })
        writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), voices: mine }), 'utf8')
      } catch {}
    }
    return mine
  } catch {
    return fromBuiltin()
  }
}

/** 合成 → 写临时文件 → 播放 → 删除。返回是否真的出声。 */
export async function speakEdge({ text, voice, rate = 0, pitch = 0, volume = 100, dir }) {
  const mp3 = await synthesize({ text, voice, rate, pitch })
  const file = join(dir, 'say-' + process.pid + '-' + Date.now() + '.mp3')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, mp3)
  try {
    return await playMp3(file, volume)
  } finally {
    setTimeout(() => {
      try { unlinkSync(file) } catch {}
    }, 2000)
  }
}
