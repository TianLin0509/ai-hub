'use strict';
const {AssistantService}=require('../../core/hub-assistant/service');
const fs=require('node:fs'),path=require('node:path');
function registerAssistantIpc(ipcMain,deps){
  const service=new AssistantService(deps);
  ipcMain.on('assistant:session-view',(_event,packet)=>service.setSessionViews(packet));
  // 助理页右栏额度表算好的精简读数，给手机等「前台客户端」的状态行用（见 core/hub-assistant/front-client.js）。
  ipcMain.on('assistant:quota-view',(_event,rows)=>service.frontClient.setQuotaView(rows));
  for(const [name,handler] of Object.entries({
    'session-cards':request=>service.sessionCards(request),
    'workbench':request=>request.refresh?service.workbench.refresh():service.workbench.snapshot(),
    'workbench-context':request=>({ok:true,text:service.workbench.context(request)}),
    'workbench-action':request=>service.workbench.action(request),
    // 当前概览弹窗（2026-11-25）：两个 Tab 的数据与弹窗内直接回复。
    'overview-board':()=>service.overviewBoard(),'overview-reply':request=>service.overviewReply(request),'overview-skip':request=>service.overviewSkip(request),
    'get-overview':()=>service.overview(),status:()=>service.overview(),
    // 侧栏只要「前台是哪个会话」，不必每 15 秒拿整份总览（生产实测约 0.38 MB、0.3 秒，2026-11-18）。
    'front-binding':()=>({ok:true,sessionId:service.store.get('sessionId')||null}),
    'ensure-session':()=>service.ensureSession(),context:request=>service.context(request),
    'ensure-photo-session':()=>service.photo.ensureSession(),
    'switch-backend':request=>service.switchBackend(request),
    'set-profile':request=>service.setProfile(request),'front-desk':()=>require('../../core/hub-assistant/front-desk').catalog(service.frontDesk()),'set-front-desk':request=>service.setFrontDesk(request),'memos':()=>service.memoView(),'memo-action':request=>{const r=service.memoAction(String(request?.ref||''),{action:request?.action,until:request?.until||'',title:request?.title||''});return{ok:true,memo:r.memo};},'dialog-log':request=>service.dialogLog(request),ask:request=>service.ask(request),'page-status':()=>service.pageStatus(),'rotate-now':()=>service.rotateNow(),
    // 重启后一键续跑卡片上的按钮：action 为 resume（全部继续）或 dismiss（不用了）。
    'restart-resume':request=>service.restartResume.act(request),
    'auto-resume':request=>service.autoResumeCards.act(request),
    // 拍板项「就这样」收起 / 恢复（电脑左栏与手机共用一份记录）；parks 读当前记录。
    parks:()=>({ok:true,parks:service.frontClient.parks()}),tasks:()=>service.frontClient.tasks(),'front-status':()=>({ok:true,...service.frontClient.status()}),'task-action':request=>service.frontClient.act(request),
    'open-memory':async()=>{const file=service.memory.file('user');if(!deps.openPath)return{ok:false,error:'记忆文件暂不可打开'};const error=await deps.openPath(file);return error?{ok:false,error}:{ok:true,path:file};},'phone-profile':()=>service.phoneProfile(),
    send:request=>service.send(request),'direct-send':request=>service.directSend(request),actions:()=>({ok:true,actions:service.store.list()}),
    notifications:request=>service.notifications(request),
    'mark-notification-read':request=>service.watches.markRead(request.id),
    'follow-task':request=>service.followTask(request),
    'unfollow-task':request=>service.watches.unfollow(request.sessionId),
    'followed-tasks':()=>({ok:true,tasks:service.followedTasks()}),
    'open-workbench':async()=>{const id=service.store.get('sessionId'),closed=id&&!deps.getSession(id);const file=closed?path.join(deps.dataDir,'assistant','workbench','CURRENT.md'):service.refreshDossier().markdownPath;if(!file||!fs.existsSync(file)||!deps.openPath)return{ok:false,error:'工作档案暂不可打开'};const error=await deps.openPath(file);return error?{ok:false,error}:{ok:true,path:file};},
  }))ipcMain.handle('assistant:'+name,async(_event,request={})=>{try{return await handler(request);}catch(error){return{ok:false,error:error.message};}});
  return service;
}
module.exports={registerAssistantIpc};
