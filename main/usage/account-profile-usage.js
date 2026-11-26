'use strict';

// Read existing account-scoped sources; never select a login to inspect its quota.
function createAccountProfileUsage(deps) {
  const errors = new Map();
  const checked = new Map();
  const antigravityData = new Map();
  let flight = null;
  let flightKey = '';
  const pending = new Map();
  let otherError = '';
  const now = deps.now || Date.now;
  function publicRow(provider, profile, data = {}, extra = {}) {
    return { provider, profileId: profile.id, profileLabel: profile.label || profile.id,
      usage5h: data?.usage5h || null, usage7d: data?.usage7d || null,
      lastSeen: data?.observedAt || data?.lastSeen || data?.ts || 0, ...extra };
  }
  function antigravityRows() {
    return (deps.antigravityProfiles?.() || []).map(profile => {
      try {
        const scope = deps.antigravityScope?.(profile.id);
        if (typeof scope !== 'string' || !scope) throw new Error('Antigravity 账号归属尚未确认');
        const data = deps.antigravityCached?.(scope) || antigravityData.get(scope);
        const groups = Array.isArray(data?.groups) ? data.groups.map(group => ({id:group.id,label:group.label,
          usage5h:group.usage5h || null,usage7d:group.usage7d || null})) : [];
        const agyProfiles = require('../../core/antigravity-subscription-profiles');
        let email = '';
        try { email = agyProfiles.accountLabel(profile); } catch {}
        return publicRow('antigravity',profile,data,{scope,selected:scope===deps.antigravityScope(),groups,
          email, egressIp: profile.network?.expectedIp || '',
          credits:typeof data?.credits==='number'&&Number.isFinite(data.credits)?data.credits:null,
          creditsObservedAt:data?.creditsObservedAt || 0,creditsError:data?.creditsError || '',
          upgradeOffered:typeof data?.upgradeOffered==='boolean'?data.upgradeOffered:null,
          error:errors.get('antigravity:'+scope) || data?.error || ''});
      } catch(error) {return publicRow('antigravity',profile,null,{groups:[],error:error.message});}
    });
  }
  function list() {
    const claude = deps.claudeProfiles().map(profile => {
      try {
        const scope = deps.claudeScope(profile.id);
        let account = {};
        try { account = deps.claudeAccount?.(profile.id) || {}; } catch {}
        return publicRow('claude', profile, deps.claudeCached(scope), {
          email: account.email || '', plan: account.plan || '', billing: account.billing || '', subscribedAt: account.subscribedAt || 0,
          planMultiplier: Number(account.planMultiplier) || 1,
          scope, selected: scope === deps.claudeScope(), error: errors.get(scope) || '',
          egressIp: profile.network?.expectedIp || deps.claudeSharedIp?.() || '',
        });
      } catch (error) { return publicRow('claude', profile, null, { error: error.message }); }
    });
    // 官方额度接口顺带给的账号事实（套餐档位、到上限原因、免费整周重置）；没读过就用登录凭证里的套餐。
    const codexFacts = (home, accountKey, plan) => {
      let f = null;
      try { f = deps.codexFacts?.(home, accountKey) || null; } catch {}
      return { plan: f?.planType || plan || '', limitReachedType: f?.limitReachedType || '',
        resetCredits: Number.isFinite(f?.resetCredits) ? f.resetCredits : null,
        resetCreditExpiries: Array.isArray(f?.resetCreditExpiries) ? f.resetCreditExpiries : [] };
    };
    const current = deps.codexScope();
    const currentRow = publicRow('codex', { id: current.profileId, label: current.profileLabel }, deps.codexCached(),
      { scope: current.scopeKey, selected: true, apiKey: current.backend === 'api', error: errors.get(current.scopeKey) || '',
        email: current.accountEmail || '', subscriptionUntil: current.subscriptionUntilMs || 0, subscriptionChecked: current.subscriptionCheckedMs || 0,
        ...codexFacts(current.home, current.accountKey, current.planType) });
    const order = deps.codexOrder();
    let otherRows;
    try { otherRows = deps.otherCodex(); }
    catch (error) { otherRows = order.filter(id => id !== current.profileId).map(profileId => ({ profileId, error: error.message })); }
    const others = otherRows.map(row => publicRow('codex', { id: row.profileId, label: row.profileLabel }, row,
      { scope: row.scopeKey, selected: false, apiKey: !!row.apiKey, error: row.error || otherError,
        email: row.accountEmail || '', subscriptionUntil: row.subscriptionUntilMs || 0, subscriptionChecked: row.subscriptionCheckedMs || 0,
        ...codexFacts(row.home, row.accountKey, row.planType) }));
    const rank = row => { const at = order.indexOf(row.profileId); return at < 0 ? order.length : at; };
    const out = { claude, codex: [currentRow, ...others].sort((a,b) => rank(a)-rank(b)),antigravity:antigravityRows() };
    // 固定序号（core/account-seq.js，2026-11-26）：右侧栏「账号N」按建号时的序号，删号不重排。
    // 序号库由 main.js 注入（deps.accountSeq），单测不注入就不落盘。
    if (deps.accountSeq) {
      try { for (const p of ['claude', 'codex', 'antigravity']) require('../../core/account-seq').stampRows(p, out[p], deps.accountSeq()); }
      catch (error) { console.warn('[account-seq]', error.message); }
    }
    return out;
  }
  async function refreshOnce({ provider, profileId, force = false, reuseAntigravityScope } = {}) {
    if (provider && !['claude', 'codex', 'antigravity'].includes(provider)) throw new Error('不支持的账号类型');
    const rows = list();
    if (profileId && !rows[provider]?.some(row => row.profileId === profileId)) throw new Error('账号不存在，请刷新账号列表');
    const tasks = [];
    for (const row of rows.claude) {
      if (force !== true) continue; // 自动看板刷新只读缓存，手动按钮才查询 Claude。
      if (provider && provider !== 'claude' || profileId && profileId !== row.profileId || !row.scope) continue;
      tasks.push((async () => {
        checked.set(row.scope, now());
        try {
          const result = await deps.refreshClaude(row.scope);
          if (result?.source === 'claude-native' && (result.data?.usage5h || result.data?.usage7d)) errors.delete(row.scope);
        }
        catch (error) { errors.set(row.scope, error.message || '读取失败'); }
      })());
    }
    if (!provider || provider === 'codex') {
      const current = rows.codex.find(row => row.selected);
      if (current && !current.apiKey && (!profileId || current.profileId === profileId)
          && (force || !checked.has(current.scope) || now()-checked.get(current.scope)>=120000)) {
        tasks.push((async () => {
          checked.set(current.scope, now());
          try {
            const result = await deps.refreshCodex(force);
            if (result?.usage5h || result?.usage7d) errors.delete(current.scope);
          }
          catch (error) { errors.set(current.scope, error.message || '读取失败'); }
        })());
      }
      if (!profileId || current?.profileId !== profileId) tasks.push(Promise.resolve().then(() => deps.refreshOtherCodex({ force }))
        .then(() => { otherError = ''; }, error => { otherError = error.message || '读取失败'; }));
    }
    for (const row of rows.antigravity) {
      if (provider && provider!=='antigravity' || profileId && profileId!==row.profileId || !row.scope) continue;
      const key='antigravity:'+row.scope;
      if (!force && checked.has(key) && now()-checked.get(key)<120000) continue;
      tasks.push((async()=>{
        checked.set(key,now());
        try {
          if(typeof deps.refreshAntigravity!=='function')throw new Error('Antigravity 账号用量读取尚未就绪');
          // A bulk action already queried this credential scope. Let its reader
          // enforce TTL; every other account keeps the explicit forced refresh.
          const result=await deps.refreshAntigravity(row.scope,force && row.scope!==reuseAntigravityScope);
          // A failed reader may return its previous successful observation.
          // Preserve its age and other accounts; never treat that as a recovery.
          if(result && (result.usage5h || result.usage7d || result.groups?.some(g=>g.usage5h||g.usage7d)))
            antigravityData.set(row.scope,result);
          if(result?.error)errors.set(key,result.error);
          else if(result && (result.usage5h || result.usage7d || result.groups?.some(g=>g.usage5h||g.usage7d)))errors.delete(key);
        } catch(error) {errors.set(key,error.message || '读取失败');}
      })());
    }
    await Promise.all(tasks);
    return list();
  }
  function refresh(options = {}) {
    if(options.provider && !['claude','codex','antigravity'].includes(options.provider))
      return Promise.reject(new Error('不支持的账号类型'));
    let key;
    try {
      const rows=list();
      const selected=(options.provider ? rows[options.provider] || [] : Object.values(rows).flat())
        .filter(row=>!options.profileId || row.profileId===options.profileId);
      key=JSON.stringify([options.provider || '*',options.profileId || '*',!!options.force,options.reuseAntigravityScope || '',
        selected.map(row=>[row.provider,row.profileId,row.scope])]);
    } catch(error) {return Promise.reject(error);}
    if (flight) {
      if (key === flightKey) return flight;
      if (!pending.has(key)) pending.set(key, flight.catch(() => {}).then(() => { pending.delete(key); return refresh(options); }));
      return pending.get(key);
    }
    flightKey = key;
    flight = refreshOnce(options).finally(() => { flight = null; });
    return flight;
  }
  function observed(provider,scope){
    if(provider==='codex')errors.delete(scope);
  }
  return { list, refresh, observed };
}
module.exports = { createAccountProfileUsage };
