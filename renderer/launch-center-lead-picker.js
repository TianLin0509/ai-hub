'use strict';
//   独立会话（默认）／加入负责人（挂到某位负责人名下当成员，team:attach-member）／创建为负责人（登记进负责人名册，team:register-lead）。
// 加入负责人：下拉里前台排第一，其余负责人按最近活动排序（team:lead-options，由 main 统一算）；可选写一句任务，随组队说明发给新会话。
// 创建为负责人：项目名默认用会话标题，可选写目标；登记后它出现在所有「选负责人」的地方，没有成员也算。
// 位置：有启动配置区时放进它的右栏底部（「配置说明」下面，账号多时这里本来是空白）；PowerShell 这类没有配置区的，放在配置区原位。
// 从侧栏右键负责人「创建子会话…」进来时自动选「加入负责人」并选中那位。

const ROLES = [['solo', '独立会话'], ['join', '加入负责人'], ['lead', '创建为负责人']];
const HINTS = {
  solo: '普通会话，不属于任何团队',
  join: '新会话作为成员挂到所选负责人名下，收到怎么汇报、交付的说明；不占同时干活的名额',
  lead: '新会话登记为负责人：自己判断要不要招人、招几个；以后建会话、右键都能把成员挂到它名下',
};

function createLaunchLeadPicker({ document, ipcRenderer, notify = () => {} }) {
  if (!document) throw new Error('lead picker requires document');
  let options = [];
  let role = 'solo';
  let wanted = '';        // 「加入负责人」要预选的负责人（右键进来的那位，或上次选的）
  let loadSeq = 0;
  let section = null, detail = null, select = null, taskInput = null, projectInput = null, goalInput = null, observer = null, placing = false;

  function build() {
    section = document.createElement('div');
    section.className = 'session-team-role';
    section.id = 'new-session-lead-section';
    section.innerHTML = '<div class="session-tuning-field session-team-field"><span id="new-session-team-label">团队角色</span>'
      + '<div class="lcc-seg session-team-seg" role="radiogroup" aria-labelledby="new-session-team-label">'
      + ROLES.map(([v, t]) => `<button type="button" role="radio" data-team-role="${v}" aria-checked="false" title="${HINTS[v]}">${t}</button>`).join('') + '</div></div>'
      + '<div class="session-tuning-field session-team-detail" hidden><span aria-hidden="true"></span><div class="session-team-inputs">'
      + '<select id="new-session-lead" aria-label="选择负责人"></select>'
      + '<input type="text" id="new-session-lead-task" maxlength="4000" aria-label="子会话任务（可选）" placeholder="任务（可选，随组队说明发给它）">'
      + '<input type="text" id="new-session-lead-project" maxlength="40" aria-label="项目名" placeholder="项目名（不填用会话标题）">'
      + '<input type="text" id="new-session-lead-goal" maxlength="2000" aria-label="项目目标（可选）" placeholder="目标（可选；写了它就直接开工）">'
      + '</div></div>';
    detail = section.querySelector('.session-team-detail');
    select = section.querySelector('#new-session-lead');
    taskInput = section.querySelector('#new-session-lead-task');
    projectInput = section.querySelector('#new-session-lead-project');
    goalInput = section.querySelector('#new-session-lead-goal');
    section.addEventListener('click', event => {
      const b = event.target.closest('[data-team-role]');
      if (!b) return;
      event.stopPropagation();
      setRole(b.dataset.teamRole);
    });
    select.addEventListener('change', () => { wanted = select.value; paint(); });
  }

  // 有启动配置区就放进它左右两栏里内容较短的那一栏底部（账号多时右栏「配置说明」下面空着，账号少时左栏账号表下面空着），
  // 不让启动中心多出纵向滚动；配置区被隐藏（PowerShell 等）时放在配置区后面，保证任何 AI 都能选。
  const contentHeight = col => [...col.children].reduce((h, el) => (el === section || el.hidden ? h : h + el.offsetHeight), 0);
  function place() {
    if (placing) return true;
    placing = true;
    try { return placeNow(); } finally { placing = false; }
  }
  function placeNow() {
    if (!section) build();
    const cfg = document.getElementById('new-session-config-section');
    if (!cfg) {
      const footer = document.querySelector('#launch-center-session-panel .session-create-footer');
      if (!footer) return false;
      if (section.parentElement !== footer.parentElement) footer.before(section);
      return true;
    }
    if (!observer && typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => place());
      // 配置区显隐（换 AI）、账号表重画、右栏字段显隐都会改变两栏高度。
      observer.observe(cfg, { attributes: true, attributeFilter: ['hidden'], subtree: true, childList: true });
    }
    const inside = !cfg.hidden;
    let host = cfg.parentElement;
    if (inside) {
      const right = cfg.querySelector('.lcc-params') || cfg, left = cfg.querySelector('.lcc-accounts');
      host = left && left.offsetParent !== null && contentHeight(left) + 8 < contentHeight(right) ? left : right;
    }
    section.classList.toggle('in-accounts', inside && host.classList.contains('lcc-accounts'));
    section.classList.toggle('standalone', !inside);
    if (inside) { if (section.parentElement !== host || host.lastElementChild !== section) host.appendChild(section); }
    else if (section.previousElementSibling !== cfg) cfg.after(section);
    return true;
  }
  function mount() { return place(); }

  const label = o => (o.front ? `前台 · ${o.title}` : `${o.title}${o.members ? `（${o.members} 名成员）` : ''}`);

  function setRole(next) {
    if (!ROLES.some(([v]) => v === next)) return;
    role = next;
    paint();
    if (role === 'lead') projectInput.focus?.();
  }

  function paint() {
    if (!mount()) return;
    for (const b of section.querySelectorAll('[data-team-role]')) b.setAttribute('aria-checked', String(b.dataset.teamRole === role));
    const known = options.some(o => o.sid === wanted);
    // 右键进来的负责人还没出现在清单里（刚成为负责人、清单还没刷新）：先放一个占位，选中它。
    const rows = known || !wanted ? options : [{ sid: wanted, title: '所选负责人', front: false, members: 0 }].concat(options);
    select.replaceChildren(...(rows.length ? rows : [{ sid: '', empty: true }]).map(o => {
      const opt = document.createElement('option');
      opt.value = o.sid;
      opt.textContent = o.empty ? '还没有负责人（可选「创建为负责人」）' : label(o);
      return opt;
    }));
    if (wanted && rows.some(o => o.sid === wanted)) select.value = wanted;
    const join = role === 'join', lead = role === 'lead';
    detail.hidden = !(join || lead);
    select.hidden = !join; taskInput.hidden = !join;
    projectInput.hidden = !lead; goalInput.hidden = !lead;
    section.classList.toggle('active', join || lead);
    section.dataset.role = role;
    const chosen = rows.find(o => o.sid === select.value);
    section.title = join && chosen ? `新会话会作为「${chosen.front ? '前台' : chosen.title}」的成员，收到怎么汇报、交付的说明；不占同时干活的名额` : HINTS[role];
    place();
  }

  async function refresh() {
    const seq = ++loadSeq;
    try {
      const result = await ipcRenderer.invoke('team:lead-options');
      if (seq !== loadSeq) return;
      options = result?.ok && Array.isArray(result.result) ? result.result.filter(o => o && o.sid) : [];
    } catch { if (seq === loadSeq) options = []; }
    paint();
  }

  // 每次打开启动中心调用：leadSid 来自右键「创建子会话…」→ 预选「加入负责人」；普通打开 → 独立会话。
  function reset(leadSid = '') {
    wanted = typeof leadSid === 'string' ? leadSid : '';
    role = wanted ? 'join' : 'solo';
    if (mount()) { taskInput.value = ''; projectInput.value = ''; goalInput.value = ''; paint(); }
    void refresh().then(() => { if (wanted && section) section.scrollIntoView?.({ block: 'nearest' }); });
  }

  // 点「创建会话」时拍快照：创建要等几秒，期间改了选项也不会挂错人。
  function selection() {
    if (!mount()) return null;
    if (role === 'join' && select.value) return { leadSid: select.value, task: taskInput.value.trim() };
    if (role === 'lead') return { asLead: true, project: projectInput.value.trim(), goal: goalInput.value.trim() };
    return null;
  }

  // 会话建好后调用。失败不影响已建好的会话，只提示原因。
  async function attach(session, chosen = selection()) {
    if (!chosen || !session?.id) return null;
    if (chosen.asLead) return registerLead(session, chosen);
    // 起个看得懂的名字：有任务用任务，没任务用「负责人 · 子会话」。否则自动标题会拿第一条消息（组队说明）起名。
    const leadRow = options.find(o => o.sid === chosen.leadSid);
    const title = chosen.task ? chosen.task.replace(/\s+/g, ' ').slice(0, 24) : `${(leadRow?.front ? '前台' : leadRow?.title || '负责人').slice(0, 14)} · 子会话`;
    try {
      const result = await ipcRenderer.invoke('team:attach-member', { leadSid: chosen.leadSid, sessionId: session.id, task: chosen.task, title });
      if (!result?.ok) throw new Error(result?.error || '挂到负责人失败');
      await ipcRenderer.invoke('rename-session', { sessionId: session.id, title, userRenamed: false }).catch(() => {});
      return result.result;
    } catch (error) {
      notify(`会话已建好，但没能挂到负责人下面：${error && error.message ? error.message : String(error)}`, 'error');
      return null;
    }
  }

  async function registerLead(session, chosen) {
    try {
      const result = await ipcRenderer.invoke('team:register-lead', { sessionId: session.id, project: chosen.project, goal: chosen.goal });
      if (!result?.ok) throw new Error(result?.error || '登记负责人失败');
      return result.result;
    } catch (error) {
      notify(`会话已建好，但没能登记为负责人：${error && error.message ? error.message : String(error)}`, 'error');
      return null;
    }
  }

  return { reset, refresh, selection, attach, mount };
}

module.exports = { createLaunchLeadPicker };
