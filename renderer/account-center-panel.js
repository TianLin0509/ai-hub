'use strict';
const { companyCards } = require('./account-center-view');
const { TABS, aiHtml, cliHtml, servicesHtml, platformHtml, toolConnections, codexQuotaHtml, riskFormValues, keeperBadgeHtml } = require('./account-workspace-view');
const { tokenPageHtml, otherAiTokensHtml, accountTotals } = require('./account-token-view');
const CORE_KINDS = new Set(['claude', 'codex', 'gemini']);
const accountRisk = require('./account-risk-state');
const { claudeWorkspaceHtml, nextLabel } = require('./account-claude-view');
const { keeperControlsHtml } = require('./account-keeper-view');
const accountInfraOn = () => require('../core/distribution').featureEnabled('accountInfra');
const ENV_PAGES = { claude: 'https://claude.ai/', ip: 'https://api.ipify.org/' };
function createAccountCenterPanel({ document, ipcRenderer, escapeHtml: esc, configModal, closeOtherPanels = () => {}, openLoginSession = () => {}, resumeLaunch = () => {}, hasLaunchDraft = () => false, notify = () => {}, getClaudeQuota = null }) {
  const page = document.getElementById('account-page'), body = page.querySelector('.ac-content');
  async function refreshTokens() {
    try {
      tokenData = await ipcRenderer.invoke('token-usage:state');
      // 第一次打开时账本还是空的，直接开始统计，不用等定时任务。
      if (tokenData && !tokenData.syncedAt && !tokenData.running && !tokenFirstSyncAsked) { tokenFirstSyncAsked = true; tokenData = await ipcRenderer.invoke('token-usage:sync'); }
    } catch (e) { tokenData = { days: {}, syncedAt: 0, error: e.message }; }
    if (!page.hidden && view === 'list') renderTools();
  }
  ipcRenderer.on?.('token-usage-changed', (_e, next) => {
    tokenData = next;
    if (!page.hidden && view === 'list' && (tab === 'token' || !next.running)) renderTools();
  });
  const keeperBadge = document.createElement('span');
  keeperBadge.className = 'ac-keeper-slot';
  page.querySelector('.ac-head h1').parentElement.appendChild(keeperBadge);
  // 2026-11-01 B 方案：Claude 单独成第一个页签，左列表选账号、右侧看详情或走新建四步。
  let tab = 'token', tokenData = null, tokenMetric = 'total', tokenFirstSyncAsked = false, claudeSelected = '', claudeFilter = false, wizard = null;
  const search = page.querySelector('.ac-search'), tabs = page.querySelector('.ac-tabs');
  let state = null, signature = '', view = 'list', error = '', notice = '', busy = '', timer, previousFocus, epoch = 0, request = 0;
  let toolGroups = null;
  let authTarget = '', returnToLaunch = false;
  // The one inline add / rename / remove form open in the Claude / Codex account cards.
  let accountEdit = null;
  let codexExits = null, codexExitFlight = null;
  let agyExits = null, agyExitFlight = null; // Antigravity 专线（2026-11-21）
  let deviceLogin = null;
  let keeperAccounts = {}, keeperFallback = null;
  const keeperReads = new Map();
  async function refreshKeeperAccount(kind, profileId, force = false) {
    const key = kind + ':' + profileId;
    if (keeperReads.has(key) || (!force && Object.hasOwn(keeperAccounts, key))) return;
    const ticket = epoch, read = {};
    keeperReads.set(key, read);
    try {
      const r = await ipcRenderer.invoke('vps-keeper:account', { kind, profileId });
      if (ticket === epoch) keeperAccounts[key] = r?.ok ? r.data : null;
    } catch { if (ticket === epoch) keeperAccounts[key] = null; }
    finally {
      if (keeperReads.get(key) === read) keeperReads.delete(key);
      if (ticket === epoch && !page.hidden) { renderTools(); renderStatus(); }
    }
  }
  async function manageInKeeper(kind, profileId) {
    if (busy) return;
    const ticket = epoch;
    busy = 'keeper-manage'; keeperFallback = null; error = ''; notice = '正在检查管家是否运行（最多等 15 秒）…'; renderStatus();
    try {
      const r = await ipcRenderer.invoke('vps-keeper:manage', { kind, profileId });
      if (!r?.ok) throw Error(r?.error || '管家未能打开');
      if (ticket === epoch) notice = r.data.message;
    } catch (e) {
      if (ticket === epoch) { notice = ''; error = '管家未能打开：' + e.message; keeperFallback = { kind, profileId }; }
    } finally {
      busy = '';
      if (ticket === epoch) { renderStatus(); void refreshKeeperAccount(kind, profileId, true); }
    }
  }
  ipcRenderer.on?.('vps-keeper-progress', (_e, p) => {
    if (busy === 'keeper-manage' && !page.hidden) { notice = p?.message || notice; renderStatus(); }
  });
  async function refreshCodexExits() {
    if (codexExitFlight) return codexExitFlight;
    codexExitFlight = ipcRenderer.invoke('accounts:codex-exits').then(r => {
      codexExits = r?.ok ? { ...r.data, checks: codexExits?.checks } : { ...codexExits, error: r?.error || '出口信息未响应' };
    }).catch(e => { codexExits = { ...codexExits, error: e.message }; }).finally(() => {
      codexExitFlight = null; if (!page.hidden && view === 'list') renderTools();
    });
    return codexExitFlight;
  }
  async function refreshAgyExits() {
    if (agyExitFlight) return agyExitFlight;
    agyExitFlight = ipcRenderer.invoke('accounts:antigravity-exits').then(r => {
      agyExits = r?.ok ? { ...r.data, checks: agyExits?.checks } : { ...agyExits, error: r?.error || '专线信息未响应' };
    }).catch(e => { agyExits = { ...agyExits, error: e.message }; }).finally(() => {
      agyExitFlight = null; if (!page.hidden && view === 'list') renderTools();
    });
    return agyExitFlight;
  }
  async function checkAgyExit(profileId) {
    if (busy) return;
    busy = 'agy-exit-check';
    agyExits = { ...agyExits, checking: profileId, error: '' }; renderTools();
    try {
      const r = await ipcRenderer.invoke('accounts:antigravity-exit-check', { profileId });
      agyExits.checks = { ...agyExits.checks, [profileId]: r?.ok ? r.data : { error: r?.error || '专线检查未完成' } };
    } catch (e) { agyExits.checks = { ...agyExits.checks, [profileId]: { error: e.message } }; }
    finally { busy = ''; agyExits.checking = ''; if (!page.hidden) renderTools(); }
  }
  async function bindAgyExit(profileId) {
    const edit = accountEdit;
    if (busy || edit?.mode !== 'agy-bind' || edit.profileId !== profileId) return;
    const exit = edit.exit || agyExits?.routes?.find(r => r.selectable)?.id;
    if (!exit) return;
    busy = 'agy-bind'; notice = '正在核对专线出口、在出口所在 VPS 上新建远程浏览器（约 1–2 分钟）…'; renderStatus();
    const ticket = epoch;
    try {
      const r = await ipcRenderer.invoke('accounts:antigravity-bind-exit', { profileId, exit });
      if (!r?.ok) throw Error(r?.error || '绑定未完成');
      if (ticket !== epoch) return;
      accountEdit = null; notice = '已绑定专线 ' + r.profile.ip + '，远程浏览器 ' + r.profile.loginEnv + ' 已建好；点「授权」在远程窗口里登录 Google。';
      await refreshAgyExits(); await refresh();
    } catch (e) { if (ticket === epoch) editAccount({ ...edit, error: e.message }); }
    finally { busy = ''; if (ticket === epoch) renderStatus(); }
  }
  async function checkCodexExit(profileId) {
    if (busy) return;
    busy = 'codex-exit-check';
    codexExits = { ...codexExits, checking: profileId, error: '' }; renderTools();
    try {
      const r = await ipcRenderer.invoke('accounts:codex-exit-check', { profileId });
      if (!r?.ok) throw Error(r?.error || '出口检查未完成');
      codexExits.checks = { ...codexExits.checks, [r.data.exit]: r.data };
    } catch (e) { codexExits.error = e.message; }
    finally { busy = ''; codexExits.checking = ''; if (!page.hidden) renderTools(); }
  }
  let vps = null, vpsFlight = null;
  async function refreshVps() {
    if (vpsFlight) return vpsFlight;
    if (!vps) vps = { loading: true };
    vpsFlight = ipcRenderer.invoke('vps-login:state').then(r => { vps = r?.ok ? r.data : { ...(vps?.loading ? {} : vps), error: r?.error || '未响应' }; })
      .catch(e => { vps = { error: e.message }; }).finally(() => { vpsFlight = null; if (!page.hidden && view === 'list') renderTools(); });
    return vpsFlight;
  }
  async function envAction(name, profileId, url = '') {
    if (busy) return;
    busy = 'env-' + name; error = ''; notice = name === 'open' ? (url ? '正在打开远程浏览器并跳转…' : '正在打开登录窗口…') : '正在关闭登录窗口…'; renderStatus();
    const ticket = epoch;
    try {
      let r = await ipcRenderer.invoke('vps-login:' + name, url ? { profileId, url } : { profileId });
      if (r?.ok && r.data?.needsConfirmation) {
        const ask = `登录环境「${r.data.others.join('、')}」还开着。
切换会关闭它（登录资料保留，未发送的草稿可能丢失）。

确认切换吗？`;
        if (!window.confirm(ask)) { notice = '已取消，原来的登录窗口保持运行'; return; }
        r = await ipcRenderer.invoke('vps-login:' + name, { profileId, url, confirmed: true });
      }
      if (!r?.ok) throw Error(r?.error || '登录环境未响应');
      if (keeperFallback?.kind === 'claude' && keeperFallback.profileId === profileId) keeperFallback = null;
      if (ticket === epoch) notice = r.data.message || '';
    } catch (e) { if (ticket === epoch) { notice = ''; error = e.message; } }
    finally { busy = ''; if (ticket === epoch) renderStatus(); void refreshVps(); }
  }
  // 「检查出口」（2026-10-31）：只在点按钮时测，结果留在页面上直到再测。
  let exits = null;
  async function checkExits(profileId) {
    if (exits?.loading) return;
    const previous = exits?.list || [];
    exits = { loading: true }; renderTools();
    try {
      const r = await ipcRenderer.invoke('vps-login:check-exits', profileId ? { profileId } : {});
      exits = r?.ok ? { list: [...(profileId ? previous.filter(e => !r.data.some(n => n.expected === e.expected)) : []), ...r.data], at: Date.now() } : { error: r?.error || '未响应' };
      void refreshVps();
    }
    catch (e) { exits = { error: e.message }; }
    if (!page.hidden && view === 'list') renderTools();
  }
  // Claude 页签的额度条（2026-11-01）：读主进程的逐号额度缓存（右侧账号看板同一来源，Hub 每 2 分钟刷新），随账号页刷新一起读。
  let claudeQuota = {};
  async function refreshClaudeQuota() {
    try {
      const cached = await ipcRenderer.invoke('account-profile-usage');
      const rows = require('./account-quota-panel.js').viewRows('claude', { accounts: { claude: cached?.claude || [] } }, '', Date.now());
      claudeQuota = Object.fromEntries(rows.map(r => [r.profileId || 'default', r]));
    } catch {}
  }
  const quotaFor = () => { if (getClaudeQuota) { try { return getClaudeQuota() || {}; } catch { return {}; } } return claudeQuota; };
  // Claude 账号邮箱保管（2026-10-30）：只含邮箱地址、备注和「是否存了密码」，读本机文件，随账号页打开读取。
  let mail = null;
  async function refreshMail() {
    try { const r = await ipcRenderer.invoke('mailbox:list'); mail = r?.ok ? { accounts: r.data } : { error: r?.error || '未响应' }; }
    catch (e) { mail = { error: e.message }; }
    if (!page.hidden && view === 'list') renderTools();
  }
  async function mailAction(name, payload) {
    if (busy) return;
    busy = 'mail-' + name; error = ''; notice = name === 'open' ? '正在打开该账号的登录窗口并进入邮箱…' : ''; renderStatus();
    const ticket = epoch;
    try {
      let r = await ipcRenderer.invoke('mailbox:' + name, payload);
      if (name === 'open' && r?.ok && r.data?.needsConfirmation) {
        if (!window.confirm(`登录环境「${r.data.others.join('、')}」还开着。\n切换会关闭它（登录资料保留，未发送的草稿可能丢失）。\n\n确认切换吗？`)) { notice = '已取消，原来的登录窗口保持运行'; return; }
        r = await ipcRenderer.invoke('mailbox:open', { ...payload, confirmed: true });
      }
      if (!r?.ok) throw Error(r?.error || '邮箱操作未完成');
      if (ticket === epoch) notice = r.data.message || '';
    } catch (e) { if (ticket === epoch) { notice = ''; error = e.message; } }
    finally { busy = ''; if (ticket === epoch) renderStatus(); if (name === 'open') void refreshVps(); if (name === 'import') void refreshMail(); }
  }
  async function saveMail() {
    const edit = accountEdit;
    if (!edit || edit.mode !== 'mail' || busy) return;
    busy = 'account-edit'; renderStatus();
    const ticket = epoch;
    try {
      const r = await ipcRenderer.invoke('mailbox:save', { profileId: edit.profileId, ...edit.mail });
      if (!r?.ok) throw Error(r?.error || '邮箱资料未保存');
      if (ticket !== epoch) return;
      accountEdit = null; notice = r.data.message; await refreshMail();
    } catch (e) { if (ticket === epoch && accountEdit) editAccount({ ...accountEdit, error: e.message }); }
    finally { busy = ''; if (ticket === epoch) renderStatus(); }
  }
  accountRisk.subscribe(() => { if (!page.hidden && view === 'list') renderTools(); });
  async function clearRisk(kind, profileId) {
    if (busy) return;
    busy = 'account-edit'; renderStatus();
    try {
      const r = await ipcRenderer.invoke('account-risk:clear', { kind, profileId });
      if (!r?.ok) throw Error(r?.error || '风控标记未解除');
      accountRisk.publish(r.data); notice = '已解除风控标记，记录保留为历史'; error = '';
    } catch (e) { error = e.message; }
    finally { busy = ''; renderStatus(); }
  }
  ipcRenderer.on?.('vps-login-progress',(_e, p) => { if (busy.startsWith('env-') || busy === 'account-edit') { notice = p?.message || notice; renderStatus(); } });
  // Sidebar badge: accounts whose login or human check needs the person (main process count).
  function setBadge(n) {
    const count = document.getElementById('accounts-attention');
    if (!count || !Number.isInteger(n)) return;
    count.textContent = n; count.hidden = !n;
    count.title = n ? n + ' 个账号需要重新登录或验证' : '';
  }
  let toolAccounts = null, toolAccountsError = '', toolAccountsFlight = null;
  const toolChoices = {};
  function selectTab(id) {
    if (!TABS.some(t => t.id === id)) return;
    tab = id; search.value = ''; error = ''; notice = ''; body.scrollTop = 0; render();
    tabs.querySelector('[aria-selected="true"]')?.focus();
    if (id === 'codex') void refreshCodexExits();
    if (id === 'gemini') void refreshAgyExits();
  }
  function footerHtml() {
    return `<footer class="ac-footnote"><span>「打开」用你自己的浏览器（AI 不碰它）；状态显示 AI 浏览器的登录，生图、中转、圆桌用的是它</span><details class="ac-connections" data-details="connections"><summary>工具连接</summary>${toolConnections(toolAccounts, esc, state?.activity)}${toolAccountsError ? `<p class="ac-item-error">${esc(toolAccountsError)}</p>` : ''}${toolsHtml()}</details></footer>`;
  }
  async function call(action, args) {
    const r = await ipcRenderer.invoke('hub-accounts:' + action, args);
    if (!r?.ok) throw Error(r?.error || '账号服务未响应');
    return r.data;
  }
  function renderStatus() {
    const el = page.querySelector('.ac-status'), text = error || notice;
    el.textContent = text; el.hidden = !text; el.classList.toggle('error', !!error);
    if (deviceLogin) {
      el.hidden = false;
      el.insertAdjacentHTML('beforeend', `<div data-codex-device-login><p>设备码：<strong>${esc(deviceLogin.deviceCode)}</strong> <button class="ac-btn" data-ac="codex-device-copy">复制设备码</button></p><p>在 VPS 远程窗口输入；授权完成后窗口自动关闭。</p><label>账号邮箱 <input class="ac-account-input" data-codex-mailbox type="email" maxlength="254" value="${esc(deviceLogin.email || '')}" placeholder="输入登录邮箱"></label> ${keeperControlsHtml('codex', deviceLogin.id.replace(/^codex-/, ''), esc, { label: '去管家打开远程窗口', busy: !!busy, account: keeperAccounts['codex:' + deviceLogin.id.replace(/^codex-/, '')] })} <button class="ac-btn" data-ac="codex-device-page">返回设备码页</button></div>`);
      void refreshKeeperAccount('codex', deviceLogin.id.replace(/^codex-/, ''));
    }
    if (keeperFallback) {
      el.hidden = false;
      el.insertAdjacentHTML('beforeend', `<p><button class="ac-btn" data-ac="keeper-fallback" data-kind="${keeperFallback.kind}" data-profile="${esc(keeperFallback.profileId)}">仍在 Hub 里打开远程窗口</button></p>`);
    }
    for (const b of page.querySelectorAll('[data-ac="keeper-manage"],[data-ac="keeper-fallback"]')) b.disabled = !!busy;
    if (returnToLaunch) { el.insertAdjacentHTML('beforeend',' <button class="ac-btn" data-ac="return-launch">返回继续创建</button>'); el.hidden = false; }
    // A background login check never disables 打开: clicking makes the check yield.
    for (const b of page.querySelectorAll('[data-ac="open"],[data-ac="login"],[data-ac="add"],[data-ac="preferred"],[data-ac="authorize"],[data-ac="external"]')) b.disabled = !!busy || state?.setupProgress?.status === 'running';
    for (const b of page.querySelectorAll('[data-ac="recover"],[data-ac="recheck"],[data-ac="copy-logins"],[data-ac="tools"],[data-ac="tools-connect"]')) b.disabled = !!busy || state?.setupProgress?.status === 'running' || state?.progress?.status === 'running';
    for (const b of page.querySelectorAll('[data-ac="codex-quota"],[data-ac="claude-quota"],[data-ac="gemini-quota"]')) b.disabled=!!busy || !!state?.clis?.find(c=>c.kind===b.dataset.ac.replace('-quota','') && (c.profileId || 'default')===b.dataset.profile)?.isDefault;
  }
  function toolsHtml() {
    const progress = state?.setupProgress;
    const status = progress ? `<p class="ac-tool-help" role="status">${esc(progress.error || progress.stage)}</p>` : '';
    if (!toolGroups) return `<button class="ac-btn" data-ac="tools">管理已有工具连接</button>${status}`;
    const options = (state.identities || []).map(i => ({ id: i.id, label: (i.id === 'main' ? '账号 1' : '账号 2') + ' · ' + (i.account || '身份待确认') }));
    return `<div class="ac-tool-setup"><p>为工具选择它原来使用的 ChatGPT 账号。接入会等待工具空闲，保留任务、历史和旧登录资料。</p>${toolGroups.map(g => `<label><span>${esc(g.name)}${g.labels?.length ? ' · ' + esc(g.labels.join(' / ')) : ''}<small>${g.lanes} 个工作页面</small></span><select data-tool-choice="${esc(g.id)}"><option value="">请选择对应账号</option>${options.map(o => `<option value="${o.id}" ${toolChoices[g.id] === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`).join('')}<button class="ac-btn" data-ac="tools-connect" ${progress?.status === 'running' ? 'disabled' : ''}>保存并接入</button>${status}</div>`;
  }
  function render() {
    if (page.hidden) return;
    keeperBadge.innerHTML = tab === 'claude' ? keeperBadgeHtml(vps, esc) : tab === 'codex' ? keeperBadgeHtml(codexExits, esc) : tab === 'gemini' ? keeperBadgeHtml(agyExits, esc) : '';
    position();
    if (state) setBadge(state.attention);
    document.getElementById('account-editor').hidden = view !== 'config'; body.hidden = view === 'config';
    page.querySelector('[data-ac="back"]').hidden = view !== 'config';
    tabs.hidden = view === 'config';
    search.hidden = view === 'config' || ['token', 'codex', 'gemini'].includes(tab);
    if (view === 'config') return renderStatus();
    const counts = { claude: 'claude', codex: 'codex', gemini: 'gemini' };
    tabs.innerHTML = TABS.map(t => { const n = counts[t.id] ? (state?.clis || []).filter(c => c.kind === counts[t.id]).length : 0; return `<button role="tab" id="ac-tab-${t.id}" aria-selected="${tab === t.id}" aria-controls="ac-list-panel" tabindex="${tab === t.id ? 0 : -1}" data-ac="tab" data-tab="${t.id}">${t.name}${n ? `<em>${n}</em>` : ''}</button>`; }).join('');
    body.setAttribute('aria-labelledby', 'ac-tab-' + tab);
    if (tab === 'token') { body.innerHTML = tokenPageHtml(tokenData, { metric: tokenMetric, clis: state?.clis || [] }, esc); return renderStatus(); }
    if (!state) { body.innerHTML = '<p class="ac-empty">正在读取账号…</p>'; return renderStatus(); }
    const expanded = [...body.querySelectorAll('details[open]')].map(d => d.dataset.details);
    const mailFocus = body.contains(document.activeElement) ? (document.activeElement.dataset?.mailField || document.activeElement.dataset?.wizField) : '';
    if (tab === 'claude') {
      const quota = quotaFor();
      body.innerHTML = claudeWorkspaceHtml(state, esc, { edit: accountEdit, vps, mail, exits, quota, tokens: tokenData ? accountTotals(tokenData, 'claude') : null, selected: claudeSelected, filter: claudeFilter, query: search.value, wizard, busy: !!busy, keeperAccounts });
      for (const d of body.querySelectorAll('details')) d.open = expanded.includes(d.dataset.details);
      for (const b of body.querySelectorAll('[data-ac=keeper-manage]')) void refreshKeeperAccount(b.dataset.kind, b.dataset.profile);
      const field = wizard ? body.querySelector(`[data-wiz-field="${mailFocus || ''}"]`) || body.querySelector('[data-account-input]') : body.querySelector('[data-account-input]:not([data-mail-field])') || (accountEdit?.mode === 'mail' ? body.querySelector(`[data-mail-field="${mailFocus || 'email'}"]`) : null);
      if (field && (!wizard || mailFocus || wizard.step === 1)) { field.focus({ preventScroll: true }); field.setSelectionRange?.(field.value.length, field.value.length); }
      return renderStatus();
    }
    body.innerHTML = tab === 'ai' ? aiHtml(state, search.value, esc)
      : tab === 'codex' || tab === 'gemini' ? codexQuotaHtml(state, esc, accountEdit, vps, mail, exits, [tab], tab === 'gemini' ? agyExits : codexExits, tokenData ? accountTotals(tokenData, tab === 'gemini' ? 'antigravity' : 'codex') : null)
      : tab === 'other' ? otherAiTokensHtml(tokenData, esc) + '<h3 class="ac-group-title">命令行账号</h3>' + cliHtml(state, search.value, esc, c => !CORE_KINDS.has(c.kind)) + '<h3 class="ac-group-title">API 与服务</h3>' + servicesHtml(toolAccounts, 'api', search.value, state, esc, toolAccountsError)
      : platformHtml(toolAccounts, search.value, state, esc, toolAccountsError);
    if (tab === 'ai' && state.tools?.some(tool => tool.tool === 'images' && tool.state === 'changed')) {
      body.innerHTML = '<p class="ac-connection-notice" role="status">生图工具连接配置已变化，生图记录暂不能归入共享账号。请在下方「工具连接」核对。</p>' + body.innerHTML;
    }
    if (tab === 'ai' && !search.value) body.innerHTML += footerHtml();
    if (state.activity?.warnings?.length) body.innerHTML += `<p class="ac-item-error">${esc(state.activity.warnings.join(' / '))}</p>`;
    if (tab === 'ai' && (state.webTools?.images?.readError || state.webTools?.roundtable?.recoveryError)) body.innerHTML += '<p class="ac-item-error">部分网页工具状态读取失败；请在原会话查看任务结果。</p>';
    if (state.progress?.status === 'running') body.innerHTML += `<p class="ac-connection-notice" role="status">${esc('正在后台确认登录（' + state.progress.done + '/' + state.progress.total + '），不影响打开网页')}</p>`;
    else if (!state.progress?.auto && (state.progress?.error || state.progress?.warnings?.length)) body.innerHTML += `<p class="ac-item-error">${esc(state.progress.error || state.progress.warnings.join(' / '))}</p>`;
    for (const d of body.querySelectorAll('details')) d.open = expanded.includes(d.dataset.details);
    // The mail form keeps the caret in the field being typed when a periodic refresh redraws the page.
    const input = body.querySelector('[data-account-input]:not([data-mail-field])') || (accountEdit?.mode === 'mail' ? body.querySelector(`[data-mail-field="${mailFocus || 'email'}"]`) : null);
    if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }
    if (authTarget) {
      const target = [...body.querySelectorAll('[data-ac="authorize"]')].find(b => b.dataset.id === authTarget);
      target?.closest('.ac-account')?.classList.add('ac-auth-target');
    }
    renderStatus();
  }
  function apply(next) {
    const sig = Math.floor(Date.now() / 60000) + ':' + JSON.stringify(next);
    if (sig === signature) return renderStatus();
    const top = body.scrollTop, focus = page.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    state = next; signature = sig; render();
    if (focus && Object.keys(focus).length) [...page.querySelectorAll('button')].find(b => Object.entries(focus).every(([k, v]) => b.dataset[k] === v))?.focus({ preventScroll: true });
    body.scrollTop = top;
  }
  function renderTools() {
    const top = body.scrollTop, focus = page.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    render();
    if (focus && Object.keys(focus).length) [...page.querySelectorAll('button,select')].find(b => Object.entries(focus).every(([k, v]) => b.dataset[k] === v))?.focus({ preventScroll: true });
    body.scrollTop = top;
  }
  function position() {
    const rail = document.getElementById('scene-rail')?.getBoundingClientRect();
    if (rail) {
      const sessionEdge = document.getElementById('session-sidebar')?.getBoundingClientRect().left;
      page.style.left = (sessionEdge ?? rail.right) + 'px';
      page.style.top = rail.top + 'px';
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (!page.hidden && view === 'list') timer = setTimeout(() => void refresh(), state?.setupProgress?.status === 'running' ? 800 : 5000);
  }
  async function refresh() {
    const ticket = epoch, seq = ++request;
    if (tab === 'claude') await refreshClaudeQuota();
    try { const next = await call('state'); if (ticket === epoch && seq === request && !page.hidden) {
      const newlyConnected = next.setupProgress?.status === 'complete' && state?.setupProgress?.status !== 'complete';
      apply(next); if (newlyConnected) void refreshToolAccounts();
    } }
    catch (e) { if (ticket === epoch && !page.hidden) { error = e.message; renderStatus(); } }
    finally { schedule(); }
  }
  async function refreshToolAccounts(force = false) {
    if (toolAccountsFlight) return toolAccountsFlight;
    const ticket = epoch;
    toolAccountsError = '';
    toolAccountsFlight = call('tool-accounts', { refresh: force }).then(data => {
      if (ticket === epoch && !page.hidden) { toolAccounts = data; renderTools(); }
    }).catch(e => { if (ticket === epoch && !page.hidden) { toolAccountsError = e.message; renderTools(); } })
      .finally(() => { toolAccountsFlight = null; if (ticket !== epoch && !page.hidden) void refreshToolAccounts(); });
    return toolAccountsFlight;
  }
  async function action(name, args) {
    if (busy) return;
    busy = name; error = ''; notice = ''; renderStatus();
    if (['external', 'open', 'login'].includes(name)) { notice = '正在打开官方入口…'; renderStatus(); }
    if (name === 'copy-logins') { notice = '正在把你的登录复制给 AI 浏览器…'; renderStatus(); }
    const ticket = epoch; ++request;
    try {
      const result = await call(name, args);
      if (ticket !== epoch) return;
      if (name === 'tools') { toolGroups = result.groups; if (!toolGroups.length) notice = '未发现需要接入的生图或中转工具'; render(); }
      else if (name === 'tools-connect') { state.setupProgress = result; render(); }
      else if (name === 'external') { notice = result.message; await refresh(); await refreshToolAccounts(); }
      else if (name === 'open' || name === 'login') { notice = result.message; await refresh(); }
      else if (name === 'copy-logins') { notice = result.message; apply(result); }
      else apply(result);
    } catch (e) { if (ticket === epoch) error = e.message; }
    finally { busy = ''; if (ticket === epoch) renderStatus(); schedule(); }
  }
  async function authorize(id) {
    if (busy) return;
    busy = 'authorize'; error = ''; notice = ''; renderStatus();
    const ticket = epoch;
    try {
      const nativeId = id.startsWith('codex:') ? id.replace('codex:', 'codex-') : ({ gemini: 'gemini-cli' }[id] || id);
      let r = await ipcRenderer.invoke('accounts:login', { id: nativeId });
      if (r?.ok && r.data?.needsConfirmation) {
        if (!window.confirm(`登录环境「${r.data.others.join('、')}」还开着。切换会关闭它，未发送的草稿可能丢失。确认切换吗？`)) return;
        r = await ipcRenderer.invoke('accounts:login', {id:nativeId,confirmed:true});
      }
      if (!r?.ok) throw Error(r?.error || '授权入口未打开');
      if (r.data?.deviceCode) deviceLogin = {...r.data,id:nativeId};
      if (ticket === epoch) notice = r.data?.message || '已打开官方授权入口';
      if (r.data?.sessionId) { close(); await openLoginSession(r.data.sessionId); }
    } catch (e) { if (ticket === epoch) error = e.message; }
    finally { busy = ''; if (ticket === epoch) renderStatus(); }
  }
  async function deviceAction(action) {
    if (!deviceLogin || busy) return;
    error = '';
    const current=deviceLogin;
    current.email=page.querySelector('[data-codex-mailbox]')?.value || current.email;
    try {
      if(action==='copy') { await navigator.clipboard.writeText(current.deviceCode); notice='设备码已复制'; }
      else {
        busy='codex-device';
        const channel=action==='mailbox'?'accounts:codex-mailbox':'accounts:codex-device-page';
        let r=await ipcRenderer.invoke(channel,{id:current.id,email:current.email});
        if(r?.ok&&r.data?.needsConfirmation){
          if(!window.confirm(`登录环境「${r.data.others.join('、')}」还开着。切换会关闭它，确认继续吗？`))return;
          r=await ipcRenderer.invoke(channel,{id:current.id,email:current.email,confirmed:true});
        }
        if(!r?.ok)throw Error(r?.error||'远程页面未打开');
        if (keeperFallback?.kind === 'codex' && current.id === 'codex-' + keeperFallback.profileId) keeperFallback = null;
        notice=action==='mailbox'?'已在远程窗口打开邮箱；取到验证码后可返回设备码页':'已返回设备码页';
      }
    }catch(e){error=e.message;}
    finally{busy='';renderStatus();}
  }
  async function switchCodexQuota(profileId, kind='codex') {
    if (busy) return;
    busy='codex-quota';error='';notice='正在切换后续会话的用量账号…';renderStatus();
    const ticket=epoch;
    try {
      const result=await ipcRenderer.invoke(kind==='gemini'?'antigravity:set-launch-account':kind==='claude'?'claude:set-launch-account':'codex:set-global-account',{profileId,scope:'launch'});
      if (!result?.ok) throw Error(result?.error || '用量账号切换失败');
      if (ticket!==epoch) return;
      notice=kind==='gemini'?'已切换新建 Antigravity 会话的账号，已有会话保持原账号。':kind==='claude'?'已切换新建会话的账号，已有会话恢复和重启仍用原账号。':'已切换后续会话的用量账号。已打开的会话保持原账号，新建、恢复和重启使用新账号。';
      await refresh();
    } catch (e) {if(ticket===epoch)error=e.message;}
    finally {busy='';if(ticket===epoch)renderStatus();}
  }
  async function configure(provider = 'codex') {
    try { await configModal.openAccountConfig(provider); if (!page.hidden) { view = 'config'; clearTimeout(timer); render(); } }
    catch (e) { error = e.message; renderStatus(); }
  }
  // render() puts focus in the name field; renderTools() would move it back to the clicked button.
  function editAccount(next) {
    accountEdit = next; error = ''; const top = body.scrollTop; render(); body.scrollTop = top;
    if ((next?.kind === 'codex' || next?.kind === 'gemini') && next.mode === 'add') body.querySelector('.ac-account-new')?.scrollIntoView({ block: 'start' });
  }
  async function saveAccountEdit() {
    const edit = accountEdit;
    if (!edit || busy) return;
    busy = 'account-edit'; renderStatus();
    const ticket = epoch;
    try {
      if (edit.mode === 'risk') {
        const r = await ipcRenderer.invoke('account-risk:flag', { kind: edit.kind, profileId: edit.profileId, note: edit.value,
          at: new Date(edit.at).getTime(), days: Number(edit.days) || null });
        if (!r?.ok) throw Error(r?.error || '风控标记未保存');
        if (ticket !== epoch) return;
        accountEdit = null; notice = '已标记风控：观察期内不再推荐，自动换号会跳过这个账号';
        accountRisk.publish(r.data); return;
      }
      if (edit.mode === 'bind') {
        notice = edit.loginEnv === 'new' || !edit.loginEnv ? '正在 VPS 上新建登录环境并核对出口（约 15–45 秒）…' : '正在绑定登录环境…'; renderStatus();
        const b = await ipcRenderer.invoke('vps-login:bind', { profileId: edit.profileId, loginEnv: edit.loginEnv || 'new' });
        if (!b?.ok) throw Error(b?.error || '绑定未完成');
        if (ticket !== epoch) return;
        accountEdit = null; notice = b.data.message; await refreshVps(); return;
      }
      const channel = { add: 'accounts:add-subscription', rename: 'accounts:rename-subscription', remove: 'accounts:remove-subscription' }[edit.mode];
      const agyExit = edit.kind === 'gemini' ? (edit.exit && edit.exit !== 'shared' ? edit.exit : edit.exit === 'shared' ? '' : agyExits?.routes?.find(r => r.selectable)?.id || '') : '';
      const exit = edit.mode === 'add' && edit.kind === 'codex' ? { exit: edit.exit || 'shared' }
        : edit.mode === 'add' && edit.kind === 'gemini' && agyExit ? { exit: agyExit }
        : edit.mode === 'add' && edit.kind === 'claude' && vps?.routes ? { route: edit.route || vps.routes.find(r => r.runnable)?.id, loginEnv: edit.loginEnv || 'new' } : {};
      if (exit.route || (exit.exit && exit.exit !== 'shared')) { notice = '正在出口所在 VPS 上新建远程浏览器并核对出口（约 1–2 分钟）…'; renderStatus(); }
      const r = await ipcRenderer.invoke(channel, { kind: edit.kind, profileId: edit.profileId, label: edit.value, ...exit });
      if (!r?.ok) throw Error(r?.error || '账号操作未完成');
      if (ticket !== epoch) return;
      accountEdit = null;
      notice = edit.mode === 'add' ? `已新建「${r.profile.label}」，正在打开官方授权…` : edit.mode === 'rename' ? `已改名为「${r.profile.label}」` : `已从列表移除「${r.profile.label}」，账号目录保留在本机`;
      await refresh();
      if (edit.kind === 'claude') void refreshVps();
      if (edit.kind === 'codex') void refreshCodexExits();
      if (edit.kind === 'gemini') void refreshAgyExits();
      if (edit.mode === 'add') { busy = ''; await authorize(edit.kind === 'codex' ? 'codex:' + r.profile.id : r.connection); }
    } catch (e) { if (ticket === epoch && accountEdit) editAccount({ ...accountEdit, error: e.message }); }
    finally { busy = ''; if (ticket === epoch) renderStatus(); }
  }
  // 新建 Claude 账号四步（2026-11-01）：第 ① 步就把账号和远程浏览器建好，后面三步都在这个账号上做。
  const claudeRow = id => state?.clis?.find(c => c.kind === 'claude' && (c.profileId || 'default') === id);
  // render() 把光标放进当前步骤的输入框；renderTools() 会把焦点还给刚点的按钮，名称框就打不进字。
  function setWizard(next) { wizard = next; error = ''; const top = body.scrollTop; render(); body.scrollTop = top; }
  function startWizard() {
    const rows = (state?.clis || []).filter(c => c.kind === 'claude');
    accountEdit = null; notice = '';
    setWizard({ step: 1, value: nextLabel(rows), route: '', loginEnv: 'new' });
    void refreshVps();
  }
  function resumeWizard(profileId) {
    const c = claudeRow(profileId), m = mail?.accounts?.[profileId];
    if (!c) return;
    accountEdit = null;
    setWizard({ step: !accountInfraOn() ? 4 : m?.email ? 3 : 2, profileId, connection: c.id, value: c.label || profileId, mail: { email: m?.email || (/@/.test(c.account || '') ? c.account : ''), recoveryEmail: m?.recoveryEmail || '' } });
  }
  async function createFromWizard() {
    const w = wizard;
    const withVps = accountInfraOn() && vps?.enabled !== false;
    if (!w || busy || (withVps && !w.route)) return;
    busy = 'account-edit'; notice = !withVps ? '正在新建账号…' : (w.loginEnv || 'new') === 'new' ? '正在新建账号，并在 VPS 上新建远程浏览器、核对出口（约 15–45 秒）…' : '正在新建账号并核对出口与远程浏览器…'; renderTools();
    const ticket = epoch;
    try {
      const r = await ipcRenderer.invoke('accounts:add-subscription', withVps ? { kind: 'claude', label: w.value, route: w.route, loginEnv: w.loginEnv || 'new' } : { kind: 'claude', label: w.value });
      if (!r?.ok) throw Error(r?.error || '账号未建成');
      if (ticket !== epoch || wizard !== w) return;
      wizard = { ...w, step: withVps ? 2 : 4, profileId: r.profile.id, connection: r.connection, value: r.profile.label, error: '', mail: {} };
      claudeSelected = r.profile.id; notice = withVps ? `已新建「${r.profile.label}」和它的远程浏览器` : `已新建「${r.profile.label}」`;
      await refresh(); void refreshVps(); void refreshMail();
    } catch (e) { if (ticket === epoch && wizard === w) { notice = ''; wizard = { ...w, error: e.message }; } }
    finally { busy = ''; if (ticket === epoch) renderTools(); }
  }
  async function saveWizardMail() {
    const w = wizard;
    if (!w?.profileId || busy) return;
    const v = w.mail || {};
    if (!v.email && !v.recoveryEmail && !v.password && !v.recoveryPassword) { setWizard({ ...w, step: 3 }); return; }
    busy = 'account-edit'; renderStatus();
    const ticket = epoch;
    try {
      // 备注不在这一步填：原样带回，避免保存时被清空。
      const r = await ipcRenderer.invoke('mailbox:save', { profileId: w.profileId, email: v.email || '', password: v.password || '', recoveryEmail: v.recoveryEmail || '', recoveryPassword: v.recoveryPassword || '', note: mail?.accounts?.[w.profileId]?.note || '' });
      if (!r?.ok) throw Error(r?.error || '邮箱资料未保存');
      if (ticket !== epoch || wizard !== w) return;
      notice = r.data.message; wizard = { ...w, step: 3, error: '', mail: { email: v.email, recoveryEmail: v.recoveryEmail } };
      await refreshMail();
    } catch (e) { if (ticket === epoch && wizard === w) wizard = { ...w, error: e.message }; }
    finally { busy = ''; if (ticket === epoch) renderTools(); }
  }
  function close() {
    if (page.hidden) return;
    page.hidden = true; epoch++; clearTimeout(timer);
    document.body.classList.remove('accounts-open');
    document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  async function open(provider) {
    closeOtherPanels(); configModal.close();
    epoch++; clearTimeout(timer); previousFocus = document.activeElement;
    page.hidden = false; document.body.classList.add('accounts-open');
    document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'true');
    keeperAccounts = {}; keeperReads.clear(); keeperFallback = null;
    view = 'list'; error = ''; notice = ''; render(); void refreshTokens(); void refreshVps(); void refreshMail(); void accountRisk.refresh(ipcRenderer); if (tab === 'codex') void refreshCodexExits(); if (tab === 'gemini') void refreshAgyExits(); await refresh();
    void refreshToolAccounts();
    if (provider && !page.hidden) await configure(provider);
  }
  page.addEventListener('click', e => {
    const currentMenu = e.target.closest('.ac-more');
    for (const menu of page.querySelectorAll('.ac-more[open]')) if (menu !== currentMenu) menu.open = false;
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (currentMenu) currentMenu.open = false;
    const a = b.dataset.ac, args = { site: b.dataset.site, identity: b.dataset.identity };
    if (a === 'close') close();
    else if (a === 'codex-device-copy') void deviceAction('copy');
    else if (a === 'keeper-manage') void manageInKeeper(b.dataset.kind, b.dataset.profile);
    else if (a === 'keeper-fallback') {
      if (b.dataset.kind === 'claude') void envAction('open', b.dataset.profile);
      else if (deviceLogin?.id === 'codex-' + b.dataset.profile) void deviceAction('page');
    }
    else if (a === 'codex-device-mailbox') void deviceAction('mailbox');
    else if (a === 'codex-device-page') void deviceAction('page');
    else if (a === 'back') { view = 'list'; render(); void refresh(); }
    else if (a === 'tab') selectTab(b.dataset.tab);
    else if (a === 'token-metric') { tokenMetric = b.dataset.v === 'net' ? 'net' : 'total'; renderTools(); }
    else if (a === 'token-sync') void ipcRenderer.invoke('token-usage:sync').then(next => { tokenData = next; renderTools(); }).catch(e => { error = e.message; renderStatus(); });
    else if (a === 'open') void action('open', args);
    else if (a === 'login') void action('login', args);
    else if (a === 'recover') void action('check-start', { ...args, live: true });
    else if (a === 'recheck') void action('check-start', args);
    else if (a === 'copy-logins') void action('copy-logins', args);
    else if (a === 'check-cancel') void action('check-cancel', {});
    else if (a === 'add' || a === 'preferred') void action('preference', { ...args, add: a === 'add' });
    else if (a === 'authorize') void authorize(b.dataset.id);
    else if (a === 'return-launch') { close(); resumeLaunch(); }
    else if (a === 'account-add') { editAccount({ mode: 'add', kind: b.dataset.kind, value: '', exit: b.dataset.kind === 'gemini' ? '' : 'shared' }); if (b.dataset.kind === 'codex') void refreshCodexExits(); if (b.dataset.kind === 'gemini') void refreshAgyExits(); }
    else if (a === 'codex-exit-select') { if (accountEdit?.mode === 'add' && accountEdit.kind === 'codex' && codexExits?.routes?.some(r => r.id === b.dataset.exit && r.selectable)) editAccount({ ...accountEdit, exit: b.dataset.exit }); }
    else if (a === 'codex-exit-check') void checkCodexExit(b.dataset.profile);
    else if (a === 'agy-exit-select') { if (accountEdit?.mode === 'add' && accountEdit.kind === 'gemini' && (b.dataset.exit === 'shared' || agyExits?.routes?.some(r => r.id === b.dataset.exit && r.selectable))) editAccount({ ...accountEdit, exit: b.dataset.exit }); }
    else if (a === 'agy-exit-check') void checkAgyExit(b.dataset.profile);
    else if (a === 'agy-bind-edit') { editAccount({ mode: 'agy-bind', kind: 'gemini', profileId: b.dataset.profile, exit: '' }); void refreshAgyExits(); }
    else if (a === 'agy-bind-select') { if (accountEdit?.mode === 'agy-bind') editAccount({ ...accountEdit, exit: b.dataset.exit }); }
    else if (a === 'agy-bind-save') void bindAgyExit(b.dataset.profile);
    else if (a === 'acb-select') { claudeSelected = b.dataset.profile; wizard = null; accountEdit = null; renderTools(); body.querySelector('.acb-detail')?.scrollTo?.(0, 0); }
    else if (a === 'acb-filter') { claudeFilter = !claudeFilter; renderTools(); }
    else if (a === 'acb-new') startWizard();
    else if (a === 'acb-resume') resumeWizard(b.dataset.profile);
    else if (a === 'acb-route') setWizard({ ...wizard, route: b.dataset.route, loginEnv: 'new', error: '' });
    else if (a === 'acb-create') void createFromWizard();
    else if (a === 'acb-mail-save') void saveWizardMail();
    else if (a === 'acb-skip' || a === 'acb-next') setWizard({ ...wizard, step: wizard.step + 1, error: '' });
    else if (a === 'acb-back') setWizard({ ...wizard, step: Math.max(wizard.profileId ? 2 : 1, wizard.step - 1), error: '' });
    else if (a === 'acb-cancel') { wizard = null; renderTools(); }
    else if (a === 'acb-authorize') { const id = b.dataset.id; claudeSelected = wizard?.profileId || claudeSelected; wizard = null; void authorize(id); }
    else if (a === 'env-url' && ENV_PAGES[b.dataset.page]) void envAction('open', b.dataset.profile, ENV_PAGES[b.dataset.page]);
    else if (a === 'account-rename') {
      const row = state?.clis?.find(c => c.kind === b.dataset.kind && (c.profileId || 'default') === b.dataset.profile);
      editAccount({ mode: 'rename', kind: b.dataset.kind, profileId: b.dataset.profile, value: row?.label || '' });
    }
    else if (a === 'account-remove') editAccount({ mode: 'remove', kind: b.dataset.kind, profileId: b.dataset.profile });
    else if (a === 'risk-edit') editAccount({ mode: 'risk', kind: b.dataset.kind, profileId: b.dataset.profile, ...riskFormValues(accountRisk.active(b.dataset.kind, b.dataset.profile)) });
    else if (a === 'risk-clear') void clearRisk(b.dataset.kind, b.dataset.profile);
    else if (a === 'account-cancel') editAccount(null);
    else if (a === 'env-open') void envAction('open', b.dataset.profile);
    else if (a === 'env-stop') void envAction('stop', b.dataset.profile);
    else if (a === 'env-bind') editAccount({ mode: 'bind', kind: 'claude', profileId: b.dataset.profile, loginEnv: 'new' });
    else if (a === 'account-save') void saveAccountEdit();
    else if (a === 'mail-edit') {
      const m = mail?.accounts?.[b.dataset.profile], row = state?.clis?.find(c => c.kind === 'claude' && (c.profileId || 'default') === b.dataset.profile);
      editAccount({ mode: 'mail', kind: 'claude', profileId: b.dataset.profile, mail: { email: m?.email || (/@/.test(row?.account || '') ? row.account : ''), recoveryEmail: m?.recoveryEmail || '', note: m?.note || '', password: '', recoveryPassword: '', totpSecret: '' } });
    }
    else if (a === 'mail-save') void saveMail();
    else if (a === 'mail-import') void mailAction('import', {});
    else if (a === 'exit-check') void checkExits(b.dataset.profile);
    else if (a === 'mail-copy') void mailAction('copy', { profileId: b.dataset.profile, which: b.dataset.which });
    else if (a === 'mail-open') void mailAction('open', { profileId: b.dataset.profile, which: b.dataset.which });
    else if (a === 'codex-quota') void switchCodexQuota(b.dataset.profile);
    else if (a === 'claude-quota') void switchCodexQuota(b.dataset.profile,'claude');
    else if (a === 'gemini-quota') void switchCodexQuota(b.dataset.profile,'gemini');
    else if (a === 'config') void configure(b.dataset.id);
    else if (a === 'tools') void action('tools');
    else if (a === 'external') void action('external', { service: b.dataset.service, action: b.dataset.operation });
    else if (a === 'tool-accounts-refresh') void refreshToolAccounts(true);
    else if (a === 'tools-connect') {
      const choices = Object.fromEntries(Object.entries(toolChoices).filter(([, value]) => value));
      if (!Object.keys(choices).length) { error = '请先选择工具对应的 ChatGPT 账号'; renderStatus(); }
      else void action('tools-connect', { choices });
    }
  });
  search.addEventListener('input', renderTools);
  page.addEventListener('input', e => {
    if (e.target.matches?.('[data-codex-mailbox]') && deviceLogin) deviceLogin.email = e.target.value;
    else if (e.target.dataset?.riskField && accountEdit?.mode === 'risk') accountEdit[e.target.dataset.riskField] = e.target.value;
    else if (e.target.dataset?.wizField && wizard) wizard.mail = { ...wizard.mail, [e.target.dataset.wizField]: e.target.value };
    else if (e.target.matches?.('[data-account-input]') && wizard) wizard.value = e.target.value;
    else if (e.target.dataset?.mailField && accountEdit?.mode === 'mail') accountEdit.mail = { ...accountEdit.mail, [e.target.dataset.mailField]: e.target.value };
    else if (e.target.matches?.('[data-account-input]') && accountEdit) accountEdit.value = e.target.value;
  });
  page.addEventListener('keydown', e => {
    if (!e.target.matches?.('[data-account-input],[data-mail-field]') || e.isComposing) return;
    if (wizard) { if (e.key === 'Enter') e.preventDefault(); return; }
    if (e.key === 'Enter') { e.preventDefault(); void (accountEdit?.mode === 'mail' ? saveMail() : saveAccountEdit()); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editAccount(null); }
  }, true);
  tabs.addEventListener('keydown', e => { const i = TABS.findIndex(t => t.id === tab); const next = ({ArrowDown: (i+1)%TABS.length, ArrowUp: (i+TABS.length-1)%TABS.length, ArrowRight: (i+1)%TABS.length, ArrowLeft: (i+TABS.length-1)%TABS.length, Home: 0, End: TABS.length-1})[e.key]; if (next !== undefined) { e.preventDefault(); selectTab(TABS[next].id); } });
  page.addEventListener('change', e => {
    if (e.target.dataset.toolChoice) toolChoices[e.target.dataset.toolChoice] = e.target.value;
    // Another exit lists other free environments, so the choice starts over at「新建」.
    if (e.target.matches?.('[data-account-route]') && accountEdit) { accountEdit = { ...accountEdit, route: e.target.value, loginEnv: 'new' }; renderTools(); }
    if (e.target.matches?.('[data-account-env]') && wizard) wizard.loginEnv = e.target.value;
    else if (e.target.matches?.('[data-account-env]') && accountEdit) accountEdit.loginEnv = e.target.value;
  });
  document.addEventListener('click', e => {
    if (e.target.closest('#btn-rail-accounts')) { if (page.hidden) void open(); else close(); }
    else if (e.target.closest('#scene-rail button') && !page.hidden) close();
    if (e.target.closest('#btn-config-accounts')) void open();
  });
  document.addEventListener('keydown', e => {
    if (page.hidden || view !== 'list' || e.isComposing || e.repeat) return;
    if (e.key === 'Escape' && !page.querySelector('dialog[open]')) { e.preventDefault(); const expanded = page.querySelector('details[open]'); if (expanded) expanded.open = false; else close(); return; }
    if (tab !== 'ai' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || busy || e.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    const n = Number(e.key), card = state && companyCards(state)[n - 1];
    if (card && n >= 1 && n <= 7) { e.preventDefault(); void action('open', { site: card.site }); }
  });
  document.addEventListener('hub-account-config-saved', () => { notice = '接入配置已保存。'; void refresh(); });
  ipcRenderer.on('codex-global-account-changed',()=>{if(!page.hidden)void refresh();});
  ipcRenderer.on('subscription-accounts-changed',()=>{if(!page.hidden)void refresh();});
  ipcRenderer.on('antigravity-launch-account-changed',()=>{if(!page.hidden)void refresh();});
  ipcRenderer.on('hub-accounts:attention', (_event, n) => setBadge(n));
  void ipcRenderer.invoke('hub-accounts:attention').then(r => { if (r?.ok) setBadge(r.data); }).catch(() => {});
  ipcRenderer.on('launch-auth-status',async(_event,result)=>{
    if (deviceLogin?.id === result?.id && !result.required) deviceLogin = null;
    if (result?.required) {
      authTarget = result.id?.startsWith('codex-') ? result.id.replace('codex-', 'codex:') : result.id === 'gemini-cli' ? 'gemini' : result.id;
      // 只在右侧额度栏那张号卡上写「需重新登录」，并弹一条提示；账号页已经开着时才定位到授权按钮。
      if (page.hidden) { notify(result.message); return; }
      returnToLaunch = result.source === 'launch' && hasLaunchDraft(); tab = 'platform'; search.value = '';
      notice = result.message; render();
      const target = [...body.querySelectorAll('[data-ac="authorize"]')].find(b => b.dataset.id === authTarget);
      target?.scrollIntoView({block:'center'}); target?.focus({preventScroll:true});
    } else if(!page.hidden){notice=result?.message || '';void refresh();}
    else if(result?.success&&result.message)notify(result.message);
  });
  ipcRenderer.on('session-created',(_event,{session})=>{if(session.kind!=='powershell'){returnToLaunch=false;authTarget='';}});
  window.addEventListener('launch-center:session-opened',event=>{if(!event.detail?.preserveDraft){returnToLaunch=false;authTarget='';}});
  window.addEventListener('resize', position);
  window.addEventListener('focus', () => {
    if (!page.hidden && !busy) for (const b of page.querySelectorAll('[data-ac=keeper-manage]')) void refreshKeeperAccount(b.dataset.kind, b.dataset.profile, true);
  });
  return { open, close, refresh };
}
module.exports = { createAccountCenterPanel };
