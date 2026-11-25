'use strict';
const CODEAGENT_KIND = /^codeagent(?:-resume)?$/;

function initialFromLabel(label) {
  const head = String(label || '').split('（')[0];
  const m = head.match(/[A-Za-z]/);
  return m ? m[0].toLowerCase() : '';
}

// 纯函数：会话 + 账号表 → { letter, title } 或 null（不是 CodeAgent 会话、或拿不到字母时不显示）。
function accountBadge(session, data) {
  if (!session || !CODEAGENT_KIND.test(String(session.kind || ''))) return null;
  const id = session.codeagentPoolAccount;
  if (id) {
    const a = (data && data.accounts && data.accounts[id]) || null;
    const letter = (a && a.initial) || initialFromLabel(session.codeagentPoolLabel);
    if (!letter) return null;
    return { letter, title: a && a.alias ? `号池 · ${a.alias}${a.note ? '（' + a.note + '）' : ''}` : '号池账号' };
  }
  const letter = data && data.personal && data.personal.initial;
  return letter ? { letter, title: '个人账号' } : null;
}

// 渲染层接线：第一次用到时取账号表，号池或个人账号登录变化（codeagent-pool:changed）后重取；取到后通知会话栏重画。
function createAccountBadges({ invoke, subscribe = null, onChange = () => {} } = {}) {
  let data = null;
  let loading = null;
  function load() {
    if (loading || typeof invoke !== 'function') return loading;
    loading = Promise.resolve().then(() => invoke('codeagent-pool:badges')).then(result => {
      const next = result && result.ok !== false ? { personal: result.personal || {}, accounts: result.accounts || {} } : { personal: {}, accounts: {} };
      const changed = JSON.stringify(next) !== JSON.stringify(data);
      data = next;
      if (changed) onChange();
    }).catch(() => { data = data || { personal: {}, accounts: {} }; }).finally(() => { loading = null; });
    return loading;
  }
  if (typeof subscribe === 'function') subscribe(change => { if (!(change && change.probing)) void load(); });
  return {
    badge(session) {
      if (!session || !CODEAGENT_KIND.test(String(session.kind || ''))) return null;
      if (!data) void load();
      return accountBadge(session, data);
    },
    load,
    data: () => data,
  };
}

module.exports = { accountBadge, initialFromLabel, createAccountBadges };
