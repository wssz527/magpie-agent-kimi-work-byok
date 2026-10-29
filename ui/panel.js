(() => {
  const $ = id => document.getElementById(id);
  const states = { 'file-applied': '原生配置已写入，等待新请求确认', 'waiting-config': '等待 Work 导入模型并生成配置',
    inherit: '继承主模型', restored: '已撤销本插件的原生配置', conflict: '配置冲突，未覆盖现有内容',
    blocked: '模型策略不可用', unverified: '当前 Work 的原生配置接口尚未通过检查', unsupported: '旧副本启动接口不可用',
    'waiting-launch': '旧副本尚未启动', 'waiting-idle': '等待 Work 空闲', 'waiting-kimi': '等待 Kimi 启动',
    'expired-request': '切换请求已过期，请重新保存', 'invalid-request': '切换请求格式无效，请重新保存',
    interrupted: '上次切换已中断，请重新保存', requested: '已请求切换主模型', failed: '操作失败' };
  let options = {}, data, ready = false, dirty = false, signature = '', saving = false;
  const tell = (message, error = false) => { $('message').textContent = message; $('message').dataset.error = String(error); };
  const eligible = () => (data?.models || []).filter(row => row.tools);
  function selection() {
    return { mode: $('mode').value, transport: 'native-config',
      ...($('mode').value === 'inherit' ? {} : { model: $('child-model').value }),
      ...($('mode').value === 'force' && $('effort').value ? { effort: $('effort').value } : {}),
      ...($('mode').value === 'pool' ? { models: [...$('pool').children].filter(row => row.querySelector('input[type=checkbox]').checked)
        .map(row => ({ id: row.dataset.id, description: row.querySelector('input[type=text]').value.trim() })) } : {}) };
  }
  function modes() {
    const mode = $('mode').value;
    $('target-fields').hidden = mode === 'inherit';
    $('effort-fields').hidden = mode !== 'force';
    $('pool-fields').hidden = mode !== 'pool';
    $('child-label').textContent = mode === 'pool' ? '默认子代理模型' : '子代理模型';
    const previous = $('effort').value;
    $('effort').replaceChildren(new Option('使用该模型的默认档位', ''));
    const target = eligible().find(row => row.id === $('child-model').value);
    for (const effort of target?.reasoningEfforts || []) $('effort').add(new Option(effort, effort));
    if ([...$('effort').options].some(row => row.value === previous)) $('effort').value = previous;
  }
  function renderPolicy(policy = { mode: 'inherit' }, main = '') {
    $('mode').value = policy.mode || 'inherit';
    $('main-model').replaceChildren(new Option('保留 Work 当前选择', ''));
    $('child-model').replaceChildren();
    for (const model of data?.models || []) $('main-model').add(new Option(model.name, model.id));
    for (const model of eligible()) $('child-model').add(new Option(model.name, model.id));
    if (policy.model && !eligible().some(row => row.id === policy.model)) $('child-model').add(new Option('已移除：' + policy.model, policy.model));
    if (policy.model) $('child-model').value = policy.model;
    if (main) $('main-model').value = main;
    $('pool').replaceChildren();
    for (const model of eligible()) {
      const entry = policy.models?.find(row => row.id === model.id);
      const row = document.createElement('div'); row.className = 'model-row'; row.dataset.id = model.id;
      const label = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = Boolean(entry);
      const name = document.createElement('span'); name.textContent = model.name;
      label.append(check, name);
      const description = document.createElement('input'); description.type = 'text'; description.maxLength = 1000;
      description.value = entry?.description || ''; description.placeholder = '用途，例如：实现、独立审查';
      description.setAttribute('aria-label', model.name + ' 的用途');
      row.append(label, description); $('pool').append(row);
    }
    for (const entry of policy.models || []) if (!eligible().some(model => model.id === entry.id)) {
      tell('模型池中有已移除的模型，请重新选择后保存。', true);
    }
    modes();
    if (policy.effort) $('effort').value = policy.effort;
  }
  function receive() {
    const incoming = globalThis.KIMI_WORK_STATE;
    if (!incoming || incoming.schemaVersion !== 1 || !Array.isArray(incoming.models)) return;
    data = incoming;
    const runtime = data.subagents || {};
    const stale = Date.now() - data.at > 15000;
    $('runtime').textContent = stale ? '插件状态已过期，请确认 Kimi Work BYOK 已启用。' :
      (runtime.observed ? '已在 Work 请求中观察到子代理模型池和默认模型' : states[runtime.state] || '正在连接 Work')
      + (runtime.reason ? ' · ' + runtime.reason : '');
    $('runtime').dataset.error = String(stale || ['conflict', 'blocked', 'unverified'].includes(runtime.state));
    $('current-model').textContent = (data.currentModel ? 'Work 当前模型：' + data.currentModel : '也可以直接使用 Work 的模型菜单。')
      + (data.main ? ' · ' + (states[data.main.state] || data.main.state) + (data.main.reason ? '：' + data.main.reason : '') : '');
    const nextSignature = JSON.stringify(data.models);
    if (ready && nextSignature !== signature) {
      const draft = dirty ? selection() : options.workModels?.subagents;
      const main = dirty ? $('main-model').value : '';
      renderPolicy(draft, main); signature = nextSignature;
    }
    $('save').disabled = !ready || saving || stale || !data.models.length;
  }
  async function boot() {
    try {
      await magpie.ready;
      options = await magpie.options.get(); ready = true;
      renderPolicy(options.workModels?.subagents);
      if (!options.workModels?.subagents) tell('尚未启用新设置；旧 Agent 选择器的目标仍按旧接入方式处理。');
      receive();
    } catch { tell('无法连接 Magpie 插件设置桥，请在 Magpie 的 Agent 页面打开此面板。', true); }
  }
  $('settings').addEventListener('input', () => { dirty = true; });
  $('mode').addEventListener('change', modes);
  $('child-model').addEventListener('change', () => { $('effort').value = ''; modes(); });
  $('reset').addEventListener('click', () => { dirty = false; renderPolicy(options.workModels?.subagents); tell('已恢复保存的设置。'); });
  $('settings').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !ready || !data || Date.now() - data.at > 15000) return;
    const policy = selection();
    if (policy.mode !== 'inherit' && !eligible().some(row => row.id === policy.model)) { tell('请选择仍可见且支持工具调用的模型。', true); return; }
    if (policy.mode === 'pool' && (!policy.models.length || policy.models.length > 32 || !policy.models.some(row => row.id === policy.model))) {
      tell('请选择 1–32 个候选模型，并把默认模型加入池中。', true); return;
    }
    if (policy.mode === 'pool' && policy.models.some(row => !row.description)) { tell('请为每个候选模型填写用途说明。', true); return; }
    saving = true; $('save').disabled = true;
    try {
      const latest = await magpie.options.get();
      if (JSON.stringify(latest.workModels) !== JSON.stringify(options.workModels)) {
        options = latest; dirty = false; renderPolicy(options.workModels?.subagents);
        tell('另一处已修改模型设置，已重新载入。请确认后再保存。', true); return;
      }
      const workModels = { ...latest.workModels, subagents: policy };
      if ($('main-model').value) {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
        workModels.mainModelRequest = { id, at: Date.now(), model: $('main-model').value };
      }
      options = await magpie.options.set({ ...latest, workModels });
      dirty = false; $('main-model').value = '';
      tell('设置已保存。Magpie 会重新加载插件；下方运行状态更新后再开始新任务。');
    } catch { tell('保存失败。请稍后重试；检查 Magpie 插件是否仍启用。', true); }
    finally { saving = false; receive(); }
  });
  function refresh() {
    const script = document.createElement('script');
    script.src = '.runtime-state.js?t=' + Date.now();
    script.onload = script.onerror = () => script.remove();
    document.head.append(script);
  }
  globalThis.addEventListener('kimi-work-state', receive);
  refresh(); setInterval(refresh, 3000); void boot();
})();
