/* 负责人组队（2026-11-01）的界面：
 *   ① 侧栏：负责人会话下挂成员子行（session-list-renderer.js 调 window.__teamUi）；负责人行带「负责人」标签，
 *      有待批准的招人计划时换成橙色「待批准」按钮；
 *   ② 批准弹窗：列出负责人提交的每个人（分工、类型、账号、目录、开工任务），账号旁边是右侧看板同一份额度
 */
(function () {
  'use strict';
  const { ipcRenderer } = require('electron');
  const company=require('../core/distribution').target==='company';
  // 样式表由本脚本自己挂上（不改 index.html）。
  if (typeof document.querySelector === 'function' && document.head && !document.querySelector('link[data-team-ui]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'team-ui.css'; link.dataset.teamUi = '1'; // 与 index.html 同在 renderer/ 目录
    document.head.appendChild(link);
  }
  const teams = new Map();   // leadSid → 主进程 publicView
  // 旧版只记「收起了哪些」（hubSidebarCollapsedTeams），读进来当作明确收起。
  const foldChoice = new Map();
  const searchReveal = new Set(); // 搜索命中成员时的临时展开，只在内存里
  const foldKey = 'hubSidebarProjectFolds', legacyKey = 'hubSidebarCollapsedTeams';
  try {
    const saved = JSON.parse(localStorage.getItem(foldKey) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, v] of Object.entries(saved)) if (typeof v === 'boolean') foldChoice.set(id, v);
    } else {
      const legacy = JSON.parse(localStorage.getItem(legacyKey) || '[]');
      if (Array.isArray(legacy)) for (const id of legacy) if (typeof id === 'string') foldChoice.set(id, true);
    }
  } catch { /* 存储不可用时，本次界面仍可展开和折叠。 */ }
  const leftChoice = new Map();
  const leftKey = 'hubSidebarLeftMemberFolds';
  try {
    const saved = JSON.parse(localStorage.getItem(leftKey) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [id, v] of Object.entries(saved)) if (typeof v === 'boolean') leftChoice.set(id, v);
  } catch { /* 存储不可用时本次照常折叠。 */ }
  // eslint-disable-next-line no-undef
  const currentActive = () => { try { return typeof activeSessionId !== 'undefined' ? activeSessionId : null; } catch { return null; } };
  let modal = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rerender = () => { if (typeof scheduleSessionListRender === 'function') scheduleSessionListRender(); };

  function accept(list) {
    teams.clear();
    for (const t of list || []) if (t && t.leadSid) teams.set(t.leadSid, t);
    rerender();
  }
  async function refresh() {
    try { const r = await ipcRenderer.invoke('team:list'); if (r && r.ok) accept(r.result); }
    catch (e) { console.warn('[team-ui] 读取失败：', e && e.message); }
  }
  ipcRenderer.on('team:changed', (_e, p) => {
    if (!p || !p.leadSid) return;
    if (p.team) teams.set(p.leadSid, p.team); else teams.delete(p.leadSid);
    rerender();
    if (modal && modal.dataset.leadSid === p.leadSid && !pendingPlan(p.leadSid)) closeModal();
  });

  const pendingPlan = leadSid => (teams.get(leadSid)?.plans || []).find(p => p.status === 'pending') || null;
  const sessionExists = (sessionMap, id) => !sessionMap || !sessionMap.get || !!sessionMap.get(id);
  // 侧栏每次重绘对每个会话都问一遍「是不是某个会议的成员」，原来每问一次就把所有会议翻一遍
  // （生产实测重绘 45 秒内耗 0.3 秒）。同一轮同步计算里会议表不变，集合在本轮结束（微任务）时丢弃。
  let meetingSubIds = null;
  const subSessionIds = meetings => {
    if (meetingSubIds && meetingSubIds.meetings === meetings) return meetingSubIds.ids;
    const ids = new Set();
    for (const m of Object.values(meetings || {})) for (const id of m.subSessions || []) ids.add(id);
    meetingSubIds = { meetings, ids };
    Promise.resolve().then(() => { meetingSubIds = null; });
    return ids;
  };
  const canNestTeam = (leadSid, sessionMap, meetings) => sessionExists(sessionMap, leadSid)
    && !sessionMap?.get(leadSid)?.meetingId
    && !subSessionIds(meetings).has(leadSid);

  window.__teamUi = {
    // 挂在某位负责人下面的成员（负责人会话还在才挂，负责人关掉后成员回到顶层）。
    membersOf(leadSid, sessionMap, meetings) {
      const t = teams.get(leadSid);
      if (!t || !canNestTeam(leadSid, sessionMap, meetings)) return [];
      return t.members.map(m => m.sid).filter(id => id && sessionExists(sessionMap, id));
    },
    memberIdSet(sessionMap, meetings) {
      const set = new Set();
      for (const t of teams.values()) for (const id of this.membersOf(t.leadSid, sessionMap, meetings)) set.add(id);
      return set;
    },
    isLead: leadSid => teams.has(leadSid),
    isRegistered: leadSid => !!teams.get(leadSid)?.registered,
    isCollapsed(leadSid) {
      const active = currentActive();
      const isMember = !!active && (teams.get(leadSid)?.members || []).some(m => m.sid === active);
      if (searchReveal.has(leadSid)) {
        if (isMember || active === leadSid) return false;
        searchReveal.delete(leadSid);
      }
      if (foldChoice.has(leadSid)) return foldChoice.get(leadSid);
      return !isMember;
    },
    revealForSearch(leadSid) { searchReveal.add(leadSid); rerender(); },
    setCollapsed(leadSid, collapsed) {
      foldChoice.delete(leadSid); foldChoice.set(leadSid, !!collapsed);
      while (foldChoice.size > 200) foldChoice.delete(foldChoice.keys().next().value);
      try { localStorage.setItem(foldKey, JSON.stringify(Object.fromEntries(foldChoice))); } catch {}
      rerender();
    },
    // 成员在某位负责人队里是否已离队（交付后休眠、被收工都算）。按负责人查：离队后被挂到别的负责人名下时，旧队的记录不算数（Codex 复审）。
    isDismissed(sid, leadSid) {
      const m = (teams.get(leadSid)?.members || []).find(x => x.sid === sid);
      return m?.status === 'dismissed';
    },
    isLeftOpen(leadSid) {
      if (leftChoice.has(leadSid)) return leftChoice.get(leadSid);
      const active = currentActive();
      return !!active && (teams.get(leadSid)?.members || []).some(m => m.sid === active && m.status === 'dismissed');
    },
    setLeftOpen(leadSid, open) {
      leftChoice.delete(leadSid); leftChoice.set(leadSid, !!open);
      while (leftChoice.size > 200) leftChoice.delete(leftChoice.keys().next().value);
      try { localStorage.setItem(leftKey, JSON.stringify(Object.fromEntries(leftChoice))); } catch {}
      rerender();
    },
    // 文件夹标题行上的人数与状态（只算成员）：等你 / 异常 / 在跑由侧栏按同一套状态算好传进来。
    planPending: leadSid => !!pendingPlan(leadSid),
    queuedCount: leadSid => (teams.get(leadSid)?.members || []).filter(m => m.status === 'queued').length,
    leadOf(sid, sessionMap, meetings) {
      for (const t of teams.values()) if (this.membersOf(t.leadSid, sessionMap, meetings).includes(sid)) return t.leadSid;
      return null;
    },
    memberInfo(sid) {
      for (const t of teams.values()) { const m = t.members.find(x => x.sid === sid); if (m) return m; }
      return null;
    },
    signature(id, sessionMap, meetings) {
      const t = teams.get(id);
      if (t) return 'L' + t.members.map(m => m.sid + m.status).join(',')
        + ':' + this.membersOf(id, sessionMap, meetings).join(',') + (pendingPlan(id) ? ':P' : '')
        + (this.isCollapsed(id) ? ':C' : ':E') + (this.isLeftOpen(id) ? ':LO' : '') + (t.registered ? ':R' + (t.project || '') + '|' + (t.goal || '') : '');
      const m = this.memberInfo(id);
      return m ? 'M' + m.memberId + m.status : '';
    },
    // 负责人行标题后的标签；成员行标题前的编号。返回 HTML 片段。
    rowTagHtml(id, sessionMap, meetings) {
      const count = this.membersOf(id, sessionMap, meetings).length;
      const collapsed = this.isCollapsed(id);
      const toggle = count ? `<button type="button" class="team-collapse-toggle" data-team-toggle="${esc(id)}" data-sidebar-control="team:${esc(id)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展开' : '折叠'} ${count} 个团队成员" title="${collapsed ? '展开' : '折叠'} ${count} 个成员（不影响后台工作）">${collapsed ? '▸' : '▾'}</button>` : '';
      const plan = pendingPlan(id);
      if (plan) return `${toggle}<button type="button" class="team-pending-badge" data-team-approve="${esc(id)}" title="负责人提交了招人计划（${plan.members.length} 人），点开批准或驳回">待批准</button>`;
      if (teams.get(id)?.members.length) {
        // 同时干活上限（2026-11-09）：排队等名额的成员还没有会话，只在负责人行上显示人数。
        const queued = teams.get(id).members.filter(m => m.status === 'queued').length;
        return toggle
          + (queued ? `<span class="sl-orch-tag team-queued-tag" title="同时干活的成员只有防失控的安全阀（默认每队、全机各 100 个），这 ${queued} 人排队；前面有人交付或休眠后 Hub 自动开工">排队 ${queued}</span>` : '');
      }
      // 登记过、还没有成员的负责人：2026-11-18 起不再挂「负责人」标签，名册仍在启动中心和右键负责人列表里。
      if (teams.get(id)?.registered) return '';
      const m = this.memberInfo(id);
      const left = m?.status === 'dismissed' ? (m.dismissReason === 'delivered' ? '（已交付，离队休眠）' : '（已离队）') : '';
      return m ? `<span class="team-member-tag${m.status === 'dismissed' ? ' dismissed' : ''}" title="${esc(m.role)}${left}">${esc(m.memberId)}</span>` : '';
    },
    openApproval,
    openRegister,
  };

  // 右键「登记为负责人…」（2026-11-15）：给已有会话登记项目名和目标，进负责人名册。人数由负责人自己按需定。
  function openRegister(sid, title = '') {
    document.querySelector('.team-register-backdrop')?.remove();
    const back = document.createElement('div');
    back.className = 'team-register-backdrop';
    back.innerHTML = `<form class="team-register" role="dialog" aria-modal="true" aria-labelledby="team-register-title">
      <h3 id="team-register-title">登记为负责人</h3>
      <p class="team-register-sub">「${esc(title || '这个会话')}」登记后会出现在启动中心和右键的负责人列表里；要不要招人、招几个由它按需判断。</p>
      <label>项目名<input name="project" maxlength="40" placeholder="不填用会话标题" value=""></label>
      <label>目标（可选）<textarea name="goal" rows="3" maxlength="2000" placeholder="写了它就按目标开工；不写就等你在会话里布置"></textarea></label>
      <p class="team-register-error" role="alert" hidden></p>
      <div class="team-register-actions"><button type="button" data-act="cancel">取消</button><button type="submit" class="primary">登记</button></div></form>`;
    document.body.appendChild(back);
    const form = back.querySelector('form'), err = back.querySelector('.team-register-error'), submit = form.querySelector('[type=submit]');
    const close = () => back.remove();
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    form.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    form.querySelector('[data-act=cancel]').addEventListener('click', close);
    form.addEventListener('submit', async e => {
      e.preventDefault(); submit.disabled = true; err.hidden = true;
      try {
        const r = await ipcRenderer.invoke('team:register-lead', { sessionId: sid, project: form.project.value.trim(), goal: form.goal.value.trim() });
        if (!r?.ok) throw Error(r?.error || '登记失败');
        if (r.result?.team) { teams.set(sid, r.result.team); rerender(); }
        close();
        window.__hubToast?.('已登记为负责人' + (r.result?.team?.project ? '：' + r.result.team.project : ''));
      } catch (error) { err.textContent = error.message; err.hidden = false; submit.disabled = false; }
    });
    form.project.focus();
  }

  // 侧栏在按下时捕获指针、松开时切换会话（session-list-renderer.js），点击事件就到不了角标；
  // 在捕获阶段先截住角标上的按下，侧栏不接手，随后的 click 落在角标本身。
  for (const type of ['pointerdown', 'mousedown', 'keydown']) document.addEventListener(type, event => {
    if (event.target && event.target.closest && event.target.closest('[data-team-approve], [data-team-toggle], [data-team-left-toggle]')) event.stopPropagation();
  }, true);
  document.addEventListener('click', event => {
    const btn = event.target && event.target.closest && event.target.closest('[data-team-approve], [data-team-toggle], [data-team-left-toggle]');
    if (!btn) return;
    event.preventDefault(); event.stopPropagation();
    if (btn.dataset.teamLeftToggle) window.__teamUi.setLeftOpen(btn.dataset.teamLeftToggle, !window.__teamUi.isLeftOpen(btn.dataset.teamLeftToggle));
    else if (btn.dataset.teamToggle) window.__teamUi.setCollapsed(btn.dataset.teamToggle, !window.__teamUi.isCollapsed(btn.dataset.teamToggle));
    else openApproval(btn.dataset.teamApprove);
  }, true);

  async function accounts() {
    if(company) {
      const r=await ipcRenderer.invoke('team:accounts');
      if(!r?.ok)throw Error(r?.error || '号池读取失败');
      return r.result.rows || [];
    }
    try {
      const [ranking, usage, config] = await Promise.all([ipcRenderer.invoke('claude:launch-ranking'), ipcRenderer.invoke('account-profile-usage'), ipcRenderer.invoke('get-hub-config')]);
      return require('../core/team-account-options').teamAccountOptions({ ranking, usage,
        codexProfiles: config?.codexSubscriptionProfiles || [], antigravityProfiles: config?.antigravitySubscriptionProfiles, sessions: typeof sessions !== 'undefined' ? [...sessions.values()] : [] });
    } catch { return {}; }
  }
  const pct = v => (v == null ? '—' : Math.round(v) + '%');
  function accountText(a) {
    if(company)return `${a.label || a.id} · ${a.activeSessions || 0} 个会话${a.usable?'':' · '+(a.unavailableReason || '暂不可用')}`;
    return `${a.label}${a.planMultiplier > 1 ? ' · ' + a.planMultiplier + 'X' : ''}　5h 剩 ${pct(a.spare5h)} · 7d 剩 ${pct(a.spare7d)} · ${a.activeSessions} 个活跃会话${a.flagged ? ' · 风控观察' : ''}${a.plenty ? ' · 充足' : ''}`;
  }

  const kindLabel = kind => ({ claude: 'Claude', codex: 'Codex', gemini: 'Antigravity', codeagent: 'CodeAgent', powershell: 'PowerShell' })[kind] || String(kind || '');
  // 摘要条：几位成员、实际用几个账号（「跟随默认」算一个），以及成员类型分布（公司版是模型分布）。
  function updatePlanSummary(opened, plan) {
    const accounts = new Set(), counts = new Map();
    plan.members.forEach((m, i) => {
      const sel = opened.querySelector(`[data-team-account="${i}"]`);
      if (sel) accounts.add(m.kind + ':' + (sel.value || 'default'));
      const model = company ? (opened.querySelector(`[data-team-model="${i}"]`)?.value || '沿用账号模型') : kindLabel(m.kind);
      counts.set(model, (counts.get(model) || 0) + 1);
    });
    const items = [...counts].map(([k, n]) => `${k} × ${n}`);
    opened.querySelector('[data-team-summary-accounts]').textContent = accounts.size ? `${accounts.size} 个账号` : '无需账号';
    const line = opened.querySelector('[data-team-summary-kinds]');
    line.textContent = items.join(' / '); line.title = items.join('\n');
  }

  function closeModal() { if (modal) { modal.remove(); modal = null; } }
  async function openApproval(leadSid) {
    const plan = pendingPlan(leadSid);
    if (!plan) return;
    closeModal();
    const leadTitle = (typeof sessions !== 'undefined' && sessions.get && sessions.get(leadSid)?.title) || '负责人';
    modal = document.createElement('div');
    modal.className = 'team-modal-backdrop';
    modal.dataset.leadSid = leadSid;
    const memberRows = plan.members.map((m, i) => {
      const hasAccounts = company || ['claude', 'codex', 'gemini'].includes(m.kind);
      const options = hasAccounts
        // 弹窗先打开，额度读回来再填（电脑忙时读额度可能要好几秒，不能让点击没反应）。
        ? (company ? '' : '<option value="">跟随 Hub 默认账号</option>') + (m.account ? `<option value="${esc(m.account)}" selected>${esc(m.account)}（正在读取账号…）</option>` : '')
        : '';
      const [firstTask, ...taskRest] = String(m.task || '').split(/\r?\n/);
      const cwd = m.cwd || '与负责人相同目录';
      return `<section class="team-member" data-kind="${esc(m.kind)}">
        <div class="team-member-head"><span class="team-member-icon" aria-hidden="true">${esc(kindLabel(m.kind).slice(0, 1))}</span>
          <div class="team-member-heading"><b>${esc(m.role || m.title)}</b><div class="team-sub">${m.title && m.title !== m.role ? esc(m.title) + ' · ' : ''}${esc(kindLabel(m.kind))}${!company && m.model ? ' · ' + esc(m.model) : ''}${!company && m.effort ? ' · ' + esc(m.effort) : ''}</div></div><span class="team-col-no">${i + 1}</span></div>
        <div class="team-task"><strong>${esc(firstTask)}</strong>${taskRest.length ? '\n' + esc(taskRest.join('\n')) : ''}</div>
        <div class="team-workdir" title="${esc(cwd)}">${esc(cwd)}</div>
        ${hasAccounts ? `<div class="team-member-fields${company ? ' two' : ''}"><label><span>${company ? '号池账号' : '账号（额度同右侧看板）'}</span><select data-team-account="${i}" data-team-kind="${esc(m.kind)}">${options}</select></label>
          ${company ? `<label><span>模型</span><select data-team-model="${i}"><option value="${esc(m.model || '')}">${esc(m.model || '沿用账号模型')}</option></select><div class="team-sub" data-team-model-hint="${i}" hidden>模型权限未核实</div></label>` : ''}</div>` : ''}
      </section>`;
    }).join('');
    modal.innerHTML = `<div class="team-modal" role="dialog" aria-modal="true" aria-label="批准招人计划">
      <header class="team-modal-head"><div><h3>「${esc(leadTitle)}」要组队：${plan.members.length} 个会话</h3><p class="team-goal">${esc(plan.goal)}</p></div><button type="button" class="team-close" data-team-close aria-label="关闭审批">×</button></header>
      <div class="team-plan-summary" aria-label="计划摘要"><div><b>${plan.members.length} 位成员</b><span data-team-summary-accounts></span></div><p data-team-summary-kinds></p></div>
      <div class="team-modal-body"><div class="team-plan">${memberRows}</div></div>
      <div class="team-modal-foot"><label class="team-note">备注（可选，会转给负责人）<textarea rows="2" data-team-note></textarea></label>
      <div class="team-error" hidden></div>
      <div class="team-actions">
        <button type="button" data-team-act="reject">驳回</button>
        <button type="button" class="primary" data-team-act="approve">批准并建 ${plan.members.length} 个会话</button>
      </div></div>
    </div>`;
    modal.addEventListener('change', () => updatePlanSummary(modal, plan));
    modal.addEventListener('click', async event => {
      if (event.target === modal) { closeModal(); return; }
      if (event.target.closest?.('[data-team-close]')) { closeModal(); return; }
      const act = event.target.closest && event.target.closest('[data-team-act]');
      if (!act) return;
      const approve = act.dataset.teamAct === 'approve';
      const edits = plan.members.map((_m, i) => { const sel = modal.querySelector(`[data-team-account="${i}"]`); return sel ? { account: sel.value,...(company?{model:modal.querySelector(`[data-team-model="${i}"]`).value}:{}) } : {}; });
      modal.querySelectorAll('button').forEach(b => { b.disabled = true; });
      // 建会话时按钮上读秒（回迁自 AI HUB-H 11-06：等的时候要看到在哪一步、等了多久）。
      const wait = require('./wait-progress');
      let stopTick = () => {};
      if (approve) {
        act.innerHTML = wait.waitHtml({ label: `正在建 ${plan.members.length} 个会话`, from: Date.now(), hint: '逐个开会话，每个通常 5–15 秒' });
        stopTick = wait.startWaitTicker(() => act);
      } else act.textContent = '正在驳回…';
      let r;
      try { r = await ipcRenderer.invoke('team:decide', { leadSid, planId: plan.id, approve, note: modal.querySelector('[data-team-note]').value, edits }); }
      finally { stopTick(); }
      if (r && r.ok) { closeModal(); return; }
      const err = modal.querySelector('.team-error');
      err.hidden = false; err.textContent = (r && r.error) || '操作失败';
      modal.querySelectorAll('button').forEach(b => { b.disabled = false; });
      act.textContent = approve ? '批准' : '驳回';
    });
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
    document.body.appendChild(modal);
    const opened = modal;
    updatePlanSummary(opened, plan);
    if(company)modal.querySelector('[data-team-act="approve"]').disabled=true;
    accounts().then(accountOptions => {
      if (modal !== opened) return;
      if(company&&!accountOptions.length)throw Error('号池里还没有账号，请先在账号管理里添加账号。');
      modal.querySelectorAll('select[data-team-account]').forEach(sel => {
        const rows = company ? accountOptions : accountOptions[sel.dataset.teamKind]?.rows;
        if (!rows) return;
        const keep = sel.value;
        sel.innerHTML = (company?'':'<option value="">跟随 Hub 默认账号</option>') + rows.map(a => `<option value="${esc(a.id)}"${company&&!a.usable?' disabled':''}>${esc(accountText(a))}</option>`).join('');
        if (keep && !rows.some(a => a.id === keep)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(keep)}">${esc(keep)}（看板里没有这个账号）</option>`);
        sel.value = keep;
        sel.querySelectorAll('option').forEach(o => { o.title = o.textContent; });
        const syncTitle = () => { sel.title = sel.selectedOptions[0]?.textContent || ''; };
        syncTitle(); sel.addEventListener('change', syncTitle);
        if(company) {
          const model=modal.querySelector(`[data-team-model="${sel.dataset.teamAccount}"]`);
          const fill=initial=>{
            const row=rows.find(a=>a.id===sel.value),chosen=initial?model.value:'';
            modal.querySelector(`[data-team-model-hint="${sel.dataset.teamAccount}"]`).hidden=!row || row.modelsAuthoritative===true;
            const available=row?.models || [];
            model.innerHTML=`<option value="">沿用账号模型${row?.defaultModel?' · '+esc(row.defaultModel):''}</option>`+available.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');
            if(chosen&&!available.includes(chosen))model.insertAdjacentHTML('beforeend',`<option value="${esc(chosen)}">${esc(chosen)}（需核对权限）</option>`);
            model.value=chosen;
          };
          fill(true);sel.addEventListener('change',()=>fill(false));
        }
      });
      updatePlanSummary(opened, plan);
      if(company)modal.querySelector('[data-team-act="approve"]').disabled=false;
    }).catch(error=>{if(modal!==opened)return;const e=modal.querySelector('.team-error');e.hidden=false;e.textContent=`${error.message} 处理后重新打开这份计划即可继续。`;});
    modal.querySelector('[data-team-act="approve"]').focus();
  }

  refresh();
})();
