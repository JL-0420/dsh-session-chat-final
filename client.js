/* 会话群聊 · 可视化面板 v2
 * 布局参照正常对话：左侧群组/会话，右侧消息流 + 输入框。
 * 与 Host 通过 /dsh-session-chat-api 通信。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-chat-final',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const API = '/dsh-session-chat-api'
    const PANEL_KEY = 'dsh-session-chat-final'
    const ME_KEY = 'dsh-session-chat:me'
    // 与 Host 约定：面板里的「主人」虚拟身份，不绑定任何会话
    const HOST_ID = '__host__'

    async function readJson(res) {
      const text = await res.text()
      if (!text) throw new Error(`HTTP ${res.status} · 响应为空 —— Host 侧 ${API} 没挂载`)
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${res.status} · 不是 JSON：${text.slice(0, 120)}`)
      }
    }

    const S = {
      root: {
        display: 'flex',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        overflow: 'hidden',
      },
      side: {
        width: 250,
        flex: '0 0 250px',
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        minHeight: 0,
      },
      sideHead: {
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      },
      sideScroll: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '6px 0' },
      sectionTitle: {
        padding: '8px 12px 4px',
        fontSize: 11,
        letterSpacing: 0.4,
        color: 'var(--dsw-alias-label-secondary)',
      },
      item: (active) => ({
        padding: '7px 12px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        borderLeft: active ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
      }),
      itemName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: (color) => ({
        fontSize: 10,
        padding: '1px 5px',
        borderRadius: 8,
        color,
        border: '1px solid ' + color,
        lineHeight: 1.5,
        flexShrink: 0,
      }),
      dot: (on) => ({
        width: 6,
        height: 6,
        borderRadius: 3,
        flexShrink: 0,
        background: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)',
      }),
      main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
      mainHead: {
        padding: '10px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      mainTitle: { fontSize: 14, fontWeight: 600 },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      flow: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '14px 16px' },
      msgRow: (mine) => ({
        display: 'flex',
        flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
        marginBottom: 10,
      }),
      msgMeta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 3 },
      bubble: (mine) => ({
        maxWidth: '78%',
        padding: '7px 11px',
        borderRadius: 10,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.55,
        background: mine ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderBottomRightRadius: mine ? 3 : 10,
        borderBottomLeftRadius: mine ? 10 : 3,
      }),
      composer: {
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        padding: '10px 16px 14px',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
      },
      textarea: {
        flex: 1,
        minHeight: 46,
        maxHeight: 140,
        resize: 'vertical',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 13,
        fontFamily: 'inherit',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        lineHeight: 1.5,
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 7,
        padding: '5px 10px',
        cursor: 'pointer',
        fontSize: 12,
        flexShrink: 0,
      },
      btnPrimary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        borderRadius: 7,
        padding: '6px 14px',
        cursor: 'pointer',
        fontSize: 12,
        flexShrink: 0,
      },
      btnGhost: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: 14,
        padding: '2px 4px',
      },
      btnDanger: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        cursor: 'pointer',
        fontSize: 12,
        padding: '2px 5px',
      },
      input: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 7,
        padding: '5px 9px',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      select: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 7,
        padding: '3px 6px',
        fontSize: 12,
        maxWidth: 220,
      },
      pop: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        borderRadius: 8,
        padding: 10,
        margin: '6px 0',
        boxShadow: '0 6px 22px rgba(0,0,0,.16)',
      },
      flash: {
        margin: '8px 16px 0',
        padding: '6px 10px',
        borderRadius: 6,
        fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      empty: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--dsw-alias-label-secondary)',
        gap: 8,
        padding: 24,
        textAlign: 'center',
        lineHeight: 1.7,
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 11,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
    }

    function Icon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 1 1 21 12z' }),
        h('circle', { cx: 9, cy: 11, r: 0.85, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 13, cy: 11, r: 0.85, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 17, cy: 11, r: 0.85, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function timeText(at) {
      try {
        return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** 用名字算一个稳定的头彩色，同一会话每次都是同色 */
    function avatarColor(name) {
      const text = String(name || '?')
      let hash = 0
      for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360
      return 'hsl(' + hash + ' 55% 48%)'
    }

    /**
     * 成员头像：用独立头像库里的图（按 seed 选一张）；
     * 没有图就退回「彩色首字」圆形头像。
     */
    function Avatar(props) {
      const name = String(props.name || '?')
      const size = props.size || 22
      const url = props.url

      if (url) {
        return h('img', {
          src: url,
          alt: name,
          title: name,
          style: {
            width: size,
            height: size,
            flexShrink: 0,
            borderRadius: Math.round(size * 0.28),
            objectFit: 'cover',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
        })
      }

      return h(
        'span',
        {
          style: {
            width: size,
            height: size,
            flexShrink: 0,
            borderRadius: size / 2,
            background: avatarColor(name),
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: Math.round(size * 0.5),
            fontWeight: 600,
            lineHeight: 1,
            userSelect: 'none',
          },
          title: name,
        },
        name.slice(0, 1).toUpperCase(),
      )
    }


    function Panel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [me, setMeState] = useState(() => {
        try {
          return window.localStorage.getItem(ME_KEY) || ''
        } catch {
          return ''
        }
      })
      const [activeGroup, setActiveGroup] = useState('')
      const [rosterOpen, setRosterOpen] = useState(false)
      const [inviteOpen, setInviteOpen] = useState(false)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [newGroup, setNewGroup] = useState('')
      const [nick, setNick] = useState('')
      const [draft, setDraft] = useState('')
      const [mentionOpen, setMentionOpen] = useState(false)
      const [profileOpen, setProfileOpen] = useState(false)
      const [mentionPicks, setMentionPicks] = useState([])
      const [memes, setMemes] = useState([]) // 已弃用，保留占位避免旧引用报错
      const [avatarList, setAvatarList] = useState([])
      const [avatarMap, setAvatarMap] = useState({})
      const [avatarDir, setAvatarDir] = useState('')
      const [avatarMsg, setAvatarMsg] = useState('')
      const fileRef = useRef(null)
      const [flash, setFlash] = useState('')
      const [busy, setBusy] = useState(false)
      const [routerMode, setRouterMode] = useState('off')
      const [routerProvider, setRouterProvider] = useState('')
      const [routerModel, setRouterModel] = useState('')
      const [providers, setProviders] = useState([])
      const [models, setModels] = useState([])
      const [modelError, setModelError] = useState('')
      const [modelLoading, setModelLoading] = useState(false)
      const [candidates, setCandidates] = useState([])
      const [candLoading, setCandLoading] = useState(false)
      const [candError, setCandError] = useState('')
      const [candFilter, setCandFilter] = useState('')
      const flowRef = useRef(null)
      const pollRef = useRef(null)

      const setMe = useCallback((id) => {
        setMeState(id)
        try {
          window.localStorage.setItem(ME_KEY, id)
        } catch {
          /* 隐私模式忽略 */
        }
      }, [])

      const refresh = useCallback(async () => {
        try {
          const url = new URL(API, window.location.origin)
          url.searchParams.set('op', 'state')
          if (me) url.searchParams.set('session', me)
          const data = await readJson(await fetch(url.toString()))
          if (data && data.ok) {
            setState(data.state)
            setError('')
            const list = (data.state && data.state.sessions) || []
            if (list.length) {
              const stillThere = list.some((s) => s.id === me)
              if (!me || !stillThere) setMe(list[0].id)
            }
          } else {
            setError((data && data.error) || '无法读取状态')
          }
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [me, setMe])

      useEffect(() => {
        refresh()
        pollRef.current = setInterval(refresh, 3000)
        return () => {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, [refresh])

      // 「正在输入」心跳：只有草稿里有字时才发，纯给面板显示用
      // 注意只读 activeGroup（state），不能用后面定义的 group
      useEffect(() => {
        if (!activeGroup || !me || !draft.trim()) return undefined
        const fire = () => {
          try {
            const url = new URL(API, window.location.origin)
            url.searchParams.set('op', 'typing')
            url.searchParams.set('session', me)
            url.searchParams.set('group', activeGroup)
            fetch(url.toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }).catch(() => {})
          } catch {
            /* 忽略 */
          }
        }
        fire()
        const id = setInterval(fire, 2500)
        return () => clearInterval(id)
      }, [activeGroup, me, draft])

      // 独立头像库：先拿列表，再按需拉图片（不依赖表情包插件）
      const loadAvatars = useCallback(async () => {
        try {
          const url = new URL(API, window.location.origin)
          url.searchParams.set('op', 'avatars')
          const data = await readJson(await fetch(url.toString()))
          if (data && data.ok) {
            const list = data.avatars || []
            setAvatarList(list)
            setAvatarDir(data.dir || '')
            // 预拉前 24 张的缩略图，供「点头像改自己头像」用
            const patch = {}
            for (const item of list.slice(0, 24)) {
              try {
                const u2 = new URL(API, window.location.origin)
                u2.searchParams.set('op', 'avatar')
                u2.searchParams.set('name', item.id)
                const d2 = await readJson(await fetch(u2.toString()))
                if (d2 && d2.ok && d2.dataUrl) patch[item.id] = d2.dataUrl
              } catch {
                /* 单张失败忽略 */
              }
            }
            if (Object.keys(patch).length) {
              setAvatarMap((prev) => Object.assign({}, prev, patch))
            }
          }
        } catch {
          setAvatarList([])
        }
      }, [])

      /** 把头像库里某张图设成自己的头像 */
      const setMyAvatar = async (fileName) => {
        if (!group) {
          setAvatarMsg('先选一个群再设头像')
          return
        }
        await run('set_avatar', { group: group.id, target: me, name: fileName })
        setAvatarMsg('头像已设为 ' + fileName)
      }

      /** 导入图片到头像库：读成 dataUrl 后交给 Host 落盘 */
      const handleAvatarUpload = async (event) => {
        const files = Array.from((event.target && event.target.files) || [])
        if (!files.length) return
        setAvatarMsg('正在导入 ' + files.length + ' 张…')
        const items = []
        for (const file of files) {
          if (!/^image\//.test(file.type)) continue
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result || ''))
              reader.onerror = reject
              reader.readAsDataURL(file)
            })
            items.push({ name: file.name, dataUrl })
          } catch {
            /* 单张读取失败跳过 */
          }
        }
        if (!items.length) {
          setAvatarMsg('没有可导入的图片')
          if (fileRef.current) fileRef.current.value = ''
          return
        }
        try {
          const url = new URL(API, window.location.origin)
          url.searchParams.set('op', 'upload_avatar')
          url.searchParams.set('session', me)
          const res = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items }),
          })
          const data = await readJson(res)
          if (data && data.ok) {
            setAvatarList(data.avatars || [])
            setAvatarMsg(
              '已导入 ' + data.saved + ' 张' + (data.failed ? '，失败 ' + data.failed + ' 张' : ''),
            )
          } else {
            setAvatarMsg('导入失败：' + ((data && data.error) || '未知'))
          }
        } catch (err) {
          setAvatarMsg('导入失败：' + String((err && err.message) || err))
        } finally {
          if (fileRef.current) fileRef.current.value = ''
        }
      }

      useEffect(() => {
        loadAvatars()
      }, [loadAvatars])

      // 给当前群成员按需拉头像图片，拉过的不重复拉
      // 注意：这里只能读 state.groups，不能引用后面的 groups 变量（TDZ）
      useEffect(() => {
        const list = (state && state.groups) || []
        const need = new Set()
        for (const g of list) {
          for (const m of g.members) {
            // 手动指定的头像直接按文件名拉
            if (m.avatarName) {
              if (!avatarMap[m.avatarName]) need.add(m.avatarName)
              continue
            }
            if (!avatarList.length) continue
            const idx = Math.abs(Number(m.seed) || 0) % avatarList.length
            const item = avatarList[idx]
            if (item && !avatarMap[item.id]) need.add(item.id)
          }
        }
        if (!need.size) return
        let alive = true
        ;(async () => {
          const patch = {}
          for (const id of need) {
            try {
              const url = new URL(API, window.location.origin)
              url.searchParams.set('op', 'avatar')
              url.searchParams.set('name', id)
              const data = await readJson(await fetch(url.toString()))
              if (data && data.ok && data.dataUrl) patch[id] = data.dataUrl
            } catch {
              /* 单张失败忽略 */
            }
          }
          if (alive && Object.keys(patch).length) {
            setAvatarMap((prev) => Object.assign({}, prev, patch))
          }
        })()
        return () => {
          alive = false
        }
      }, [avatarList, state, avatarMap])


      const run = async (op, payload) => {
        if (busy) return null
        setBusy(true)
        setFlash('')
        try {
          const url = new URL(API, window.location.origin)
          url.searchParams.set('op', op)
          url.searchParams.set('session', me)
          const res = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, payload, { session: me })),
          })
          const data = await readJson(res)
          if (data && data.state) setState(data.state)
          if (data && data.result && data.result.text) setFlash(data.result.text)
          else if (data && data.error) setFlash('错误：' + data.error)
          return data
        } catch (err) {
          setFlash('请求失败：' + String((err && err.message) || err))
          return null
        } finally {
          setBusy(false)
        }
      }

      const rate = (state && state.rate) || { perMinute: 3, paused: false }
      const quota = (state && state.quota) || { used: 0, limit: rate.perMinute, resetInMs: 0 }
      const sessions = (state && state.sessions) || []
      const groups = (state && state.groups) || []
      const meInfo = sessions.find((s) => s.id === me)
      const meName = (meInfo && meInfo.name) || ''
      const group = groups.find((g) => g.id === activeGroup) || null
      // 当前用户在这个群里的成员对象（两处 head 都要用）
      const meMember = group ? group.members.find((m) => m.id === me) || null : null

      /** 成员头像：手动指定的优先，其次按 seed 从库里取；都没有返回空（Avatar 退回首字） */
      const avatarUrlFor = (member) => {
        if (!member) return ''
        if (member.avatarName) return avatarMap[member.avatarName] || ''
        const lib = Array.isArray(avatarList) ? avatarList : []
        if (!lib.length) return ''
        const idx = Math.abs(Number(member.seed) || 0) % lib.length
        const item = lib[idx]
        return (item && avatarMap[item.id]) || ''
      }

      const memberById = (id) => (group ? group.members.find((x) => x.id === id) : undefined)

      const isMine = (g) => !!g && !!me && (g.ownerId === me || me === HOST_ID)
      const amMember = (g) => !!g && !!me && g.members.some((m) => m.id === me)

      useEffect(() => {
        const el = flowRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [activeGroup, group ? group.messages.length : 0])

      const send = async () => {
        const text = draft.trim()
        if (!text || !group) return
        if (me !== HOST_ID && !amMember(group)) return
        const picks = mentionPicks.slice()
        setDraft('')
        setMentionPicks([])
        await run('send', { group: group.id, text, mentions: picks })
      }

      /** 戳一戳：单独叫醒某个成员一次，不带上下文 */
      const pokeMember = async (member) => {
        if (!member || !group) return
        if (member.id === me) {
          setFlash('不能戳自己')
          return
        }
        await run('poke', { group: group.id, target: member.id })
      }

      /** 把某个成员插进 @ 并记下 id（不靠名字，改名重名都不会错） */
      const pickMention = (member) => {
        if (!member) return
        setDraft((d) => (d && !/\s$/.test(d) ? d + ' ' : d || '') + '@' + member.name + ' ')
        setMentionPicks((prev) => (prev.includes(member.id) ? prev : prev.concat(member.id)))
        setMentionOpen(false)
      }

      const changeRate = (d) => run('set_rate', { value: Math.max(1, Math.min(120, rate.perMinute + d)) })

      // 拉可用 provider / model 给路由配置用
      const loadModels = async (provider) => {
        setModelLoading(true)
        setModelError('')
        try {
          const url = new URL(API, window.location.origin)
          url.searchParams.set('op', 'models')
          if (provider) url.searchParams.set('provider', provider)
          const data = await readJson(await fetch(url.toString()))
          if (data && data.ok) {
            setProviders(data.providers || [])
            setModels(data.models || [])
            setModelError(data.error || '')
            if (!provider && data.provider) setRouterProvider(data.provider)
          } else {
            setModelError((data && data.error) || '读取模型列表失败')
          }
        } catch (err) {
          setProviders([])
          setModels([])
          setModelError('请求失败：' + String((err && err.message) || err))
        } finally {
          setModelLoading(false)
        }
      }

      // 拉人候选：活会话 + 休眠会话都列出来
      const loadCandidates = async (groupId) => {
        setCandLoading(true)
        setCandError('')
        try {
          const url = new URL(API, window.location.origin)
          url.searchParams.set('op', 'candidates')
          url.searchParams.set('group', groupId)
          const data = await readJson(await fetch(url.toString()))
          if (data && data.ok) {
            setCandidates(data.candidates || [])
          } else {
            setCandidates([])
            setCandError((data && data.error) || '读取候选会话失败')
          }
        } catch (err) {
          setCandidates([])
          setCandError('请求失败：' + String((err && err.message) || err))
        } finally {
          setCandLoading(false)
        }
      }

      const groupItems = groups.map((g) =>
        h(
          'div',
          {
            key: g.id,
            style: S.item(activeGroup === g.id),
            onClick: () => {
              setActiveGroup(g.id)
              setRosterOpen(false)
              setInviteOpen(false)
            },
            title: g.name,
          },
          h('span', { key: 'd', style: S.dot(true) }),
          h('span', { key: 'n', style: S.itemName }, g.name),
          amMember(g)
            ? h('span', { key: 'm', style: S.badge('var(--dsw-alias-brand-primary)') }, '在群')
            : null,
        ),
      )

      // 左栏只列真实会话；「主人」是面板虚拟身份，只出现在顶部下拉里
      const sessionItems = sessions
        .filter((s) => !s.host)
        .map((s) =>
          h(
            'div',
            { key: s.id, style: S.item(false), title: s.cwd || s.id },
            h('span', { key: 'd', style: S.dot(true) }),
            h('span', { key: 'n', style: S.itemName }, s.name),
            s.id === me ? h('span', { key: 'me', style: S.badge('var(--dsw-alias-brand-primary)') }, '我') : null,
          ),
        )

      const side = h('div', { key: 'side', style: S.side }, [
        h('div', { key: 'head', style: S.sideHead }, [
          h('span', { key: 'i', style: { display: 'flex' } }, h(Icon, {})),
          h('span', { key: 't', style: { fontWeight: 600 } }, '会话群聊'),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h('button', { key: 'r', type: 'button', style: S.btnGhost, title: '刷新', onClick: refresh }, '⟳'),
        ]),
        h('div', { key: 'scroll', style: S.sideScroll }, [
          h('div', { key: 'gt', style: S.sectionTitle }, '群组'),
          groups.length === 0
            ? h('div', { key: 'ge', style: Object.assign({}, S.meta, { padding: '2px 12px 6px' }) }, '还没有群组')
            : groupItems,
          h('div', { key: 'st', style: S.sectionTitle }, '会话'),
          sessionItems.length === 0
            ? h('div', { key: 'se', style: Object.assign({}, S.meta, { padding: '2px 12px' }) }, '没有活会话')
            : sessionItems,
        ]),
        h(
          'div',
          {
            key: 'new',
            style: {
              borderTop: '1px solid var(--dsw-alias-border-l1)',
              padding: 8,
              display: 'flex',
              gap: 6,
            },
          },
          [
            h('input', {
              key: 'i',
              style: Object.assign({}, S.input, { flex: 1, minWidth: 0 }),
              placeholder: '新群组名',
              value: newGroup,
              onChange: (e) => setNewGroup(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && newGroup.trim()) {
                  const name = newGroup.trim()
                  setNewGroup('')
                  run('create_group', { name }).then((r) => {
                    const made = r && r.state && r.state.groups.find((g) => g.name === name)
                    if (made) setActiveGroup(made.id)
                  })
                }
              },
            }),
            h(
              'button',
              {
                key: 'b',
                type: 'button',
                style: Object.assign({}, S.btnPrimary, {
                  opacity: newGroup.trim() && me ? 1 : 0.45,
                }),
                disabled: !newGroup.trim() || !me,
                onClick: () => {
                  const name = newGroup.trim()
                  if (!name) return
                  setNewGroup('')
                  run('create_group', { name }).then((r) => {
                    const made = r && r.state && r.state.groups.find((g) => g.name === name)
                    if (made) setActiveGroup(made.id)
                  })
                },
              },
              '建群',
            ),
          ],
        ),
      ])

      let right = null

      if (error) {
        right = h('div', { style: S.empty }, [
          h('div', { key: 'a' }, '⚠ ' + error),
          h(
            'div',
            { key: 'b', style: { fontSize: 12 } },
            '排查：① 插件重装后是否重启过 DSH；② 执行 session_chat 的 action=diag 看「面板 API」是否 mounted。',
          ),
        ])
      } else if (!state) {
        right = h('div', { style: S.empty }, '载入中…')
      } else if (!group) {
        right = h('div', { style: S.empty }, [
          h('div', { key: 'a' }, groups.length ? '左侧选一个群组开始聊' : '还没有群组，先在左下角建一个'),
          h(
            'div',
            { key: 'b', style: { fontSize: 12 } },
            '每个会话每分钟最多发 ' + rate.perMinute + ' 条，可在群里的「设置」调整',
          ),
        ])
      } else {
        const member = amMember(group)
        const isHostMe = me === HOST_ID
        const canSpeak = isHostMe || member
        const owner = isMine(group)

        const roster = h('div', { style: S.pop }, [
          h('div', { key: 't', style: Object.assign({}, S.meta, { marginBottom: 6 }) }, '成员 ' + group.members.length + ' 人'),
          h(
            'div',
            { key: 'l' },
            group.members.map((m) =>
              h('div', { key: m.id, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' } }, [
                h('span', { key: 'avw', style: { display: 'flex', cursor: 'pointer' }, title: '戳一戳', onClick: () => pokeMember(m) },
                  h(Avatar, { key: 'a', name: m.name, url: avatarUrlFor(m), size: 20 }),
                ),
                h(
                  'button',
                  {
                    key: 'n',
                    type: 'button',
                    title: '点击把 @名字 插进输入框',
                    style: {
                      flex: 1,
                      textAlign: 'left',
                      border: 'none',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: 12,
                      padding: 0,
                      fontFamily: 'inherit',
                    },
                    onClick: () => { pickMention(m); setRosterOpen(false) },
                  },
                  m.name + (m.id === me ? '（我）' : ''),
                ),
                m.id === group.ownerId
                  ? h('span', { key: 'o', style: S.badge('var(--dsw-alias-state-warn-primary)') }, '群主')
                  : null,
                owner && m.id !== me
                  ? h(
                      'button',
                      {
                        key: 'k',
                        type: 'button',
                        style: S.btnDanger,
                        title: '移出群组',
                        onClick: () => run('kick', { group: group.id, target: m.id }),
                      },
                      '踢出',
                    )
                  : null,
              ]),
            ),
          ),
          member
            ? h(
                'button',
                {
                  key: 'leave',
                  type: 'button',
                  style: Object.assign({}, S.btnDanger, { marginTop: 6 }),
                  onClick: () =>
                    run('leave', { group: group.id }).then(() => setRosterOpen(false)),
                },
                '退出此群',
              )
            : null,
        ])

        const kw = candFilter.trim().toLowerCase()
        const shown = kw
          ? candidates.filter(
              (c) =>
                (c.name || '').toLowerCase().includes(kw) || (c.cwd || '').toLowerCase().includes(kw),
            )
          : candidates

        const invite = h('div', { style: S.pop }, [
          h('div', { key: 't', style: Object.assign({}, S.meta, { marginBottom: 6 }) }, '选择要拉进群的会话'),
          h('div', { key: 'sr', style: { display: 'flex', gap: 6, marginBottom: 6 } }, [
            h('input', {
              key: 'i',
              style: Object.assign({}, S.input, { flex: 1 }),
              placeholder: '按名字或工作区筛选',
              value: candFilter,
              onChange: (e) => setCandFilter(e.target.value),
            }),
            h(
              'button',
              {
                key: 'r',
                type: 'button',
                style: S.btnGhost,
                onClick: () => loadCandidates(group.id),
                title: '重新扫描（含休眠会话）',
              },
              '⟳',
            ),
          ]),
          candLoading
            ? h('div', { key: 'l', style: S.meta }, '正在扫描会话（含休眠存档）…')
            : candError
              ? h(
                  'div',
                  { key: 'e', style: Object.assign({}, S.meta, { color: 'var(--dsw-alias-state-warn-primary)' }) },
                  candError,
                )
              : shown.length === 0
                ? h(
                    'div',
                    { key: 'e', style: Object.assign({}, S.meta, { padding: '4px 0' }) },
                    candidates.length === 0 ? '没有可邀请的会话（都已在群里）' : '没有匹配的会话',
                  )
                : h(
                    'div',
                    { key: 'l', style: { maxHeight: '38vh', overflowY: 'auto' } },
                    shown.slice(0, 200).map((s) =>
                      h(
                        'button',
                        {
                          key: s.id,
                          type: 'button',
                          style: Object.assign({}, S.btn, {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            width: '100%',
                            textAlign: 'left',
                            marginBottom: 3,
                          }),
                          title: s.cwd || s.id,
                          onClick: () =>
                            run('join', { group: group.id, target: s.id }).then(() => setInviteOpen(false)),
                        },
                        h('span', { key: 'd', style: S.dot(s.live) }),
                        h('span', { key: 'n', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name),
                        h('span', { key: 'tag', style: S.meta }, s.live ? '在线' : '休眠'),
                      ),
                    ),
                  ),
          h(
            'div',
            { key: 'h', style: Object.assign({}, S.meta, { marginTop: 4 }) },
            '休眠会话也能拉，但它不在线时消息只会排队，等它被打开再补发。',
          ),
        ])

        const head = h('div', { key: 'head', style: S.mainHead }, [
          h('span', { key: 't', style: S.mainTitle }, group.name),
          h('span', { key: 'm', style: S.meta }, group.members.length + ' 人 · ' + group.messages.length + ' 条'),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h(
            'button',
            {
              key: 'roster',
              type: 'button',
              style: S.btn,
              onClick: () => {
                setRosterOpen(!rosterOpen)
                setInviteOpen(false)
                setSettingsOpen(false)
              },
            },
            '成员',
          ),
          owner
            ? h(
                'button',
                {
                  key: 'inv',
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    const next = !inviteOpen
                    setInviteOpen(next)
                    setRosterOpen(false)
                    setSettingsOpen(false)
                    if (next) {
                      setCandFilter('')
                      loadCandidates(group.id)
                    }
                  },
                },
                '＋ 拉人',
              )
            : null,
          h(
            'button',
            {
              key: 'set',
              type: 'button',
              style: S.btn,
              onClick: () => {
                const next = !settingsOpen
                setSettingsOpen(next)
                setRosterOpen(false)
                setInviteOpen(false)
                if (next) {
                  const rt = (state && state.router) || {}
                  setRouterMode(rt.mode || 'off')
                  setRouterProvider(rt.provider || '')
                  setRouterModel(rt.model || '')
                  loadModels(rt.provider || '')
                }
              },
            },
            '设置',
          ),
          !member && !isHostMe
            ? h(
                'button',
                {
                  key: 'join',
                  type: 'button',
                  style: S.btnPrimary,
                  onClick: () => run('join', { group: group.id }),
                },
                '加入群组',
              )
            : null,
        ])

        const msgs = group.messages.map((m) => {
          const mine = m.from === me
          const pingedMe = !mine && (m.mentions || []).indexOf(me) >= 0
          const metaText = mine
            ? '我 · ' + timeText(m.at)
            : m.fromName + (pingedMe ? ' · @你' : '') + ' · ' + timeText(m.at)
          const bubbleStyle = pingedMe
            ? Object.assign({}, S.bubble(mine), { borderLeft: '3px solid var(--dsw-alias-brand-primary)' })
            : S.bubble(mine)
          const metaStyle = pingedMe
            ? Object.assign({}, S.msgMeta, { color: 'var(--dsw-alias-brand-primary)', fontWeight: 600 })
            : S.msgMeta

          // 头像：按发送者找群成员；主人不是成员，用名字做兜底头像
          const sender = memberById(m.from)
          const avatarUrl = sender ? avatarUrlFor(sender) : avatarMap['__host__'] || ''
          const senderLabel = m.fromName || '?'

          // 像正常聊天软件：头像在气泡外侧，自己靠右
          return h(
            'div',
            {
              key: m.id,
              style: {
                display: 'flex',
                flexDirection: mine ? 'row-reverse' : 'row',
                alignItems: 'flex-start',
                gap: 8,
                marginBottom: 10,
              },
            },
            [
              h('span', {
                  key: 'av',
                  style: { display: 'flex', cursor: sender ? 'pointer' : 'default' },
                  title: sender ? '戳一戳 ' + senderLabel : senderLabel,
                  onClick: sender ? () => pokeMember(sender) : undefined,
                },
                h(Avatar, { name: senderLabel, url: avatarUrl, size: 32 }),
              ),
              h(
                'div',
                {
                  key: 'col',
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: mine ? 'flex-end' : 'flex-start',
                    maxWidth: '76%',
                  },
                },
                [
                  h('div', { key: 'meta', style: metaStyle }, metaText),
                  h('div', { key: 'b', style: bubbleStyle }, m.text),
                ],
              ),
            ],
          )
        })

        const body =
          group.messages.length === 0
            ? h('div', { key: 'e', style: Object.assign({}, S.empty, { flex: 'none' }) }, [
                h('div', { key: 'a' }, '这个群还没有消息'),
                h('div', { key: 'b', style: { fontSize: 12 } }, member ? '从下面发第一条' : '先点右上「加入群组」'),
              ])
            : msgs.concat([
                // 「某某正在输入…」——只给看面板的人看，不投递给任何会话
                (group.typing || []).filter((t) => t.id !== me).length > 0
                  ? h(
                      'div',
                      {
                        key: 'typing',
                        style: {
                          fontSize: 12,
                          color: 'var(--dsw-alias-label-secondary)',
                          padding: '2px 4px 6px',
                          fontStyle: 'italic',
                        },
                      },
                      (group.typing || [])
                        .filter((t) => t.id !== me)
                        .map((t) => t.name)
                        .join('、') + ' 正在输入…',
                    )
                  : null,
              ])

        right = h('div', { style: S.main }, [
          head,
          profileOpen && group && member
            ? h('div', { key: 'profile', style: { padding: '0 16px' } }, [
                h(
                  'div',
                  { key: 't', style: Object.assign({}, S.meta, { marginBottom: 6 }) },
                  '我的资料 · 头像只能从头像库里选',
                ),
                h(
                  'div',
                  { key: 'avs', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
                  (Array.isArray(avatarList) ? avatarList : []).slice(0, 24).map((item) =>
                    h(
                      'button',
                      {
                        key: item.id,
                        type: 'button',
                        title: item.name,
                        style: {
                          width: 36,
                          height: 36,
                          padding: 0,
                          cursor: 'pointer',
                          border:
                            member.avatarName === item.id
                              ? '2px solid var(--dsw-alias-brand-primary)'
                              : '2px solid var(--dsw-alias-border-l1)',
                          borderRadius: 8,
                          overflow: 'hidden',
                          background: 'var(--dsw-alias-bg-layer-2)',
                        },
                        onClick: () => setMyAvatar(item.id),
                      },
                      avatarMap[item.id]
                        ? h('img', {
                            src: avatarMap[item.id],
                            alt: item.name,
                            style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
                          })
                        : h('span', { style: { fontSize: 10 } }, '…'),
                    ),
                  ),
                ),
                (Array.isArray(avatarList) ? avatarList.length : 0) === 0
                  ? h(
                      'div',
                      { key: 'empty', style: Object.assign({}, S.meta, { marginBottom: 6 }) },
                      '头像库还是空的：先把图片丢进 ' + (avatarDir || 'avatars 目录') + '，或点右边「导入」',
                    )
                  : null,
                h('div', { key: 'n', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
                  h('input', {
                    key: 'i',
                    style: Object.assign({}, S.input, { flex: '1 1 120px', padding: '5px 8px' }),
                    placeholder: '昵称',
                    value: nick,
                    onChange: (e) => setNick(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' && nick.trim()) {
                        run('identity', { name: nick.trim() }).then(() => setNick(''))
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      key: 's',
                      type: 'button',
                      style: S.btnPrimary,
                      disabled: !nick.trim(),
                      onClick: () => {
                        if (!nick.trim()) return
                        run('identity', { name: nick.trim() }).then(() => setNick(''))
                      },
                    },
                    '保存',
                  ),
                  h(
                    'button',
                    { key: 'u', type: 'button', style: S.btn, onClick: () => fileRef.current && fileRef.current.click() },
                    '导入',
                  ),
                  h('button', { key: 'c', type: 'button', style: S.btn, onClick: () => setProfileOpen(false) }, '关闭'),
                ]),
              ])
            : null,
          rosterOpen ? h('div', { key: 'roster', style: { padding: '0 16px' } }, roster) : null,
          inviteOpen ? h('div', { key: 'invite', style: { padding: '0 16px' } }, invite) : null,
          flash ? h('div', { key: 'flash', style: S.flash }, flash) : null,
          h('div', {
            key: 'flow',
            ref: flowRef,
            style: S.flow,
            // 点消息区（非弹层）就把展开的弹层收起来
            onClick: () => {
              setSettingsOpen(false)
              setRosterOpen(false)
              setInviteOpen(false)
              setMentionOpen(false)
            },
          }, body),
          // @ 提及选择器：点 @ 按钮列出群成员，点谁就插入 @谁
          mentionOpen && canSpeak
            ? h(
                'div',
                {
                  key: 'mention',
                  style: {
                    margin: '0 16px',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    borderRadius: 8,
                    background: 'var(--dsw-alias-bg-overlay)',
                    padding: 8,
                    maxHeight: '30vh',
                    overflowY: 'auto',
                  },
                },
                group.members.filter((m) => m.id !== me).length === 0
                  ? h('div', { style: S.meta }, '群里没有其他成员可提及')
                  : group.members
                      .filter((m) => m.id !== me)
                      .map((m) =>
                        h(
                          'button',
                          {
                            key: m.id,
                            type: 'button',
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              width: '100%',
                              textAlign: 'left',
                              border: 'none',
                              background: 'transparent',
                              color: 'inherit',
                              cursor: 'pointer',
                              padding: '5px 6px',
                              borderRadius: 6,
                              fontSize: 12,
                              fontFamily: 'inherit',
                            },
                            onMouseEnter: (e) => {
                              e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)'
                            },
                            onMouseLeave: (e) => {
                              e.currentTarget.style.background = 'transparent'
                            },
                            onClick: () => pickMention(m),
                          },
                          h(Avatar, { key: 'a', name: m.name, url: avatarUrlFor(m), size: 22 }),
                          h('span', { key: 'n', style: { flex: 1 } }, m.name),
                          h('span', { key: 't', style: S.meta }, m.live ? '在线' : '休眠'),
                        ),
                      ),
              )
            : null,
          h('div', { key: 'comp', style: S.composer }, [
            h(
              'button',
              {
                key: 'at',
                type: 'button',
                title: '插入 @成员',
                style: Object.assign({}, S.btn, {
                  opacity: canSpeak ? 1 : 0.45,
                  fontWeight: 600,
                  minWidth: 34,
                }),
                disabled: !canSpeak,
                onClick: () => setMentionOpen(!mentionOpen),
              },
              '@',
            ),
            h('textarea', {
              key: 't',
              style: S.textarea,
              rows: 2,
              placeholder: canSpeak
                ? rate.paused
                  ? '投递已暂停，消息不会送出去'
                  : '以「' + meName + '」的身份发言；点左边 @ 可以提及成员；Enter 发送'
                : '先加入群组才能发言',
              value: draft,
              disabled: !canSpeak,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              },
            }),
            // 强制全员：跳过 AI 路由，直接叫醒所有成员
            h(
              'button',
              {
                key: 'force',
                type: 'button',
                title: '强制全员（跳过 AI 路由判断）',
                style: Object.assign({}, S.btn, {
                  opacity: canSpeak && draft.trim() ? 1 : 0.45,
                }),
                disabled: !canSpeak || !draft.trim(),
                onClick: () => {
                  const text = draft.trim()
                  if (!text || !group) return
                  const picks = mentionPicks.slice()
                  setDraft('')
                  setMentionPicks([])
                  run('send', { group: group.id, text, force: true, mentions: picks })
                },
              },
              '⚡全员',
            ),
            h(
              'button',
              {
                key: 's',
                type: 'button',
                style: Object.assign({}, S.btnPrimary, {
                  opacity: canSpeak && draft.trim() ? 1 : 0.45,
                }),
                disabled: !canSpeak || !draft.trim(),
                onClick: send,
              },
              '发送',
            ),
          ]),
        ])
      }

      const settingsPanel = h('div', { style: S.pop }, [
        h('div', { key: 'nt', style: Object.assign({}, S.meta, { marginBottom: 4 }) }, '我的群聊昵称'),
        h('div', { key: 'nr', style: { display: 'flex', gap: 6, marginBottom: 10 } }, [
          h('input', {
            key: 'i',
            style: Object.assign({}, S.input, { flex: 1 }),
            placeholder: meName || '输入昵称',
            value: nick,
            onChange: (e) => setNick(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && nick.trim()) {
                run('identity', { name: nick.trim() }).then(() => setNick(''))
              }
            },
          }),
          h(
            'button',
            {
              key: 'b',
              type: 'button',
              style: S.btnPrimary,
              onClick: () => {
                if (nick.trim()) run('identity', { name: nick.trim() }).then(() => setNick(''))
              },
            },
            '保存',
          ),
        ]),
        h('div', { key: 'rt', style: Object.assign({}, S.meta, { marginBottom: 4 }) }, '每个会话每分钟条数'),
        h('div', { key: 'rr', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } }, [
          h('button', { key: 'm', type: 'button', style: S.btn, onClick: () => changeRate(-1) }, '−'),
          h('span', { key: 'v', style: { minWidth: 58, textAlign: 'center', fontWeight: 600 } }, rate.perMinute + ' 条'),
          h('button', { key: 'p', type: 'button', style: S.btn, onClick: () => changeRate(1) }, '+'),
          h('span', { key: 'q', style: Object.assign({}, S.meta, { marginLeft: 4 }) }, '已用 ' + quota.used + '/' + quota.limit),
        ]),
        h(
          'button',
          {
            key: 'pz',
            type: 'button',
            style: rate.paused ? S.btnDanger : S.btn,
            onClick: () => run('set_paused', { paused: !rate.paused }),
          },
          rate.paused ? '已暂停 · 点此恢复' : '暂停投递',
        ),
        h('div', {
          key: 'divider-av',
          style: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '10px 0' },
        }),
        h(
          'div',
          { key: 'av-t', style: Object.assign({}, S.meta, { marginBottom: 4 }) },
          '头像库（成员进群时随机抽一张）',
        ),
        h(
          'div',
          { key: 'av-r', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 } },
          [
            h(
              'button',
              {
                key: 'up',
                type: 'button',
                style: S.btnPrimary,
                onClick: () => fileRef.current && fileRef.current.click(),
              },
              '导入图片',
            ),
            h('span', { key: 'c', style: S.meta }, '已导入 ' + avatarList.length + ' 张'),
            h('button', { key: 'rf', type: 'button', style: S.btnGhost, onClick: loadAvatars }, '⟳'),
          ],
        ),
        h('input', {
          key: 'fi',
          ref: fileRef,
          type: 'file',
          accept: 'image/*',
          multiple: true,
          style: { display: 'none' },
          onChange: handleAvatarUpload,
        }),
        avatarDir ? h('div', { key: 'av-d', style: S.meta }, avatarDir) : null,
        avatarMsg ? h('div', { key: 'av-m', style: Object.assign({}, S.meta) }, avatarMsg) : null,
        (Array.isArray(avatarList) ? avatarList.length : 0) > 0
          ? h(
              'div',
              { key: 'av-grid-l', style: Object.assign({}, S.meta, { marginTop: 6, marginBottom: 4 }) },
              '点一张设成自己的头像：',
            )
          : null,
        (Array.isArray(avatarList) ? avatarList.length : 0) > 0
          ? h(
              'div',
              { key: 'av-grid', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 } },
              (Array.isArray(avatarList) ? avatarList : []).slice(0, 24).map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    title: '设为我的头像：' + item.name,
                    style: {
                      width: 34,
                      height: 34,
                      padding: 0,
                      cursor: 'pointer',
                      border: '2px solid var(--dsw-alias-border-l1)',
                      borderRadius: 8,
                      overflow: 'hidden',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    },
                    onClick: () => setMyAvatar(item.id),
                  },
                  avatarMap[item.id]
                    ? h('img', {
                        src: avatarMap[item.id],
                        alt: item.name,
                        style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
                      })
                    : h('span', { style: { fontSize: 10 } }, '…'),
                ),
              ),
            )
          : null,
        h('div', {
          key: 'divider-eg',
          style: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '10px 0' },
        }),
        h(
          'div',
          { key: 'eg-t', style: Object.assign({}, S.meta, { marginBottom: 4 }) },
          '回复意愿（影响投递给 AI 的提示措辞）',
        ),
        h(
          'div',
          { key: 'eg-r', style: { display: 'flex', gap: 6, marginBottom: 4 } },
          [
            ['cautious', '克制'],
            ['balanced', '平衡'],
            ['active', '活跃'],
          ].map(([key, label]) => {
            const on = ((state && state.eagerness) || 'balanced') === key
            return h(
              'button',
              {
                key,
                type: 'button',
                style: Object.assign({}, S.btn, on
                  ? {
                      borderColor: 'var(--dsw-alias-brand-primary)',
                      color: 'var(--dsw-alias-brand-primary)',
                      fontWeight: 600,
                    }
                  : {}),
                onClick: () => run('set_eagerness', { text: key }),
              },
              label,
            )
          }),
        ),
        h(
          'div',
          { key: 'eg-h', style: Object.assign({}, S.meta, { marginBottom: 6 }) },
          '克制：AI 之间不主动接话；平衡：有话说就接；活跃：鼓励互动',
        ),
        h('div', {
          key: 'divider',
          style: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '10px 0' },
        }),
        h(
          'div',
          { key: 'rt2', style: Object.assign({}, S.meta, { marginBottom: 4 }) },
          'AI 路由（用哪个模型判断该叫谁）',
        ),
        h('div', { key: 'rr2', style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' } }, [
          h(
            'select',
            {
              key: 'm',
              style: S.select,
              value: routerMode,
              onChange: (e) => setRouterMode(e.target.value),
            },
            [
              h('option', { key: 'off', value: 'off' }, '全员推送（不判断）'),
              h('option', { key: 'auto', value: 'auto' }, '跟随发消息的会话（推荐）'),
              h('option', { key: 'ai', value: 'ai' }, '指定模型'),
            ],
          ),
          routerMode === 'ai'
            ? h(
                'button',
                {
                  key: 'load',
                  type: 'button',
                  style: S.btnGhost,
                  onClick: () => loadModels(routerProvider),
                },
                '刷新模型列表',
              )
            : null,
        ]),
        routerMode === 'auto'
          ? h(
              'div',
              { key: 'auto', style: Object.assign({}, S.meta, { marginBottom: 6, lineHeight: 1.7 }) },
              '用「发消息那个会话」自己的模型来判断该叫谁，不用另配。' +
                '若拿不到会话模型，会退回默认模型；都拿不到就按全员推送。',
            )
          : null,
        routerMode === 'ai'
          ? h('div', { key: 'ai', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              h(
                'select',
                {
                  key: 'p',
                  style: S.select,
                  value: routerProvider,
                  onChange: (e) => {
                    setRouterProvider(e.target.value)
                    setRouterModel('')
                    loadModels(e.target.value)
                  },
                },
                providers.length === 0
                  ? [h('option', { key: '0', value: '' }, '（无可用 provider）')]
                  : providers.map((p) => h('option', { key: p.id, value: p.id }, p.name || p.id)),
              ),
              h(
                'select',
                {
                  key: 'mo',
                  style: S.select,
                  value: routerModel,
                  onChange: (e) => setRouterModel(e.target.value),
                },
                models.length === 0
                  ? [h('option', { key: '0', value: '' }, '（无模型列表，下面手填）')]
                  : models.map((m) => h('option', { key: m.id, value: m.id }, m.name || m.id)),
              ),
              modelLoading
                ? h('div', { key: 'ml', style: Object.assign({}, S.meta) }, '正在拉取模型列表…')
                : null,
              modelError
                ? h(
                    'div',
                    {
                      key: 'merr',
                      style: Object.assign({}, S.meta, { color: 'var(--dsw-alias-state-warn-primary)' }),
                    },
                    modelError,
                  )
                : null,
              h('input', {
                key: 'mo2',
                style: S.input,
                placeholder: '或直接手填模型 id',
                value: routerModel,
                onChange: (e) => setRouterModel(e.target.value),
              }),
              h(
                'button',
                {
                  key: 'save2',
                  type: 'button',
                  style: S.btnPrimary,
                  onClick: () =>
                    run('set_router', {
                      mode: 'ai',
                      provider: routerProvider,
                      model: routerModel,
                    }).then((r) => {
                      if (r && r.result && r.result.ok === false) setFlash(r.result.text)
                    }),
                },
                '保存（指定模型）',
              ),
            ])
          : h(
              'button',
              {
                key: 'save3',
                type: 'button',
                style: routerMode === 'auto' ? S.btnPrimary : S.btn,
                onClick: () => run('set_router', { mode: routerMode === 'auto' ? 'auto' : 'off' }),
              },
              routerMode === 'auto' ? '保存（跟随会话模型）' : '保存（全员推送）',
            ),
      ])

      const topBar = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            flexWrap: 'wrap',
          },
        },
        [
          h('span', { key: 'l', style: S.meta }, '我是'),
          // 点自己的头像开「我的资料」（改头像/改昵称，一个弹层搞定）
          group && meMember
            ? h(
                'span',
                {
                  key: 'me-av',
                  title: '点这里改头像和昵称',
                  style: { display: 'flex', cursor: 'pointer' },
                  onClick: () => setProfileOpen(!profileOpen),
                },
                h(Avatar, { name: meName, url: avatarUrlFor(meMember), size: 22 }),
              )
            : null,
          h(
            'select',
            {
              key: 's',
              style: S.select,
              value: me,
              onChange: (e) => setMe(e.target.value),
              title: '面板拿不到你正在看哪个会话，需要在这里选一次；选择会被记住',
            },
            sessions.length === 0
              ? h('option', { key: '0', value: '' }, '（无活会话）')
              : sessions.map((s) => h('option', { key: s.id, value: s.id }, s.name)),
          ),
          h('span', { key: 'sp', style: { flex: 1 } }),
          // 版本对照：源码版本 ≠ 运行版本 时标红，提醒需要重启
          state && state.version && state.version.running
            ? h(
                'span',
                {
                  key: 'ver',
                  style: Object.assign(
                    {},
                    S.chip,
                    state.version.stale
                      ? {
                          borderColor: 'var(--dsw-alias-state-error-primary)',
                          color: 'var(--dsw-alias-state-error-primary)',
                          fontWeight: 600,
                        }
                      : { color: 'var(--dsw-alias-label-secondary)' },
                  ),
                  title: state.version.stale
                    ? '磁盘上是 v' +
                      state.version.disk +
                      '，但运行的是 v' +
                      state.version.running +
                      '——改了源码还没重启 DSH'
                    : '源码与运行版本一致',
                },
                state.version.stale
                  ? '⚠ 源码 ' + state.version.disk + ' / 运行 ' + state.version.running
                  : 'v' + state.version.running,
              )
            : null,
          // 路由状态：直接可点，点了就展开配置
          h(
            'button',
            {
              key: 'routerchip',
              type: 'button',
              title: '点这里改“用什么模型判断该叫谁”',
              style: Object.assign({}, S.chip, {
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: routerMode !== 'off' ? 'var(--dsw-alias-brand-primary)' : undefined,
                borderColor:
                  routerMode !== 'off' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
              }),
              onClick: () => {
                const next = !settingsOpen
                if (next && !activeGroup && groups.length) setActiveGroup(groups[0].id)
                setSettingsOpen(next)
                setRosterOpen(false)
                setInviteOpen(false)
                if (next) {
                  const rt = (state && state.router) || {}
                  setRouterMode(rt.mode || 'off')
                  setRouterProvider(rt.provider || '')
                  setRouterModel(rt.model || '')
                  loadModels(rt.provider || '')
                }
              },
            },
            routerMode === 'ai'
              ? '路由: ' + (routerModel || '未选模型')
              : routerMode === 'auto'
                ? '路由: 跟随会话'
                : '路由: 全员推送',
          ),
          rate.paused
            ? h(
                'span',
                {
                  key: 'pz',
                  style: Object.assign({}, S.chip, {
                    borderColor: 'var(--dsw-alias-state-error-primary)',
                    color: 'var(--dsw-alias-state-error-primary)',
                  }),
                },
                '投递已暂停',
              )
            : h('span', { key: 'rt', style: S.chip }, rate.perMinute + ' 条/分钟 · 已用 ' + quota.used),
        ],
      )

      return h('div', { style: Object.assign({}, S.root, { flexDirection: 'column' }) }, [
        topBar,
        settingsOpen
          ? h(
              'div',
              {
                key: 'settings',
                style: {
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  maxHeight: '46vh',
                  overflowY: 'auto',
                },
              },
              settingsPanel,
            )
          : null,
        h('div', { key: 'body', style: Object.assign({}, S.root, { flex: 1, minHeight: 0 }) }, [side, right]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, Panel))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 60, label: () => '会话群聊' },
            Icon,
          ),
        )
      },
    }
  },
})
