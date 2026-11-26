'use strict';
function registerAccountCenterIpc(ipcMain,service,{codexExits = require('../../core/codex-account-exit').createCodexExitService(),
 agyExits = require('../../core/antigravity-exit').createAntigravityExitService()} = {}){
 for(const [name,fn] of Object.entries({'codex-exits':()=>codexExits.state(),'codex-exit-check':p=>codexExits.check(p.profileId),
  'antigravity-exits':()=>agyExits.state(),'antigravity-exit-check':p=>agyExits.check(p.profileId)})){
  ipcMain.handle('accounts:'+name,async(_event,p={})=>{try{return {ok:true,data:await fn(p)};}catch(e){return {ok:false,error:e.message||'出口检查未完成'};}});
 }
 ipcMain.handle('accounts:login-many',async(_event,p={})=>{try{return {ok:true,data:await service.loginMany(p.ids,{phone:p.phone})};}catch(e){return {ok:false,error:e.message||'批量登录未完成'};}});
 ipcMain.handle('accounts:submit-code',async(_event,p={})=>{try{return {ok:true,data:await service.submitCode(p.id,p.code)};}catch{return {ok:false,error:'验证码提交未完成，请检查账号和官方窗口；验证码不会记录到日志'};}});
 ipcMain.handle('accounts:codex-mailbox',async(_event,p={})=>{try{return {ok:true,data:await service.codexMailbox(p.id,p.email,{confirmed:p.confirmed===true})};}catch(e){return {ok:false,error:e.message};}});
 ipcMain.handle('accounts:codex-device-page',async(_event,p={})=>{try{return {ok:true,data:await service.codexDevicePage(p.id,{confirmed:p.confirmed===true})};}catch(e){return {ok:false,error:e.message};}});
 for(const [name,fn] of Object.entries({snapshot:()=>service.snapshot(),'check-all':()=>service.checkAll(),check:p=>service.check(p.id),open:p=>service.open(p.id),login:p=>service.login(p.id,{confirmed:p.confirmed===true,email:p.email,agyMode:p.agyMode==='dedicated'?'dedicated':''}),release:p=>service.release(p.id)})){
  ipcMain.handle('accounts:'+name,async(_event,p={})=>{try{if(!['snapshot','check-all'].includes(name)&&(typeof p.id!=='string'||p.id.length>100))throw Error('连接标识无效');return {ok:true,data:await fn(p)};}catch(e){return {ok:false,error:e.message||'账号操作失败'};}});
 }
}
module.exports={registerAccountCenterIpc};
