'use strict';
const { companyCards, cliChip } = require('./account-center-view');
const accountRisk = require('./account-risk-state');
const { formatTokens } = require('./account-token-view');
// 2026-11-08 分区工作台：按使用频次排，Token 开销第一；低频的平台登录收进「平台与授权」。
const TABS = [{ id: 'token', name: 'Token 开销' }, { id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }, { id: 'gemini', name: 'Antigravity' }, { id: 'other', name: '其他 AI' }, { id: 'ai', name: '网页登录' }, { id: 'platform', name: '平台与授权' }];
const PLATFORM_GROUPS = [{ id: 'work', name: '工作平台' }, { id: 'content', name: '内容平台' }, { id: 'cli', name: '命令行授权' }];
const GROUP = { github: 'work', social: 'content', mediaPublish: 'content' };
const NATIVE = { signed_in: ['已登录', 'ok'], signed_out: ['未登录', 'warn'], unknown: ['登录状态未确认', 'idle'] };
const BINDING = { shared: '共享专属 Chrome', bound: '已连接', changed: '连接配置已变化', pending: '尚未共享登录', native: '独立授权', host: '客户端授权' };
const LOGOS = { chatgpt: 'codex', claude: 'claude', google: 'gemini', deepseek: 'deepseek', kimi: 'kimi', qwen: 'qwen' };
function brandIcon(card, esc, row = false) {
  const logo = LOGOS[card.site];
  return `<span class="ac-company-mark${row ? ' ac-product-mark' : ''}" style="--ac-mark:${card.color}" aria-hidden="true">${logo ? `<img src="assets/ai-logos/${logo}.svg" alt="">` : esc(card.mark)}</span>`;
}
function relativeTime(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时前';
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function usage(activity, now) {
  if (!activity) return { text: '尚无访问或工具使用记录', tone: 'idle', login: false };
  const labels = { opened: '打开过网页', visited: '访问过网页', success: activity.source === 'images' ? '生图成功' : '使用成功', using: '发起过生图',
    login_required: '需要登录', verification_required: '需要验证', rate_limited: '服务限流', quota_exhausted: '额度用完', network_error: '网络连接失败', adapter_changed: '网页适配需更新', failed: '上次使用未完成' };
  const unresolved = activity.issue?.outcome;
  return { text: (relativeTime(activity.at, now) + ' · ' + (labels[activity.outcome] || '使用过')).trim(),
    tone: unresolved ? 'warn' : activity.outcome === 'success' ? 'ok' : ['failed', 'login_required', 'verification_required', 'rate_limited', 'quota_exhausted', 'network_error', 'adapter_changed'].includes(activity.outcome) ? 'warn' : 'idle',
    login: !!unresolved || ['login_required', 'verification_required'].includes(activity.outcome),
    // A check is passed in a clean window (a handoff when the site is paused), not by signing in again.
    verify: (unresolved || activity.outcome) === 'verification_required',
    note: unresolved && unresolved !== activity.outcome ? '最近调用' + labels[unresolved] : activity.lastSuccessAt && activity.outcome !== 'success' ? '上次成功：' + relativeTime(activity.lastSuccessAt, now) : '',
    title: ({ images: '生图 MCP', roundtable: '网页圆桌', website: '网页入口', history: '专属 Chrome 访问记录；不代表当前仍已登录' }[activity.source] || '使用记录') + ' · ' + new Date(activity.at).toLocaleString('zh-CN') };
}
// Which tools use this login and how their last step went (hub-account-activity.js sources).
const TOOL_NAMES = { images: '生图', bridge: '中转', roundtable: '圆桌' };
const TOOL_OUTCOMES = { success: '正常', verification_required: '需验证', login_required: '需登录', rate_limited: '限流', quota_exhausted:'额度用完', network_error:'网络失败', adapter_changed:'适配需更新', failed: '未完成', using: '进行中' };
function toolsNote(entry, now = Date.now()) {
  return Object.entries(entry?.sources || {}).filter(([source]) => TOOL_NAMES[source]).sort((a, b) => b[1].at - a[1].at)
    .map(([source, v]) => TOOL_NAMES[source] + ' ' + relativeTime(v.at, now) + (TOOL_OUTCOMES[v.outcome] || '')).join(' · ');
}
const toolsHtmlLine = (note, esc) => note ? `<small class="ac-tools" title="使用这个账号的网页工具及其最近一次结果">${esc(note)}</small>` : '';
const matches = (values, query) => !query || values.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
function authLabel(state) {
  return ({signed_in:'已授权，CLI 已确认',authorized:'已有授权记录',missing:'尚未授权',expired:'需要重新授权',unreadable:'授权记录不可读',invalid:'凭据格式错误，需重新授权',api_key:'使用 API Key'})[state] || '授权待确认';
}
function authorizeButton(c, esc) {
  return `<button class="ac-text-btn" data-ac="authorize" data-id="${esc(c.id)}">${['authorized','signed_in','expired'].includes(c.state)?'重新授权':'授权'} ↗</button>`;
}
// Add / rename / remove for Claude and Codex accounts (2026-10-27). `edit` is the
// one inline form the account panel has open: {mode:'add'|'rename'|'remove', kind, profileId, value, error}.
// 2026-11-17：Antigravity（gemini）同样能新建、改名、移除；它的内置我的账号/账号 2也能从列表移除（只隐藏）。
const EDITABLE = new Set(['claude', 'codex', 'gemini']);
const KIND_PLACEHOLDER = { claude: '如：Claude 账号6', codex: '如：Codex 账号3', gemini: '如：Antigravity 账号3' };
const BUILT_IN_ACCOUNTS = new Set(['default', 'second']);
function accountFormHtml(edit, esc, label = '', vps = null) {
  if (edit.mode === 'remove') {
    return `<div class="ac-account-form" role="group" aria-label="移除账号"><p>${esc(`从列表移除「${label}」？账号目录、登录和历史都留在本机，也不会退出登录。`)}</p>${edit.error ? `<p class="ac-item-error" role="alert">${esc(edit.error)}</p>` : ''}<div class="ac-row-actions"><button class="ac-open" data-ac="account-save">确认移除</button><button class="ac-text-btn" data-ac="account-cancel">取消</button></div></div>`;
  }
  const title = edit.mode === 'add' ? ((edit.kind === 'codex' || edit.kind === 'gemini') && vps && vps.enabled !== false ? '名称与出口' : '新账号名称') : '账号名称';
  return `<div class="ac-account-form" role="group" aria-label="${title}"><label><span>${title}</span><input class="ac-account-input" data-account-input maxlength="40" spellcheck="false" placeholder="${KIND_PLACEHOLDER[edit.kind] || ''}" value="${esc(edit.value || '')}"></label>${edit.mode === 'add' ? newClaudeExitHtml(edit, vps, esc) : ''}${edit.error ? `<p class="ac-item-error" role="alert">${esc(edit.error)}</p>` : ''}<div class="ac-row-actions"><button class="ac-open" data-ac="account-save">${edit.mode === 'add' ? '新建并去授权' : '保存名称'}</button><button class="ac-text-btn" data-ac="account-cancel">取消</button></div>${edit.mode === 'add' ? '<p class="ac-tool-help">会在本机新建一个独立的账号目录，接着打开官方授权页' + (edit.kind === 'codex' ? '（用这个账号专属的浏览器身份，不和其他账号混用登录）' : edit.kind === 'gemini' ? '：在弹出的官方登录窗口点开 Google 链接，选要用的账号，把网页给出的授权码粘回窗口回车' : '') + '。</p>' : ''}</div>`;
}
const ENV_STATE = { active: '运行中', activating: '正在启动', deactivating: '正在关闭', reloading: '正在启动', failed: '上次启动失败' };
function freeEnvs(vps, ip) { return (vps?.envs || []).filter(e => e.ip === ip && !e.boundTo && e.ready); }
function envOptionsHtml(vps, ip, chosen, esc) {
  return `<option value="new" ${chosen === 'new' ? 'selected' : ''}>新建登录环境</option>` + freeEnvs(vps, ip)
    .map(e => `<option value="${esc(e.id)}" ${chosen === e.id ? 'selected' : ''}>${esc('沿用「' + e.name + '」' + (e.email ? '（' + e.email + '）' : ''))}</option>`).join('');
}
// legacyRemote preserves the old button markup until migration step 3.
function loginEnvHtml(c, vps, esc, edit, legacyRemote = false) {
  if (!vps || vps.enabled === false) return '';
  if (vps.loading) return '<p class="ac-login-env">登录环境：正在读取 VPS…</p>';
  if (vps.error) return `<p class="ac-login-env ac-item-error">${esc('登录环境：读取失败，' + vps.error)}</p>`;
  const id = c.profileId || 'default', row = (vps.accounts || []).find(a => a.profileId === id);
  if (!row) return '';
  const exit = row.runIp ? '出口 ' + row.runIp : '出口未记录';
  if (edit && edit.mode === 'bind' && edit.profileId === id) {
    return `<div class="ac-account-form" role="group" aria-label="绑定登录环境"><label><span>登录环境</span><select data-account-env>${envOptionsHtml(vps, row.runIp, edit.loginEnv || 'new', esc)}</select></label><p class="ac-tool-help">${esc('只列出出口同为 ' + row.runIp + ' 的环境；绑定后网页登录、官方授权和日常使用都走这个 IP，之后不在这里更换。')}</p>${edit.error ? `<p class="ac-item-error" role="alert">${esc(edit.error)}</p>` : ''}<div class="ac-row-actions"><button class="ac-open" data-ac="account-save">确认绑定</button><button class="ac-text-btn" data-ac="account-cancel">取消</button></div></div>`;
  }
  if (!row.envId) return `<p class="ac-login-env">${esc(exit + ' · 还没有登录环境')}<button class="ac-text-btn" data-ac="env-bind" data-profile="${esc(id)}">绑定登录环境</button></p>`;
  if (!row.consistent) return `<p class="ac-login-env ac-item-error" role="alert">${esc(exit + ' · ' + row.problem + '，已停用登录窗口')}</p>`;
  if (!legacyRemote) return `<p class="ac-login-env"><span class="ac-env-ok" aria-hidden="true"></span>${esc(exit + ' · 登录环境「' + row.envName + '」与运行出口一致')}</p>`;
  const running = ['active', 'activating', 'reloading'].includes(row.envState);
  return `<p class="ac-login-env"><span class="ac-env-ok" aria-hidden="true"></span>${esc(exit + ' · 登录环境「' + row.envName + '」与运行出口一致 · ' + (ENV_STATE[row.envState] || '未运行'))}<button class="ac-text-btn" data-ac="env-open" data-profile="${esc(id)}">打开登录窗口 ↗</button>${running ? `<button class="ac-text-btn" data-ac="env-stop" data-profile="${esc(id)}">关闭</button>` : ''}</p>`;
}
// Claude 账号邮箱保管（2026-10-30）：界面只知道「存没存密码」；打开邮箱走该账号的登录环境（同一出口）。
const MAIL_KIND = { outlook: 'Outlook', gmail: 'Gmail', mailcom: 'mail.com', onet: 'Onet', other: '其他邮箱' };
function mailFieldHtml(name, label, value, esc, { type = 'text', placeholder = '' } = {}) {
  return `<label><span>${label}</span><input class="ac-account-input" data-mail-field="${name}" type="${type}" autocomplete="off" spellcheck="false" maxlength="${name === 'note' ? 300 : 254}" placeholder="${esc(placeholder)}" value="${esc(value || '')}"></label>`;
}
function mailboxHtml(c, mail, esc, edit, legacyRemote = false) {
  if (!mail) return '';
  if (mail.error) return `<p class="ac-mailbox ac-item-error">${esc('邮箱资料读取失败：' + mail.error)}</p>`;
  const id = c.profileId || 'default', m = mail.accounts?.[id];
  if (edit && edit.mode === 'mail' && edit.profileId === id) {
    const v = edit.mail || {};
    return `<div class="ac-account-form ac-mail-form" role="group" aria-label="邮箱资料">${mailFieldHtml('email', '登录邮箱', v.email, esc, { placeholder: 'Outlook / Gmail 地址' })}${mailFieldHtml('password', '邮箱密码', v.password, esc, { type: 'password', placeholder: m?.hasPassword ? '已保存，留空不改' : '可不填' })}${mailFieldHtml('recoveryEmail', '辅助邮箱', v.recoveryEmail, esc, { placeholder: '可不填' })}${mailFieldHtml('recoveryPassword', '辅助邮箱密码', v.recoveryPassword, esc, { type: 'password', placeholder: m?.hasRecoveryPassword ? '已保存，留空不改' : '可不填' })}${mailFieldHtml('totpSecret', '2FA 密钥', v.totpSecret, esc, { type: 'password', placeholder: m?.hasTotp ? '已保存，留空不改' : '可不填；填了能一键复制 6 位验证码' })}${mailFieldHtml('note', '备注', v.note, esc, { placeholder: '备注' })}<p class="ac-tool-help">密码用 Windows 账户加密存在本机，界面和 AI 都看不到明文；只在你点「复制密码」时放进剪贴板，45 秒后自动清除。</p>${edit.error ? `<p class="ac-item-error" role="alert">${esc(edit.error)}</p>` : ''}<div class="ac-row-actions"><button class="ac-open" data-ac="mail-save">保存</button><button class="ac-text-btn" data-ac="account-cancel">取消</button></div></div>`;
  }
  const edit_ = `<button class="ac-text-btn" data-ac="mail-edit" data-profile="${esc(id)}">${m ? '编辑' : '登记邮箱'}</button>`;
  if (!m) return `<p class="ac-mailbox"><span class="ac-mail-label">邮箱</span>${esc('未登记，密码和辅助邮箱可以存在这里')}${edit_}</p>`;
  const part = (email, kind, canOpen, hasPassword, which) => email ? `<span class="ac-mail-item">${esc(email + (kind ? '（' + (MAIL_KIND[kind] || kind) + '）' : ''))}${legacyRemote && canOpen ? `<button class="ac-text-btn" data-ac="mail-open" data-profile="${esc(id)}" data-which="${which}">打开邮箱 ↗</button>` : ''}${hasPassword ? `<button class="ac-text-btn" data-ac="mail-copy" data-profile="${esc(id)}" data-which="${which}">复制密码</button>` : '<small>未存密码</small>'}</span>` : '';
  return `<p class="ac-mailbox"><span class="ac-mail-label">邮箱</span>${part(m.email, m.provider, m.canOpen, m.hasPassword, 'main') || '<span class="ac-mail-item">未填登录邮箱</span>'}${m.hasTotp ? `<button class="ac-text-btn" data-ac="mail-copy" data-profile="${esc(id)}" data-which="totp">复制 2FA 码</button>` : ''}${m.recoveryEmail ? '<span class="ac-mail-label">辅助</span>' + part(m.recoveryEmail, m.recoveryProvider, m.canOpenRecovery, m.hasRecoveryPassword, 'recovery') : ''}${m.note ? `<span class="ac-mail-note">${esc(m.note)}</span>` : ''}${edit_}</p>`;
}
// 2026-11-21：Antigravity 专线。新建时选出口；「本机代理」= 沿用 Hub 全局代理（旧做法）。
// 2026-11-25：多条专线可选；Google 登录和授权都在本机专用浏览器里完成，浏览器只走这个账号的专线。
function agyRoutesHtml(data, chosen, esc, action, withShared = true) {
  const routes = [...(withShared ? [{ id: 'shared', name: '本机代理（不走专线）', selectable: true, note: '沿用 Hub 全局代理，Google 登录在本机浏览器' }] : []),
    ...(data?.routes || []).map(r => ({ ...r, note: r.ip + ' · ' + (r.vpsName || r.vps || '') + ' · 已有 ' + r.agyCount + ' 个 Antigravity 账号' }))];
  return `<div class="acb-routes acb-keeper-routes" role="radiogroup" aria-label="Antigravity 出口">${routes.map(r => `<button type="button" class="acb-route acb-keeper-route" role="radio" aria-checked="${r.id === chosen}" data-ac="${action}" data-exit="${esc(r.id)}" ${r.selectable ? '' : 'disabled'}><b>${esc(r.name || r.id)}${r.id !== 'shared' ? ' <span class="acb-tag use">推荐</span>' : ''}</b><span>${esc(r.selectable ? r.note : '管家未在线或出口未接通')}</span></button>`).join('')}</div>`;
}
function newAgyExitHtml(edit, data, esc) {
  if (!data || data.enabled === false) return '';
  if (!data.routes) return '<p class="ac-tool-help">正在读取可用专线…</p>';
  const chosen = edit.exit || (data.routes.find(r => r.selectable)?.id || 'shared');
  return `<p class="ac-tool-help">选专线后，Google 登录和授权在本机的专用浏览器里完成，那个浏览器只走这条专线；日常使用也是同一个 IP。授权前可以改选，授权后锁定。</p>${data.error ? `<p class="ac-item-error">${esc(data.error)}</p>` : ''}${agyRoutesHtml(data, chosen, esc, 'agy-exit-select')}`;
}
function agyExitHtml(c, data, esc, edit) {
  if (!data || data.enabled === false) return '';
  const id = c.profileId || 'default', b = data.bindings?.[id];
  if (id === 'default') return '<p class="ac-tool-help">我的账号用系统钥匙串登录，不能绑定专线；要走专线请新建一个 Antigravity 账号。</p>';
  if (edit?.mode === 'agy-bind' && edit.profileId === id && !(b && b.authorized)) {
    const chosen = edit.exit || b?.exit || data.routes?.find(r => r.selectable)?.id || '';
    return `<section class="ac-codex-exit ac-account-form" aria-label="选择专线"><strong>${b ? '改选专线' : '绑定专线'}</strong><p class="ac-tool-help">${esc('Google 登录和授权在本机专用浏览器里完成，浏览器只走选中的专线。授权前可以改选，授权后锁定。')}</p>${edit.error ? `<p class="ac-item-error" role="alert">${esc(edit.error)}</p>` : ''}${agyRoutesHtml({ routes: (data.routes || []) }, chosen, esc, 'agy-bind-select', false)}<div class="ac-row-actions"><button class="ac-open" data-ac="agy-bind-save" data-profile="${esc(id)}" ${chosen && chosen !== b?.exit ? '' : 'disabled'}>保存专线</button><button class="ac-text-btn" data-ac="account-cancel">取消</button></div></section>`;
  }
  if (b) {
    const result = data.checks?.[id];
    const check = result ? `<span class="ac-keeper-check ${result.check?.status === 'ok' ? 'acb-ok' : 'acb-faint'}">${esc(result.error ? '检查失败：' + result.error : '专线检查 · 出口 ' + result.check.ip + ' · 正常')}</span>` : '<span class="ac-keeper-check acb-faint">尚未检查</span>';
    const auth = b.lastAuth ? '上次授权 ' + new Date(b.lastAuth.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + (b.lastAuth.via || '本机浏览器') + ' · 出口 ' + b.lastAuth.ip
      : b.authorized ? '已授权（授权记录早于本版）' : '尚未授权';
    const lock = b.authorized ? '已授权，专线锁定' : '尚未授权，可改选专线';
    return `<section class="ac-codex-exit" aria-label="专线与本机专用浏览器"><strong>专线与本机专用浏览器</strong><p>${esc(b.ip + ' · ' + b.name + (b.vpsName ? ' · 所在 VPS：' + b.vpsName : ''))}</p><p>${esc(lock + ' · 本机经 ' + b.proxy.replace('http://', '') + ' 出去')}</p><p>${esc(auth)}</p><p>${check} <button class="ac-text-btn" data-ac="agy-exit-check" data-profile="${esc(id)}" ${data.checking ? 'disabled' : ''}>${data.checking === id ? '检查中…' : '检查专线'}</button>${b.authorized ? '' : ` <button class="ac-text-btn" data-ac="agy-bind-edit" data-profile="${esc(id)}">改选专线</button>`}</p><p class="ac-tool-help">${esc('授权：点「授权」拿链接，在你自己的 Chrome 资料里打开（这个资料先装好本专线扩展，整份资料都走 ' + b.ip + '），再把授权码粘回。')} <button class="ac-text-btn" data-ac="agy-chrome-ext" data-profile="${esc(id)}">生成 Chrome 专线扩展</button> <button class="ac-text-btn" data-ac="agy-dedicated-login" data-profile="${esc(id)}">改用专用浏览器授权</button></p></section>`;
  }
  return `<p class="ac-tool-help">${esc('未走专线：现在经 Hub 全局代理出去，Google 登录在本机浏览器。')}<button class="ac-text-btn" data-ac="agy-bind-edit" data-profile="${esc(id)}">绑定专线</button></p>`;
}
function newClaudeExitHtml(edit, vps, esc) {
  if (edit.kind === 'codex') return newCodexExitHtml(edit, vps, esc);
  if (edit.kind === 'gemini') return newAgyExitHtml(edit, vps, esc);
  if (edit.kind !== 'claude' || !vps || vps.enabled === false) return '';
  if (vps.loading || vps.error) return `<p class="ac-tool-help">${esc(vps.error ? '登录环境读取失败：' + vps.error + '；可刷新后再建' : '正在读取可用出口…')}</p>`;
  const routes = (vps.routes || []).filter(r => r.runnable), route = routes.find(r => r.id === edit.route) || routes[0];
  if (!route) return '';
  return `<label><span>出口</span><select data-account-route>${routes.map(r => `<option value="${esc(r.id)}" ${r.id === route.id ? 'selected' : ''}>${esc((r.shared ? '共享出口' : r.name) + ' · ' + r.ip)}</option>`).join('')}</select></label><label><span>登录环境</span><select data-account-env>${envOptionsHtml(vps, route.ip, edit.loginEnv || 'new', esc)}</select></label><p class="ac-tool-help">${esc('出口建好后不再更换：这个账号的网页登录、官方授权和日常 Claude 都走 ' + route.ip + '。')}</p>`;
}
function newCodexExitHtml(edit, data, esc) {
  if (!data || data.enabled === false) return '';
  const routes = data.routes?.length ? data.routes : [{ id: 'shared', name: '共享出口', shared: true, selectable: true }];
  const chosen = edit.exit || 'shared';
  return `<p class="ac-tool-help">出口建好后不再更换；Codex 不受 Claude 每出口 4 个账号的上限约束。</p>${data.error ? `<p class="ac-item-error">${esc(data.error)}</p>` : ''}<div class="acb-routes acb-keeper-routes" role="radiogroup" aria-label="Codex 出口">${routes.map(r => `<button type="button" class="acb-route acb-keeper-route" role="radio" aria-checked="${r.id === chosen}" data-ac="codex-exit-select" data-exit="${esc(r.id)}" ${r.selectable ? '' : 'disabled'}><b>${esc(r.name || r.id)}${r.fresh ? ' <span class="acb-tag use">新机 · 推荐</span>' : ''}</b><span>${esc(r.ip || 'IP 暂未记录')}</span><span>${esc(r.vpsName || r.vps || '所在 VPS 未记录')} · ${esc(r.codexCount ?? 0)} 个 Codex 账号</span><span>${keeperCheckHtml(r.check, data.keeper, esc)}</span>${!r.selectable ? `<span>${esc(r.unavailable || '专属出口尚未接通')}</span>` : ''}</button>`).join('')}</div><p class="ac-tool-help">${chosen === 'shared' ? '登录浏览器：本机 Chrome · 接入时新建独立资料 · 使用共享出口代理。' : '登录浏览器：出口所在 VPS 的独立远程浏览器 · 邮箱登录 · 设备码授权。'}${data.keeper?.source === 'snapshot' ? '当前显示管家快照。' : data.keeper?.source === 'none' ? '管家未运行；共享出口沿用 Hub 当前代理设置。' : ''}</p>`;
}
function codexExitHtml(c, data, esc) {
  if (!data || data.enabled === false) return '';
  const id = c.exit || 'shared', route = data.routes?.find(r => r.id === id);
  const result = data.keeper?.source === 'snapshot' ? null : data.checks?.[id];
  const name = route?.name || (id === 'shared' ? '共享出口' : id);
  const browser = id !== 'shared' ? `VPS 远程浏览器 · ${c.loginEnv || '尚未绑定'}` : c.browserIdentity ? `本机 Chrome · 独立资料 ${c.browserIdentity}` : '接入时新建，现在用的是本机默认资料';
  return `<section class="ac-codex-exit" aria-label="出口与浏览器"><strong>出口与浏览器</strong><p>${esc((route?.ip || 'IP 暂未记录') + ' · ' + name + ' · 所在 VPS：' + (route?.vpsName || route?.vps || '未记录'))}</p><p>已锁定，IP 不会变${id === 'shared' ? ' <small>（账号绑定不变，共享代理沿用 Hub 设置）</small>' : ''}</p><p>${keeperCheckHtml(result?.check || route?.check, result || data.keeper, esc)} <button class="ac-text-btn" data-ac="codex-exit-check" data-profile="${esc(c.profileId || 'default')}" ${data.checking ? 'disabled' : ''}>${data.checking === (c.profileId || 'default') ? '正在检测…' : '检测出口'}</button></p><p>${esc('登录浏览器：' + browser + ' · 挂' + name + '的代理')}</p>${id !== 'shared' ? '<p>在远程浏览器用邮箱登录，输入设备码完成授权；日常会话启动前核对出口。</p>' : ''}${data.error ? `<p class="ac-item-error" role="alert">${esc(data.error)}</p>` : ''}</section>`;
}
// 账号风控标记（2026-10-31）：观察期内整行醒目提示；结束后留一行灰字记录。
const RISK_DAYS = [[7, '7 天'], [14, '14 天'], [30, '30 天'], [0, '一直到手动解除']];
const DEFAULT_RISK_DAYS = 14;
function fullTime(at) {
  const d = new Date(at), pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dateTimeLocal(at) {
  const d = new Date(at), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function riskFormValues(flag, now = Date.now()) {
  const span = flag?.until == null ? 0 : Math.round((flag.until - flag.flaggedAt) / 86400000);
  return { value: flag ? flag.note : '被提示登出', at: dateTimeLocal(flag ? flag.flaggedAt : now),
    days: !flag ? DEFAULT_RISK_DAYS : RISK_DAYS.some(([days]) => days === span) ? span : DEFAULT_RISK_DAYS };
}
function riskHtml(kind, c, esc, edit, now = Date.now()) {
  const id = c.profileId || 'default', attrs = `data-kind="${kind}" data-profile="${esc(id)}"`;
  if (edit && edit.mode === 'risk' && edit.kind === kind && edit.profileId === id) {
    return `<div class="ac-account-form ac-risk-form" role="group" aria-label="标记风控"><label><span>发生时间</span><input type="datetime-local" class="ac-account-input" data-risk-field="at" value="${esc(edit.at || '')}"></label><label><span>观察期</span><select data-risk-field="days">${RISK_DAYS.map(([days, name]) => `<option value="${days}" ${Number(edit.days) === days ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label><span>情况说明</span><input class="ac-account-input" data-account-input maxlength="200" spellcheck="false" placeholder="如：被提示登出" value="${esc(edit.value || '')}"></label><p class="ac-tool-help">观察期内这个账号仍可手动使用，但不再被推荐，自动换号也会跳过它；账号标签和启动中心都会显示提醒。</p>${edit.error ? `<p class="ac-item-error" role="alert">${esc(edit.error)}</p>` : ''}<div class="ac-row-actions"><button class="ac-open" data-ac="account-save">保存标记</button><button class="ac-text-btn" data-ac="account-cancel">取消</button></div></div>`;
  }
  const active = accountRisk.active(kind, id, now);
  if (active) {
    const left = active.until == null ? '一直到手动解除' : `到 ${fullTime(active.until)}（还剩 ${Math.ceil((active.until - now) / 86400000)} 天）`;
    const asDefault = c.isDefault ? ' · 它还是后续新建会话的账号，建议改用其他账号' : '';
    return `<p class="ac-risk is-active" role="status"><strong>⚠ 风控观察中</strong>${esc(` · ${fullTime(active.flaggedAt)} 发生 · ${left}${active.note ? ' · ' + active.note : ''} · 不推荐使用，自动换号会跳过${asDefault}`)}<button class="ac-text-btn" data-ac="risk-edit" ${attrs}>修改</button><button class="ac-text-btn" data-ac="risk-clear" ${attrs}>解除标记</button></p>`;
  }
  const last = accountRisk.entry(kind, id)?.last;
  return last ? `<p class="ac-risk">${esc(`上次风控：${fullTime(last.flaggedAt)}${last.note ? ' · ' + last.note : ''} · ${fullTime(last.endedAt)} 结束`)}</p>` : '';
}
function accountMenuHtml(kind, c, esc) {
  const id = c.profileId || 'default';
  const riskItem = accountRisk.active(kind, id) ? '' : `<button data-ac="risk-edit" data-kind="${kind}" data-profile="${esc(id)}">标记风控</button>`;
  if (!EDITABLE.has(kind)) return riskItem ? `<details class="ac-more" data-details="account-${kind}-${esc(id)}"><summary aria-label="${esc(c.label || id)} 更多操作">···</summary><div>${riskItem}</div></details>` : '';
  const remove = BUILT_IN_ACCOUNTS.has(id) && kind !== 'gemini' ? '' : c.isDefault
    ? '<button disabled title="当前用量账号不能移除，请先切到别的账号">移除账号</button>'
    : `<button data-ac="account-remove" data-kind="${kind}" data-profile="${esc(id)}">移除账号</button>`;
  return `<details class="ac-more" data-details="account-${kind}-${esc(id)}"><summary aria-label="${esc(c.label || id)} 更多操作">···</summary><div>${riskItem}<button data-ac="account-rename" data-kind="${kind}" data-profile="${esc(id)}">改名</button>${remove}</div></details>`;
}
const EXIT_STATE = { ok: '连通', mismatch: '出口 IP 不符', unreachable: '连不上', unwired: '本机未接通' };
function keeperTime(at) {
  const date = new Date(at);
  return at && Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '未知时间';
}
function keeperBadgeHtml(vps, esc) {
  if (!vps?.keeper || vps.enabled === false) return '';
  const { source, at } = vps.keeper;
  const text = source === 'api' ? `管家在线 · ${(vps.routes || []).filter(r => r.check?.status === 'ok').length} 条出口正常`
    : source === 'snapshot' ? `管家未运行 · 显示 ${keeperTime(at)} 的快照` : '管家未运行 · 使用原有出口信息';
  return `<span class="ac-keeper ${source === 'api' ? 'online' : 'offline'}" role="status">${esc(text)}</span>`;
}
function keeperCheckHtml(check, keeper, esc) {
  const ok = check?.status === 'ok';
  const status = ok ? '正常' : check?.reason || (check?.status ? '异常：' + check.status : '尚未检查');
  const seconds = Number.isFinite(check?.seconds) ? ` · 请求耗时 ${check.seconds.toFixed(2)} 秒` : '';
  const origin = keeper?.source === 'snapshot' ? `快照 ${keeperTime(keeper.at)} · ` : '管家检查 · ';
  return `<span class="ac-keeper-check ${ok ? 'acb-ok' : 'acb-faint'}" data-keeper-check="${esc(check?.status || 'unknown')}">${esc(origin + status + seconds)}</span>${check?.at ? `<span class="ac-keeper-at"> · ${esc(new Date(check.at).toLocaleString('zh-CN'))}</span>` : ''}`;
}
function exitCheckHtml(exits, vps, esc) {
  if (!exits) return '';
  if (exits.loading) return '<p class="ac-tool-help ac-exit-check" role="status">正在检查出口，等待检查结果…</p>';
  if (exits.error) return `<p class="ac-item-error ac-exit-check" role="alert">${esc('出口检查未完成：' + exits.error)}</p>`;
  const name = e => e.shared ? '共享出口' : ((vps?.routes || []).find(r => r.ip === e.expected)?.name || '专用出口');
  const rows = exits.list.map(e => `<tr data-exit-state="${esc(e.state)}"><td>${esc(name(e))}</td><td>${esc(e.ip || e.expected || '—')}</td><td class="ac-exit-${e.state === 'ok' ? 'ok' : 'bad'}">${esc(EXIT_STATE[e.state] || e.state)}${e.state === 'mismatch' ? esc('（应为 ' + e.expected + '）') : ''}${e.failed ? esc(' · 失败 ' + e.failed + ' 次') : ''}</td><td>${e.median == null ? '—' : esc((e.median / 1000).toFixed(2) + ' 秒')}</td><td>${esc(e.accounts.length + ' 个账号')}</td></tr>`).join('');
  const method = exits.list.some(e => e.source === 'keeper') ? '；管家结果为经出口访问 api.ipify.org 的请求耗时；回退本机检查为 3 次请求中位数。' : '；延迟为经该出口完整请求一次的耗时（3 次中位数，含建隧道与加密握手），走的就是 Claude 实际使用的本机通道。';
  return `<div class="ac-exit-check" role="region" aria-label="出口检查结果"><table><thead><tr><th>出口</th><th>出口 IP</th><th>状态</th><th>延迟</th><th>使用</th></tr></thead><tbody>${rows}</tbody></table><p class="ac-tool-help">${esc('检查时间 ' + new Date(exits.at).toLocaleTimeString() + method)}</p></div>`;
}

// Claude 有自己的页签（2026-11-01 B 方案，account-claude-view.js）；AI 网页页签只传 codex、gemini。
function codexQuotaHtml(state, esc, edit = null, vps = null, mail = null, exits = null, kinds = ['codex','claude','gemini'], codexExits = null, tokens = null) {
  return kinds.map(kind => {
    const rows=(state.clis || []).filter(c=>c.kind===kind).map(c=>kind==='gemini'?{...c,profileId:c.profileId||'default',label:c.label||'我的账号'}:c);
    if (!rows.length) return '';
    const name=kind==='gemini'?'Antigravity':kind==='claude'?'Claude':'Codex';
    const help=kind==='gemini'?'新建会话使用所选账号；已有会话继续使用原账号。各模型额度与重置时间见右侧看板。':kind==='claude'?'新建会话使用所选账号；已有会话恢复、重启仍用原账号。':'切换后，新建、恢复和重启会话使用所选账号额度。已打开的会话继续使用原账号。';
    const mine = edit && edit.kind === kind;
    const add = (kind === 'claude' && vps && vps.enabled !== false ? `<button class="ac-text-btn ac-exit-btn" data-ac="exit-check" ${exits?.loading ? 'disabled' : ''}>检查出口</button>` : '') + (kind === 'claude' && mail ? '<button class="ac-text-btn ac-mail-import" data-ac="mail-import">导入邮箱资料</button>' : '') + (EDITABLE.has(kind) ? `<button class="ac-text-btn" data-ac="account-add" data-kind="${kind}">+ 添加账号</button>` : '');
    return `<article class="ac-company ac-codex-quota" data-account-kind="${kind}" aria-label="${name} 用量账号"><header><h2>${name} 用量账号</h2><span class="ac-count">${rows.length} 个账号</span>${add}</header><p class="ac-tool-help">${help}</p>${kind==='claude'?exitCheckHtml(exits,vps,esc):''}${rows.map(c=>{
      const id=c.profileId || 'default';
      const editing = mine && edit.mode !== 'add' && edit.profileId === id;
      return `<div class="ac-account" data-account-profile="${esc(id)}"><div class="ac-account-title"><strong>${esc(c.label || c.profileId)}</strong><span class="ac-account-name">${esc(c.account || '账号未确认')} · ${authLabel(c.state)}</span>${tokens?.[id]?`<span class="ac-account-name">近 30 天 ${esc(formatTokens(tokens[id]))} token</span>`:''}${c.isDefault?'<span class="ac-default">后续使用</span>':''}</div><div class="ac-row-actions">${authorizeButton(c,esc)}<button class="ac-open" data-ac="${kind}-quota" data-profile="${esc(c.profileId)}" ${c.isDefault?'disabled aria-pressed="true"':'aria-pressed="false"'}>${c.isDefault?'当前用量账号':'使用此账号额度'}</button>${accountMenuHtml(kind,c,esc)}</div>${riskHtml(kind,c,esc,edit)}${kind==='codex'?codexExitHtml(c,codexExits,esc):''}${kind==='gemini'?agyExitHtml(c,codexExits,esc,mine?edit:null):''}${kind==='claude'?loginEnvHtml(c,vps,esc,edit&&edit.kind==='claude'?edit:null)+mailboxHtml(c,mail,esc,edit&&edit.kind==='claude'?edit:null):''}${editing && edit.mode !== 'bind' && edit.mode !== 'agy-bind' && edit.mode !== 'mail' && edit.mode !== 'risk' ? accountFormHtml(edit, esc, c.label || id) : ''}</div>`;
    }).join('')}${mine && edit.mode === 'add' ? `<div class="ac-account ac-account-new">${accountFormHtml(edit, esc, '', kind === 'codex' || kind === 'gemini' ? codexExits : vps)}</div>` : ''}</article>`;
  }).join('');
}
function usageHtml(value, esc, tools = '', detail = '') {
  return `<div class="ac-usage ${value.tone}" title="${esc(value.title || '')}"><span>${esc(value.text)}</span>${value.note ? `<small>${esc(value.note)}</small>` : ''}${toolsHtmlLine(tools, esc)}${detail}</div>`;
}
// A person handoff pauses every web tool (core/web-risk-guard.js); say so, so nobody wonders why.
function handoffHtml(risk, esc) {
  const lease = risk?.handoff;
  if (!lease) return '';
  const until = new Date(lease.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `<p class="ac-connection-notice ac-handoff" role="status">${esc('网页工具已暂停并断开，你正在专属 Chrome 里验证或登录；完成后关闭那个窗口，再复核并继续原任务。接管记录到 ' + until + '，窗口仍开着时工具不会接管。')}</p>`;
}
// The image MCP in one sentence: which route draws right now.
function imageServiceHtml(images, esc) {
  if (!images) return '';
  const enabled = (images.web || []).filter(w => w.enabled);
  const webAble = enabled.some(w => w.able ?? w.ready), codexReady = !!images.codex?.ready;
  const order = images.codex?.preferred ? 'Codex 优先、网页兜底' : '网页优先、Codex 兜底';
  const retryAt = Math.min(...enabled.map(w => w.retryAt || Infinity));
  const retry = Number.isFinite(retryAt) ? '，' + (retryAt <= Date.now() ? '下次有生图任务时' : new Date(retryAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 后有生图任务时') + '自动再试网页' : '';
  const now = webAble && !(images.codex?.preferred && codexReady) ? '现在走 ChatGPT 网页'
    : codexReady ? '现在走 Codex' + (enabled.length && !webAble ? '（ChatGPT 网页被网站验证拦住' + retry + '）' : '') : '暂时没有可用通道';
  return `<p class="ac-connection-notice ac-image-status" role="status">${esc('生图 MCP：' + order + ' · ' + now)}</p>`;
}
// One line per account: the verdict, then where it came from.
const PROOF = { check: '网页确认已登录', cookie: '本机登录记录有效', images: '生图调用成功', roundtable: '网页圆桌调用成功', bridge: '中转调用成功', opened: '你打开过网页' };
const BY = { check: '网页检查', cookie: '本机登录记录', images: '生图', roundtable: '网页圆桌', bridge: '中转', paused: '网页工具' };
// A verification wall a tool met: a note about the tools, not a task for the person.
function automationNote(wall, now) {
  if (!wall) return '';
  if (wall.by === 'paused') return '网页工具遇到网站验证，自动化暂停到 ' + new Date(wall.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '；你自己使用不受影响';
  return relativeTime(wall.at, now) + ' ' + BY[wall.by] + '遇到网站验证；你自己使用不受影响';
}
function healthView(health, now = Date.now()) {
  const h = health || { state: 'unknown' };
  const when = at => relativeTime(at, now);
  const note = automationNote(h.automation, now);
  if (h.state === 'attention') {
    const p = h.problem;
    const detail = when(p.at) + ' ' + BY[p.by] + (p.by === 'cookie' ? '已失效' : p.by === 'check' ? '发现已退出登录' : '提示需要登录');
    return { tone: 'warn', text: 'AI 浏览器需要重新登录', detail, action: 'login', button: '给 AI 登录' };
  }
  const synced = h.syncedAt ? when(h.syncedAt) + '同步' : '';
  if (h.state === 'ok') return { tone: 'ok', text: '正常' + (synced ? ' · ' + synced : ''), detail: note || PROOF[h.syncedBy] || '', action: 'open', button: '打开' };
  if (h.state === 'off') return { tone: 'idle', text: 'AI 浏览器未登录', detail: '', action: 'open', button: '打开' };
  return { tone: 'idle', text: '未确认' + (synced ? ' · ' + when(h.syncedAt) + '打开过' : ''), detail: note, action: 'open', button: '打开' };
}
function accountToolHtml(state, card, account, esc) {
  const waiting = account.identity === 'main' ? (state.webTools?.roundtable?.waiting || []).filter(t => t.provider === card.site) : [];
  const html = waiting.length ? `<small class="ac-tools">${esc('网页圆桌有 ' + waiting.length + ' 个任务等这个账号 · ' + (waiting.every(t => t.submitted) ? '只补收原回答' : '保留原任务继续'))}</small>` : '';
  return { waiting, html };
}
function aiHtml(state, query, esc, now = Date.now()) {
  const network = state.chrome?.network;
  const networkHtml = network && !['applied', 'next_launch'].includes(network.state) ? `<p class="ac-connection-notice ac-network" role="status">${esc(network.message)}</p>` : '';
  const progress = state.progress?.status === 'running' ? state.progress : null;
  return networkHtml + imageServiceHtml(state.webTools?.images, esc) + handoffHtml(state.risk, esc) + (companyCards(state).map(card => {
    const accounts = card.accounts.filter(a => matches([card.company, card.product, a.label, a.account], query));
    if (!accounts.length) return '';
    return `<article class="ac-company" data-site="${card.site}"><header>${brandIcon(card, esc)}<h2>${esc(card.company)}</h2><span class="ac-count">${card.accounts.length} 个账号</span><kbd title="账号页内打开默认账号">Alt+${card.shortcut}</kbd></header>
      ${accounts.map(a => {
        const view = healthView(a.health, now), detail = accountToolHtml(state, card, a, esc);
        const checking = progress?.current?.identity === a.identity && progress.current.site === card.site;
        const canRecover = detail.waiting.some(t => t.canResume);
        return `<div class="ac-account" data-identity="${a.identity}"><div class="ac-account-title">${brandIcon(card, esc, true)}<strong>${esc(card.product)}</strong><span class="ac-account-name">${esc(a.account === '账号待确认' ? a.label : a.account)}</span>${a.preferred ? '<span class="ac-default">默认</span>' : ''}</div>
          <div class="ac-usage ${checking ? 'idle' : view.tone}" data-health="${esc(a.health?.state || 'unknown')}"><span>${esc(checking ? '正在后台确认登录…' : view.text)}</span>${view.detail ? `<small>${esc(view.detail)}</small>` : ''}${detail.html}</div><div class="ac-row-actions"><button class="ac-open" data-ac="${view.action}" data-site="${card.site}" data-identity="${a.identity}" aria-label="${esc(view.button)} ${esc(card.product)} ${esc(a.label)}">${view.button} ↗</button>
          ${canRecover ? `<button class="ac-text-btn" data-ac="recover" data-site="${card.site}" data-identity="${a.identity}">复核并继续原任务</button>` : ''}
          <details class="ac-more" data-details="account-${card.site}-${a.identity}"><summary aria-label="${esc(card.product)} ${esc(a.label)}更多操作">···</summary><div><button data-ac="recheck" data-site="${card.site}" data-identity="${a.identity}">立即确认登录</button>${view.action === 'login' ? `<button data-ac="open" data-site="${card.site}" data-identity="${a.identity}">在你的浏览器打开</button>` : `<button data-ac="login" data-site="${card.site}" data-identity="${a.identity}">${a.health?.automation ? '帮 AI 过网站验证' : '给 AI 重新登录'}</button>`}<button data-ac="copy-logins" data-site="${card.site}" data-identity="${a.identity}" title="你在自己的浏览器里重新登录过时用：把登录复制给 AI 浏览器">把我的登录复制给 AI</button>${!a.preferred ? `<button data-ac="preferred" data-site="${card.site}" data-identity="${a.identity}">设为默认账号</button>` : ''}${card.accounts.length < 2 ? `<button data-ac="add" data-site="${card.site}" data-identity="alt">添加第二个账号</button>` : ''}</div></details></div></div>`;
      }).join('')}</article>`;
  }).join('') || '<p class="ac-empty">没有匹配的账号</p>');
}
function cliHtml(state, query, esc, keep = () => true) {
  const rows = (state.clis || []).filter(c => keep(c) && matches([c.name, c.label, c.account], query));
  return rows.map(c => `<article class="ac-account ac-standalone"><div class="ac-account-title"><strong>${esc(c.name)} · ${esc(c.label || '默认账号')}</strong><span class="ac-account-name">${esc(c.account || '账号未确认')}</span></div><div class="ac-usage ${cliChip(c).tone}">${authLabel(c.state)}</div><div class="ac-row-actions">${authorizeButton(c,esc)}<button class="ac-text-btn" data-ac="config" data-id="${esc(c.kind)}">配置</button></div></article>`).join('') || '<p class="ac-empty">没有匹配的命令行账号</p>';
}
function serviceHtml(service, state, esc, now) {
  const value = usage(state.activity?.entries?.['main:' + service.id], now);
  const evidence = service.credential === 'read_error' ? '授权记录读取失败' : service.credential === 'record_found' ? '已有配置记录' : '由原工具管理';
  const research = GROUP[service.id] === 'research';
  const native = research && service.nativeStatus ? NATIVE[service.nativeStatus.state] : null;
  const openLabel = research ? '登录 ↗' : '打开 ↗';
  const nativeHtml = research ? `<div class="ac-usage ${native ? native[1] : 'idle'}" title="${esc(service.nativeStatus?.message || '')}"><span>${esc(native ? native[0] : '还没检查登录')}</span>${service.nativeStatus?.checkedAt ? `<small>${esc(relativeTime(service.nativeStatus.checkedAt, now))}检查</small>` : ''}</div>` : '';
  return `<article class="ac-service" data-account-service="${esc(service.id)}"><div class="ac-account"><div class="ac-account-title"><strong>${esc(service.name)}</strong>${service.purpose ? `<span class="ac-account-name">${esc(service.purpose)}</span>` : ''}</div>${research ? nativeHtml : service.website ? usageHtml(value, esc) : `<div class="ac-usage idle">${esc(evidence)}</div>`}<div class="ac-row-actions">${service.website ? `<button class="ac-open" data-ac="external" data-service="${esc(service.id)}" data-operation="open">${openLabel}</button>` : ''}${research ? `<button class="ac-open" data-ac="external" data-service="${esc(service.id)}" data-operation="check">检查登录</button>` : ''}<details class="ac-more" data-details="service-${esc(service.id)}"><summary aria-label="${esc(service.name)}详情">···</summary><div><span>${esc(BINDING[service.status] || '')}</span><p>${esc(service.help)}</p>${service.canAuthorize ? `<button data-ac="external" data-service="${esc(service.id)}" data-operation="authorize">授权 GitHub CLI ↗</button>` : ''}${(service.consumers || []).map(c => `<span>${esc(c.name)}</span>`).join('')}</div></details></div></div></article>`;
}
function servicesHtml(data, tab, query, state, esc, error, now = Date.now()) {
  if (error) return `<p class="ac-item-error" role="alert">${esc(error)} <button class="ac-text-btn" data-ac="tool-accounts-refresh">重试</button></p>`;
  if (!data) return '<p class="ac-empty" role="status">正在读取账号…</p>';
  const services = data.services.filter(s => !['images', 'bridge', 'roundtable'].includes(s.id) && (GROUP[s.id] || 'api') === tab && matches([s.name, ...(s.consumers || []).map(c => c.name)], query));
  return services.map(s => serviceHtml(s, state, esc, now)).join('') || '<p class="ac-empty">没有匹配的账号</p>';
}
// A tool's latest step on any login it uses, for the connection list.
function lastToolStep(activity, tool, now) {
  const steps = Object.values(activity?.entries || {}).map(e => e.sources?.[tool]).filter(Boolean).sort((a, b) => b.at - a.at);
  return steps.length ? '最近：' + relativeTime(steps[0].at, now) + (TOOL_OUTCOMES[steps[0].outcome] || '') : '';
}
function toolConnections(data, esc, activity, now = Date.now()) {
  if (!data) return '';
  return data.services.filter(s => ['images', 'bridge', 'roundtable'].includes(s.id)).map(s => `<div class="ac-connection"><span>${esc(s.name)}</span><span>${esc(BINDING[s.status])}</span><small>${s.identities.map(i => (i.identity === 'main' ? '账号 1' : '账号 2')).join('、')}${lastToolStep(activity, s.id, now) ? ' · ' + esc(lastToolStep(activity, s.id, now)) : ''}${s.id === 'roundtable' ? ' · 支持 DeepSeek、Kimi、千问；Claude/Codex 新会话选「浏览器」或「全部」加载 MCP，运行中的旧会话需重新创建' : ''}</small></div>`).join('');
}
// 「平台与授权」一页放下原来四个低频页签，每组带小标题。
function platformHtml(data, query, state, esc, error, now = Date.now()) {
  return PLATFORM_GROUPS.map(g => `<h3 class="ac-group-title">${g.name}</h3>${g.id === 'cli' ? cliHtml(state, query, esc) : servicesHtml(data, g.id, query, state, esc, error, now)}`).join('');
}
module.exports = { PLATFORM_GROUPS, platformHtml, riskFormValues, riskHtml, TABS, relativeTime, usage, toolsNote, healthView, imageServiceHtml, aiHtml, cliHtml, servicesHtml, toolConnections, codexQuotaHtml, mailboxHtml, exitCheckHtml,
  authLabel, authorizeButton, accountFormHtml, accountMenuHtml, loginEnvHtml, envOptionsHtml, freeEnvs, EXIT_STATE, MAIL_KIND, keeperBadgeHtml, keeperCheckHtml };
