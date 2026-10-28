/**
 * DSH 会话群聊插件
 *
 * 目标：让已经开着的多个会话彼此聊天，但**绝不共享工作区文件**。
 *
 * 设计边界
 * - 只搬运文本；插件从不读、不写任何会话的文件。
 * - 工作区路径仅用于展示，让用户分清谁是谁。
 * - 投递走 Harness 官方通道 agent.followup(userMessage)，
 *   消息对象按宿主 createMessage 的等价形状自建，不依赖任何 @deepseek-ai 包。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

export const inject = ['tools', 'agents']

const DEFAULT_CONFIG = {
  maxHistory: 200,
  maxMembersPerGroup: 20,
  wakeOnDeliver: true,
  scanHeadFrames: 40,
  ratePerMinute: 3,
  contextMessages: 2,
  // 回复意愿档位：cautious（克制）/ balanced（平衡）/ active（活跃）
  replyEagerness: 'balanced',
  stateDir: join(homedir(), '.dsh', 'session-chat'),
}

/** 三档回复意愿的提示语；改这里就能改投递给 AI 的措辞 */
const EAGERNESS_NOTES = {
  cautious: {
    host: '主人发来的群聊消息。请正常回应，简短一两句就够。',
    mention: '群里 @ 了你。请正常回应，简短一两句。',
    peer: '另一个 AI 会话的群聊发言，知情即可，不要主动接话，避免无限来回。',
  },
  balanced: {
    host: '主人发来的群聊消息。请正常回应，简短一两句就够。',
    mention: '群里 @ 了你。请正常回应，简短一两句。',
    peer: '另一个 AI 会话的群聊发言。你是这条的当事人、或者确实有想补充的，可以接一句；没啥可说就不用回。',
  },
  active: {
    host: '主人发来的群聊消息。请积极回应，别敷衍。',
    mention: '群里 @ 了你。请积极回应。',
    peer: '另一个 AI 会话的群聊发言。你可以自行判断要不要接话——想聊就聊，但别为了接话而接话。',
  },
}

// 版本自报：diag 会打出来，用来确认宿主到底加载的是哪一版
const PLUGIN_VERSION = '1.13.0'

/**
 * 读磁盘上 package.json 的版本。
 * 它和内存里的 PLUGIN_VERSION 不一致，就说明「改了源码但没重启」——
 * 这个对照是给用户看的，避免反复误判。
 */
function readDiskVersion() {
  try {
    const path = fileURLToPath(new URL('./package.json', import.meta.url))
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return String(data.version || '')
  } catch {
    return ''
  }
}

/**
 * 磁盘上的 client.js 特征检查。
 * 注意边界：这只证明「代码在磁盘上」，不证明 Web 端已加载。
 * 三态：① 缺失=没写 ② 有但运行版本旧=没重启 ③ 有且版本一致=大概率生效。
 */
function checkClientFeatures() {
  try {
    const path = fileURLToPath(new URL('./client.js', import.meta.url))
    const src = readFileSync(path, 'utf8')
    return {
      atButton: src.includes('插入 @成员'),
      bubbleAvatar: src.includes("key: 'av'"),
      versionChip: src.includes('版本对照'),
      avatarPicker: src.includes('点一张设成自己的头像'),
    }
  } catch {
    return null
  }
}

// 面板里“以主人身份直接发言”的虚拟身份：不绑定任何会话，也不占用任何会话的昵称
const HOST_ID = '__host__'
const HOST_NAME = '主人'

/**
 * 等价于宿主 dsh-llm 的 createUserMessage：
 *   createMessage(input) -> deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
 *   createUserMessage(input) -> createMessage({ ...input, role: 'user' })
 * 这样不依赖 @deepseek-ai/dsh-llm 能否被解析。
 */
function makeUserMessage(text) {
  const message = structuredClone({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    id: randomUUID(),
  })
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const inner of Object.values(value)) freeze(inner)
      Object.freeze(value)
    }
    return value
  }
  return freeze(message)
}

export async function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }

  // 状态落盘位置（默认 ~/.dsh/session-chat，Host 进程可写；测试可覆盖）
  const stateDir = String(cfg.stateDir || join(homedir(), '.dsh', 'session-chat'))
  const stateFile = join(stateDir, 'state.json')

  // 独立头像库：自己的目录，不再借用表情包
  const avatarDir = join(stateDir, 'avatars')
  // 群聊记录目录（Markdown，方便直接翻看）
  const roomsDir = join(stateDir, 'rooms')
  const AVATAR_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
  const AVATAR_MAX_BYTES = 400 * 1024
  const AVATAR_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }

  function listAvatars() {
    try {
      if (!existsSync(avatarDir)) return []
      const entries = readdirSync(avatarDir, { withFileTypes: true })
      const rows = []
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const ext = extname(entry.name).toLowerCase()
        if (!AVATAR_EXT.has(ext)) continue
        let size = 0
        try {
          size = statSync(join(avatarDir, entry.name)).size
        } catch {
          continue
        }
        if (size > AVATAR_MAX_BYTES) continue
        rows.push({ id: entry.name, name: entry.name, bytes: size })
      }
      rows.sort((a, b) => a.name.localeCompare(b.name))
      return rows
    } catch {
      return []
    }
  }

  function readAvatarDataUrl(name) {
    try {
      const safe = basename(String(name || ''))
      if (!safe) return null
      const ext = extname(safe).toLowerCase()
      if (!AVATAR_EXT.has(ext)) return null
      const full = join(avatarDir, safe)
      if (!existsSync(full)) return null
      const buf = readFileSync(full)
      if (buf.length > AVATAR_MAX_BYTES) return null
      return 'data:' + (AVATAR_MIME[ext] || 'image/png') + ';base64,' + buf.toString('base64')
    } catch {
      return null
    }
  }

  /** 保存一张上传的头像（dataUrl 形式），返回文件名 */
  function saveAvatar(originalName, dataUrl) {
    const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(String(dataUrl || '').trim())
    if (!match) return { ok: false, error: '不是合法的图片 dataUrl' }
    const mime = match[1].toLowerCase()
    const buf = Buffer.from(match[2], 'base64')
    if (!buf.length) return { ok: false, error: '图片内容为空' }
    if (buf.length > AVATAR_MAX_BYTES) {
      return { ok: false, error: `图片太大（${Math.round(buf.length / 1024)}KB），上限 ${AVATAR_MAX_BYTES / 1024}KB` }
    }
    const ext = Object.keys(AVATAR_MIME).find((k) => AVATAR_MIME[k] === mime)
    if (!ext) return { ok: false, error: '只支持 png / jpg / webp / gif' }

    mkdirSync(avatarDir, { recursive: true })
    const base = basename(String(originalName || 'avatar')).replace(/\.[^.]+$/, '')
    const safeBase =
      base
        .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
        .replace(/^[._]+/, '')
        .slice(0, 40) || 'avatar'
    let fileName = safeBase + ext
    let i = 1
    while (existsSync(join(avatarDir, fileName))) {
      fileName = safeBase + '-' + i + ext
      i += 1
      if (i > 999) break
    }
    writeFileSync(join(avatarDir, fileName), buf)
    return { ok: true, name: fileName, bytes: buf.length }
  }

  /** @type {Map<string, {id:string,name:string,owner:string,members:Set<string>,messages:Array<object>,createdAt:number}>} */
  const groups = new Map()
  /** @type {Map<string, string>} */
  const identities = new Map()
  /** @type {Map<string, Array<{groupId:string,text:string}>>} 离线待补发 */
  const pending = new Map()

  // 限流：按「每个 AI（会话）」计，默认每分钟 3 条
  const rate = { perMinute: Number(cfg.ratePerMinute) > 0 ? Number(cfg.ratePerMinute) : 3, paused: false }
  /** @type {Map<string, {windowStart:number, count:number}>} */
  const usage = new Map()

  /** provider -> { at, models } 缓存，避免每次打开设置都去问端点 */
  const modelCache = new Map()

  // 戳一戳冷却：同一对人 3 秒内只戳一次，防止面板连点刷屏
  const pokeCooldown = new Map()
  const POKE_COOLDOWN_MS = 3000

  // 「正在输入」状态：只在面板里显示，不给任何会话投递
  const typingState = new Map() // groupId -> Map(sessionId -> ts)
  const TYPING_TTL_MS = 6000

  function markTyping(groupId, sessionId) {
    if (!groupId || !sessionId) return
    if (!typingState.has(groupId)) typingState.set(groupId, new Map())
    typingState.get(groupId).set(sessionId, Date.now())
  }

  function typingList(groupId, exceptId) {
    const bucket = typingState.get(groupId)
    if (!bucket) return []
    const now = Date.now()
    const rows = []
    for (const [id, ts] of bucket) {
      if (now - ts > TYPING_TTL_MS) {
        bucket.delete(id)
        continue
      }
      if (id === exceptId) continue
      rows.push({ id, name: displayName(id), at: ts })
    }
    return rows
  }

  // AI 路由：决定一条群聊消息该唤醒谁。mode='off' 表示全员推送。
  const router = { mode: 'off', provider: '', model: '' }

  // 回复意愿档位，控制投递给 AI 的提示措辞
  let eagerness = EAGERNESS_NOTES[cfg.replyEagerness] ? cfg.replyEagerness : 'balanced'
  const eagernessNotes = () => EAGERNESS_NOTES[eagerness] || EAGERNESS_NOTES.balanced

  // ---- 持久化：群组、历史、昵称、限流、路由配置 --------------------------
  function loadState() {
    try {
      if (!existsSync(stateFile)) return
      const raw = readFileSync(stateFile, 'utf8')
      if (!raw || !raw.trim()) return
      const data = JSON.parse(raw)
      if (data.rate && Number.isFinite(Number(data.rate.perMinute))) {
        rate.perMinute = Math.max(1, Math.min(120, Number(data.rate.perMinute)))
        rate.paused = Boolean(data.rate.paused)
      }
      if (data.router) {
        if (EAGERNESS_NOTES[data.eagerness]) eagerness = data.eagerness
    router.mode = data.router.mode === 'ai' ? 'ai' : 'off'
        router.provider = String(data.router.provider || '')
        router.model = String(data.router.model || '')
      }
      if (data.identities && typeof data.identities === 'object') {
        for (const [key, value] of Object.entries(data.identities)) {
          if (typeof value === 'string' && value) identities.set(key, value)
        }
      }
      if (Array.isArray(data.groups)) {
        for (const g of data.groups) {
          if (!g || !g.id) continue
          groups.set(g.id, {
            id: String(g.id),
            name: String(g.name || '群组'),
            owner: String(g.owner || ''),
            members: new Set(Array.isArray(g.members) ? g.members : []),
            joinedAt: g.joinedAt && typeof g.joinedAt === 'object' ? { ...g.joinedAt } : {},
            avatars: g.avatars && typeof g.avatars === 'object' ? { ...g.avatars } : {},
            messages: Array.isArray(g.messages) ? g.messages : [],
            createdAt: Number(g.createdAt) || Date.now(),
          })
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('[session-chat] 读取状态失败：' + String(error?.message ?? error))
    }
  }

  function saveState() {
    try {
      mkdirSync(stateDir, { recursive: true })
      const data = {
        version: 1,
        savedAt: Date.now(),
        rate: { perMinute: rate.perMinute, paused: rate.paused },
        router: { mode: router.mode, provider: router.provider, model: router.model },
        eagerness,
        identities: Object.fromEntries(identities),
        groups: [...groups.values()].map((g) => ({
          id: g.id,
          name: g.name,
          owner: g.owner,
          members: [...g.members],
          joinedAt: { ...(g.joinedAt || {}) },
          avatars: { ...(g.avatars || {}) },
          messages: g.messages.slice(-cfg.maxHistory),
          createdAt: g.createdAt,
        })),
      }
      writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.('[session-chat] 保存状态失败：' + String(error?.message ?? error))
    }
  }

  loadState()

  /**
   * 检查并占用一个发送额度。
   * @returns {{allowed:true, used:number}|{allowed:false, reason:'paused'|'rate', retryAfterMs:number, used:number}}
   */
  function takeQuota(senderId) {
    if (rate.paused) {
      return { allowed: false, reason: 'paused', retryAfterMs: 0, used: 0 }
    }
    const now = Date.now()
    const bucket = usage.get(senderId)
    if (!bucket || now - bucket.windowStart >= 60_000) {
      usage.set(senderId, { windowStart: now, count: 1 })
      return { allowed: true, used: 1 }
    }
    if (bucket.count >= rate.perMinute) {
      return {
        allowed: false,
        reason: 'rate',
        retryAfterMs: Math.max(0, 60_000 - (now - bucket.windowStart)),
        used: bucket.count,
      }
    }
    bucket.count += 1
    return { allowed: true, used: bucket.count }
  }

  function quotaView(senderId) {
    const bucket = usage.get(senderId)
    const now = Date.now()
    if (!bucket || now - bucket.windowStart >= 60_000) {
      return { used: 0, limit: rate.perMinute, resetInMs: 0 }
    }
    return {
      used: bucket.count,
      limit: rate.perMinute,
      resetInMs: Math.max(0, 60_000 - (now - bucket.windowStart)),
    }
  }


  let seq = 0
  const newId = (prefix) => `${prefix}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

  // 可选服务获取。
  // 关键教训：`ctx.llm ?? ctx.get('llm')` 是错的——没 inject 时 ctx.llm 直接抛异常，
  // `??` 左边的异常让整个表达式跳进 catch，右边永远不执行，于是永远拿不到服务。
  // 必须先走 ctx.get（不抛），再用 Optional 注入在服务晚就绪时补上。
  const serviceCache = new Map()
  function getService(name) {
    const cached = serviceCache.get(name)
    if (cached) return cached
    let found = null
    try {
      found = ctx.get(name) ?? null
    } catch {
      found = null
    }
    if (!found) {
      try {
        found = ctx[name] ?? null
      } catch {
        found = null
      }
    }
    if (found) serviceCache.set(name, found)
    return found
  }

  for (const serviceName of ['llm', 'webServer', 'sessions']) {
    try {
      ctx.inject([serviceName], (svcCtx) => {
        const resolved = svcCtx ? svcCtx[serviceName] : undefined
        if (resolved) serviceCache.set(serviceName, resolved)
      })
    } catch {
      /* 宿主没有这个可选注入能力时忽略 */
    }
  }

  const sessionsService = () => getService('sessions')

  /** 判断某个活会话是不是 subagent 子会话（子会话不该被拉进群） */  function isSubagentSession(sessionId) {
    try {
      const session = sessionsService() ? sessionsService().get(sessionId) : undefined
      const header = session ? session.header : undefined
      if (!header) return false
      return (
        header.origin === 'subagent' ||
        Boolean(header.parentSession) ||
        Number(header.delegationDepth ?? 0) > 0
      )
    } catch {
      return false
    }
  }

  function cwdOf(sessionId) {
    try {
      const session = sessionsService()?.get(sessionId)
      return session?.header?.cwd ?? ''
    } catch {
      return ''
    }
  }

  function baseName(path) {
    if (!path) return ''
    const parts = String(path).split(/[\\/]+/).filter(Boolean)
    return parts[parts.length - 1] ?? ''
  }

  function displayName(sessionId) {
    if (!sessionId) return ''
    // 主人是面板里的虚拟身份，昵称固定，可被 set_identity 改
    if (sessionId === HOST_ID) return identities.get(HOST_ID) || HOST_NAME
    const custom = identities.get(sessionId)
    if (custom) return custom
    const base = baseName(cwdOf(sessionId))
    const tail = String(sessionId).slice(-4)
    return base ? `${base}·${tail}` : `会话·${tail}`
  }

  function liveSessions() {
    try {
      return ctx.agents.list()
    } catch {
      return []
    }
  }

  // ---- 休眠会话存档扫描 -----------------------------------------------
  // 会话文件是 zstd 多帧 jsonl：必须按 magic 切帧逐帧解，单次解压只出第一帧。
  const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

  function sessionRoots() {
    const roots = []
    try {
      roots.push(join(homedir(), '.dsh', 'sessions'))
    } catch {
      /* ignore */
    }
    const profileDir = process.env.DSH_PROFILE_DIR
    if (profileDir) {
      const parts = String(profileDir).split(/[\\/]+/)
      parts.pop()
      parts.pop()
      if (parts.length) roots.push(join(parts.join('/'), 'sessions'))
    }
    return [...new Set(roots)].filter((root) => {
      try {
        return existsSync(root)
      } catch {
        return false
      }
    })
  }

  function decodeHead(filePath, maxFrames) {
    const buf = readFileSync(filePath)
    const positions = []
    for (let i = 0; i + 4 <= buf.length && positions.length < maxFrames; i += 1) {
      if (
        buf[i] === ZSTD_MAGIC[0] &&
        buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] &&
        buf[i + 3] === ZSTD_MAGIC[3]
      ) {
        positions.push(i)
      }
    }
    if (positions.length === 0) return ''
    const parts = []
    for (let k = 0; k < positions.length; k += 1) {
      const start = positions[k]
      const end = k + 1 < positions.length ? positions[k + 1] : buf.length
      try {
        parts.push(zstdDecompressSync(buf.subarray(start, end)))
      } catch {
        /* 帧边界误判或截断，跳过 */
      }
    }
    return Buffer.concat(parts).toString('utf8')
  }

  /** file -> { mtimeMs, size, value } */
  const archivedCache = new Map()

  function parseArchived(filePath) {
    let stat
    try {
      stat = statSync(filePath)
    } catch {
      return null
    }
    const cached = archivedCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value

    let value = null
    try {
      const text = decodeHead(filePath, cfg.scanHeadFrames)
      let header = null
      let title = ''
      for (const line of text.split('\n')) {
        if (!line) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'session' && !header) header = event
        else if (event.type === 'session/title' && event.data?.title && !title) title = event.data.title
      }
      value = {
        id: header?.id ?? '',
        cwd: header?.cwd ?? '',
        createdAt: header?.createdAt ?? 0,
        title,
        // 子会话标记：subagent 产生的会话不该出现在“拉人”列表里
        isSubagent:
          header?.origin === 'subagent' ||
          Boolean(header?.parentSession) ||
          Number(header?.delegationDepth ?? 0) > 0,
        parentSession: header?.parentSession ?? '',
      }
    } catch {
      value = null
    }
    archivedCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value
  }

  // 归档状态 + 工作区标题：来自 ~/.dsh/storages/workspace.json（DSH 的权威登记）
  let wsMetaCache = { at: 0, file: '', archived: new Set(), titles: {} }
  function workspaceMeta() {
    const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
    let stat = null
    try {
      stat = statSync(file)
    } catch {
      return { archived: new Set(), titles: {} }
    }
    if (wsMetaCache.file === file && wsMetaCache.at === stat.mtimeMs) return wsMetaCache
    const archived = new Set()
    const titles = {}
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const list = data?.global?.archivedSessionIds
      if (Array.isArray(list)) for (const id of list) archived.add(String(id))
      const workspaces = data?.tables?.workspaces || {}
      for (const ws of Object.values(workspaces)) {
        if (ws && ws.path) titles[String(ws.path).toLowerCase()] = String(ws.title || '')
      }
    } catch {
      /* 读不动就当作没有归档信息 */
    }
    wsMetaCache = { at: stat.mtimeMs, file, archived, titles }
    return wsMetaCache
  }

  /** 工作区目录 -> DSH 里的显示名（解决了 5361~724C 这种编码目录名不可读） */
  function workspaceTitle(cwd) {
    if (!cwd) return ''
    const titles = workspaceMeta().titles
    return titles[String(cwd).toLowerCase()] || ''
  }

  function scanArchived() {
    const found = []
    for (const root of sessionRoots()) {
      let cwdDirs = []
      try {
        cwdDirs = readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const cwdDir of cwdDirs) {
        if (!cwdDir.isDirectory()) continue
        const cwdPath = join(root, cwdDir.name)
        let sessionDirs = []
        try {
          sessionDirs = readdirSync(cwdPath, { withFileTypes: true })
        } catch {
          continue
        }
        for (const sessionDir of sessionDirs) {
          if (!sessionDir.isDirectory()) continue
          const file = join(cwdPath, sessionDir.name, 'session.v4.jsonl.zstd')
          if (!existsSync(file)) continue
          const parsed = parseArchived(file)
          if (!parsed) continue
          let lastActive = 0
          try {
            lastActive = statSync(file).mtimeMs
          } catch {
            lastActive = 0
          }
          found.push({
            id: parsed.id || sessionDir.name,
            dirName: sessionDir.name,
            title: parsed.title,
            cwd: parsed.cwd,
            createdAt: parsed.createdAt,
            lastActive,
            // 必须把子会话标记带出去，否则调用方永远过滤不掉（实测 331 个里 259 个是子会话）
            isSubagent: Boolean(parsed.isSubagent),
            parentSession: parsed.parentSession || '',
          })
        }
      }
    }
    return found
  }

  function liveIdSet() {
    return new Set(liveSessions().map((agent) => agent.id))
  }

  /** 找会话：优先 id（精确或末尾片段），标题匹配只作兜底 —— 改名、重名都不影响 id 命中 */
  function resolveSessionRef(ref) {
    const wanted = String(ref ?? '').trim()
    if (!wanted) return undefined
    const live = liveSessions()
    const byId = live.find((agent) => agent.id === wanted) ?? live.find((agent) => agent.id.endsWith(wanted))
    if (byId) return { id: byId.id, title: displayName(byId.id), cwd: cwdOf(byId.id), live: true }

    const archived = scanArchived()
    const exact = archived.find((row) => row.id === wanted)
    if (exact) return { ...exact, live: false }
    const byTail = archived.find((row) => row.id.endsWith(wanted))
    if (byTail) return { ...byTail, live: false }
    const lower = wanted.toLowerCase()
    const byTitle = archived.filter((row) => (row.title ?? '').toLowerCase().includes(lower))
    if (byTitle.length === 1) return { ...byTitle[0], live: false }
    if (byTitle.length > 1) return { ambiguous: byTitle }
    return undefined
  }

  function groupByKey(key) {
    if (!key) return undefined
    if (groups.has(key)) return groups.get(key)
    const wanted = String(key).toLowerCase()
    for (const group of groups.values()) {
      if (group.name.toLowerCase() === wanted || group.id.toLowerCase() === wanted) return group
    }
    return undefined
  }

  /** 字符串 -> 稳定整数，用于没有记录头像种子的老成员 */
  function stableSeed(text) {
    const str = String(text || '?')
    let hash = 0
    for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) % 1000000
    return hash
  }

  function groupView(group) {
    return {
      id: group.id,
      name: group.name,
      owner: displayName(group.owner),
      ownerId: group.owner,
      members: [...group.members].map((id) => {
        const stored = group.avatars ? group.avatars[id] : undefined
        const picked = typeof stored === 'string' && stored ? stored : ''
        return {
          id,
          name: displayName(id),
          cwd: cwdOf(id),
          online: liveSessions().some((agent) => agent.id === id),
          // avatarName：手动指定的头像文件；否则用进群时随机抽的 seed
          avatarName: picked,
          seed: picked ? null : Number.isFinite(stored) ? stored : stableSeed(id),
        }
      }),
      messageCount: group.messages.length,
      // 谁正在输入（只给面板看，不投递）
      typing: typingList(group.id, null),
    }
  }

  /** 群主退群时按“最早加入”选接班人，避免 Set 顺序不稳定导致随机换主 */
  function pickSuccessor(group) {
    const at = (group && group.joinedAt) || {}
    const list = [...(group ? group.members : [])]
    list.sort((a, b) => {
      const ta = Number(at[a]) || Number.MAX_SAFE_INTEGER
      const tb = Number(at[b]) || Number.MAX_SAFE_INTEGER
      return ta - tb
    })
    return list[0]
  }

  /**
   * 群聊记录落盘成可读的 Markdown，投递时只带最近几条 + 这个路径。
   * 这样消息体不会越滚越长，想看全文去读文件。
   */
  function roomLogPath(group) {
    const safe =
      String(group.name || 'group')
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'group'
    return join(roomsDir, safe + '-' + String(group.id).slice(-6) + '.md')
  }

  function appendRoomLog(group, entry) {
    try {
      mkdirSync(roomsDir, { recursive: true })
      const file = roomLogPath(group)
      if (!existsSync(file)) {
        writeFileSync(file, `# 群聊记录 · ${group.name}\n\n群 id: ${group.id}\n\n`, 'utf8')
      }
      const time = new Date(entry.at || Date.now()).toLocaleString()
      const text = String(entry.text || '').replace(/\r?\n/g, ' ')
      const mentions = Array.isArray(entry.mentions) && entry.mentions.length ? ' @' + entry.mentions.length : ''
      appendFileSync(file, `- [${time}] **${entry.fromName}**${mentions}：${text}\n`, 'utf8')
      return file
    } catch {
      return ''
    }
  }

  function pushMessage(group, entry) {
    group.messages.push(entry)
    if (group.messages.length > cfg.maxHistory) {
      group.messages.splice(0, group.messages.length - cfg.maxHistory)
    }
    appendRoomLog(group, entry)
  }

  /**
   * 把一条群聊消息真正送进目标会话。
   * 离线目标不丢消息：先挂在 pending，等它的 agent 上线再补。
   * @returns {'sent'|'offline'|'failed'}
   */
  function deliver(targetId, text) {
    const agent = ctx.agents.get(targetId)
    if (!agent) return 'offline'
    try {
      agent.followup(makeUserMessage(text))
      return 'sent'
    } catch (error) {
      ctx.logger?.warn?.(`[session-chat] 投递到 ${targetId} 失败: ${error?.message ?? error}`)
      return 'failed'
    }
  }

  /**
   * 用配置的小模型判断这条消息该唤醒哪些成员。
   * @returns {Promise<string[]|null>} null 表示“不做路由，按全员处理”
   */
  /**
   * 决定用哪个模型来做路由判断。
   * - 显式配了 provider/model → 用它
   * - 否则（mode=auto 或没配）→ 跟随发送者会话自己的模型（“核心 AI”），
   *   拿不到再退回默认模型
   */
  function resolveRouterModel(senderId) {
    if (router.provider && router.model) return { provider: router.provider, model: router.model }
    try {
      const session = sessionsService() ? sessionsService().get(senderId) : undefined
      const info =
        session && typeof session.requestContext === 'function' ? session.requestContext() : undefined
      if (info && info.provider && info.model) return { provider: info.provider, model: info.model }
    } catch {
      /* 会话已关闭等 */
    }
    try {
      const svc = getService('agentDefaultModel')
      const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : undefined
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    } catch {
      /* 没有默认模型服务 */
    }
    return null
  }

  /**
   * 尝试「强行激活」一个不在线的会话（冷恢复）。
   * 只依赖宿主暴露的 agents.resume；拿不到或失败就返回说明，不抛。
   */
  async function tryWake(sessionId) {
    const agents = getService('agents')
    if (!agents || typeof agents.resume !== 'function') {
      return { ok: false, reason: '宿主没有 agents.resume' }
    }
    try {
      const handle = await agents.resume({ sessionId })
      // 不同版本可能返回 AgentHandle 或 Agent，都兼容一下
      const live = handle && (handle.agent || handle)
      if (live && live.followup) return { ok: true, agent: live }
      // 即使返回值形状不认识，也再查一次注册表
      const again = agents.get ? agents.get(sessionId) : undefined
      if (again && again.followup) return { ok: true, agent: again }
      return { ok: false, reason: '恢复后拿不到 agent' }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  async function decideTargets(group, senderId, text) {
    if (router.mode !== 'ai' && router.mode !== 'auto') return null
    // 先算人数：只有一个可能的接收者时没必要花一次模型调用
    const others = [...group.members].filter((id) => id !== senderId)
    if (others.length <= 1) return null

    const llm = getService('llm')
    if (!llm || typeof llm.stream !== 'function') {
      ctx.logger?.warn?.('[session-chat] 配了 AI 路由但 llm 服务不可用，本次按全员推送')
      return null
    }
    const model = resolveRouterModel(senderId)
    if (!model) {
      ctx.logger?.warn?.('[session-chat] 解析不到路由模型（auto 且拿不到会话模型），本次按全员推送')
      return null
    }

    const roster = others.map((id) => `- id:${id} 名字:${displayName(id)}`).join('\n')
    // 回复意愿档位影响路由的「推送意向」：克制档宁可不打扰
    const stance =
      eagerness === 'cautious'
        ? [
            '当前回复意愿档位：克制。',
            '除非有人在明确提问、或者确实需要某个具体成员答复，否则一律输出 NONE。',
            '宁可不推送，也不要打扰别人；闲聊、通知、事后补充一律 NONE。',
          ].join('\n')
        : eagerness === 'active'
          ? ['当前回复意愿档位：活跃。', '只要这条消息与某人相关就列出他；拿不准时倾向于列出来。'].join('\n')
          : [
              '当前回复意愿档位：平衡。',
              '只有当某个成员确实需要回应时才列出他；纯通知类可以输出 NONE。',
            ].join('\n')

    const prompt = [
      `群组「${group.name}」里除发送者外的成员：`,
      roster,
      '',
      `发送者：${displayName(senderId)}`,
      '消息内容：',
      '"""',
      text.slice(0, 1500),
      '"""',
      '',
      stance,
      '',
      '判断这条消息需要哪些成员回应。只输出需要回应的成员 id（形如 id:xxx），一行一个；',
      '不需要任何人回应就只输出 NONE。不要解释。',
    ].join('\n')

    try {
      const stream = llm.stream({
        provider: model.provider,
        model: model.model,
        system: '你是群聊消息路由器，只输出结果，不输出解释。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0,
        maxTokens: 200,
      })
      let out = ''
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta') out += chunk.text
        else if (chunk && chunk.type === 'finish') break
      }
      if (/\bNONE\b/i.test(out)) return []
      const picked = others.filter((id) => out.includes(id))
      return picked.length ? picked : null
    } catch (error) {
      ctx.logger?.warn?.('[session-chat] AI 路由失败，本次按全员推送：' + String(error?.message ?? error))
      return null
    }
  }

  function flushPending(sessionId) {
    const queue = pending.get(sessionId)
    if (!queue || queue.length === 0) return
    pending.delete(sessionId)
    for (const item of queue) {
      const group = groups.get(item.groupId)
      if (!group || !group.members.has(sessionId)) continue
      deliver(sessionId, item.text)
    }
  }

  // ---- 会话生命周期 -------------------------------------------------------
  ctx.on('agent/created', ({ agent }) => {
    flushPending(agent.id)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    for (const group of groups.values()) group.members.delete(agent.id)
    saveState()
  })

  // ---- 工具 ---------------------------------------------------------------
  const toolDef = {
      name: 'session_chat',
      description:
        '跨会话群聊：列出会话（含休眠存档）、创建群组、拉人/踢人、设置昵称、查看与更换头像、在群里发消息、戳一戳。只传文本，不共享任何工作区文件。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list_sessions',
              'list_all_sessions',
              'list_groups',
              'create_group',
              'join_group',
              'leave_group',
              'kick_member',
              'transfer_owner',
              'set_identity',
              'list_avatars',
              'set_avatar',
              'send',
              'poke',
              'history',
              'quota',
              'set_rate',
              'set_paused',
              'set_eagerness',
              'router',
              'set_router',
              'diag',
              'help',
            ],
            description: '要执行的操作',
          },
          group: {
            type: 'string',
            description: '群组名或群组 id（**不是模型名**，别和 provider/model 搞混）',
          },
          session: {
            type: 'string',
            description: '目标会话 **id**（最可靠，改名/重名都不受影响）。也接受 id 末尾片段或标题关键字作为兜底，但改名后可能失效',
          },
          text: {
            type: 'string',
            description:
              '消息正文；set_paused 用 on/off；set_router 用 ai/auto/off；set_eagerness 用 cautious/balanced/active',
          },
          name: { type: 'string', description: '群组名称或自己的昵称' },
          value: { type: 'number', description: 'set_rate 时的每分钟条数' },
          provider: { type: 'string', description: 'AI 路由使用的 provider（set_router 用）' },
          model: { type: 'string', description: 'AI 路由使用的模型 id（set_router 用）' },
          force: { type: 'boolean', description: 'send 时强制唤醒全员，跳过 AI 路由判断' },
          mentions: {
            type: 'array',
            items: { type: 'string' },
            description: 'send 时要 @ 的成员 sessionId 列表（比在正文里写 @名字可靠，改名或重名都不会错）',
          },
          include_subagent: { type: 'boolean', description: 'list_all_sessions 时是否包含 subagent 子会话' },
          include_archived: { type: 'boolean', description: 'list_all_sessions 时是否包含已归档会话' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            data: { type: 'object' },
          },
          required: ['ok', 'text'],
          additionalProperties: true,
        },
        render(_args, value) {
          const head = value?.ok === false ? '❌ ' : ''
          return [{ type: 'text', text: `${head}${value?.text ?? ''}`.trim() || '(空)' }]
        },
      },
      async execute(args, exec) {
        const me = exec?.agent?.id
        if (!me) {
          return { ok: false, text: '这个工具需要在会话里由 Agent 调用。' }
        }
        const action = args?.action

        switch (action) {
          case 'help': {
            return {
              ok: true,
              text: [
                '我是会话群聊工具 session_chat，可用 action：',
                '',
                '【会话 / 群组】',
                '· list_sessions —— 只看当前开着（活）的会话（默认不含 subagent 子会话）',
                '· list_all_sessions —— 全部会话含休眠存档；要子会话/已归档加 include_subagent / include_archived',
                '· list_groups —— 看所有群组和成员',
                '· create_group {name} —— 建群，自己自动成为群主',
                '· join_group {group, session?} —— 自己加入；群主/主人可用 session 拉别人',
                '· leave_group {group} —— 退出群组',
                '· kick_member {group, session} —— 群主/主人踢人',
                '· transfer_owner {group, session} —— 转让群主',
                '',
                '【发言】',
                '· send {group, text, mentions?, force?} —— 在群里发言；mentions 传成员 id 最准；force=true 跳过 AI 路由全员送达',
                '· poke {session, group?} —— 戳一戳：单独提醒某人，不带上下文、不写群记录、离线会自动尝试冷启动',
                '· history {group} —— 看群聊记录',
                '',
                '【个人资料】',
                '· set_identity {name} —— 改自己的群聊昵称',
                '· list_avatars —— 列出头像库文件名 + 真实绝对路径（不知道头像放哪就先跑这个）',
                '· set_avatar {name, group?} —— 换头像，name 必须是头像库里已有的文件名',
                '',
                '【配置】',
                '· quota —— 看自己这个分钟的用量',
                '· set_rate {value} —— 每分钟条数（1~120）',
                '· set_paused {text=on|off} —— 暂停/恢复投递',
                '· router —— 看 AI 路由现状',
                '· set_router {text=off|auto|ai, provider?, model?} —— off 全员 / auto 跟随会议模型 / ai 固定模型',
                '· set_eagerness {text=cautious|balanced|active} —— 回复意愿三档',
                '· diag —— 版本对照、面板挂载、磁盘检查（排错用）',
                '· help —— 就是这一页',
                '',
                '目标优先用 **session id**（完整或末尾片段），标题/群名只作兜底——改名后 id 仍然准。',
                '群里只互通对话，工作区文件互不共享；离线会话消息会排队，等它上线补发。',
              ].join('\n'),
              data: {},
            }
          }

          case 'list_sessions': {
            const rows = liveSessions().map((agent) => {
              const cwd = cwdOf(agent.id)
              const joined = [...groups.values()]
                .filter((group) => group.members.has(agent.id))
                .map((group) => group.name)
              return {
                id: agent.id,
                name: displayName(agent.id),
                cwd,
                groups: joined,
                self: agent.id === me,
              }
            })
            const text =
              rows.length === 0
                ? '当前没有其他活着的会话。'
                : [
                    `当前共 ${rows.length} 个活会话：`,
                    ...rows.map(
                      (row) =>
                        `· ${row.self ? '【我】' : ''}${row.name}\n    id: ${row.id}` +
                        (row.cwd ? `\n    工作区: ${row.cwd}` : '') +
                        (row.groups.length ? `\n    已加入: ${row.groups.join('、')}` : ''),
                    ),
                  ].join('\n')
            return { ok: true, text, data: { sessions: rows } }
          }

          case 'list_all_sessions': {
            let archived = []
            let scanError = ''
            try {
              archived = scanArchived()
            } catch (error) {
              scanError = error?.message ?? String(error)
            }
            if (scanError) {
              return {
                ok: false,
                text: `读取会话存档失败：${scanError}\n（活会话仍可用 list_sessions 查看）`,
              }
            }
            const liveIds = liveIdSet()
            const meta = workspaceMeta()
            const wantSubagent = args?.include_subagent === true
            const wantArchived = args?.include_archived === true
            const subagentCount = archived.filter((row) => row.isSubagent).length
            const archivedCount = archived.filter(
              (row) => !row.isSubagent && meta.archived.has(row.id),
            ).length
            const scoped = archived.filter((row) => {
              if (!wantSubagent && row.isSubagent) return false
              if (!wantArchived && meta.archived.has(row.id)) return false
              return true
            })
            const rows = scoped
              .map((row) => ({
                ...row,
                live: liveIds.has(row.id),
                archived: meta.archived.has(row.id),
                workspaceTitle: workspaceTitle(row.cwd),
                name:
                  row.title ||
                  workspaceTitle(row.cwd) ||
                  baseName(row.cwd) ||
                  `会话·${String(row.id).slice(-4)}`,
              }))
              .sort((a, b) => b.lastActive - a.lastActive)

            if (rows.length === 0) {
              return { ok: true, text: '没有在磁盘上找到任何会话存档。', data: { sessions: [] } }
            }

            const liveCount = rows.filter((row) => row.live).length
            const roots = sessionRoots()
            const byWorkspace = new Map()
            for (const row of rows) {
              const key = row.cwd || '(未知工作区)'
              byWorkspace.set(key, (byWorkspace.get(key) ?? 0) + 1)
            }

            const head = [
              `磁盘会话存档 ${rows.length} 个（其中 ${liveCount} 个正在运行），跨 ${byWorkspace.size} 个工作区：`,
              ...(subagentCount && !wantSubagent ? [`已隐藏 ${subagentCount} 个 subagent 子会话（要看得加 include_subagent）`] : []),
              ...(archivedCount && !wantArchived ? [`已隐藏 ${archivedCount} 个已归档会话（要看得加 include_archived）`] : []),
              ...[...byWorkspace.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([cwd, count]) => `  · ${workspaceTitle(cwd) || cwd || '(未知)'} —— ${count} 个`),
              `存档位置：${roots.join('  |  ')}`,
              '',
              '最近的 25 个会话：',
            ]
            const lines = rows.slice(0, 25).map((row) => {
              const when = row.lastActive ? new Date(row.lastActive).toLocaleString() : '未知时间'
              return (
                `· ${row.live ? '【运行中】' : '【休眠】'} ${row.name}\n` +
                `    id: ${row.id}\n` +
                `    工作区: ${row.cwd || '(未知)'}\n` +
                `    最后活动: ${when}`
              )
            })

            return {
              ok: true,
              text: [...head, ...lines].join('\n'),
              data: {
                total: rows.length,
                liveCount,
                workspaces: Object.fromEntries(byWorkspace),
                roots,
                sessions: rows,
              },
            }
          }

          case 'list_groups': {
            if (groups.size === 0) {
              return { ok: true, text: '还没有任何群组。用 create_group 建一个。', data: { groups: [] } }
            }
            const views = [...groups.values()].map(groupView)
            const text = views
              .map(
                (view) =>
                  `· ${view.name}  (id: ${view.id})  群主: ${view.owner}\n` +
                  `    成员 ${view.members.length}：${view.members.map((m) => m.name).join('、')}`,
              )
              .join('\n')
            return { ok: true, text: `共 ${views.length} 个群组：\n${text}`, data: { groups: views } }
          }

          case 'create_group': {
            const name = (args?.name ?? '').trim()
            if (!name) return { ok: false, text: '需要提供 name（群组名称）。' }
            if ([...groups.values()].some((group) => group.name.toLowerCase() === name.toLowerCase())) {
              return { ok: false, text: `已经有一个叫「${name}」的群组了。` }
            }
            const group = {
              id: newId('g'),
              name,
              owner: me,
              members: new Set([me]),
              joinedAt: { [me]: Date.now() },
              avatars: { [me]: Math.floor(Math.random() * 1000000) },
              messages: [],
              createdAt: Date.now(),
            }
            groups.set(group.id, group)
            saveState()
            return {
              ok: true,
              text: `群组「${name}」已创建，你是群主。\n群 id: ${group.id}\n用 join_group 把其他会话拉进来。`,
              data: { group: groupView(group) },
            }
          }

          case 'join_group': {
            const group = groupByKey(args?.group)
            if (!group) return { ok: false, text: '找不到这个群组，先用 list_groups 看一下。' }
            const rawRef = (args?.session ?? '').trim()
            let target = me
            let targetLive = true
            if (rawRef && rawRef !== me) {
              if (group.owner !== me && me !== HOST_ID) {
                return { ok: false, text: '只有群主可以把别的会话拉进群。' }
              }
              const resolved = resolveSessionRef(rawRef)
              if (!resolved) {
                return {
                  ok: false,
                  text: `找不到会话「${rawRef}」。可以先用 list_all_sessions 看准确 id 或标题。`,
                }
              }
              if (resolved.ambiguous) {
                const list = resolved.ambiguous
                  .slice(0, 10)
                  .map((row) => `· ${row.title || '(无标题)'} —— id: ${row.id}`)
                  .join('\n')
                return { ok: false, text: `「${rawRef}」匹配到多个会话，请给更精确的 id：\n${list}` }
              }
              target = resolved.id
              targetLive = resolved.live
            }
            if (group.members.size >= cfg.maxMembersPerGroup) {
              return { ok: false, text: `群成员已达上限 ${cfg.maxMembersPerGroup}。` }
            }
            if (group.members.has(target)) {
              return { ok: true, text: `${displayName(target)} 本来就在群里。`, data: { group: groupView(group) } }
            }
            group.members.add(target)
            if (!group.joinedAt) group.joinedAt = {}
            if (!group.joinedAt[target]) group.joinedAt[target] = Date.now()
            // 进群时随机抽一个头像种子（前端用它去表情包里取图）
            if (!group.avatars) group.avatars = {}
            if (!Number.isFinite(group.avatars[target])) {
              group.avatars[target] = Math.floor(Math.random() * 1000000)
            }
            saveState()
            const notice =
              target === me
                ? `【群聊·${group.name}】${displayName(me)} 加入了群组。`
                : `【群聊·${group.name}】${displayName(me)} 把 ${displayName(target)} 加入了群组。`
            for (const memberId of group.members) {
              if (memberId === me || memberId === target) continue
              deliver(memberId, notice)
            }
            return {
              ok: true,
              text:
                `${displayName(target)} 已加入「${group.name}」。` +
                (targetLive
                  ? ''
                  : '\n注意：这个会话当前是休眠状态，消息会排队，等它被打开后再补发。'),
              data: { group: groupView(group) },
            }
          }

          case 'leave_group': {
            const group = groupByKey(args?.group)
            if (!group) return { ok: false, text: '找不到这个群组。' }
            if (!group.members.has(me)) return { ok: false, text: '你不在这个群里。' }
            const wasOwner = group.owner === me
            group.members.delete(me)
            if (group.joinedAt) delete group.joinedAt[me]

            if (wasOwner) {
              // 关键：按“最早加入”接班，而不是 [...members][0]。
              // 会话重启后重新加入会排到队尾，用 Set 顺序等于随机换群主。
              const successor = pickSuccessor(group)
              if (!successor) {
                groups.delete(group.id)
                saveState()
                return { ok: true, text: `你退出了「${group.name}」，群里没人了，群组已解散。` }
              }
              group.owner = successor
              saveState()
              const note = `【群聊·${group.name}】群主 ${displayName(me)} 退群，群主已按加入时间转给 ${displayName(successor)}。`
              for (const memberId of group.members) deliver(memberId, note)
              return {
                ok: true,
                text: `已退出「${group.name}」，群主已转给 ${displayName(successor)}（最早加入的那位）。`,
              }
            }

            saveState()
            return { ok: true, text: `已退出「${group.name}」。` }
          }

          case 'transfer_owner': {
            const group = groupByKey(args?.group)
            if (!group) return { ok: false, text: '找不到这个群组。' }
            if (group.owner !== me && me !== HOST_ID) return { ok: false, text: '只有当前群主可以转让群主。' }
            const rawRef = (args?.session ?? '').trim()
            if (!rawRef) return { ok: false, text: '需要提供 session（转给谁）。' }
            let target = group.members.has(rawRef) ? rawRef : undefined
            if (!target) {
              const resolved = resolveSessionRef(rawRef)
              if (resolved && !resolved.ambiguous) target = resolved.id
            }
            if (!target || !group.members.has(target)) {
              return { ok: false, text: `「${rawRef}」不在这个群里，先把他拉进来。` }
            }
            if (target === me) return { ok: false, text: '你已经是群主了。' }
            const previous = group.owner
            group.owner = target
            saveState()
            const note = `【群聊·${group.name}】群主由 ${displayName(previous)} 转给 ${displayName(target)}。`
            for (const memberId of group.members) {
              if (memberId === target) continue
              deliver(memberId, note)
            }
            return {
              ok: true,
              text: `群主已转给 ${displayName(target)}。`,
              data: { group: groupView(group) },
            }
          }

          case 'kick_member': {
            const group = groupByKey(args?.group)
            if (!group) return { ok: false, text: '找不到这个群组。' }
            if (group.owner !== me && me !== HOST_ID) return { ok: false, text: '只有群主可以踢人。' }
            const rawRef = (args?.session ?? '').trim()
            if (!rawRef) return { ok: false, text: '需要提供 session（要踢的会话 id 或标题）。' }
            let target = group.members.has(rawRef) ? rawRef : undefined
            if (!target) {
              const resolved = resolveSessionRef(rawRef)
              if (resolved && !resolved.ambiguous) target = resolved.id
            }
            if (!target) {
              const preview = [...group.members]
                .filter((id) => id !== me)
                .slice(0, 10)
                .map((id) => `· ${displayName(id)} —— id: ${id}`)
                .join('\n')
              return { ok: false, text: `群成员里没有「${rawRef}」。当前成员：\n${preview || '(只有你自己)'}` }
            }
            if (target === me) return { ok: false, text: '群主不能踢自己，用 leave_group 退群。' }
            if (!group.members.has(target)) return { ok: false, text: '这个人不在群里。' }
            group.members.delete(target)
            saveState()
            const notice = `【群聊·${group.name}】${displayName(me)} 把 ${displayName(target)} 移出了群组。`
            for (const memberId of group.members) {
              if (memberId === me) continue
              deliver(memberId, notice)
            }
            return { ok: true, text: `${displayName(target)} 已被移出「${group.name}」。` }
          }

          case 'list_avatars': {
            const rows = listAvatars()
            if (!rows.length) {
              return {
                ok: true,
                text:
                  '头像库是空的。把图片放进这个目录即可：\n' +
                  avatarDir +
                  '\n放好后用 list_avatars 复查，再用 set_avatar 指定。',
                data: { dir: avatarDir, avatars: [] },
              }
            }
            return {
              ok: true,
              text:
                `头像库（${avatarDir}）共 ${rows.length} 张：\n` +
                rows.map((row, i) => `${i + 1}. ${row.name}`).join('\n') +
                '\n\n换头像：session_chat(action="set_avatar", name="上面的文件名", group="群名或id")',
              data: { dir: avatarDir, avatars: rows },
            }
          }

          case 'set_avatar': {
            const fileName = basename(String((args && args.name) || '').trim())
            const ext = extname(fileName).toLowerCase()
            if (!fileName || !AVATAR_EXT.has(ext)) {
              return { ok: false, text: '要指定头像文件名（png / jpg / webp / gif）。先用 list_avatars 看看有哪些。' }
            }
            if (!existsSync(join(avatarDir, fileName))) {
              return {
                ok: false,
                text: `头像库里没有「${fileName}」。目录：${avatarDir}（用 list_avatars 看现有列表）`,
              }
            }
            const avGroup = groupByKey((args && args.group) || '') || (groups.size === 1 ? [...groups.values()][0] : undefined)
            if (!avGroup) return { ok: false, text: '看不出要改哪个群的头像，请带 group。' }
            if (!avGroup.members.has(me)) return { ok: false, text: '你不在这个群里。' }
            if (!avGroup.avatars) avGroup.avatars = {}
            avGroup.avatars[me] = fileName
            saveState()
            return { ok: true, text: `头像已换成「${fileName}」。`, data: { state: panelState(me) } }
          }

          case 'set_identity': {
            const name = (args?.name ?? '').trim()
            if (!name) return { ok: false, text: '需要提供 name（昵称）。' }
            if (name.length > 24) return { ok: false, text: '昵称最多 24 个字符。' }
            identities.set(me, name)
            saveState()
            return { ok: true, text: `你的群聊昵称现在是「${name}」。` }
          }

          case 'send': {
            const group = groupByKey(args?.group)
            if (!group) return { ok: false, text: '找不到这个群组，先用 list_groups 看一下。' }
            // 主人是虚拟身份，不需要“入群”就能发言
            const isHostSender = me === HOST_ID
            if (!isHostSender && !group.members.has(me)) {
              return { ok: false, text: '你不在这个群里，先 join_group。' }
            }
            const text = (args?.text ?? '').trim()
            if (!text) return { ok: false, text: '需要提供 text（消息内容）。' }

            const quota = takeQuota(me)
            if (!quota.allowed) {
              if (quota.reason === 'paused') {
                return { ok: false, text: '群聊当前已暂停投递，消息未发送。（面板上可恢复）' }
              }
              const secs = Math.ceil(quota.retryAfterMs / 1000)
              return {
                ok: false,
                text: `已达频率上限：每分钟最多 ${rate.perMinute} 条，请等 ${secs} 秒再发。`,
                data: { retryAfterMs: quota.retryAfterMs, limit: rate.perMinute },
              }
            }

            const senderName = displayName(me)

            // @ 提及：优先用面板显式传来的成员 id（不依赖名字，改名/重名都不会错）；
            // 没有 id 时才从正文里解析 @名字 作为兜底（AI 调用常常只给文本）。
            const mentions = []
            const explicit = Array.isArray(args?.mentions) ? args.mentions : []
            for (const raw of explicit) {
              const id = String(raw || '').trim()
              if (!id || id === me) continue
              if (!group.members.has(id)) continue
              if (!mentions.includes(id)) mentions.push(id)
            }
            if (mentions.length === 0) {
              const candidates = [...group.members]
                .filter((id) => id !== me)
                .map((id) => ({ id, name: displayName(id) }))
                .filter((item) => item.name)
                .sort((a, b) => b.name.length - a.name.length)
              for (const item of candidates) {
                if (text.includes('@' + item.name) && !mentions.includes(item.id)) mentions.push(item.id)
              }
            }

            pushMessage(group, {
              from: me,
              fromName: senderName,
              text,
              at: Date.now(),
              mentions: [...mentions],
            })

            const others = [...group.members].filter((id) => id !== me)
            if (others.length === 0) {
              saveState()
              return { ok: true, text: '消息已记录，但群里目前只有你一个人。', data: { delivered: 0 } }
            }

            // 强制唤醒：跳过 AI 路由，直接全员。给「连路由都别信」的情况兜底。
            const force = args?.force === true
            // 保守策略：主人说的话一律不经过路由判断，直接全员送达。
            // 模型再怎么判，也不能把宿主本人的话吞掉。
            const byHost = me === HOST_ID
            // AI 路由：决定这次唤醒谁；@ 的人始终包含在内
            const routed = force || byHost ? null : await decideTargets(group, me, text)
            let targets =
              routed === null
                ? others
                : [...new Set([...others.filter((id) => routed.includes(id)), ...mentions])]

            // 路由说「没人需要回」时不吞消息：仍然全员送达，
            // 由每个 AI 自己决定要不要看群记录、要不要回。
            let routeHint = ''
            if (targets.length === 0) {
              targets = others
              routeHint = '（AI 路由觉得这条大概不用回应；你看情况决定要不要回，不回也没关系。）'
            }

            saveState()

            // 上下文只带最近几条（每条截断）+ 完整记录文件路径。
            // 群聊越滚越长，全塞进消息里既费 token 又难读，想看全文让他们去读文件。
            const recent = group.messages.slice(-(cfg.contextMessages + 1), -1)
            const logFile = roomLogPath(group)
            const historyText =
              (recent.length
                ? '【群里最近 ' +
                  recent.length +
                  ' 条】\n' +
                  recent
                    .map((m) => `${m.fromName}：${String(m.text || '').replace(/\r?\n/g, ' ').slice(0, 120)}`)
                    .join('\n') +
                  '\n'
                : '') + (logFile ? '【完整记录】' + logFile + '\n\n' : '\n')
            // 只有「路由确实筛掉了人」才提示；路由判空时已改全员送达，不该再报“只叫了几人”
            const routeNote =
              routed !== null && routed.length > 0 && targets.length < others.length
                ? `（AI 路由：群里 ${others.length} 人，这次只叫了 ${targets.length} 人）\n\n`
                : ''

            const mentionNames = mentions.map((id) => displayName(id))

            // 回复意愿按“谁发的”区分：
            //   主人发的 → 鼓励正常回应（这是群聊的意义）
            //   被 @ 的   → 鼓励回应
            //   其他 AI 的普通发言 → 知情即可，不主动接话（这才是防循环的关键）
            const fromHost = me === HOST_ID
            const notes = eagernessNotes()
            const hostNote =
              '（' +
              notes.host +
              '群里说话简短点，别铺长文。回应发回群里用 session_chat 的 send，group 填群名或 id。）'
            const peerNote = '（' + notes.peer + '）'
            const mentionNote =
              '（' + notes.mention + '回应用 session_chat 的 send。）'
            // 这条 @ 了别人、但没 @ 我 → 我只是被抄送的旁观者，大幅降低回复意愿
            const bystanderNote =
              '（群里这条 @ 的是『' +
              (mentionNames.join('、') || '别人') +
              '』，不是 @ 你。你只是被抄送知情——除非确实有必要补充，否则不用回。）'

            const base =
              routeNote +
              routeHint +
              historyText +
              `【群聊·${group.name}】${senderName}：${text}\n` +
              (fromHost ? hostNote : peerNote)

            let sent = 0
            const offline = []
            const failed = []
            const pinged = []
            // 路由参考：告诉接收者「模型认为这条是给谁的」，只作参考、不强制行为
            const routeRefFor = (memberId) => {
              if (routed === null || !routed.length) return ''
              const names = routed.map((id) => displayName(id)).join('、')
              if (routed.length === 1 && routed[0] === memberId) {
                return '（路由参考：这条主要针对「你」）'
              }
              if (routed.includes(memberId)) {
                return `（路由参考：这条主要针对「${names}」，其中有你）`
              }
              return `（路由参考：这条主要针对「${names}」，你只是知情）`
            }

            for (const memberId of targets) {
              const isMentioned = mentions.includes(memberId)
              if (isMentioned) pinged.push(memberId)
              // 有人被 @ 且不是我 → 旁观者提示
              const isBystander = mentions.length > 0 && !isMentioned
              const refLine = routeRefFor(memberId)
              const payload = isMentioned
                ? routeNote +
                  historyText +
                  `【群聊·${group.name}】【@你】${senderName}：${text}\n` +
                  (refLine ? refLine + '\n' : '') +
                  mentionNote
                : isBystander
                  ? routeNote +
                    historyText +
                    `【群聊·${group.name}】${senderName}：${text}\n` +
                    (refLine ? refLine + '\n' : '') +
                    (fromHost ? hostNote : '') +
                    bystanderNote
                  : base + (refLine ? '\n' + refLine : '')
              const result = deliver(memberId, payload)
              if (result === 'sent') {
                sent += 1
              } else if (result === 'offline') {
                offline.push(memberId)
                const queue = pending.get(memberId) ?? []
                queue.push({ groupId: group.id, text: payload })
                pending.set(memberId, queue)
              } else {
                failed.push(memberId)
              }
            }

            return {
              ok: sent > 0 || offline.length > 0 || failed.length === 0,
              text:
                `已发送到「${group.name}」：${sent} 个会话在线收到` +
                (offline.length ? `，${offline.length} 个离线已排队等它上线补发` : '') +
                (failed.length ? `，${failed.length} 个投递失败（会话可能正在关闭）` : '') +
                (mentionNames.length ? `；已 @ ${mentionNames.join('、')}` : '') +
                '。',
              data: { delivered: sent, queued: offline, failed, mentions, pinged },
            }
          }

          case 'poke': {
            // 戳一戳：单独叫醒某个会话一次，不带聊天记录，也不写群历史
            const raw = String(args?.session || '').trim()
            if (!raw) return { ok: false, text: '要戳谁？需要提供 session（会话 id 或名字）。' }
            const pokeGroup = args?.group ? groupByKey(args.group) : undefined
            // 先看是不是群成员：群成员哪怕离线也该能被识别出来
            let targetId = ''
            if (pokeGroup && pokeGroup.members.has(raw)) {
              targetId = raw
            } else {
              const resolved = resolveSessionRef(raw)
              if (resolved && resolved.ambiguous) {
                const list = resolved.ambiguous
                  .slice(0, 8)
                  .map((row) => `· ${row.title || '(无标题)'} —— id: ${row.id}`)
                  .join('\n')
                return { ok: false, text: `「${raw}」匹配到多个会话：\n${list}` }
              }
              if (resolved) targetId = resolved.id
            }
            if (!targetId) return { ok: false, text: `找不到会话「${raw}」。` }
            if (targetId === me) return { ok: false, text: '不能戳自己。' }

            // 冷却：防止连点刷屏。同一对人 3 秒内只戳一次，重复的静默忽略。
            const cooldownKey = me + '->' + targetId
            const lastPoke = pokeCooldown.get(cooldownKey) || 0
            const nowMs = Date.now()
            if (nowMs - lastPoke < POKE_COOLDOWN_MS) {
              const wait = Math.ceil((POKE_COOLDOWN_MS - (nowMs - lastPoke)) / 1000)
              return {
                ok: true,
                text: `刚戳过 ${displayName(targetId)}，${wait} 秒后才能再戳。`,
                data: { target: targetId, result: 'cooldown' },
              }
            }
            pokeCooldown.set(cooldownKey, nowMs)

            const quota = takeQuota(me)
            if (!quota.allowed) {
              if (quota.reason === 'paused') {
                return { ok: false, text: '群聊投递已暂停，戳不出去。' }
              }
              return {
                ok: false,
                text: `已达频率上限：每分钟最多 ${rate.perMinute} 次，请等 ${Math.ceil(quota.retryAfterMs / 1000)} 秒。`,
              }
            }
            const where = args?.group ? (groupByKey(args.group) || {}).name : ''
            const time = new Date().toLocaleTimeString()
            const payload =
              `【${where ? '群聊·' + where : '群聊'}】${displayName(me)} 戳了你一下（${time}）\n` +
              '（这是一次戳一戳，只是提醒。要不要回、回什么，你自己判断——想回就回，不想回忽略也行，不用带上下文。）'
            let poked = deliver(targetId, payload)
            let wakeNote = ''
            if (poked === 'offline') {
              // 离线就试着强行激活（冷恢复），成功后稍等再投一次
              const wake = await tryWake(targetId)
              if (wake.ok) {
                await new Promise((resolve) => setTimeout(resolve, 600))
                poked = deliver(targetId, payload)
                wakeNote = poked === 'sent' ? '（已强行激活）' : '（已尝试激活，但仍未送达）'
              } else if (wake.reason) {
                wakeNote = `（未能激活：${wake.reason}）`
              }
            }
            return {
              ok: poked === 'sent',
              text:
                poked === 'sent'
                  ? `已戳 ${displayName(targetId)} 一下${wakeNote}`
                  : poked === 'offline'
                    ? `${displayName(targetId)} 不在线，没戳到（戳不排队）${wakeNote}`
                    : `戳 ${displayName(targetId)} 失败${wakeNote}`,
              data: { target: targetId, result: poked },
            }
          }

          case 'history': {
            const group = groupByKey(args?.group)
            if (!group) return { ok: false, text: '找不到这个群组。' }
            // 主人是虚拟身份，不在成员表里，但可以看任何群的历史
            if (me !== HOST_ID && !group.members.has(me)) {
              return { ok: false, text: '你不在这个群里。' }
            }
            if (group.messages.length === 0) return { ok: true, text: '这个群还没有消息。' }
            const lines = group.messages.map((message) => {
              const time = new Date(message.at).toLocaleTimeString()
              return `[${time}] ${message.fromName}：${message.text}`
            })
            return {
              ok: true,
              text: `「${group.name}」最近 ${group.messages.length} 条：\n${lines.join('\n')}`,
              data: { messages: group.messages },
            }
          }

          case 'quota': {
            const view = quotaView(me)
            const secs = Math.ceil(view.resetInMs / 1000)
            return {
              ok: true,
              text:
                `当前频率限制：每个会话每分钟 ${view.limit} 条` +
                (rate.paused ? '（已暂停投递）' : '') +
                `；本分钟已用 ${view.used}/${view.limit}` +
                (view.resetInMs > 0 ? `，${secs} 秒后重置。` : '。'),
              data: { ...view, paused: rate.paused },
            }
          }

          case 'set_rate': {
            const next = Number(args?.value ?? args?.text)
            if (!Number.isFinite(next) || next < 1 || next > 120) {
              return { ok: false, text: '每分钟条数需要在 1~120 之间。' }
            }
            rate.perMinute = Math.floor(next)
            saveState()
            return {
              ok: true,
              text: `已把频率限制设为每个会话每分钟 ${rate.perMinute} 条。`,
              data: { perMinute: rate.perMinute },
            }
          }

          case 'set_eagerness': {
            const key = String((args && (args.text || args.value)) || '').trim()
            if (!EAGERNESS_NOTES[key]) {
              return { ok: false, text: '档位只能是 cautious（克制）/ balanced（平衡）/ active（活跃）。' }
            }
            eagerness = key
            saveState()
            const label = { cautious: '克制', balanced: '平衡', active: '活跃' }[key]
            return { ok: true, text: `回复意愿已设为「${label}」`, data: { state: panelState(me) } }
          }

          case 'set_paused': {
            const raw = String(args?.text ?? args?.name ?? '').trim().toLowerCase()
            if (raw !== 'on' && raw !== 'off' && raw !== 'true' && raw !== 'false') {
              return { ok: false, text: '用 text=on 或 text=off 控制暂停。' }
            }
            rate.paused = raw === 'on' || raw === 'true'
            saveState()
            return {
              ok: true,
              text: rate.paused ? '群聊投递已暂停。' : '群聊投递已恢复。',
              data: { paused: rate.paused },
            }
          }

          case 'router': {
            return {
              ok: true,
              text:
                router.mode === 'ai'
                  ? `AI 路由已开启：${router.provider} / ${router.model}\n` +
                    '每条群聊消息会先用这个小模型判断该唤醒谁；被 @ 的人始终包含在内。'
                  : 'AI 路由关闭：群聊消息推送给群里所有在线成员。',
              data: { mode: router.mode, provider: router.provider, model: router.model },
            }
          }

          case 'set_router': {
            const mode = String(args?.text ?? '').trim().toLowerCase()
            if (mode === 'off' || mode === 'all') {
              router.mode = 'off'
              saveState()
              return { ok: true, text: '已关闭 AI 路由，之后消息推送给全员。', data: { mode: router.mode } }
            }
            if (mode === 'auto' || mode === 'follow') {
              router.mode = 'auto'
              router.provider = ''
              router.model = ''
              saveState()
              return {
                ok: true,
                text: 'AI 路由已开启：自动跟随「发消息那个会话」自己的模型来判断，不用另配。',
                data: { mode: router.mode },
              }
            }
            if (mode === 'ai' || mode === 'on') {
              const provider = String(args?.provider ?? '').trim()
              const model = String(args?.model ?? '').trim()
              if (!provider || !model) {
                return { ok: false, text: '开启固定模型路由需要同时提供 provider 和 model。' }
              }
              router.mode = 'ai'
              router.provider = provider
              router.model = model
              saveState()
              return {
                ok: true,
                text: `AI 路由已开启：固定用 ${provider} / ${model} 判断唤醒谁。`,
                data: { mode: router.mode, provider, model },
              }
            }
            return { ok: false, text: '用 text=auto（跟随会话模型）、text=ai（配 provider/model）或 text=off。' }
          }

          case 'diag': {
            const diskVer = readDiskVersion()
            const features = checkClientFeatures()
            const featureLines = features
              ? [
                  '  @ 按钮      ' + (features.atButton ? '✓' : '✗ 缺失'),
                  '  气泡头像    ' + (features.bubbleAvatar ? '✓' : '✗ 缺失'),
                  '  版本对照    ' + (features.versionChip ? '✓' : '✗ 缺失'),
                  '  头像选择    ' + (features.avatarPicker ? '✓' : '✗ 缺失'),
                ]
              : null
            let wsInfo = 'unavailable'
            try {
              // 只走 ctx.get：直接摸 ctx.webServer 在没 inject 时会抛
              const ws = ctx.get('webServer')
              wsInfo = ws ? `已就绪 (register=${typeof ws.register})` : 'undefined'
            } catch (error) {
              wsInfo = 'lookup threw: ' + String(error?.message ?? error)
            }
            return {
              ok: true,
              text: [
                '【会话群聊诊断】',
                `插件版本：运行 ${PLUGIN_VERSION} / 磁盘 ${diskVer || '读不到'}` +
                  (diskVer && diskVer !== PLUGIN_VERSION ? '  ⚠ 不一致，改了没重启' : '  ✓ 一致'),
                `面板 API：${api.reason}`,
                `  path=${api.path}  mounted=${api.mounted}`,
                `webServer：${wsInfo}`,
                `状态文件：${stateFile}（存在=${existsSync(stateFile)}）`,
                `频率限制：${rate.perMinute} 条/分钟，暂停=${rate.paused}`,
                `AI 路由：${
                  router.mode === 'ai'
                    ? '固定模型 ' + router.provider + ' / ' + router.model
                    : router.mode === 'auto'
                      ? '跟随发消息的会话模型'
                      : '关闭（全员推送）'
                }`,
                `回复意愿：${eagerness}（cautious / balanced / active）`,
                `活会话：${liveSessions().length}　群组：${groups.size}`,
                `本会话已用：${quotaView(me).used}/${rate.perMinute}`,
                // 三态说明直接印在这里：README 没人读，但 diag 每次排错都会看
                '【磁盘 client.js 检查 ≠ 已加载】',
                ...(featureLines || ['  读不到 client.js']),
                '  判读：① 缺失＝根本没写　② 有但运行版本旧＝写了没重启　③ 有且版本一致＝大概率生效（视觉仍要人看）',
              ].join('\n'),
              data: {
                api,
                webServer: wsInfo,
                rate: { ...rate },
                quota: quotaView(me),
                liveSessions: liveSessions().length,
                groups: groups.size,
              },
            }
          }

          default:
            return {
              ok: false,
              text: `未知 action：${action}。用 action=help 看可用操作。`,
            }
        }
      },
  }

  ctx.effect(() => ctx.tools.register(toolDef))

  // ---- 可视化面板的 HTTP 通道 -------------------------------------------
  // Client 侧直接 fetch('/dsh-session-chat-api?...')，与工具共用同一套 action 逻辑。
  //
  // 注意：webServer 不在 inject 里（不能为了面板把整个插件挂死在硬依赖上），
  // 所以 apply 执行时它常常还没就绪。必须用 ctx.inject 等服务出现后再挂路由，
  // 直接 ctx.get('webServer') 会静默拿到 undefined，面板就永远空响应。
  const API_PATH = '/dsh-session-chat-api'
  const api = { mounted: false, path: API_PATH, reason: 'pending' }

  /** 面板用：把状态一次性打包 */
  function panelState(senderId) {
    const live = liveSessions()
    const liveIds = new Set(live.map((agent) => agent.id))
    const diskVersion = readDiskVersion()
    return {
      // 源码版本 vs 运行版本：不一致说明改了没重启
      version: {
        running: PLUGIN_VERSION,
        disk: diskVersion,
        stale: Boolean(diskVersion && diskVersion !== PLUGIN_VERSION),
      },
      rate: { perMinute: rate.perMinute, paused: rate.paused },
      router: { mode: router.mode, provider: router.provider, model: router.model },
      eagerness,
      quota: senderId ? quotaView(senderId) : { used: 0, limit: rate.perMinute, resetInMs: 0 },
      sessions: [
        { id: HOST_ID, name: displayName(HOST_ID), cwd: '', host: true },
        ...live.map((agent) => ({
          id: agent.id,
          name: displayName(agent.id),
          cwd: cwdOf(agent.id),
          host: false,
        })),
      ],
      groups: [...groups.values()].map((group) => ({
        ...groupView(group),
        members: groupView(group).members.map((member) => ({
          ...member,
          live: liveIds.has(member.id),
        })),
        messages: group.messages.slice(-60).map((message) => ({
          ...message,
          fromName: message.fromName || displayName(message.from),
        })),
      })),
      now: Date.now(),
    }
  }

  function mountApi(ws) {
    if (api.mounted) return
    if (!ws || typeof ws.register !== 'function') {
      api.reason = 'webserver-unavailable'
      return
    }
    api.mounted = true
    api.reason = 'mounted'
    try {
      ctx.effect(() =>
        ws.register({
          kind: 'exact',
          path: API_PATH,
        async handler(req, res) {
          const send = (status, obj) => {
            res.writeHead(status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(JSON.stringify(obj))
          }
          try {
            const url = new URL(req.url || '/', 'http://localhost')
            const op = url.searchParams.get('op') || 'state'

            let body = {}
            if (req.method === 'POST') {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              const raw = Buffer.concat(chunks).toString('utf8')
              if (raw) {
                try {
                  body = JSON.parse(raw)
                } catch {
                  send(400, { ok: false, error: 'bad json' })
                  return
                }
              }
            }

            const pick = (key) => body[key] ?? url.searchParams.get(key) ?? undefined
            const senderId = pick('session')

            if (op === 'state') {
              send(200, { ok: true, state: panelState(senderId) })
              return
            }

            if (op === 'set_rate') {
              const next = Number(pick('value'))
              if (!Number.isFinite(next) || next < 1 || next > 120) {
                send(400, { ok: false, error: '每分钟条数需在 1~120' })
                return
              }
              rate.perMinute = Math.floor(next)
              saveState()
              send(200, { ok: true, state: panelState(senderId) })
              return
            }

            if (op === 'set_paused') {
              rate.paused = Boolean(pick('paused'))
              saveState()
              send(200, { ok: true, state: panelState(senderId) })
              return
            }

            if (op === 'set_router') {
              const mode = String(pick('mode') ?? '').toLowerCase()
              if (mode === 'off') {
                router.mode = 'off'
                saveState()
                send(200, { ok: true, state: panelState(senderId) })
                return
              }
              if (mode === 'auto') {
                router.mode = 'auto'
                router.provider = ''
                router.model = ''
                saveState()
                send(200, { ok: true, state: panelState(senderId) })
                return
              }
              if (mode === 'ai') {
                const provider = String(pick('provider') ?? '').trim()
                const model = String(pick('model') ?? '').trim()
                if (!provider || !model) {
                  send(400, { ok: false, error: '固定模型路由需要 provider 和 model' })
                  return
                }
                router.mode = 'ai'
                router.provider = provider
                router.model = model
                saveState()
                send(200, { ok: true, state: panelState(senderId) })
                return
              }
              send(400, { ok: false, error: 'mode 只能是 auto / ai / off' })
              return
            }

            // ---- 独立头像库 ----------------------------------------------------
            // 「正在输入」心跳：只更新面板状态，不投递任何会话
            if (op === 'typing') {
              const group = groupByKey(pick('group'))
              if (group && senderId && group.members.has(senderId)) {
                markTyping(group.id, senderId)
              }
              send(200, { ok: true })
              return
            }

            if (op === 'avatars') {
              const rows = listAvatars()
              send(200, { ok: true, dir: avatarDir, count: rows.length, avatars: rows })
              return
            }

            if (op === 'avatar') {
              const name = pick('name')
              const dataUrl = name ? readAvatarDataUrl(name) : null
              if (!dataUrl) {
                send(404, { ok: false, error: '没有这张头像' })
                return
              }
              send(200, { ok: true, name: basename(String(name)), dataUrl })
              return
            }

            if (op === 'upload_avatar') {
              const items = Array.isArray(body.items) ? body.items : []
              const results = []
              for (const item of items) {
                results.push(saveAvatar(item && item.name, item && item.dataUrl))
              }
              send(200, {
                ok: true,
                results,
                saved: results.filter((r) => r.ok).length,
                failed: results.filter((r) => !r.ok).length,
                avatars: listAvatars(),
              })
              return
            }

            if (op === 'delete_avatar') {
              const name = basename(String(pick('name') || ''))
              const ext = extname(name).toLowerCase()
              if (!name || !AVATAR_EXT.has(ext)) {
                send(400, { ok: false, error: '文件名不合法' })
                return
              }
              try {
                const full = join(avatarDir, name)
                if (existsSync(full)) {
                  unlinkSync(full)
                }
                send(200, { ok: true, avatars: listAvatars() })
              } catch (error) {
                send(500, { ok: false, error: String(error?.message ?? error) })
              }
              return
            }

            // 手动指定某个成员的头像（不传 target 就是给自己设）
            if (op === 'set_avatar') {
              const group = groupByKey(pick('group'))
              if (!group) {
                send(400, { ok: false, error: '找不到群组' })
                return
              }
              const target = String(pick('target') || senderId || '').trim()
              if (!target) {
                send(400, { ok: false, error: '不知道给谁设头像' })
                return
              }
              if (!group.members.has(target)) {
                send(400, { ok: false, error: '这个会话不在群里' })
                return
              }
              const fileName = basename(String(pick('name') || ''))
              const ext = extname(fileName).toLowerCase()
              if (!fileName || !AVATAR_EXT.has(ext)) {
                send(400, { ok: false, error: '头像文件名不合法' })
                return
              }
              if (!existsSync(join(avatarDir, fileName))) {
                send(404, { ok: false, error: '头像库里没有这张图' })
                return
              }
              if (!group.avatars) group.avatars = {}
              group.avatars[target] = fileName
              saveState()
              send(200, { ok: true, state: panelState(senderId) })
              return
            }

            // 给面板选模型用：有哪些 provider、某个 provider 下有哪些 model
            if (op === 'models') {
              const out = { ok: true, provider: '', providers: [], models: [], error: '' }
              const llm = getService('llm')
              if (!llm) {
                out.error = '宿主没有 llm 服务'
                send(200, out)
                return
              }

              try {
                const list = typeof llm.listProviders === 'function' ? llm.listProviders() : []
                out.providers = (list || []).map((p) => ({ id: p.id, name: p.name || p.id }))
              } catch (error) {
                out.error = 'listProviders 失败：' + String(error?.message ?? error)
              }

              const want = String(pick('provider') ?? '') || (out.providers[0] && out.providers[0].id) || ''
              out.provider = want

              if (want && typeof llm.listModels === 'function') {
                const cached = modelCache.get(want)
                if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
                  out.models = cached.models
                } else {
                  // listModels 会真的去问 provider 端点，必须限时，否则面板一直转圈。
                  // 定时器成功后必须 clearTimeout，否则 8 秒后仍会 reject（未处理拒绝）。
                  let timerId = null
                  const timer = new Promise((_, reject) => {
                    timerId = setTimeout(() => reject(new Error('拉取模型超时（8 秒）')), 8000)
                  })
                  timer.catch(() => {})
                  try {
                    const list = await Promise.race([llm.listModels(want), timer])
                    out.models = (list || []).map((m) => ({ id: m.id, name: m.name || m.id }))
                    if (out.models.length) modelCache.set(want, { at: Date.now(), models: out.models })
                    else out.error = '该 provider 没返回任何模型，可手填模型 id'
                  } catch (error) {
                    out.error = String(error?.message ?? error) + '（下面可以手填模型 id）'
                    out.models = []
                  } finally {
                    if (timerId) clearTimeout(timerId)
                  }
                }
              } else if (!want) {
                out.error = '没有可用 provider'
              }

              send(200, out)
              return
            }

            // 拉人候选：活会话 + 磁盘上的休眠会话，排除已在群里的
            if (op === 'candidates') {
              const group = groupByKey(pick('group'))
              if (!group) {
                send(400, { ok: false, error: '找不到群组' })
                return
              }
              const live = liveSessions()
              const liveIds = new Set(live.map((agent) => agent.id))
              const meta = workspaceMeta()
              const rows = []
              for (const agent of live) {
                if (group.members.has(agent.id)) continue
                if (isSubagentSession(agent.id)) continue
                if (meta.archived.has(agent.id)) continue
                rows.push({
                  id: agent.id,
                  name: displayName(agent.id),
                  cwd: cwdOf(agent.id),
                  live: true,
                  lastActive: Date.now(),
                })
              }
              let archivedCount = 0
              let skippedSubagent = 0
              let skippedArchived = 0
              try {
                for (const row of scanArchived()) {
                  if (group.members.has(row.id) || liveIds.has(row.id)) continue
                  if (row.isSubagent) {
                    skippedSubagent += 1
                    continue
                  }
                  if (meta.archived.has(row.id)) {
                    skippedArchived += 1
                    continue
                  }
                  archivedCount += 1
                  rows.push({
                    id: row.id,
                    name: row.title || workspaceTitle(row.cwd) || baseName(row.cwd) || `会话·${String(row.id).slice(-4)}`,
                    cwd: row.cwd,
                    live: false,
                    lastActive: row.lastActive || 0,
                  })
                }
              } catch (error) {
                ctx.logger?.warn?.('[session-chat] 扫描休眠会话失败：' + String(error?.message ?? error))
              }
              rows.sort((a, b) => {
                if (a.live !== b.live) return a.live ? -1 : 1
                return (b.lastActive || 0) - (a.lastActive || 0)
              })
              send(200, {
                ok: true,
                total: rows.length,
                liveCount: rows.filter((r) => r.live).length,
                archivedCount,
                skippedSubagent,
                skippedArchived,
                candidates: rows.slice(0, 300),
              })
              return
            }

            // 其余操作统一转发给工具逻辑，保证面板和 AI 行为一致
            const map = {
              create_group: 'create_group',
              join: 'join_group',
              leave: 'leave_group',
              kick: 'kick_member',
              send: 'send',
              poke: 'poke',
              // 面板用的是 action 原名，两条都认，避免再报 unknown op
              eagerness: 'set_eagerness',
              set_eagerness: 'set_eagerness',
              set_avatar: 'set_avatar',
              list_avatars: 'list_avatars',
              identity: 'set_identity',
              history: 'history',
              quota: 'quota',
            }
            const action = map[op]
            if (!action) {
              send(400, { ok: false, error: `unknown op: ${op}` })
              return
            }
            if (!senderId) {
              send(400, { ok: false, error: '需要 session（以哪个会话的身份操作）' })
              return
            }

            const result = await toolDef.execute(
              {
                action,
                group: pick('group'),
                session: action === 'join_group' || action === 'kick_member' || action === 'poke' ? pick('target') : undefined,
                text: pick('text'),
                name: pick('name'),
                force: pick('force') === true || pick('force') === '1',
                mentions: Array.isArray(body.mentions) ? body.mentions : undefined,
                value: pick('value') === undefined ? undefined : Number(pick('value')),
              },
              { agent: { id: senderId } },
            )
            send(200, { ok: true, result, state: panelState(senderId) })
          } catch (error) {
            try {
              send(500, { ok: false, error: String(error?.message ?? error) })
            } catch {
              /* 响应已发出 */
            }
          }
        },
      }),
      )
    } catch (error) {
      api.mounted = false
      api.reason = 'register-failed: ' + String(error?.message ?? error)
      ctx.logger?.warn?.('[session-chat] 面板 API 挂载失败: ' + api.reason)
    }
  }

  // ① 服务已就绪就立刻挂；② 否则用 Cordis 可选注入等它就绪。
  //    直接 ctx.get('webServer') 在 apply 阶段常拿到 undefined，
  //    那样 if 分支被跳过、路由永不注册，面板只会拿到空响应。
  let mountedNow = false
  try {
    const now = getService('webServer')
    if (now && typeof now.register === 'function') {
      mountApi(now)
      mountedNow = api.mounted
    } else {
      api.reason = 'waiting-for-webserver'
    }
  } catch (error) {
    api.reason = 'lookup-failed: ' + String(error?.message ?? error)
  }

  if (!mountedNow) {
    try {
      ctx.inject(['webServer'], (webCtx) => {
        mountApi(webCtx.webServer)
      })
    } catch (error) {
      api.reason = 'inject-failed: ' + String(error?.message ?? error)
    }
  }

  ctx.logger?.info?.(
    '[session-chat] 会话群聊已就绪；面板 API: ' + api.reason + ' (' + API_PATH + ')',
  )
}
