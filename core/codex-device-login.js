'use strict';
const { spawn } = require('child_process');
const network = require('./codex-exit-network');
const { ENV_ID, VpsLoginEnv } = require('./vps-login-env');
const DEVICE_URL = 'https://auth.openai.com/codex/device';
function parseDeviceOutput(raw) {
  const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const url = text.match(/https:\/\/[^\s<>"']+/)?.[0];
  const code = text.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/)?.[0];
  if (!url || !code) return null;
  if (url !== DEVICE_URL) throw Error('Codex 返回了非预期的设备码网址，未打开');
  return {verificationUrl:url,deviceCode:code};
}
class CodexDeviceLogin {
  constructor({manager,keeper,spawnImpl=spawn,resolveCommand=require('../main/codex-windows-command').resolveWindowsCodex,
    onComplete=()=>{}, timeoutMs=15*60000, readyTimeoutMs=45000, exists}={}) {
    Object.assign(this,{manager,keeper,spawnImpl,resolveCommand,onComplete,timeoutMs,readyTimeoutMs,exists});
    this.flights=new Map();
  }
  service() { return this.manager ||= new VpsLoginEnv({dataDir:require('./data-dir').getHubDataDir()}); }
  resume(row) { const e=this.flights.get(row.home); return e ? e.ready : false; }
  login(row,env,{confirmed=false,email=''}={}) {
    if(this.flights.has(row.home))return this.flights.get(row.home).ready;
    const entry={};this.flights.set(row.home,entry);
    entry.ready=this.start(row,env,{confirmed,email},entry).catch(e=>{if(this.flights.get(row.home)===entry)this.flights.delete(row.home);throw e;});
    return entry.ready;
  }
  async validate(row) {
    if(!network.dedicated(row)||!ENV_ID.test(row.loginEnv||''))throw Error('这个 Codex 账号尚未绑定远程浏览器，未打开本机浏览器');
    const checked=await network.checkedRoute(row,{keeper:this.keeper,exists:this.exists});
    const status=await this.service().status(), bound=status.accounts?.[row.loginEnv];
    if(!bound || (bound.host||'main')!==checked.route.hubHost || bound.route!==checked.route.launcherRoute
      || (bound.managed&&!bound.provisioned))throw Error('Codex 登录环境与专属出口不一致，请在管家检查');
    return checked;
  }
  async mailbox(row,email,{confirmed=false}={}) {
    const {mailUrl}=require('./claude-mailbox-vault');
    const url=mailUrl(email||row.accountLabel);
    if(!url)throw Error('请输入 Outlook、Gmail、mail.com 或 Onet 邮箱地址；其他邮箱可在远程窗口手动打开');
    await this.validate(row);
    return this.service().open(row.loginEnv,{url,confirmed});
  }
  async page(row,options={}) {
    await this.validate(row);
    return this.service().open(row.loginEnv,{url:DEVICE_URL,confirmed:options.confirmed===true});
  }
  async start(row,env,options,entry) {
    const checked=await this.validate(row);
    if(entry.cancelled)throw Error('Codex 授权已取消');
    // Ask about occupied browsers before starting a one-time-code CLI. Never force-close another account.
    const opened=await this.service().open(row.loginEnv,{url:DEVICE_URL,confirmed:options.confirmed});
    if(opened.needsConfirmation){this.flights.delete(row.home);return opened;}
    if(entry.cancelled){await this.service().stop(row.loginEnv,{closeViewer:true});throw Error('Codex 授权已取消');}
    const launchEnv=network.applyEnvironment(require('../main/codex-account-namespace').cleanCodexAccountEnv({...env,CODEX_HOME:row.home}),checked.env);
    delete launchEnv.BROWSER;
    const cmd=this.resolveCommand(launchEnv);
    return new Promise((resolve,reject)=>{
      let ready=false,done=false,buffer='',timer,readyTimer;
      const finish=async(success,message)=>{
        if(done)return;done=true;clearTimeout(timer);clearTimeout(readyTimer);
        if(!success)try{entry.child?.kill();}catch{}
        let cleanup='';
        try{await this.service().stop(row.loginEnv,{closeViewer:true});}catch{cleanup='；远程窗口未能自动关闭，请手动关闭远程窗口';}
        if(this.flights.get(row.home)===entry)this.flights.delete(row.home);
        if(!ready)reject(Error(message));
        this.onComplete({id:row.id,success,message:message+cleanup});
      };
      entry.cancel=()=>void finish(false,'Codex 授权已取消');
      try {
        const child=entry.child=this.spawnImpl(cmd.command,[...cmd.args,'-c','cli_auth_credentials_store="file"','-c','forced_login_method="chatgpt"','login','--device-auth'],
          {cwd:row.home,env:cmd.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        const read=chunk=>{
          if(done||ready)return;
          buffer=(buffer+String(chunk)).slice(-32768);
          try {
            const code=parseDeviceOutput(buffer);
            if(code){ready=true;clearTimeout(readyTimer);resolve({...code,pending:true,profileId:row.id.replace(/^codex-/,''),
              email:options.email||row.accountLabel||'',message:'请在远程浏览器用邮箱登录并输入设备码；若设备码登录未开启，请先在 ChatGPT 安全设置开启。'});}
          }catch(e){void finish(false,e.message);}
        };
        child.stdout.on('data',read);child.stderr.on('data',read);
        child.once('error',()=>void finish(false,'Codex 设备码登录进程无法启动'));
        child.once('close',code=>void finish(code===0,code===0?'Codex 订阅授权已完成，远程浏览器已关闭':'Codex 设备码授权未完成（退出码 '+code+'），请重试并确认已开启设备码登录'));
        timer=setTimeout(()=>void finish(false,'Codex 设备码授权超时，请重新授权'),this.timeoutMs);timer.unref?.();
        readyTimer=setTimeout(()=>void finish(false,'Codex 未返回设备码，请检查出口和设备码登录设置'),this.readyTimeoutMs);readyTimer.unref?.();
      }catch(e){void finish(false,e.message);}
    });
  }
  close(){for(const e of this.flights.values()){e.cancelled=true;e.cancel?.();}}
}
module.exports={CodexDeviceLogin,parseDeviceOutput,DEVICE_URL};
