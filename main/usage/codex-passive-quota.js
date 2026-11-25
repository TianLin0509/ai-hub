'use strict';
const {normalizeCodexRateLimitsResponse}=require('./codex-app-server-usage');

const WINDOW_KEYS=['usage5h','usage7d'];
const stamp=value=>Number(value?.observedAt || value?._ts || value?.ts) || 0;
const valid=value=>Number.isFinite(value?.pct) && value.pct>=0 && value.pct<=100;

// Account snapshots can be sparse. A new short-window observation must not
// make the retained weekly observation appear newer, or erase it altogether.
function mergeCodexQuotaObservation(current,incoming,at) {
  const same=current?.scopeKey===incoming.scopeKey;
  const previous=same?current:null;
  const next={...previous,...incoming,source:'app-server',observedAt:at,_ts:at};
  for(const key of WINDOW_KEYS){
    const old=previous?.[key],value=incoming[key];
    if(!valid(value)){
      next[key]=valid(old)?{...old,observedAt:old.observedAt || stamp(previous)}:null;
      continue;
    }
    const observed=value.observedAt || at;
    const oldReset=Number(old?.resetsAt),newReset=Number(value.resetsAt);
    const sameWindow=oldReset>0 && newReset>0 && Math.abs(oldReset-newReset)<=60000;
    const olderWindow=oldReset>0 && newReset>0 && newReset<oldReset-60000;
    if(valid(old) && (observed<(old.observedAt || stamp(previous)) || olderWindow
        || sameWindow && value.pct<old.pct)){
      next[key]={...old,observedAt:old.observedAt || stamp(previous)};
    }else next[key]={...value,observedAt:observed};
  }
  delete next.unavailable;
  return next;
}

function createCodexPassiveQuota({resolveScope,readCache,writeCache,publish,now=Date.now}) {
  // observedAt：读数实际产生的时刻（会话记录里那条 rate_limits 的时间），不给就是现在。
  function observe(scope,data,{notification=false,sessionId='',epoch=null,connectionId='',observedAt=0}={}) {
    const at=Number(observedAt)>0?Number(observedAt):now();
    const cached=readCache(scope);
    // Token estimates and history fallbacks are not account-authoritative and
    // must never overrule a measured percentage or become a measured window.
    const previous=cached?.scopeKey===scope.scopeKey && cached.source==='app-server'?cached:null;
    const incoming={...data,scopeKey:scope.scopeKey};
    if(!WINDOW_KEYS.some(key=>valid(incoming[key])))return null;
    const next=mergeCodexQuotaObservation(previous,incoming,at);
    if(notification){
      const oldStats=previous?.notificationStats;
      const samples=Array.isArray(oldStats?.samples)?oldStats.samples:[];
      const last=samples.findLast(sample=>sample.sessionId===sessionId && sample.epoch===epoch && sample.connectionId===connectionId);
      const sample={at,sessionId,epoch,connectionId,intervalMs:last?Math.max(0,at-last.at):null};
      for(const key of WINDOW_KEYS){
        const before=previous?.[key],after=incoming[key];
        sample[key+'Delta']=valid(before)&&valid(after)&&before.resetsAt===after.resetsAt
          ? Math.max(0,after.pct-before.pct):null;
      }
      next.notificationStats={count:(oldStats?.count || 0)+1,lastReceivedAt:at,
        lastIntervalMs:sample.intervalMs,samples:[...samples,sample].slice(-60)};
      next.delivery='notification';
    }
    writeCache(scope,next);
    publish(scope,next);
    return next;
  }
  function receive(event){
    if(!event?.profileId || !event.accountKey)return null;
    const scope=resolveScope(event.profileId);
    if(!scope || scope.backend!=='subscription' || scope.accountKey!==event.accountKey)return null;
    const params=event.params;
    const bucket=params?.rateLimitsByLimitId?.codex || params?.rateLimits;
    if(!bucket || bucket.limitId && bucket.limitId!=='codex')return null;
    let data;
    try{data=normalizeCodexRateLimitsResponse({rateLimits:bucket},now(),{exactPercent:true});}
    catch{return null;}
    for(const key of WINDOW_KEYS)if(!valid(data[key]))data[key]=null;
    return observe(scope,data,{notification:true,sessionId:event.sessionId,epoch:event.epoch,connectionId:event.connectionId});
  }
  return {receive,observe};
}
module.exports={createCodexPassiveQuota,mergeCodexQuotaObservation};
