'use strict';
const fs = require('fs');
const path = require('path');
const profiles = require('../../core/antigravity-subscription-profiles');
const {createAntigravityUsage} = require('./antigravity-account-usage');

// Each reader owns its native credential environment, cached result and flight.
// 2026-11-21：读数按账号归属落盘（file），Hub 重启后看板仍显示上次的真实读数和它的时间，不再一片空白。
function createAntigravityProfilesUsage({getConfig,env=process.env,createReader=createAntigravityUsage,file=''}={}) {
  const readers=new Map(), values=new Map(), selections=new Map();
  let saved={};
  if(file){try{saved=JSON.parse(fs.readFileSync(file,'utf8'))||{};}catch{saved={};}}
  const persist=(key,value)=>{
    if(!file || !value || !(value.usage5h || value.usage7d || value.groups?.length))return;
    saved[key]=value;
    try{
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const tmp=file+'.'+process.pid+'.tmp';
      fs.writeFileSync(tmp,JSON.stringify(saved),'utf8');fs.renameSync(tmp,file);
    }catch{/* 本次运行内存里仍有读数 */}
  };
  const list=()=>profiles.normalizeProfiles(getConfig().antigravitySubscriptionProfiles,
    env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME);
  function resolve(id) {
    const profile=profiles.resolveProfile(getConfig(),id,env);
    return {profile,scope:profiles.publicAuthInfo(profile).authScope};
  }
  function scope(id) {const selected=resolve(id);selections.set(selected.scope,selected.profile.id);return selected.scope;}
  async function refresh(key,force=false) {
    if(!selections.has(key)) throw new Error('Antigravity 账号归属尚未确认，请刷新账号额度');
    const selected=resolve(selections.get(key));
    if(selected.scope!==key) throw new Error('Antigravity 登录已变化，请刷新账号额度');
    let reader=readers.get(key);
    if(!reader) {
      const own=selected.profile.id!=='default';
      reader=createReader({env:profiles.applyProfileEnv(env,selected.profile),initial:own?saved[key] || null:null,keepTier:own});
      readers.set(key,reader);
    }
    const value=await reader.refresh(force);
    if(scope(selected.profile.id)!==key) throw new Error('Antigravity 登录已变化，本次额度结果未采用');
    values.set(key,value);
    // 我的账号凭据在系统 keyring 里，归属里没有登录身份，换了 Google 号也认不出来；它的读数只留内存，不落盘。
    if(!value?.error && selected.profile.id!=='default')persist(key,value);
    return value;
  }
  const persisted=key=>selections.get(key)==='default'?null:saved[key]||null;
  return {profiles:list,scope,refresh,cached:key=>values.get(key)||persisted(key)};
}
module.exports={createAntigravityProfilesUsage};
