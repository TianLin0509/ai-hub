'use strict';
const {spawn,execFile}=require('child_process');
const {resolveCommand,cliEnv,backgroundEnv,windowsCmdLine,EFFORT_SUFFIX}=require('./antigravity-config');
function runPrompt(prompt,{env,profileId,model,effort,bypassPermissions=false,timeoutMs=90000,spawnImpl=spawn}={}){
  const profiles=require('./antigravity-subscription-profiles');
  const base=env || process.env;
  if(base.AI_HUB_ANTIGRAVITY_PROFILE && profileId && profileId!==base.AI_HUB_ANTIGRAVITY_PROFILE)
    throw new Error('Antigravity 已绑定账号的环境不能用于另一账号，请重新选择启动环境');
  let profile=null;
  if(base.AI_HUB_ANTIGRAVITY_PROFILE && (!profileId || profileId===base.AI_HUB_ANTIGRAVITY_PROFILE)) {
    profiles.assertProfileEnv(base);env=cliEnv(base);
  } else {
    profile=profiles.resolveProfile(require('./hub-config').getConfig(),profileId,base);
    env=cliEnv(profiles.applyProfileEnv(base,profile));
  }
  // Dream consolidation runs unattended: same no-browser / no-updater env as the usage poll.
  env=backgroundEnv(env);
  const args=['--input-format','stream-json','--output-format','stream-json'];
  if(bypassPermissions===true)args.unshift('--dangerously-skip-permissions');
  if(model){
    if(!/^[\w.-]+$/.test(model))throw new Error('Antigravity 模型 ID 无效');
    args.push('--model',model);
  }
  if(effort && !(model && EFFORT_SUFFIX.test(model))){
    if(!['low','medium','high','xhigh','max'].includes(effort))throw new Error('Antigravity 思考档无效');
    args.push('--effort',effort);
  }
  const command=resolveCommand(env);
  const viaCmd=process.platform==='win32' && spawnImpl===spawn;
  const file=viaCmd ? (env.ComSpec || env.COMSPEC || 'cmd.exe') : command;
  const argv=viaCmd ? ['/d','/s','/c',windowsCmdLine(command,args)] : args;
  const start=()=>new Promise((resolve,reject)=>{
    const child=spawnImpl(file,argv,{env,windowsHide:true,windowsVerbatimArguments:viaCmd,stdio:['pipe','pipe','pipe']});
    let done=false,buffer='',stderr='',result=null;
    const killTree=()=>{
      if(process.platform==='win32'&&child?.pid){
        execFile('taskkill',['/T','/F','/PID',String(child.pid)],{windowsHide:true},()=>{});
        setTimeout(()=>{try{child.kill();}catch{}},3000).unref?.();
        return;
      }
      try{child.kill();}catch{}
    };
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{killTree();finish(Error('Antigravity 调用超时'));},timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      for(let p;(p=buffer.indexOf('\n'))>=0;){
        const line=buffer.slice(0,p);buffer=buffer.slice(p+1);if(!line.trim())continue;
        try{const e=JSON.parse(line);if(e.event==='result')result=e.result;}
        catch{killTree();finish(Error('Antigravity 返回了无效的事件流'));return;}
      }
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    child.on('error',error=>finish(Error('Antigravity 启动失败：'+error.message)));
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')finish(error);});
    child.on('close',code=>{
      if(code!==0||result?.status!=='SUCCESS')return finish(Error(result?.error||`Antigravity 未成功完成（${code}）：${stderr.slice(-500)}`));
      if(typeof result.response!=='string'||!result.response.trim())return finish(Error('Antigravity 未返回正文'));
      finish(null,result.response);
    });
    child.stdin.end(JSON.stringify({event:'user',message:{content:prompt}})+'\n','utf8');
  });
  return profile?.network
    ? require('./antigravity-exit').checkedNetwork(profile.network).then(start)
    : start();
}
module.exports={runPrompt};
