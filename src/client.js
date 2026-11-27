// dsh-voice-fish · 设置页（DSH 设置里的「大肥鱼的声音」）
// 给鱼鱼挑嗓子：音色、语速、音调、音量、什么时候说话。
window.__ModuleLoader__.load({
  id: 'dsh-voice-fish',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    const inject = ['slots']
    const B = '/dsh-voice-fish'

    const 卡 = { padding: 14, borderRadius: 10, background: 'rgba(127,127,127,.07)', marginBottom: 12 }
    const 小字 = { fontSize: 12, opacity: 0.68, lineHeight: 1.6 }
    const 标题 = { fontSize: 13, fontWeight: 600, marginBottom: 8 }
    const 按钮 = {
      padding: '4px 10px',
      borderRadius: 6,
      border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: 12,
    }
    const 选中按钮 = Object.assign({}, 按钮, {
      borderColor: 'rgba(120,160,255,.9)',
      background: 'rgba(120,160,255,.16)',
    })
    const 下拉 = {
      padding: '6px 9px',
      borderRadius: 6,
      border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
      width: '100%',
      maxWidth: 420,
    }
    const 行 = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }

    const get = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const 引擎们 = [
      { id: 'edge', 名字: '神经音色', 说明: '用下面挑的声音，从本机放出来' },
      { id: 'bridge', 名字: '朗读桥', 说明: 'DeepSeek 网页端那副声音' },
      { id: 'sapi', 名字: '系统语音', 说明: 'Windows 自带的慧慧，最土但最稳' },
      { id: 'auto', 名字: '自动', 说明: '朗读桥 → 神经音色 → 系统语音，挨个试' },
    ]

    const 场合们 = [
      { id: 'SUCCESS', 名字: '做完一件事' },
      { id: 'ERROR', 名字: '出错的时候' },
      { id: 'APPROVAL', 名字: '等你点确认' },
    ]

    function 音色页() {
      const [cfg, setCfg] = React.useState(null)
      const [catalog, setCatalog] = React.useState([])
      const [读着, set读着] = React.useState(true)
      const [存着, set存着] = React.useState(false)
      const [试着, set试着] = React.useState(false)
      const [提示, set提示] = React.useState('')
      const [句子, set句子] = React.useState('我是鱼鱼，这个声音好听吗')

      const 说一句 = (t) => {
        set提示(t)
        setTimeout(() => set提示(''), 2600)
      }

      React.useEffect(() => {
        ;(async () => {
          const r = await get('/config')
          if (r && r.ok) {
            setCfg(r.config)
            setCatalog(Array.isArray(r.catalog) ? r.catalog : [])
          } else {
            set提示('读不到配置，插件可能在重启')
          }
          set读着(false)
        })()
      }, [])

      const 改 = (patch) => setCfg((old) => Object.assign({}, old, patch))

      const 保存 = async () => {
        if (!cfg) return
        set存着(true)
        const patch = {
          enabled: cfg.enabled,
          ownerName: cfg.ownerName,
          engine: cfg.engine,
          edgeVoice: cfg.edgeVoice,
          edgeRate: cfg.edgeRate,
          edgePitch: cfg.edgePitch,
          volume: cfg.volume,
          states: cfg.states,
          greeting: cfg.greeting,
          thinking: cfg.thinking,
          readSummary: cfg.readSummary,
          summaryMaxChars: cfg.summaryMaxChars,
        }
        const r = await post('/config', { patch })
        set存着(false)
        if (r && r.ok) {
          setCfg(r.config)
          说一句('存好啦，下一句就用这个声音')
        } else {
          说一句('没存上，再点一次试试')
        }
      }

      const 试听 = async () => {
        if (!cfg) return
        set试着(true)
        await post('/preview', {
          text: 句子,
          voice: cfg.edgeVoice,
          rate: cfg.edgeRate,
          pitch: cfg.edgePitch,
          volume: cfg.volume,
        })
        set试着(false)
      }

      const 切场合 = (id, on) => {
        const set = new Set(Array.isArray(cfg.states) ? cfg.states : [])
        if (on) set.add(id)
        else set.delete(id)
        改({ states: [...set] })
      }

      if (读着) return React.createElement('div', { style: 小字 }, '正在读配置…')
      if (!cfg) return React.createElement('div', { style: 小字 }, '读不到配置。DSH 重启一次再来看？')

      const 当前音色 = catalog.find((v) => v.id === cfg.edgeVoice)

      const 头 = React.createElement(
        'div',
        { style: Object.assign({}, 卡, { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }) },
        React.createElement('div', { style: { fontSize: 22, lineHeight: 1 } }, '🐟'),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } },
            '鱼鱼现在的声音：' + (当前音色 ? 当前音色.name : cfg.edgeVoice || '没选'),
          ),
          React.createElement('div', { style: 小字 },
            (当前音色 && 当前音色.note ? 当前音色.note + ' · ' : '') +
            '语速 ' + (cfg.edgeRate > 0 ? '+' : '') + cfg.edgeRate + '%' +
            ' · 音调 ' + (cfg.edgePitch > 0 ? '+' : '') + cfg.edgePitch + 'Hz',
          ),
        ),
      )

      const 引擎块 = React.createElement(
        'div',
        { style: 卡 },
        React.createElement('div', { style: 标题 }, '声音从哪儿来'),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
          ...引擎们.map((e) =>
            React.createElement(
              'button',
              {
                key: e.id,
                type: 'button',
                style: cfg.engine === e.id ? 选中按钮 : 按钮,
                onClick: () => 改({ engine: e.id }),
              },
              e.名字,
            ),
          ),
        ),
        React.createElement('div', { style: 小字 },
          (引擎们.find((e) => e.id === cfg.engine) || {}).说明 || '',
        ),
      )

      const 称呼块 = React.createElement(
        'div',
        { style: 卡 },
        React.createElement('div', { style: 标题 }, '它怎么称呼你'),
        React.createElement('input', {
          type: 'text',
          value: cfg.ownerName || '',
          style: 下拉,
          onChange: (ev) => 改({ ownerName: ev.target.value }),
          placeholder: '菲',
        }),
        React.createElement('div', { style: Object.assign({}, 小字, { marginTop: 6 }) }, '播报时会念「某某，搞定啦」。'),
      )

      const 音色块 = React.createElement(
        'div',
        { style: 卡 },
        React.createElement('div', { style: 标题 }, '音色'),
        React.createElement(
          'select',
          {
            style: 下拉,
            value: cfg.edgeVoice || '',
            onChange: (ev) => 改({ edgeVoice: ev.target.value }),
          },
          ...catalog.map((v) =>
            React.createElement(
              'option',
              { key: v.id, value: v.id },
              v.name + (v.note ? ' —— ' + v.note : '') + (v.gender ? '（' + v.gender + '）' : ''),
            ),
          ),
        ),
        React.createElement(
          'div',
          { style: Object.assign({}, 小字, { marginTop: 6 }) },
          '这个是微软 Edge 的神经音色，本机直接合成，不经过浏览器，也基本不限额。',
        ),
      )

      const 滑杆 = (标签, 值, 最小, 最大, 单位, 改值) =>
        React.createElement(
          'div',
          { style: 行 },
          React.createElement('span', { style: Object.assign({}, 小字, { width: 34 }) }, 标签),
          React.createElement('input', {
            type: 'range',
            min: 最小,
            max: 最大,
            step: 1,
            value: 值,
            style: { flex: 1, maxWidth: 300 },
            onChange: (ev) => 改值(Number(ev.target.value)),
          }),
          React.createElement('span', { style: Object.assign({}, 小字, { width: 56 }) }, (值 > 0 ? '+' : '') + 值 + 单位),
        )

      const 调节块 = React.createElement(
        'div',
        { style: 卡 },
        React.createElement('div', { style: 标题 }, '语速和音调'),
        滑杆('语速', cfg.edgeRate, -50, 50, '%', (v) => 改({ edgeRate: v })),
        滑杆('音调', cfg.edgePitch, -50, 50, 'Hz', (v) => 改({ edgePitch: v })),
        滑杆('音量', cfg.volume, 0, 100, '', (v) => 改({ volume: v })),
        React.createElement('div', { style: 小字 }, '音调往上就是更嫩、更「小女生」，往下就是更稳更御。'),
      )

      const 试听块 = React.createElement(
        'div',
        { style: 卡 },
        React.createElement('div', { style: 标题 }, '听听看'),
        React.createElement('input', {
          type: 'text',
          value: 句子,
          style: 下拉,
          onChange: (ev) => set句子(ev.target.value),
          placeholder: '想让它念什么',
        }),
        React.createElement(
          'div',
          { style: Object.assign({}, 行, { marginTop: 8 }) },
          React.createElement('button', { type: 'button', style: 选中按钮, onClick: 试听, disabled: 试着 }, 试着 ? '正在念…' : '▶ 试听这一句'),
          React.createElement('span', { style: 小字 }, '用现在选的音色念，不用先保存'),
        ),
      )

      const 场合块 = React.createElement(
        'div',
        { style: 卡 },
        React.createElement('div', { style: 标题 }, '什么时候出声'),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 } },
          ...场合们.map((s) =>
            React.createElement(
              'label',
              { key: s.id, style: Object.assign({}, 小字, { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }) },
              React.createElement('input', {
                type: 'checkbox',
                checked: Array.isArray(cfg.states) && cfg.states.includes(s.id),
                onChange: (ev) => 切场合(s.id, ev.target.checked),
              }),
              s.名字,
            ),
          ),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 18, flexWrap: 'wrap' } },
          React.createElement(
            'label',
            { style: Object.assign({}, 小字, { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }) },
            React.createElement('input', {
              type: 'checkbox',
              checked: cfg.thinking !== false,
              onChange: (ev) => 改({ thinking: ev.target.checked }),
            }),
            '每轮开始思考时先说一句「让我思考一下~」',
          ),
          React.createElement(
            'label',
            { style: Object.assign({}, 小字, { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }) },
            React.createElement('input', {
              type: 'checkbox',
              checked: cfg.readSummary !== false,
              onChange: (ev) => 改({ readSummary: ev.target.checked }),
            }),
            '每轮完成时把结果概括念一遍',
          ),
          React.createElement(
            'label',
            { style: Object.assign({}, 小字, { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }) },
            React.createElement('input', {
              type: 'checkbox',
              checked: cfg.greeting === true,
              onChange: (ev) => 改({ greeting: ev.target.checked }),
            }),
            'DSH 启动时打个招呼',
          ),
        ),
        React.createElement(
          'div',
          { style: Object.assign({}, 行, { marginTop: 10, marginBottom: 0 }) },
          React.createElement('span', { style: Object.assign({}, 小字, { width: 74 }) }, '概括最多'),
          React.createElement('input', {
            type: 'range',
            min: 30,
            max: 200,
            step: 10,
            value: cfg.summaryMaxChars || 80,
            style: { flex: 1, maxWidth: 240 },
            onChange: (ev) => 改({ summaryMaxChars: Number(ev.target.value) }),
          }),
          React.createElement('span', { style: Object.assign({}, 小字, { width: 56 }) }, (cfg.summaryMaxChars || 80) + ' 字'),
        ),
        React.createElement('div', { style: 小字 }, '念的是这一轮最后说的几句人话：代码、表格、文件路径会跳过去。'),
      )

      const 底 = React.createElement(
        'div',
        { style: Object.assign({}, 行, { marginTop: 4 }) },
        React.createElement('button', { type: 'button', style: 选中按钮, onClick: 保存, disabled: 存着 }, 存着 ? '保存中…' : '保存'),
        React.createElement('span', { style: { fontSize: 12, color: 'rgba(120,180,120,.95)' } }, 提示),
      )

      return React.createElement('div', null, 头, 称呼块, 引擎块, 音色块, 调节块, 试听块, 场合块, 底)
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (!slots || typeof slots.inject !== 'function') return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'dsh-voice-fish', order: 61, label: '大肥鱼的声音' }, 音色页),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
