// Browser half of dsh-plugin-test-controller.
//
// DSH loads a client bundle by evaluating this file, which only registers a
// factory on window.__ModuleLoader__; the body runs on first materialization.
// `require` resolves modules already registered by the shell, so keep the
// dependency list to what the shell always provides.
//
// The whole interface is one sidebar panel: overview counters, plans, runs with
// expandable details, install images and the memory-only test credential.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-test-controller',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const API = '/plugin-test';
    const POLL_MS = 3000;
    const PANEL_ID = 'plugin-test';

    const color = {
      label: 'var(--dsw-alias-label-primary, #1f2328)',
      secondary: 'var(--dsw-alias-label-secondary, #57606a)',
      tertiary: 'var(--dsw-alias-label-tertiary, #6e7781)',
      border: 'var(--dsw-alias-border-l1, #d0d7de)',
      surface: 'var(--dsw-specific-menu, #ffffff)',
      fill: 'var(--dsw-alias-fill-l1, rgba(31,35,40,0.06))',
      danger: 'var(--dsw-alias-state-error-primary, #cf222e)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)'
    };

    const font = {
      base: '13px/1.7 var(--dsw-font-sans, system-ui)',
      small: '12px/1.7 var(--dsw-font-sans, system-ui)',
      mono: '11px/1.6 var(--dsw-font-mono, ui-monospace, monospace)'
    };

    const LIVE = ['queued', 'preparing', 'running', 'collecting', 'cleaning', 'open'];

    async function request(path, init) {
      const response = await fetch(`${API}${path}`, init);
      const text = await response.text();
      let value;
      try {
        value = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Unexpected response from ${path}`);
      }
      if (!response.ok) throw new Error(value.error ?? `${response.status} ${response.statusText}`);
      return value;
    }

    const stateOf = (run) => run.state ?? 'unknown';
    const isLive = (run) => LIVE.includes(stateOf(run));
    const short = (id) => (typeof id === 'string' && id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id);
    const clock = (iso) => {
      if (!iso) return '';
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour12: false });
    };
    const bytes = (size) => {
      if (size === null || size === undefined) return '';
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / 1024 / 1024).toFixed(1)} MB`;
    };
    const span = (from, to) => {
      if (!from) return '';
      const start = new Date(from).getTime();
      const end = to ? new Date(to).getTime() : Date.now();
      if (Number.isNaN(start) || Number.isNaN(end)) return '';
      const ms = Math.max(0, end - start);
      return ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60000).toFixed(1)} min`;
    };

    function buttonStyle(kind) {
      const base = {
        border: `1px solid ${color.border}`,
        background: color.surface,
        color: color.label,
        borderRadius: '6px',
        padding: '2px 10px',
        fontSize: '12px',
        lineHeight: '20px',
        cursor: 'pointer',
        flex: 'none'
      };
      return kind === 'primary'
        ? { ...base, background: color.label, color: color.surface, borderColor: color.label }
        : base;
    }

    function Field({ title, hint, extra, children }) {
      return h('div', { style: { padding: '14px 0', borderTop: `1px solid ${color.border}` } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
          h('div', { style: { color: color.label, fontSize: '13px', fontWeight: 600 } }, title),
          extra ?? null),
        hint ? h('div', { style: { color: color.tertiary, fontSize: '12px', marginTop: '2px' } }, hint) : null,
        h('div', { style: { marginTop: '8px' } }, children)
      );
    }

    function Badge({ tone, children }) {
      const palette = {
        live: { fg: color.secondary, bg: color.fill },
        ok: { fg: color.ok, bg: 'transparent' },
        bad: { fg: color.danger, bg: 'transparent' },
        idle: { fg: color.tertiary, bg: 'transparent' }
      }[tone] ?? { fg: color.tertiary, bg: 'transparent' };
      return h('span', {
        style: { color: palette.fg, background: palette.bg, borderRadius: '4px', padding: '0 5px', fontSize: '10px', lineHeight: '16px', whiteSpace: 'nowrap' }
      }, children);
    }

    function Row({ label, children }) {
      return h('div', { style: { display: 'flex', gap: '10px', padding: '2px 0', alignItems: 'flex-start' } },
        h('span', { style: { color: color.tertiary, fontSize: '11px', width: '84px', flex: 'none', paddingTop: '1px' } }, label),
        h('span', { style: { font: font.mono, color: color.label, minWidth: 0, wordBreak: 'break-all', flex: 1 } }, children)
      );
    }

    function Pre({ text, tone }) {
      if (!text) return null;
      return h('pre', {
        style: {
          margin: '4px 0 0', padding: '8px 10px', maxHeight: '220px', overflow: 'auto',
          background: color.fill, borderRadius: '6px', font: font.mono,
          color: tone === 'bad' ? color.danger : color.secondary, whiteSpace: 'pre-wrap', wordBreak: 'break-all'
        }
      }, text);
    }

    function toneOf(run) {
      const state = stateOf(run);
      if (state === 'completed') return 'ok';
      if (['failed', 'timed_out', 'output_limit', 'interrupted'].includes(state)) return 'bad';
      return isLive(run) ? 'live' : 'idle';
    }

    /** The DSH invocation a worker derives from this plan (paths live in the sandbox). */
    function commandOf(plan) {
      const patch = '<run>/sandbox/test.patch.yml';
      if (plan.mode === 'open') return `dsh web --patch ${patch} --port 0 --no-open`;
      const profile = plan.mode === 'inspect' ? 'plugin-inspect' : 'headless';
      const base = `dsh --profile ${profile} --patch ${patch}`;
      if (plan.mode === 'headless') return `${base} --json ${JSON.stringify((plan.prompt ?? '').slice(0, 80))}`;
      return `${base} --dump-config-schema`;
    }

    function PlanSummary({ detail }) {
      const plan = detail.plan ?? {};
      const plugins = Array.isArray(plan.plugins) ? plan.plugins : [];
      const install = Array.isArray(plan.install) ? plan.install : [];
      const expect = Array.isArray(plan.expect) ? plan.expect : [];
      return h('div', {
        style: { margin: '4px 0 8px 0', padding: '10px 12px', border: `1px solid ${color.border}`, borderRadius: '8px', background: color.fill }
      },
      h(Row, { label: '文件' }, detail.path),
      h(Row, { label: '模式' }, `${plan.mode ?? 'inspect'} · 安装 ${plan.installMode ?? 'cached'}`),
      h(Row, { label: '命令' }, commandOf(plan)),
      plan.prompt ? h(Row, { label: 'prompt' }, plan.prompt) : null,
      h(Row, { label: '插件' }, plugins.length === 0 ? '（无，依赖 install 挂载）' : plugins.map((item) => item.module).join('\n')),
      plugins.some((item) => item.config && Object.keys(item.config).length > 0)
        ? h(Row, { label: 'config' }, JSON.stringify(plugins.map((item) => item.config)))
        : null,
      h(Row, { label: '安装' }, install.length === 0 ? '（无）' : install.map((item) => item.source).join('\n')),
      h(Row, { label: '凭据' }, (plan.credentialEnv ?? []).length === 0 ? '（无）' : (plan.credentialEnv ?? []).join(', ')),
      h(Row, { label: '证据' }, (plan.evidence ?? []).length === 0 ? '（无）' : (plan.evidence ?? []).join(', ')),
      h(Row, { label: '超时' }, `run ${plan.timeoutSeconds ?? 120}s · install ${plan.installTimeoutSeconds ?? 300}s · open ${plan.openTimeoutSeconds ?? 7200}s`),
      expect.length > 0
        ? h(Row, { label: '断言' }, expect.map((item) => `${item.file}${item.path ? `.${item.path}` : ''} ${item.equals !== undefined ? `= ${JSON.stringify(item.equals)}` : item.contains !== undefined ? `⊃ ${JSON.stringify(item.contains)}` : `~ /${item.matches}/`}`).join('\n'))
        : null
      );
    }

    function RunDetail({ detail, busy, onExport }) {
      const status = detail.status ?? {};
      const check = status.check ?? {};
      const install = (detail.environment ?? {}).install ?? null;
      const assertions = Array.isArray(check.assertions) ? check.assertions : [];
      const files = Array.isArray(detail.files) ? detail.files : [];
      return h('div', {
        style: { margin: '4px 0 10px 0', padding: '10px 12px', border: `1px solid ${color.border}`, borderRadius: '8px', background: color.fill }
      },
      h(Row, { label: '状态' }, `${stateOf(status)} · cleanup ${status.cleanup ?? '—'} · verdict ${status.verdict ?? '—'}${status.exitCode === undefined ? '' : ` · exit ${status.exitCode}`}`),
      h(Row, { label: '时间' }, `${clock(status.createdAt)} → ${clock(status.endedAt)}（${span(status.startedAt ?? status.createdAt, status.endedAt)}）`),
      status.error ? h(Row, { label: '错误' }, h('span', { style: { color: color.danger } }, status.error)) : null,
      status.cleanupError ? h(Row, { label: '清理错误' }, h('span', { style: { color: color.danger } }, status.cleanupError)) : null,
      check.kind ? h(Row, { label: '检查' }, `${check.kind} · ${check.passed ? 'passed' : 'not passed'}${Array.isArray(check.entries) && check.entries.length ? ` · ${check.entries.map((e) => `${e.id}:${e.status}`).join(', ')}` : ''}`) : null,
      assertions.length > 0
        ? h(Row, { label: '断言' }, assertions.map((item, index) => `${item.ok ? '✓' : '✗'} #${index} ${item.file}${item.path ? `.${item.path}` : ''}${item.ok ? '' : `（期望 ${JSON.stringify(item.expected ?? '')}${item.actual === undefined ? '' : `，实际 ${JSON.stringify(item.actual)}`}${item.error ? `，${item.error}` : ''}）`}`).join('\n'))
        : null,
      install
        ? h(Row, { label: '安装' }, `${install.cached ? '来自镜像' : '本次安装'} · ${install.durationMs ?? '?'} ms${install.imageKey ? ` · image ${install.imageKey}` : ''}${install.imageError ? ` · 镜像失败：${install.imageError}` : ''}\n${(install.packages ?? []).map((p) => `${p.name}@${p.version ?? '?'}（${p.spec}）`).join('\n') || '（无包）'}`)
        : null,
      (detail.environment ?? {}).dshVersion
        ? h(Row, { label: '环境' }, `DSH ${detail.environment.dshVersion} · Node ${detail.environment.nodeVersion} · ${detail.environment.platform}/${detail.environment.arch}`)
        : null,
      files.length > 0
        ? h(Row, { label: '证据' }, files.map((file) => `${file.name}${file.bytes === null ? '' : `（${bytes(file.bytes)}）`}`).join('\n'))
        : h(Row, { label: '证据' }, '（还没有文件）'),
      detail.installTail ? h(Row, { label: 'install.log' }, h(Pre, { text: detail.installTail })) : null,
      detail.stderrTail ? h(Row, { label: 'stderr' }, h(Pre, { text: detail.stderrTail, tone: 'bad' })) : null,
      detail.stdoutTail ? h(Row, { label: 'stdout' }, h(Pre, { text: detail.stdoutTail })) : null,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
        h('button', { type: 'button', disabled: busy, onClick: () => onExport(status.id), style: buttonStyle('ghost') }, '获取证据目录'))
      );
    }

    function TestIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true
      },
      h('path', { d: 'M6 2h4' }),
      h('path', { d: 'M6.6 2v4.3L3.5 12.2A1 1 0 0 0 4.3 13.7h7.4a1 1 0 0 0 .8-1.5L9.4 6.3V2' }),
      h('path', { d: 'M5.2 10.4h5.6' })
      );
    }

    function TestConsole() {
      const [data, setData] = useState({ plans: [], planDetails: [], runs: [], root: '', rootSource: 'default', credentials: [], images: [] });
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      const [secretName, setSecretName] = useState('DEEPSEEK_API_KEY');
      const [secretValue, setSecretValue] = useState('');
      const [expandedPlan, setExpandedPlan] = useState(null);
      const [planDetail, setPlanDetail] = useState(null);
      const [planError, setPlanError] = useState(null);
      const [expandedRun, setExpandedRun] = useState(null);
      const [runDetail, setRunDetail] = useState(null);
      const [runError, setRunError] = useState(null);
      const [filter, setFilter] = useState('');
      const [rootDraft, setRootDraft] = useState(null);
      const [creating, setCreating] = useState(false);
      const [draft, setDraft] = useState('');
      const [createError, setCreateError] = useState(null);

      const load = useCallback(async () => {
        try {
          const [state, images] = await Promise.all([request('/state'), request('/images').catch(() => [])]);
          setData({
            plans: Array.isArray(state.plans) ? state.plans : [],
            planDetails: Array.isArray(state.planDetails)
              ? state.planDetails
              : (Array.isArray(state.plans) ? state.plans : []).map((name) => ({ name, mode: 'inspect' })),
            runs: Array.isArray(state.runs) ? state.runs : [],
            root: state.root ?? '',
            rootSource: state.rootSource ?? 'default',
            credentials: Array.isArray(state.credentials) ? state.credentials : [],
            images: Array.isArray(images) ? images : []
          });
          setRootDraft((current) => current ?? state.root ?? '');
          setError(null);
        } catch (cause) {
          setError(cause.message);
        }
      }, []);

      useEffect(() => {
        load();
        const timer = setInterval(load, POLL_MS);
        return () => clearInterval(timer);
      }, [load]);

      const post = useCallback(async (path, body, method = 'POST') => {
        setBusy(true);
        setNotice(null);
        try {
          const value = await request(path, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
          await load();
          return value;
        } catch (cause) {
          setError(cause.message);
          return null;
        } finally {
          setBusy(false);
        }
      }, [load]);

      const start = useCallback(async (plan) => {
        const value = await post('/start', { plan });
        if (value) setNotice(`已启动 ${plan}：${value.id}`);
      }, [post]);

      const openRun = useCallback(async (plan) => {
        const value = await post('/open', { plan });
        if (value) setNotice(`正在打开 ${plan}：${value.id}（地址出现后点「打开」）`);
      }, [post]);

      const saveRoot = useCallback(async () => {
        const value = await post('/config', { root: String(rootDraft ?? '').trim() });
        if (value) {
          setRootDraft(value.root);
          setNotice(`状态根已切换到 ${value.root}`);
        }
      }, [post, rootDraft]);

      const resetRoot = useCallback(async () => {
        const value = await post('/config', {}, 'DELETE');
        if (value) {
          setRootDraft(value.root);
          setNotice(`已恢复默认状态根 ${value.root}（${value.source}）`);
        }
      }, [post]);

      const createPlan = useCallback(async () => {
        setCreateError(null);
        let parsed;
        try {
          parsed = JSON.parse(draft);
        } catch (cause) {
          setCreateError(`JSON 解析失败：${cause.message}`);
          return;
        }
        const value = await post('/plan', { plan: parsed });
        if (value) {
          setNotice(`已保存计划 ${value.name}（${value.mode}）`);
          setCreating(false);
          setDraft('');
        }
      }, [draft, post]);

      const deletePlan = useCallback(async (name) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(`删除计划 ${name}？`)) return;
        const value = await post(`/plan?name=${encodeURIComponent(name)}`, {}, 'DELETE');
        if (value) {
          if (expandedPlan === name) { setExpandedPlan(null); setPlanDetail(null); }
          setNotice(`已删除计划 ${name}`);
        }
      }, [post, expandedPlan]);

      const deleteRun = useCallback(async (id) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(`删除运行 ${id} 及其证据？`)) return;
        const value = await post(`/run?id=${encodeURIComponent(id)}`, {}, 'DELETE');
        if (value) {
          if (expandedRun === id) { setExpandedRun(null); setRunDetail(null); }
          setNotice(`已删除运行 ${id}`);
        }
      }, [post, expandedRun]);

      const togglePlan = useCallback(async (name) => {
        if (expandedPlan === name) { setExpandedPlan(null); setPlanDetail(null); return; }
        setExpandedPlan(name); setPlanDetail(null); setPlanError(null);
        try { setPlanDetail(await request(`/plan?name=${encodeURIComponent(name)}`)); }
        catch (cause) { setPlanError(cause.message); }
      }, [expandedPlan]);

      const toggleRun = useCallback(async (id) => {
        if (expandedRun === id) { setExpandedRun(null); setRunDetail(null); return; }
        setExpandedRun(id); setRunDetail(null); setRunError(null);
        try { setRunDetail(await request(`/run?id=${encodeURIComponent(id)}`)); }
        catch (cause) { setRunError(cause.message); }
      }, [expandedRun]);

      const saveSecret = useCallback(async () => {        const value = await post('/credentials', { name: secretName.trim(), value: secretValue });
        if (value) {
          setSecretValue('');
          setNotice(`已保存 ${secretName.trim()}（仅保存在宿主内存，重启失效）`);
        }
      }, [post, secretName, secretValue]);

      const clearSecret = useCallback(async (name) => {
        const value = await post('/credentials', name ? { name } : {}, 'DELETE');
        if (value) setNotice(name ? `已清除 ${name}` : '已清除全部凭据');
      }, [post]);

      const showEvidence = useCallback(async (id) => {
        setBusy(true);
        try {
          const value = await request(`/export?id=${encodeURIComponent(id)}`);
          setNotice(value.directory ?? '证据目录不可用');
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      }, []);

      const plans = data.planDetails;
      const live = data.runs.filter(isLive).length;
      const images = data.images;
      const visibleRuns = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        if (!needle) return data.runs;
        return data.runs.filter((run) => `${run.id} ${run.plan ?? ''} ${stateOf(run)}`.toLowerCase().includes(needle));
      }, [data.runs, filter]);

      // The main slot gives a fixed-height stage; this page owns its scrolling so
      // long run lists and expanded details stay reachable.
      return h('div', {
        style: {
          font: font.base,
          color: color.label,
          padding: '24px 32px 40px',
          maxWidth: '980px',
          height: '100%',
          boxSizing: 'border-box',
          overflowY: 'auto',
          overflowX: 'hidden'
        }
      },
        h('h2', { style: { fontSize: '18px', fontWeight: 600, margin: '0 0 4px' } }, '插件测试'),
        h('p', { style: { color: color.secondary, fontSize: '12px', margin: '0 0 10px' } },
          '一次性 DSH 环境：装插件、跑计划、收证据。计划可以在这里新建，也可以在终端用 dsh-test plan 注册。'),

        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11px', color: color.secondary, alignItems: 'center' } },
          h(Badge, { tone: 'idle' }, `计划 ${plans.length}`),
          h(Badge, { tone: 'idle' }, `运行 ${data.runs.length}`),
          h(Badge, { tone: live ? 'live' : 'idle' }, `进行中 ${live}`),
          h(Badge, { tone: 'idle' }, `镜像 ${images.length}`),
          h('span', { style: { font: font.mono, color: color.tertiary, overflow: 'hidden', textOverflow: 'ellipsis' } }, data.root || '—')
        ),

        error ? h('div', { style: { color: color.danger, fontSize: '12px', marginTop: '8px' } }, error) : null,
        notice ? h('div', { style: { color: color.secondary, fontSize: '12px', marginTop: '8px', wordBreak: 'break-all' } }, notice) : null,

        h(Field, {
          title: '配置',
          hint: '状态根决定计划、运行和镜像的位置；工具与 CLI 共用这一项，保存后立即生效（已启动的运行仍留在旧目录）。'
        },
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          h('input', {
            value: rootDraft ?? '',
            onChange: (event) => setRootDraft(event.target.value),
            spellCheck: false,
            style: { font: font.mono, padding: '4px 8px', border: `1px solid ${color.border}`, borderRadius: '6px', background: color.surface, color: color.label, width: '460px', maxWidth: '100%' }
          }),
          h('button', { type: 'button', disabled: busy || !String(rootDraft ?? '').trim(), onClick: saveRoot, style: buttonStyle('primary') }, '保存'),
          h('button', { type: 'button', disabled: busy, onClick: resetRoot, style: buttonStyle('ghost') }, '恢复默认')
        ),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center', fontSize: '11px', color: color.tertiary } },
          h(Badge, { tone: data.rootSource === 'ui' ? 'ok' : 'idle' }, { ui: '面板设置', config: '插件配置', env: 'DSH_TEST_ROOT', default: '默认' }[data.rootSource] ?? data.rootSource),
          h('span', { style: { font: font.mono, wordBreak: 'break-all' } }, data.root || '—')
        )),

        h(Field, {
          title: '计划',
          hint: '点计划名查看它装什么、跑什么；inspect/headless 点「启动」，open 点「打开」。新建时相对模块路径按状态根解析。',
          extra: h('button', { type: 'button', disabled: busy, onClick: () => { setCreating((value) => !value); setCreateError(null); }, style: { ...buttonStyle('ghost'), marginLeft: 'auto' } }, creating ? '收起' : '新建计划')
        },
          creating
            ? h('div', { style: { marginBottom: '8px' } },
              h('textarea', {
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                spellCheck: false,
                rows: 10,
                placeholder: '{\n  "name": "my-plan",\n  "mode": "inspect",\n  "plugins": [{ "module": "D:/path/to/plugin.mjs" }]\n}',
                style: { width: '100%', boxSizing: 'border-box', font: font.mono, padding: '8px', border: `1px solid ${color.border}`, borderRadius: '6px', background: color.surface, color: color.label, resize: 'vertical' }
              }),
              createError ? h('div', { style: { color: color.danger, fontSize: '11px', marginTop: '4px' } }, createError) : null,
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
                h('button', { type: 'button', disabled: busy, onClick: createPlan, style: buttonStyle('primary') }, '保存计划'),
                h('button', { type: 'button', disabled: busy, onClick: () => { setCreating(false); setCreateError(null); }, style: buttonStyle('ghost') }, '取消')
              ))
            : null,
          plans.length === 0
            ? h('div', { style: { color: color.tertiary, fontSize: '12px' } }, '还没有计划。点「新建计划」粘贴 JSON，或用 node bin/dsh-test.mjs plan <file> 注册。')
            : plans.map((plan) => h('div', { key: plan.name, style: { padding: '3px 0' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('button', {
                  type: 'button',
                  onClick: () => togglePlan(plan.name),
                  title: '查看计划详情',
                  style: { font: font.mono, flex: 1, textAlign: 'left', background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: color.label }
                }, `${expandedPlan === plan.name ? '▾' : '▸'} ${plan.name}`),
                h(Badge, { tone: plan.mode === 'open' ? 'ok' : 'idle' }, plan.mode),
                plan.mode === 'open'
                  ? h('button', { type: 'button', disabled: busy, onClick: () => openRun(plan.name), style: buttonStyle('primary') }, '打开')
                  : h('button', { type: 'button', disabled: busy, onClick: () => start(plan.name), style: buttonStyle('primary') }, '启动'),
                h('button', { type: 'button', disabled: busy, onClick: () => deletePlan(plan.name), style: buttonStyle('ghost') }, '删除')
              ),
              expandedPlan === plan.name
                ? (planError
                  ? h('div', { style: { color: color.danger, fontSize: '11px', margin: '4px 0' } }, planError)
                  : planDetail && planDetail.name === plan.name
                    ? h(PlanSummary, { detail: planDetail })
                    : h('div', { style: { color: color.tertiary, fontSize: '11px', margin: '4px 0' } }, '读取中…'))
                : null
            ))),

        h(Field, {
          title: `运行${live ? ` · ${live} 个进行中` : ''}`,
          hint: 'open 模式的运行会一直开着，直到点「销毁」或超过 openTimeoutSeconds；点运行号看详情。',
          extra: h('input', {
            value: filter,
            placeholder: '筛选 id / 计划 / 状态',
            onChange: (event) => setFilter(event.target.value),
            style: { marginLeft: 'auto', font: font.small, padding: '2px 8px', border: `1px solid ${color.border}`, borderRadius: '6px', background: color.surface, color: color.label, width: '200px' }
          })
        },
        visibleRuns.length === 0
          ? h('div', { style: { color: color.tertiary, fontSize: '12px' } }, data.runs.length === 0 ? '还没有运行记录。' : '没有匹配的运行。')
          : visibleRuns.map((run) => h('div', { key: run.id, style: { padding: '3px 0' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', font: font.mono } },
              h('button', {
                type: 'button',
                onClick: () => toggleRun(run.id),
                title: '查看运行详情',
                style: { background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: color.label, font: font.mono, flex: 'none' }
              }, `${expandedRun === run.id ? '▾' : '▸'} ${short(run.id)}`),
              h('span', { style: { color: color.secondary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, run.plan ?? ''),
              h(Badge, { tone: toneOf(run) }, stateOf(run)),
              run.cleanup && run.cleanup !== 'succeeded' ? h(Badge, { tone: 'bad' }, `cleanup ${run.cleanup}`) : null,
              run.check && Array.isArray(run.check.assertions) && run.check.assertions.length > 0
                ? h(Badge, { tone: run.check.assertions.every((item) => item.ok) ? 'ok' : 'bad' },
                  `expect ${run.check.assertions.filter((item) => item.ok).length}/${run.check.assertions.length}`)
                : null,
              h('span', { style: { color: color.tertiary, flex: 'none' } }, clock(run.createdAt)),
              ...(stateOf(run) === 'open'
                ? [
                  run.url
                    ? h('a', { key: 'open', href: run.url, target: '_blank', rel: 'noreferrer', style: { color: color.label, fontSize: '11px', textDecoration: 'underline', flex: 'none' } }, '打开')
                    : h('span', { key: 'pending', style: { color: color.tertiary, fontSize: '11px' } }, '启动中…'),
                  h('button', { key: 'destroy', type: 'button', disabled: busy, onClick: () => post('/destroy', { id: run.id }), style: buttonStyle('ghost') }, '销毁')
                ]
                : [isLive(run)
                  ? h('button', { key: 'cancel', type: 'button', disabled: busy, onClick: () => post('/cancel', { id: run.id }), style: buttonStyle('ghost') }, '取消')
                  : h('button', { key: 'export', type: 'button', disabled: busy, onClick: () => showEvidence(run.id), style: buttonStyle('ghost') }, '证据'),
                  !isLive(run) ? h('button', { key: 'remove', type: 'button', disabled: busy, onClick: () => deleteRun(run.id), style: buttonStyle('ghost') }, '删除') : null])
            ),
            expandedRun === run.id
              ? (runError
                ? h('div', { style: { color: color.danger, fontSize: '11px', margin: '4px 0' } }, runError)
                : runDetail && runDetail.id === run.id
                  ? h(RunDetail, { detail: runDetail, busy, onExport: showEvidence })
                  : h('div', { style: { color: color.tertiary, fontSize: '11px', margin: '4px 0' } }, '读取中…'))
              : null
          ))),

        h(Field, { title: '安装镜像', hint: '同一个安装输入第二次运行直接克隆镜像，不再执行 pnpm。镜像不会自动清理。' },
          images.length === 0
            ? h('div', { style: { color: color.tertiary, fontSize: '12px' } }, '还没有镜像。带 install 的计划跑过一次后会自动生成。')
            : images.map((image) => h('div', { key: image.key, style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '2px 0', font: font.mono, flexWrap: 'wrap' } },
              h('span', { style: { color: color.label } }, image.unreadable ? `${image.key}（不可读）` : image.key),
              h('span', { style: { color: color.tertiary } }, `DSH ${image.dshVersion ?? '?'}`),
              h('span', { style: { color: color.tertiary } }, `${(image.packages ?? []).length} 个包`),
              h('span', { style: { color: color.tertiary } }, clock(image.createdAt))
            ))),

        h(Field, {
          title: '测试用凭据',
          hint: '只保存在宿主内存，不写计划、不写磁盘，重启即失效；仅用于从这里启动的运行。'
        },
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          h('input', {
            value: secretName,
            onChange: (event) => setSecretName(event.target.value),
            spellCheck: false,
            style: { font: font.mono, padding: '4px 8px', border: `1px solid ${color.border}`, borderRadius: '6px', background: color.surface, color: color.label, width: '210px' }
          }),
          h('input', {
            value: secretValue,
            type: 'password',
            placeholder: '值',
            onChange: (event) => setSecretValue(event.target.value),
            style: { font: font.mono, padding: '4px 8px', border: `1px solid ${color.border}`, borderRadius: '6px', background: color.surface, color: color.label, width: '240px' }
          }),
          h('button', { type: 'button', disabled: busy || !secretValue, onClick: saveSecret, style: buttonStyle('primary') }, '保存'),
          data.credentials.length
            ? h('button', { type: 'button', disabled: busy, onClick: () => clearSecret(), style: buttonStyle('ghost') }, '全部清除')
            : null
        ),
        data.credentials.length
          ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } },
            data.credentials.map((name) => h('span', {
              key: name,
              style: { display: 'inline-flex', alignItems: 'center', gap: '6px', font: font.mono, border: `1px solid ${color.border}`, borderRadius: '999px', padding: '1px 8px' }
            },
            name,
            h('button', {
              type: 'button',
              onClick: () => clearSecret(name),
              disabled: busy,
              title: `清除 ${name}`,
              style: { border: 0, background: 'transparent', color: color.tertiary, cursor: 'pointer', padding: 0, fontSize: '12px' }
            }, '×')
            )))
          : h('div', { style: { color: color.tertiary, fontSize: '12px', marginTop: '6px' } }, '未配置；headless 计划需要在计划里声明 credentialEnv，或在这里填入。'))
      );
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({})
      }, TestConsole));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 10,
        label: () => '插件测试'
      }, TestIcon));
    }

    return { name: 'plugin-test-controller', inject: ['slots'], apply };
  }
});
