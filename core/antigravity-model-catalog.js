'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {resolveCommand,cliEnv,runCli}=require('./antigravity-config');
const crypto=require('node:crypto');
// `agy models` starts a full language server and refreshes OAuth (5-15 s). The
// new-session dialog asks on open and again on submit, so share one call.
const SUCCESS_TTL_MS=10*60*1000,FAILURE_TTL_MS=60*1000,DISK_TTL_MS=24*60*60*1000;
const cached=new Map(),inflight=new Map();
function readDiskCache(cacheFile,key,now){
  if(!cacheFile)return null;
  try{
    const raw=JSON.parse(fs.readFileSync(cacheFile,'utf8'));
    const entry=raw&&typeof raw==='object'?raw[key]:null;
    if(!entry||!Array.isArray(entry.models)||!entry.models.length)return null;
    if(!Number.isFinite(entry.at)||now()-entry.at>DISK_TTL_MS)return null;
    return {at:entry.at,value:{ok:true,models:entry.models,source:'agy models (cached)',observedAt:entry.at,cached:true}};
  }catch{return null;}
}
function writeDiskCache(cacheFile,key,value,at){
  if(!cacheFile||!value?.ok||!Array.isArray(value.models)||!value.models.length)return;
  try{
    let data={};
    try{const old=JSON.parse(fs.readFileSync(cacheFile,'utf8'));if(old&&typeof old==='object'&&!Array.isArray(old))data=old;}catch{}
    data[key]={at,models:value.models};
    fs.mkdirSync(path.dirname(cacheFile),{recursive:true});
    const tmp=cacheFile+'.'+process.pid+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(data),'utf8');
    fs.renameSync(tmp,cacheFile);
  }catch{}
}
const NAMESPACE_ENV=/^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|CLAUDE_HUB_HOME_DIR|AI_HUB_ANTIGRAVITY_COMMAND|AI_HUB_ANTIGRAVITY_HOME|AI_HUB_ANTIGRAVITY_PROFILE|SSH_TTY|SSH_CLIENT|SSH_CONNECTION|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR|(?:AGY|ANTIGRAVITY|GEMINI|GOOGLE)_.+)$/i;
function namespaceKey({profileId='default',home='',authScope='',env}){
  // Hash only authentication/storage namespace inputs, never publish them.
  // This isolates observations; it does not make changing HOME an auth switch.
  const entries=Object.entries(env).filter(([key])=>NAMESPACE_ENV.test(key))
    .map(([key,value])=>[process.platform==='win32'?key.toUpperCase():key,String(value)])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify([profileId,home,authScope,resolveCommand(env),entries])).digest('hex');
}
function parseModels(text){
  const seen=new Set(),models=[];
  for(const line of String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/)){
    const m=/^\s*((?:gemini|claude|gpt-oss)[\w.-]+)\s+(.+?)\s*$/.exec(line);
    if(m&&!seen.has(m[1])){seen.add(m[1]);models.push({id:m[1],label:m[2]});}
  }
  return models;
}
async function fetchModelCatalog({env,runImpl}){
  if(env.CLAUDE_HUB_HOME_DIR&&!env.AI_HUB_ANTIGRAVITY_COMMAND)return {ok:false,models:[],error:'隔离 Hub 不读取真实 Antigravity 账号'};
  try{
    const r=await runImpl(resolveCommand(env),['models'],env,30000),models=parseModels(r.stdout);
    const loginRequired=/please sign in|not signed in|sign in to view|not logged in/i.test(r.stdout+'\n'+r.stderr);
    if(r.code!==0||!models.length)return {ok:false,models:[],loginRequired,error:loginRequired?'请先完成 Antigravity Google 登录':'未收到有效的 Antigravity 模型清单'};
    return {ok:true,models,source:'agy models',observedAt:Date.now()};
  }catch(error){return {ok:false,models:[],error:error.message};}
}
// account-adapters' gemini check passes its own default runner (plain execFile of
// agy.exe), which flashes a Windows Terminal window from Electron; swap that one
// for runCli. Injected test doubles pass through unchanged.
function backgroundRunner(runImpl){return !runImpl||runImpl===require('./account-adapters').run?runCli:runImpl;}
function readModelCatalog({env=process.env,runImpl=runCli,force=false,now=Date.now,
  profileId='default',home='',authScope='',cacheFile='',allowDiskCache=false}={}){
  let effectiveEnv,key;
  try {effectiveEnv=cliEnv(env);key=namespaceKey({profileId,home,authScope,env:effectiveEnv});}
  catch(error){return Promise.resolve({ok:false,models:[],error:error.message});}
  const entry=cached.get(key);
  if(!force&&entry&&now()-entry.at<(entry.value.ok?SUCCESS_TTL_MS:FAILURE_TTL_MS))return Promise.resolve(entry.value);
  // Disk cache is only for model-picker UI responsiveness; account auth checks must always run live `agy models`.
  const disk=allowDiskCache&&!force&&cacheFile?readDiskCache(cacheFile,key,now):null;
  if(disk&&now()-disk.at<SUCCESS_TTL_MS)return Promise.resolve(disk.value);
  let task=inflight.get(key);
  if(!task){
    task=fetchModelCatalog({env:effectiveEnv,runImpl:backgroundRunner(runImpl)}).then(value=>{
      const at=now();
      if(inflight.get(key)===task){
        cached.set(key,{at,value});
        if(value.ok)writeDiskCache(cacheFile,key,value,at);
      }
      return value;
    }).finally(()=>{if(inflight.get(key)===task)inflight.delete(key);});
    inflight.set(key,task);
  }
  if(!allowDiskCache||!disk)return task;
  return task.then(value=>{
    if(!value.ok&&!value.loginRequired){
      return {...disk.value,stale:true,refreshError:value.error};
    }
    return value;
  });
}
function resetModelCatalogCache(){cached.clear();inflight.clear();}
module.exports={parseModels,readModelCatalog,resetModelCatalogCache,backgroundRunner};
