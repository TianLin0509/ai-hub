'use strict';
const path=require('node:path');
const fs=require('node:fs');
const { randomUUID }=require('node:crypto');
const INNER_PURPOSES=['memory-dream','hub-orchestrator','company-assistant'];
const { AssistantHistory }=require('./history');
const { AssistantStore }=require('./store');
const { AssistantBridge }=require('./bridge');
const { buildBootstrapPrompt,resolveTimeRange }=require('./context');
const {AssistantSnapshots}=require('./snapshots');
const { readGroupHistory }=require('./group-history');
const { requireAuthorizedTarget,requireBoundTarget,bindOperation }=require('./action-policy');
const {nativeId}=require('./live-history');
const {AssistantWatches,reminderIntent}=require('./watches');
const {isAssistantSession,requireManagerCaller}=require('./permissions');
const {projectSessionStates}=require('./session-state');
const backends=require('./backends');
const profiles=require('./profiles');
const dispatch=require('./dispatch');
// 助理始终是同一个长寿会话（上下文由 CLI 自带压缩），每天在同一会话里写一次交接记录，见 rotation.js。
const rotation=require('./rotation');
const EVENT_KINDS=new Set(['claude','codex','deepseek','kimi','gemini']); // 这些后端答完一轮会发完成事件
const PREWARM_RECENT_MS=3*86400000;
const CHECKPOINT_PROMPT='【交接记录】这是每天一次的交接记录：你继续担任助理（还是这个会话），这份记录用于上下文压缩后或以后新开会话时接续。先把最近发现的用户稳定偏好或长期约定用 update_memory 记下来（已记过的不重复）。确认 USER.md 里有用户的称呼、工作领域、常在城市和沟通偏好，MEMORY.md 里有常用项目与长期约定，缺的从你已知的全局规则和对话中整理补上，每条一句、具体可用，不写密钥、账号和家人下属的私人细节。然后用不超过 300 字写交接，只写接续需要的内容：1. 还没办完或在等结果的事；2. 用户最近定下的决定和偏好；3. 正在关注的任务及当前状态。不派工、不新建会话，只输出交接正文。';
const HANDOFF_PROMPT='【换班交接】你即将换班，接班的是同一位助理的新会话，它只能看到你写的交接、成长记忆和 Hub 记录。先把这一班里发现的用户稳定偏好或长期约定用 update_memory 记下来（已记过的不重复）。然后用不超过 300 字写交接，只写对接班有用的内容：1. 还没办完或在等结果的事；2. 用户最近定下的决定和偏好；3. 正在关注的任务及当前状态。不派工、不新建会话，只输出交接正文。';
const SYSTEM_PREFIXES=['【Hub 告警，不是用户原话】','【Hub 知会，不是用户原话】','【负责人交卷，不是用户原话】','【负责人请用户拍板，不是用户原话】'];
const isSystemInjection=text=>SYSTEM_PREFIXES.some(p=>String(text||'').startsWith(p));
class AssistantService {
  constructor(deps) {
    this.taskGroups=new (require('./task-groups').TaskGroups)(deps.dataDir,{ttlMs:deps.dispatchGrantTtlMs});
    this.deps=deps; this.sessionViews=new Map(); this.store=new AssistantStore(path.join(deps.dataDir,'assistant'));
    this.history=new AssistantHistory(deps.historyDatabasePath||path.join(deps.dataDir,'cache','session-search-v3.sqlite'));
    this.bridge=new AssistantBridge(request=>this.invokeTool(request)); this.currentRequest=null; this.inputModes=new Map();
    this.endpointFile=path.join(deps.dataDir,'assistant','bridge-endpoint.json');
    this.snapshots=new AssistantSnapshots(deps.dataDir,this.store);
    this.dossier=new (require('./dossier').AssistantDossier)(deps.dataDir);
    this.liveHistory=new (require('./final-readers').AssistantFinalReaders)(deps);
    this.continuity=new (require('./continuity').AssistantContinuity)(path.join(deps.dataDir,'assistant'));
    this.dialog=new (require('./dialog-log').DialogLog)(path.join(deps.dataDir,'assistant'));
    this.reminders=new (require('./reminders').AssistantReminders)({store:this.store,isOwner:()=>this.ownsTimers(),onFire:r=>this.fireReminder(r),onReschedule:r=>{try{this.deps.onReminderChanged?.({action:'set',reminder:r});}catch{}}});
    // 提醒检查不能因数据库已关闭等异常把进程带崩（测试结束、Hub 退出时）。
    this.memos=new (require('./memos').AssistantMemos)({store:this.store,reminders:this.reminders,isOwner:()=>this.ownsTimers(),onChange:memo=>{try{this.deps.onMemosChanged?.(memo);}catch{}},onDigest:d=>this.watches.addNotice({id:d.id,title:'备忘清单',kind:'memo-digest',label:'晚间备忘',text:d.text})});
    if(!deps.noReminderTimer)setTimeout(()=>{try{this.reminders.schedule();this.memos.schedule();}catch(e){console.warn('[assistant] reminders',e.message);}},3000).unref?.();
    this.memory=new (require('./memory').AssistantMemory)(path.join(deps.dataDir,'assistant','memory'));
    this.ledger=new (require('./ledger').AssistantLedger)(path.join(deps.dataDir,'assistant','ledger'),{read:(meta,options)=>this.liveHistory.read(meta,options)});
    this.workbench=new (require('./workbench').AssistantWorkbench)({assistant:this});
    this.secretary=new (require('./daily-secretary').DailySecretary)({assistant:this});
    if(!deps.noReminderTimer){require('./timer-owner').claimTimers(this.store);setTimeout(()=>this.secretary.schedule(),4000).unref?.();}
    // 认领表（2026-11-18 订阅直通）：谁的事件送给谁；组队成员的负责人从组队数据现查。
    this.claims=new (require('./claims').Claims)({dir:path.join(deps.dataDir,'assistant'),getTeams:()=>this.deps.getTeams?.()||[],getSession:id=>this.deps.getSession(id)});
    // 关注推送不推「无更新」暗号；前台新开任务时顺手加的关注（auto），负责人改走交卷直送（handoff-feed），不再逐轮推原文。
    const muteWatch=(watch,record)=>require('../team-silent-reply').isNoUpdateReply(record?.text)||(!!watch.auto&&this.claims.isFrontLead(watch.sessionId));
    this.watches=new AssistantWatches(this.store,{mute:muteWatch,getSession:id=>this.sessionMetadata(id),getOpenSession:id=>this.deps.getSession(id)?this.sessionMetadata(id):null,readFinal:(meta,options)=>this.liveHistory.read(meta,options),onNotification:notice=>{try{if(notice.kind!=='restart-resume'&&notice.kind!=='auto-resume')this.logDialog({id:'notice:'+notice.id,role:'assistant',lane:'notice',by:notice.title||'提醒',text:notice.text||'',...(notice.progress?{progress:notice.progress}:{}),...(notice.jump?{card:'lead-brief',kind:notice.kind,label:notice.label,jump:notice.jump,brief:notice.brief||[],code:notice.code||null}:{})});}catch(error){console.warn('[assistant] notice dialog',error.message);}this.deps.onAssistantNotification?.(notice);}});
    // 重启后一键续跑：它的通知不写成提醒气泡，卡片由 restart-resume.js 自己写进对话流。
    this.restartResume=new (require('./restart-resume').RestartResume)(this);
    this.autoResumeCards=new (require('./auto-resume-card').AutoResumeCards)(this);
    this.progressFeed=new (require('./progress-feed').ProgressFeed)(this);
    this.feedStore=deps.noFeedStore?null:new (require('./feed-store').FeedStore)({dir:path.join(deps.dataDir,'assistant')});
    this.handoff=new (require('./handoff-feed').HandoffFeed)(this,{store:this.feedStore});
    // 入口适配层（2026-11-21）：各端先过 intake；拍板编号、回一行路由、按端字数和推送路由都在这里。
    {const door=require('./front-door');this.frontDoor=new door.FrontDoor(this,{healthPollMs:deps.noReminderTimer?0:undefined});door.publish(this.frontDoor);}
    this.patrol=new (require('./patrol').FrontPatrol)(this);if(!deps.noReminderTimer)this.patrol.start();
    // 一轮多派：不设人数上限，只限制同时启动的会话数，其余依次开工并回执「排队中」。
    this.dispatchQueue=new (require('./dispatch-queue').DispatchQueue)({store:this.feedStore,run:(job,ack)=>this.execute(job.action,{...job.options,onLedger:ack}),hasLedger:id=>this.store.has(id),
      notify:(job,r)=>{void this.frontDoor?.push({id:'dispatch-failed:'+job.id,title:'派活',kind:'dispatch-failed',label:'派活失败',text:`排队的任务「${String(job.action.title||'').slice(0,30)}」没派出去：${r?.error||'未确认送达'}。`});}});
    this.frontClient=new (require('./front-client').FrontClient)(this,{onChange:parks=>{try{this.deps.onParksChanged?.(parks);}catch{}}});
    // m3 会话健康与处置（2026-11-15）：4 道检查点、按键/停止/重启/换号接力、远端监督、主动告警，见 health-wiring.js。
    this.care=require('./health-wiring').attach(this);
    try{if(this.feedStore?.load('desk').length)void this.desk;}catch(error){console.warn('[assistant] desk restore',error.message);}
  }
  sessionMetadata(id){const persisted=this.deps.getSessionMetadata?.(id),live=this.deps.getSession(id);return persisted||live?{...persisted,...live,id}:null;}
  setSessionViews({changed=[],removed=[]}={}){
    for(const id of removed)this.sessionViews.delete(id);
    for(const row of changed){
      if(!this.deps.getSession(row.id)||!row.hubState||!['run','wait','error','unread','dorm','idle','unknown'].includes(row.hubState.state))continue;
      this.sessionViews.set(row.id,row);
    }
  }
  sessions() {const all=new Map();for(const s of this.deps.listKnownSessions?.()||[]){const id=s.id||s.hubId;if(id)all.set(id,{...s,id,isOpen:false,status:'closed'});}for(const s of this.deps.getAllSessions?.()||[])all.set(s.id,{...all.get(s.id),...s,isOpen:true,sidebarView:this.sessionViews.get(s.id)});const own=new Set(this.assistantIds());return projectSessionStates([...all.values()].filter(s=>!own.has(s.id)&&s.purpose!=='hub-assistant'));}
  assistantIds(){return Object.values(backends.bindings(this.store));}
  captureContinuity(){for(const id of this.assistantIds()){const meta=this.sessionMetadata(id);if(!meta)continue;for(const row of this.liveHistory.read(meta).records)this.continuity.add({...row,provider:meta.kind,timestamp:row.timestamp||Date.now()});}}
  liveInventory(){return this.sessions().map(s=>{const result=s.isOpen?this.liveHistory.read(s):null;return{...s,nativeSessionId:nativeId(s),latestFinal:result?.records.at(-1)||null,liveIssue:result?.issue||null};});}
  get videos(){if(!this._videos)this._videos=new (require('./video-studio').VideoStudio)({assistant:this});return this._videos;}
  get photo(){if(!this._photo)this._photo=new (require('./photo-assistant').PhotoAssistant)(this);return this._photo;}
  sessionCards(request){return require('./session-cards').sessionCards(this,request);}
  readLiveFinal(sessionId){const meta=this.sessionMetadata(sessionId);if(!meta)throw new Error('找不到原会话');const result=this.liveHistory.read(meta);return{sessionId,title:meta.title,...result};}
  // 不做固定频率的心跳：会话答完一轮由完成事件记账与提醒；换班按精确时间点（空闲 2 小时、每天 4 点）触发；
  // 每 2 小时做一次全面核对补漏；只有被关注的会话不发完成事件（千问、GLM 等）时，才每 5 分钟补查关注任务。
  startWatching({reconcileMs=2*3600000,safetyPollMs=300000,startupDelayMs=20000,prewarmDelayMs=1000}={}){
    if(this.reconcileTimer)return;
    const unref=timer=>{timer?.unref?.();return timer;};
    if(prewarmDelayMs>=0)this.prewarmTimer=unref(setTimeout(()=>void this.prewarm(),prewarmDelayMs));
    this.startupTimer=unref(setTimeout(()=>this.scheduledReconcile(),startupDelayMs));
    this.reconcileTimer=unref(setInterval(()=>this.scheduledReconcile(),reconcileMs));
    this.safetyTimer=unref(setInterval(()=>{try{if(this.ownsAssistant()&&this.watches.list().some(w=>w.state!=='paused-closed'&&!EVENT_KINDS.has(this.sessionMetadata(w.sessionId)?.kind)))this.pollWatches();}catch{}},safetyPollMs));
    this.scheduleDaily();
    try{this.restartResume.watch();}catch(error){console.warn('[assistant] restart-resume',error.message);}
  }
  // 启动预热（2026-11-11）：主进程启动 1 秒后就在后台把前台助理的会话拉起来，不等界面。此前要等界面加载完、自动打开助理页时才拉（会话多时界面要 10 秒左右，
  // 生产实测第 11 秒才开始拉），CLI 冷启动的 4–7 秒排在界面加载后面；现在两段同时进行。
  // 只预热最近 3 天用过的前台；从没用过或久不用的不白占一个进程。多开 Hub 时只有负责定时任务的那个预热。
  async prewarm(now=Date.now()){
    const id=backends.bindings(this.store)[this.activeKind()];
    if(!id||this.deps.getSession(id)||now-(this.store.get('lastActiveAt:'+id)||0)>PREWARM_RECENT_MS||!this.ownsTimers())return false;
    try{this._ensureTrigger='prewarm';return !!(await this.ensureSession()).ok;}catch(error){console.warn('[assistant] prewarm',error.message);return false;}finally{this._ensureTrigger=null;}
  }
  // 冷启动耗时记录：只记「助理会话不在、需要恢复或新建」的那几次（每天几行），写 diagnostics/assistant-timings.jsonl，超过 200 KB 只留最后 500 行。
  timing(row){
    try{const file=path.join(this.deps.dataDir,'diagnostics','assistant-timings.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
      if(fs.existsSync(file)&&fs.statSync(file).size>200*1024)fs.writeFileSync(file,fs.readFileSync(file,'utf8').trim().split('\n').slice(-500).join('\n')+'\n');
      fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),sinceHubStartMs:Math.round(process.uptime()*1000),...row})+'\n');}catch(error){console.warn('[assistant] timing',error.message);}
  }
  // 只有当前持有助理会话的 Hub 做定时核对，多开 Hub 时不会两边同时写账本。
  ownsAssistant(){const id=this.store.get('sessionId');return !!(id&&this.deps.getSession(id));}
  // 定时任务归属：见 timer-owner.js（不要求助理会话此刻开着）。
  ownsTimers(){return require('./timer-owner').ownsTimers(this.store);}
  scheduledReconcile(){
    if(!this.ownsAssistant())return;
    try{this.reconcileLedger();this.pollWatches();this.ledger.prune();}catch(error){console.warn('[assistant] reconcile',error.message);}
    void this.maybeCheckpointInBackground().catch(error=>console.warn('[assistant] checkpoint',error.message));
  }
  scheduleDaily(){
    clearTimeout(this.dailyTimer);const next=rotation.dailyBoundary(Date.now())+86400000+30000;
    this.dailyTimer=setTimeout(()=>{void this.maybeCheckpointInBackground().catch(()=>{});this.scheduleDaily();},Math.max(1000,next-Date.now()));this.dailyTimer.unref?.();
  }
  scheduleIdleCheckpoint(lastActiveAt){
    clearTimeout(this.idleTimer);
    this.idleTimer=setTimeout(()=>{void this.maybeCheckpointInBackground().catch(error=>console.warn('[assistant] checkpoint',error.message));},Math.max(1000,lastActiveAt+rotation.IDLE_MS+60000-Date.now()));this.idleTimer.unref?.();
  }
  // 任一会话答完一轮：助理自己 → 记上下文用量并排好空闲换班；其他会话 → 立即记账，被关注则立即提醒。
  onTurnComplete(sessionId,event={}){
    if(this.store.get('photoAssistant')?.id===sessionId){this.deps.onAssistantTurnComplete?.(sessionId);return;}
    const at=Number(event.completedAt)||Date.now();
    if(this.assistantIds().includes(sessionId)){this.observeUsage(sessionId,event.usage,at);this.store.set('lastActiveAt:'+sessionId,at);this.scheduleIdleCheckpoint(at);
      try{this.deps.onAssistantTurnComplete?.(sessionId);}catch{}
      this.secretary?.schedule();
      if(this._desk){setTimeout(()=>this._desk.check(),300).unref?.();}
      setTimeout(()=>{try{this.checkSystemReplies();}catch(error){console.warn('[assistant] system reply',error.message);}},300).unref?.();return;}
    const meta=this.sessionMetadata(sessionId);if(!meta||meta.purpose==='hub-assistant')return;
    // 前台的负责人答完一轮走交卷直送（交卷、拍板进前台，中途进展只进看板）；其他普通会话照旧出进展提醒。
    try{const entries=this.ledger.record({...meta,id:sessionId});if(!this.handoff.onTurn(sessionId,meta,entries))this.progressFeed.onTurn(sessionId,meta,entries);}catch(error){console.warn('[assistant] ledger',error.message);}
    if(this.ownsAssistant()&&this.watches.list().some(w=>w.sessionId===sessionId))this.pollWatches();
  }
  reconcileLedger(){
    const metas=this.sessions().map(s=>({...(this.sessionMetadata(s.id)||s),id:s.id,isOpen:s.isOpen}));
    return this.ledger.reconcile(metas,{groupSources:since=>readGroupHistory({dataDir:this.deps.dataDir,since,until:Date.now(),query:'',maxChars:20000,maxFiles:30,meetings:this.deps.getMeetings?.()})});
  }
  // 定时器只检查「关注的任务有没有新回复」（结果推到手机和助理页靠它）。工作台按需刷新：
  pollWatches(){return this.watches.poll();}
  notifications(request){return this.watches.notifications(request);}
  followedTasks(){return this.watches.list().map(({cursor,seen,...watch})=>watch);}
  observePromptReceipt(snapshot){
    if(snapshot?.status!=='confirmed'||snapshot.notSent||snapshot.contentMismatch||!snapshot.clientSubmissionId||!snapshot.sessionId)return false;
    if(snapshot.sessionId===this.currentRequest?.sessionId&&snapshot.clientSubmissionId===this.currentRequest.id)this.continuity.add({id:'user:'+snapshot.clientSubmissionId,sessionId:snapshot.sessionId,provider:this.store.get('backendKind')||'codex',role:'user',deliveryState:'confirmed',timestamp:this.currentRequest.createdAt,text:this.currentRequest.text});
    const row=this.store.db.prepare('SELECT state,result FROM actions WHERE id=?').get(snapshot.clientSubmissionId);
    if(!row||row.state!=='unknown'||!row.result)return false;
    const result=JSON.parse(row.result);if(result.sessionId!==snapshot.sessionId)return false;
    this.store.finish(snapshot.clientSubmissionId,'acknowledged',{...result,originalReceipt:result.receipt,lateReceipt:snapshot,
      receipt:{...result.receipt,ok:true,lateReconciled:true,receipt:{...result.receipt?.receipt,...snapshot,status:'confirmed'}}});return true;
  }
  followTask({sessionId,auto=false}){if(this.assistantIds().includes(sessionId)||this.sessionMetadata(sessionId)?.purpose==='hub-assistant')throw new Error('助理不能关注自身回复');return{ok:true,watch:this.watches.follow(sessionId,{auto})};}
  overview() {
    const sessionId=this.store.get('sessionId'),session=sessionId?this.deps.getSession(sessionId):null,lastContext=this.store.get('lastContext');
    const runtime=session?.cliRuntime||session?.nativeRuntime,issue=runtime?.connection==='disconnected'?runtime.reason||'原生后端连接中断':null;
    return{ok:true,sessionId,backendKind:this.store.get('backendKind')||'codex',profile:this.currentProfile(),context:this.contextStatus(),backends:backends.SELECTABLE_BACKENDS,backendSessions:backends.bindings(this.store),available:!!session,submissionPending:!!this.deps.hasPendingPrompt?.(sessionId),status:session?.status||'not-created',summary:'',connectionSummary:issue?'助理后端未连接：'+issue:session?'助理会话已打开；账号可用性和执行结果以原生回执为准。':'首次启用后，助理作为独立会话运行，可选择 Hub 支持的后端并连接专属工具。',toolConfiguration:'助理专用 lean 配置，连接 Hub 助理工具；普通会话配置保持不变。',needsAttention:issue?[issue]:[],updatedAt:lastContext?.asOf||null,contextCoverage:lastContext,actions:this.store.list(),followedTasks:this.followedTasks(),watchableSessions:this.sessions().map(s=>({id:s.id,title:s.title||s.name,kind:s.kind,status:s.status,isOpen:s.isOpen})),...this.notifications({limit:10})};
  }
  async ensureSession() {
    if(this.creating)return this.creating;
    if(this.switching)throw new Error('助理正在切换后端，请稍候');
    // 迁移与创建放在同一个 creating 里串行，并发的就绪请求只会得到同一个助理。
    this.creating=(async()=>{
      if(this.store.get('assistantDefaultsVersion')!==2){const migrated=await this.migrateDefaults();if(migrated)return migrated;}
      return this._ensureSession(this.activeKind());
    })();
    try{return await this.creating;}finally{this.creating=null;}
  }
  activeKind(){return this.store.get('backendKind')||profiles.ASSISTANT_DEFAULT_KIND;}
  // 每轮结束时记下助理上下文用量（来自 CLI 原生记录的 usage）、最后活动时间，并记一行速度日志供校准阈值。
  observeUsage(sessionId,usage,completedAt=Date.now()){
    if(!usage||!this.assistantIds().includes(sessionId))return null;
    const meta=this.sessionMetadata(sessionId),kind=meta?.kind;
    const tokens=require('../ai-kinds').isCodexCliKind(kind)?Number(usage.input_tokens)||0
      :(Number(usage.input_tokens)||0)+(Number(usage.cache_read_input_tokens)||0)+(Number(usage.cache_creation_input_tokens)||0);
    this.store.set('contextTokens:'+sessionId,tokens);this.store.set('lastActiveAt:'+sessionId,completedAt);
    const clock=this.turnClock?.sessionId===sessionId?this.turnClock:null,ms=clock?Math.max(0,completedAt-clock.at):null;
    if(clock)this.turnClock=null;
    this.recordMetric({at:completedAt,sessionId,kind,model:require('../session-capabilities').sessionModelId(meta),effort:meta?.effort||null,tokens,ms,origin:clock?.origin||'unknown'});
    return tokens;
  }
  recordMetric(row){
    try{const file=path.join(this.deps.dataDir,'assistant','turn-metrics.jsonl');
      if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024)fs.renameSync(file,file.replace(/\.jsonl$/,'.1.jsonl'));
      fs.appendFileSync(file,JSON.stringify(row)+'\n');}catch(error){console.warn('[assistant] metrics',error.message);}
  }
  checkpointReasonFor(id){
    return rotation.checkpointReason({tokens:this.store.get('contextTokens:'+id),lastActiveAt:this.store.get('lastActiveAt:'+id),lastCheckpointAt:this.store.get('lastCheckpointAt:'+id)||0});
  }
  contextStatus(){
    const kind=this.activeKind(),id=backends.bindings(this.store)[kind],meta=id?this.sessionMetadata(id):null;
    return{tokens:id?this.store.get('contextTokens:'+id):null,cap:meta?.contextMax||null,lastActiveAt:id?this.store.get('lastActiveAt:'+id):null,
      checkpointDue:id?this.checkpointReasonFor(id):null,lastCheckpoint:this.store.get('lastCheckpoint'),lastRotation:this.store.get('lastRotation')};
  }
  // 每天一次交接记录：只对已打开且空闲的助理进行，在同一会话里复盘并写交接，不换会话。
  async maybeCheckpointInBackground(){
    if(!this.workbench.config().checkpoint)return null; // 2026-11-11 默认关，见 workbench.js
    if(/^claude(?:-resume)?$/.test(this.activeKind()))return null;
    if(this.creating||this.switching||this.checkpointing||this.store.get('assistantDefaultsVersion')!==2)return null;
    const kind=this.activeKind(),id=backends.bindings(this.store)[kind],session=id&&this.deps.getSession(id);
    if(!session)return null;
    if(require('../session-runtime-truth').sessionRuntimeIsActive(session)||['running','waiting'].includes(session.status)||this.deps.hasPendingPrompt?.(id))return null;
    const reason=this.checkpointReasonFor(id);if(!reason)return null;
    this.checkpointing=true;
    try{
      const since=this.store.get('lastReviewAt')||Date.now()-86400000;
      const text=await this.writeHandoff(kind,id,this.reviewPrompt(since,CHECKPOINT_PROMPT),420000,'【交接记录】');
      const now=Date.now();this.store.set('lastCheckpointAt:'+id,now);
      if(text){this.store.set('lastReviewDay',require('./ledger').localDay(now));this.store.set('lastReviewAt',now);}
      this.store.set('lastCheckpoint',{at:now,kind,reason,reasonLabel:rotation.REASON_LABELS[reason]||reason,sessionId:id,ok:!!text});
      return{ok:!!text,sessionId:id,reason};
    }finally{this.checkpointing=false;}
  }
  async maybeRotateInBackground({reason:forced}={}){
    if(this.creating||this.switching||this.store.get('assistantDefaultsVersion')!==2)return null;
    const kind=this.activeKind(),id=backends.bindings(this.store)[kind];
    if(!id||!this.deps.getSession(id))return null;
    const reason=forced;if(!reason)return null;
    this.creating=(async()=>{const rotated=await this.rotate(kind,id,{reason,handoff:true});return rotated||this._ensureSession(kind);})();
    try{return await this.creating;}finally{this.creating=null;}
  }
  rotateNow(){
    if(this.creating||this.switching)throw new Error('助理正在连接或切换，请稍候');
    const id=backends.bindings(this.store)[this.activeKind()],session=id&&this.deps.getSession(id);
    if(!session)throw new Error('助理尚未打开，下次打开时会直接用新会话');
    if(require('../session-runtime-truth').sessionRuntimeIsActive(session)||['running','waiting'].includes(session.status)||this.deps.hasPendingPrompt?.(id))throw new Error('助理正在回答，请等本轮结束后再新开');
    return this.maybeRotateInBackground({reason:'manual'});
  }
  reviewPrompt(sinceMs,base=HANDOFF_PROMPT){
    const files=this.nativeMemoryUpdates(sinceMs);
    return base+'在写交接之前先做今天的复盘：① 回顾今天和用户的交流，他没说「记住」但已明确表态或反复体现的偏好与约定，用 update_memory 记下；与旧条目矛盾的更新，重复的合并，只出现一次的推测不记。'
      +(files.length?'② 下面是今天更新过的 CLI 自带记忆（只在各自的 CLI 里自动生效），读一下，把与用户合作方式相关、稳定有价值的内容同步进 USER.md / MEMORY.md：'+files.join('；')+'。':'② 今天两家 CLI 自带记忆没有相关更新。');
  }
  // Claude Code 自动记忆目录里 user/feedback 类条目、Codex 记忆摘要，取 since 之后改过的。
  nativeMemoryUpdates(sinceMs){
    const os=require('node:os'),home=os.homedir(),files=[];
    const roots=this.deps.nativeMemoryRoots||(()=>{
      const list=[];
      try{const settings=JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),'settings.json'),'utf8'));if(settings.autoMemoryDirectory)list.push({kind:'claude',dir:settings.autoMemoryDirectory});}catch{}
      for(const codexHome of [process.env.CODEX_HOME||path.join(home,'.codex'),...(()=>{try{return fs.readdirSync(path.join(home,'.codex-profiles')).map(name=>path.join(home,'.codex-profiles',name));}catch{return[];}})()])list.push({kind:'codex',dir:path.join(codexHome,'memories')});
      return list;
    })();
    for(const root of roots){
      try{
        if(root.kind==='codex'){const file=path.join(root.dir,'memory_summary.md');if(fs.existsSync(file)&&fs.statSync(file).mtimeMs>sinceMs)files.push(file);continue;}
        const realRoot=fs.realpathSync(root.dir);
        for(const name of fs.readdirSync(realRoot)){
          // 只列根目录下名字规整的 .md，且真实路径仍在该目录内（不跟随指向别处的链接）。
          if(!/^[\w.-]+\.md$/.test(name))continue;const file=fs.realpathSync(path.join(realRoot,name));if(path.dirname(file)!==realRoot)continue;const stat=fs.statSync(file);
          if(stat.mtimeMs<=sinceMs)continue;
          const head=fs.readFileSync(file,'utf8').slice(0,600);if(/^\s*type:\s*(user|feedback)\s*$/m.test(head))files.push(file);
        }
      }catch{}
    }
    return files.slice(0,12);
  }
  // 让旧助理写一段交接，写进交接记录（最长等 3 分钟；拿不到就只靠原始记录接续）。
  async writeHandoff(kind,oldId,prompt=HANDOFF_PROMPT,timeoutMs=180000,label='【上一班交接】'){
    const requestId='handoff-'+randomUUID();
    try{const receipt=await this.deps.sendPrompt(oldId,prompt,requestId);if(receipt?.ok===false)return null;}catch(error){console.warn('[assistant] handoff not sent',error.message);return null;}
    for(const end=Date.now()+timeoutMs;Date.now()<end;await new Promise(r=>setTimeout(r,1500))){
      const meta=this.sessionMetadata(oldId);if(!meta)return null;
      const hit=this.liveHistory.read(meta).records.find(row=>row.clientSubmissionId===requestId);
      if(hit?.text){
        this.continuity.add({id:'handoff:'+requestId,sessionId:oldId,provider:kind,role:'assistant',timestamp:Date.now(),text:label+hit.text.trim()});
        // 等这轮在 CLI 里收尾，再休眠旧会话。
        for(const settle=Date.now()+15000;Date.now()<settle;await new Promise(r=>setTimeout(r,500))){const s=this.deps.getSession(oldId);if(!s||!(require('../session-runtime-truth').sessionRuntimeIsActive(s)||['running','waiting'].includes(s.status)))break;}
        return hit.text;
      }
    }
    return null;
  }
  // 换班：同一后端、同一档位新开助理会话，靠交接记录（assistantContinuity 与工作档案）接续；旧会话休眠保留可查。
  async rotate(kind,oldId,{reason='size',handoff=false}={}){
    const old=this.deps.getSession(oldId);
    if(old&&(require('../session-runtime-truth').sessionRuntimeIsActive(old)||['running','waiting'].includes(old.status)||this.deps.hasPendingPrompt?.(oldId)))return null;
    const today=require('./ledger').localDay(Date.now()),review=handoff&&old&&this.store.get('lastReviewDay')!==today;
    // 复盘窗口从上次复盘算起（隔了几天也不漏），复盘比普通交接多给时间。
    const handoffText=handoff&&old?await this.writeHandoff(kind,oldId,review?this.reviewPrompt(this.store.get('lastReviewAt')||Date.now()-86400000):HANDOFF_PROMPT,review?420000:180000):null;
    if(review&&handoffText){this.store.set('lastReviewDay',today);this.store.set('lastReviewAt',Date.now());}
    // 交接超时而旧助理还在跑：这次不换班，等它空下来再说，避免把正在干活的会话休眠掉。
    const stillBusy=s=>s&&(require('../session-runtime-truth').sessionRuntimeIsActive(s)||['running','waiting'].includes(s.status)||this.deps.hasPendingPrompt?.(s.id));
    if(handoff&&old&&stillBusy(this.deps.getSession(oldId)))return null;
    this.captureContinuity();
    backends.retire(this.store,kind,oldId);this.store.set('rotateDue:'+kind,null);
    let result;
    try{result=await this._ensureSession(kind);}catch(error){backends.unretire(this.store,kind,oldId);throw error;}
    if(!result.ok){backends.unretire(this.store,kind,oldId);return null;}
    this.currentRequest=null;this.store.set('lastContext',null);
    this.store.set('lastRotation',{at:Date.now(),kind,reason,reasonLabel:rotation.REASON_LABELS[reason]||reason,oldId,sessionId:result.sessionId,tokens:this.store.get('contextTokens:'+oldId),handoff:!!handoffText});
    console.log('[assistant] rotated',kind,reason,oldId,'->',result.sessionId,'context',this.store.get('contextTokens:'+oldId),'handoff',!!handoffText);
    try{await this.deps.retireSession?.(oldId);}catch(error){console.warn('[assistant] retire old session',error.message);}
    this.deps.onAssistantRotated?.({kind,oldId,sessionId:result.sessionId});
    return result;
  }
  // 2026-10-03：助理默认改为快速档（Sonnet 5.5 · 低思考）。旧数据只迁移一次，之后完全按用户选择。
  // 老用户走正规的后端切换：助理忙时推迟到下次空闲；切换失败就留在原后端并不再重试。
  async migrateDefaults(){
    const kind=profiles.ASSISTANT_DEFAULT_KIND,previous=this.store.get('backendKind'),currentId=this.store.get('sessionId');
    const markProfile=()=>{this.store.set('profile:'+kind,profiles.ASSISTANT_DEFAULTS[kind]);this.store.set('profilePending:'+kind,true);};
    if(!currentId||previous===kind||!previous){markProfile();this.store.set('backendKind',kind);this.store.set('assistantDefaultsVersion',2);return null;}
    const current=this.deps.getSession(currentId);
    if(current&&(require('../session-runtime-truth').sessionRuntimeIsActive(current)||['running','waiting'].includes(current.status)||this.deps.hasPendingPrompt?.(currentId)))return null;
    const before={profile:this.store.get('profile:'+kind),pending:!!this.store.get('profilePending:'+kind)};
    markProfile();this.store.set('assistantDefaultsVersion',2);
    try{const result=await this.switchUnguarded(kind);if(result.ok)return result;}catch(error){console.warn('[assistant] default migration kept',previous,error.message);}
    this.store.set('profile:'+kind,before.profile);this.store.set('profilePending:'+kind,before.pending);
    return null;
  }
  currentProfile(){
    const kind=this.activeKind();
    const id=backends.bindings(this.store)[kind],live=id?this.deps.getSession(id):null,saved=this.store.get('profile:'+kind)||profiles.ASSISTANT_DEFAULTS[kind]||{};
    const {sessionModelId}=require('../session-capabilities');
    const pending=!!this.store.get('profilePending:'+kind);
    const model=(!pending&&live&&sessionModelId(live))||saved.model||sessionModelId(live)||null;
    return{...profiles.describe(kind,model,(!pending&&live?.effort)||saved.effort||null),pending};
  }
  // 切换助理的后端、模型或思考深度。设置先保存；助理空闲时立即按新模型重启原会话（保留历史），忙时等下一次就绪再生效。
  async setProfile({kind,model,effort}={}){
    backends.backendKind(kind);
    const defaults=await this.deps.getDefaults?.(kind)||{};
    const picked=profiles.pick(kind,{model,effort},{...defaults,...(profiles.ASSISTANT_DEFAULTS[kind]||{})});
    this.store.set('assistantDefaultsVersion',2); // 用户亲自选择后不再做默认迁移
    const previous={profile:this.store.get('profile:'+kind),pending:!!this.store.get('profilePending:'+kind)};
    const restore=()=>{this.store.set('profile:'+kind,previous.profile);this.store.set('profilePending:'+kind,previous.pending);};
    this.store.set('profile:'+kind,picked);this.store.set('profilePending:'+kind,true);this.profileError=null;
    // 换后端失败（例如助理正在回答）时撤回本次设置，避免之后悄悄生效。
    let result;try{result=kind!==this.store.get('backendKind')?await this.switchBackend({kind}):await this.ensureSession();}catch(error){restore();throw error;}
    if(!result.ok){restore();return result;}
    if(this.profileError){const error=this.profileError;this.profileError=null;return{ok:false,error,profile:this.currentProfile()};}
    return{ok:true,profile:this.currentProfile()};
  }
  recentHistory(){return this.continuity.records.slice(-6).map(row=>({role:row.role,text:row.text}));}
  recordFastLane({id,question,answer,model}){
    const at=Date.now();
    this.continuity.add({id:'user:'+id,sessionId:'fast-lane',provider:'fast-lane',role:'user',deliveryState:'confirmed',timestamp:at-1,text:question});
    this.continuity.add({id:'fast:'+id,sessionId:'fast-lane',provider:'fast-lane:'+(model||''),role:'assistant',timestamp:at,text:answer});
  }
  // 手机消息的回答方式：api＝前台快答（默认），cli＝每条交给助理会话。设置保存后立即生效，手机与电脑面板同步。
  frontDesk(){return require('./front-desk').describe(this.store.get('frontDesk'),{legacyDisabled:this.store.get('fastLaneDisabled')===true});}
  setFrontDesk(input={}){
    const fd=require('./front-desk'),picked=fd.validate(input),before=this.frontDesk();
    this.store.set('frontDesk',{mode:picked.mode,model:picked.model||before.model});
    const after=this.frontDesk();try{this.deps.onFrontDeskChanged?.(after);}catch{}
    return{ok:true,frontDesk:after};
  }
  fastLaneDisabled(){return this.frontDesk().mode==='cli';}
  // 快答用的 Hub 只读状态摘要（会话、最近结果、关注、待提醒）。
  // 会话是否在干活：PTY 会话以 CLI hook 报告的本轮为准（列表里的 status 对它们常显示空闲），再看原生运行态与待核对的提交。
  sessionBusy(id){const s=this.deps.getSession(id);if(!s)return false;return !!this.deps.isAgentTurnActive?.(id)||require('../session-runtime-truth').sessionRuntimeIsActive(s)||['running','waiting'].includes(s.status)||!!this.deps.hasPendingPrompt?.(id);}
  // 负责人看板：组队记录 + 进展卡快照 + 答复账本（2026-11-03）。任一数据源不可用时按空处理，不影响其余资料。
  leadBoard(sessions=this.sessions()){
    let teams=[],cards=[];
    try{teams=this.deps.getTeams?.()||[];}catch(error){console.warn('[assistant] teams',error.message);}
    try{cards=this.deps.getProgressCards?.()||[];}catch(error){console.warn('[assistant] progress cards',error.message);}
    let ledger=[];try{ledger=this.ledger.entries();}catch{}
    return require('./lead-board').buildLeadBoard({teams,cards,sessions,ledger,since:this.store.get('lastAskAt')||null});
  }
  // 当前概览弹窗（2026-11-25）：待我决策 + 任务进展。数据源任一不可用按空处理，弹窗照样能开。
  overviewBoard(){
    let tasks=[],teams=[],cards=[],parks={};
    try{tasks=this.frontClient.tasks().tasks||[];}catch(error){console.warn('[assistant] overview tasks',error.message);}
    const sessions=new Map(),inner=new Set();let all=[];
    try{all=this.sessions();for(const s of all){sessions.set(s.id,{open:!!s.isOpen,closedByUser:!s.isOpen&&s.suspendReason==='user-close',title:s.title||s.name||''});if(INNER_PURPOSES.includes(s.purpose))inner.add(s.id);}}catch(error){console.warn('[assistant] overview sessions',error.message);}
    tasks=tasks.filter(t=>!inner.has(t.id));
    try{teams=this.deps.getTeams?.()||[];}catch(error){console.warn('[assistant] overview teams',error.message);}
    try{cards=this.deps.getProgressCards?.()||[];}catch(error){console.warn('[assistant] overview cards',error.message);}
    try{parks=this.frontClient.parks();}catch{}
    const dec=this.frontDoor?.decisions;
    let appVersion='';try{appVersion=require('../../package.json').version||'';}catch{}
    const keepOuter=d=>d&&!inner.has(d.sessionId);
    let skips=[],skipsIssue='';const store=this.overviewSkips();
    try{skips=store.load();if(store.recovered)skipsIssue=`跳过记录文件损坏，已备份到 ${store.recovered}，之前跳过的可能重新出现`;}catch(error){skipsIssue=`跳过记录这次没读出来（${error.message}），之前跳过的可能暂时又出现`;}
    const board=require('./overview-board').buildOverview({tasks,teams,cards,parks,sessions,appVersion,skips,
      decisions:dec?dec.list().filter(keepOuter):[],answered:dec?dec.recentAnswered().filter(keepOuter):[]});
    if(skipsIssue)board.decisions.filtered.skipsIssue=skipsIssue;
    // 同一问还在的跳过记录：标成在用（不受 90 天 / 500 条清理），并每月续期一次（复验建议 8）。
    else{store.inUse=new Set(board.decisions.skipKeysInUse||[]);const old=new Set(skips.filter(r=>Date.now()-(r.at||0)>30*86400000).map(r=>r.key)),touch=(board.decisions.skipKeysInUse||[]).filter(k=>old.has(k));
      if(touch.length){try{store.touch(touch);}catch(error){console.warn('[assistant] overview skips touch',error.message);}}}
    try{const rs=this.overviewReading(),now=Date.now();let entries=[];try{entries=this.ledger.since(now-14*86400000,{maxEntries:1500,maxChars:3000000}).entries||[];}catch{}
      const skip=new Set([...inner,...[...board.decisions.main,...board.decisions.more].map(x=>x.sessionId)]);
      const frontLeads=new Set(all.filter(x=>{try{return this.claims?.isFrontLead(x.id);}catch{return false;}}).map(x=>x.id));
      const remoteOpen=sid=>{try{return Number(this.care?.remoteOpenFor?.(sid))||0;}catch{return 0;}};
      const r=require('./overview-reading').buildReading({sessions:all,teams,cards,tasks,entries,state:rs.load(),skip,frontLeads,remoteOpen,now});
      if(r.seen.length)rs.view(r.seen,now);delete r.seen;board.reading=r;
    }catch(error){console.warn('[assistant] overview reading',error.message);board.reading={rows:[],older:[],badge:0,total:0,error:error.message};}
    return board;
  }
  overviewReading(){return this._overviewReading||(this._overviewReading=new (require('./overview-reading').ReadingStore)(path.join(this.deps.dataDir,'assistant')));}
  overviewRead({ids=[]}={}){const list=(Array.isArray(ids)?ids:[ids]).filter(x=>typeof x==='string'&&x).slice(0,500);if(!list.length)return{ok:false,error:'没有要标记的会话'};this.overviewReading().view(list,Date.now());return{ok:true,done:list.length};}
  noteViewed(ids){try{this.overviewReading().view(ids,Date.now());}catch(error){console.warn('[assistant] overview viewed',error.message);}}
  noteHandoff(sessionId,info){try{this.overviewReading().handoff(sessionId,info);}catch(error){console.warn('[assistant] overview handoff',error.message);}}
  overviewSkips(){return this._overviewSkips||(this._overviewSkips=new (require('./overview-skips').OverviewSkips)(path.join(this.deps.dataDir,'assistant')));}
  // action：skip（跳过）、undo（撤销跳过）、keep（把自动过期的恢复出来）。服务端按编号现查问题全文，不信任界面传来的文字。
  overviewSkip({items=[],action='skip'}={}){
    if(!['skip','undo','keep'].includes(action))throw new Error('不认识的操作');
    const list=Array.isArray(items)?items.filter(x=>x&&x.id).slice(0,200):[];
    if(!list.length)throw new Error('没有要处理的条目');
    const board=this.overviewBoard(),d=board.decisions,{skipKey,askMatches}=require('./overview-board'),store=this.overviewSkips();
    const live=[...d.main,...d.more,...d.unverified],skipped=d.skipped||[];
    const full=x=>({sessionId:x.sessionId,title:x.title||'',question:x.askQuestion??x.fullQuestion??x.question,recommendation:x.askRecommendation??x.fullRecommendation??x.recommendation??''});
    const pick=(pool,it)=>{const x=pool.find(i=>i.id===it.id);if(!x)return{missing:true};if(it.ver&&x.ver!==it.ver)return{changed:true};return{x};};
    let done=0,changed=0,missing=0;
    if(action==='skip'){
      const rows=[];
      for(const it of list){const p=pick(live,it);if(p.missing){missing++;continue;}if(p.changed){changed++;continue;}const f=full(p.x);rows.push({key:skipKey(f.sessionId,f.question,f.recommendation),kind:'skip',...f});}
      if(rows.length)store.add(rows);done=rows.length;
    }else if(action==='undo'){
      // 撤销删掉所有能对上这一问的跳过记录（编号与卡片、截断与全文可能各记过一条），按实际删掉的条数报（复审第 4 项）。
      const asks=[];for(const it of list){const p=pick(skipped.filter(i=>i.skipKind==='manual'),it);if(p.missing){missing++;continue;}if(p.changed){changed++;continue;}asks.push(full(p.x));}
      if(asks.length){const rows=store.load(),gone=rows.filter(r=>r.kind!=='keep'&&asks.some(a=>askMatches(r,a.sessionId,a.question,a.recommendation)));
        if(gone.length)store.remove(gone.map(r=>r.key));done=asks.filter(a=>gone.some(r=>askMatches(r,a.sessionId,a.question,a.recommendation))).length;missing+=asks.length-done;}
    }else{
      const rows=[];for(const it of list){const p=pick(skipped.filter(i=>i.skipKind==='auto'),it);if(p.missing){missing++;continue;}if(p.changed){changed++;continue;}const f=full(p.x);rows.push({key:'keep:'+skipKey(f.sessionId,f.question,f.recommendation),kind:'keep',...f});}
      if(rows.length)store.add(rows);done=rows.length;
    }
    const word={skip:'跳过',undo:'撤销',keep:'恢复'}[action];
    const text=`已${word} ${done} 条`+(changed?`；${changed} 条负责人刚改了问题，没有处理，请看新问题`:'')+(missing?`；${missing} 条已经不在列表里`:'')+'。';
    return{ok:done>0,done,changed,missing,text};
  }

  async overviewReply({id,action,pick,text,ver}={}){
    const {cardVersion}=require('./overview-board');
    const changed={ok:false,state:'superseded',text:'负责人刚改了这一问，已刷新成新问题，请看过再选。'};
    const dec=this.frontDoor?.decisions;
    if(!dec)throw new Error('前台服务还没就绪，稍后再试');
    let no=null;
    // 编号的版本按弹窗里那一条的身份核对（能对上卡片时是卡上全文）；弹窗里已经没有这一条（被跳过、过期等）时退回按编号自身文字核对（复验 B）。
    if(/^D\d+$/i.test(String(id||''))){no=Number(String(id).slice(1));const cur=dec.get(no);
      if(ver&&cur){let shown=null;try{const d=this.overviewBoard().decisions;shown=[...d.main,...d.more,...d.unverified,...(d.skipped||[])].find(x=>x.id===String(id).toUpperCase())||null;}catch{}
        if((shown?shown.ver:cardVersion(cur.question,cur.recommendation))!==ver)return changed;}}
    else if(String(id||'').startsWith('card:')){
      const sid=String(id).slice(5),c=(this.deps.getProgressCards?.()||[]).find(x=>x?.sessionId===sid);
      const d=c?require('./lead-board').cardView(c,Date.now())?.decision:null;
      if(!d)return{ok:false,state:'superseded',text:'这一问已经不在负责人的进展卡上了，可能已经有人定过。'};
      if(ver&&cardVersion(d.question,d.recommendation)!==ver)return changed;
      const s=this.deps.getSession?.(sid)||this.sessions().find(x=>x.id===sid);
      no=dec.create({sessionId:sid,title:s?.title||s?.name||sid,text:d.question,question:d.question,recommendation:d.recommendation,source:'card',ifNoReply:d.ifNoReply||''}).no;
    }
    if(!no)throw new Error('没有这一条待定');
    const words=String(text||'').trim(),{wording}=require('./decisions');
    let item;
    if(action&&action!=='free'&&!words)item={no,action,pick};
    else if(words){const lead=action&&action!=='free'?{recommend:'按推荐',pick:`选 ${pick}`,skip:'先不做'}[action]:'';const short=[...words].length>30?[...words].slice(0,30).join('')+'…':words;
      item={no,action:'free',text:lead?`${wording({action,pick})}${words}`:words,label:lead?`${lead}，${short}`:short};}
    else throw new Error('先选一个选项或写一句话');
    const r=await dec.answer(item,{endpoint:'desktop',endpointLabel:'电脑'});
    return{...r,ok:r.ok!==false};
  }
  // 2026-11-18 前台纯派活：认领表由 m1 的 claims.js 提供（合同见任务总纲）；没挂到实例上时按数据目录打开。
  frontClaims(){
    if(this.claims)return this.claims;
    const mod=require('./claims');
    return this.claims=typeof mod.createClaims==='function'?mod.createClaims(path.join(this.deps.dataDir,'assistant')):mod;
  }
  // 前台看板：负责人 / 你自己开的 / 其余计数，一会话一行，≤4 KB。任一数据源不可用时按空处理。
  frontBoard(){
    const sessions=this.sessions();let leads=[],cards=[],teams=[],ledger=[];
    try{leads=this.frontClaims().leads()||[];}catch(error){console.warn('[assistant] claims',error.message);}
    try{cards=this.deps.getProgressCards?.()||[];}catch{}
    try{teams=this.deps.getTeams?.()||[];}catch{}
    try{ledger=this.ledger.entries();}catch{}
    const slim=require('./slim');
    return require('./front-board').buildFrontBoard({sessions,leads,cards,teams,ledger,
      isBusy:s=>s.isOpen?this.sessionBusy(s.id):false,
      healthWord:id=>{try{return this.care?.health?.word?.(id)||null;}catch{return null;}},
      readCardFirst:file=>{try{return require('./front-board').firstLine(slim.cardSections(require('node:fs').readFileSync(file,'utf8')).forYou);}catch{return'';}}});
  }
  // 最后一次最终回复（答复账本里最新一条），read_progress 没有进展卡时用。
  lastReplyOf(sessionId){let last=null;try{for(const e of this.ledger.entries())if(e.sessionId===sessionId&&(!last||e.at>last.at))last=e;}catch{}return last;}
  // 收编：会话号精确匹配优先，否则按标题关键词唯一命中；登记成负责人（owner=front）。
  claimSession({session,title}={}){
    const ref=String(session||'').trim();if(!ref)throw new Error('请给会话编号或标题关键词');
    const all=this.sessions();let hits=all.filter(s=>s.id===ref);
    if(!hits.length){const k=ref.toLowerCase();hits=all.filter(s=>String(s.title||s.name||'').toLowerCase().includes(k)||String(s.id).toLowerCase().startsWith(k));}
    if(hits.length>1){const open=hits.filter(s=>s.isOpen);if(open.length===1)hits=open;}
    if(!hits.length)throw new Error('没有找到这个会话；换个关键词，或用 list_sessions keyword 查编号');
    if(hits.length>1)throw new Error(`「${ref}」命中 ${hits.length} 个会话：`+hits.slice(0,5).map(s=>s.id+' '+(s.title||s.name||'')).join('；')+'。请给更具体的关键词或编号');
    const s=hits[0],claim=this.frontClaims().claim(s.id,{title:String(title||s.title||'').slice(0,100),by:'adopt'});
    const team=this.registerLead(s.id,title||s.title);
    return{ok:true,team,sessionId:s.id,title:s.title||s.name||'',claim,note:'已登记为负责人：此后它的卡住、失败等事件直接送它自己，交卷或要你拍板时再由前台转告。'};
  }
  // 2026-11-19 前台行为改进：侧栏「项目」只看组队名册（team.registered），前台认领表（claims.json）另是一本；
  // 收编和带 lead 的新建同时登进名册，没招成员的负责人也不再掉进「零碎」。失败只回报，不影响派工本身。
  registerLead(sessionId,project){
    if(!this.deps.registerTeamLead)return{ok:false,error:'组队服务不在'};
    try{const r=this.deps.registerTeamLead({sessionId,project:String(project||'').slice(0,40)});return r?.ok?{ok:true,project:'已进侧栏「项目」'}:{ok:false,error:'组队服务未返回结果'};}
    catch(error){return{ok:false,error:error.message};}
  }
  statusDigest(){
    try{const sessions=this.sessions().map(x=>x.isOpen&&x.status!=='waiting'&&this.sessionBusy(x.id)?{...x,status:'running'}:x);return require('./status-digest').buildStatusDigest({sessions,ledger:this.ledger.entries(),followed:this.followedTasks(),reminders:this.reminders.list(),leadBoard:this.leadBoard(sessions)});}
    catch(e){console.warn('[assistant] status digest',e.message);return '';}
  }
  fireReminder(r){
    try{this.memos?.reminderFired(r);}catch{}
    const late=r.late?'（原定 '+new Date(r.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false})+'，Hub 当时没开，现在补上）':'';
    this.watches.addNotice({id:'reminder:'+r.id,title:'提醒',kind:'reminder',label:'到点提醒',text:'用户，到点了：'+r.text+late});
  }
  addMemo(input){const memo=this.memos.add(input);if(memo.reminderId)this.syncReminder('set',memo.reminderId);return memo;}
  memoAction(ref,change){const before=this.memos.find(ref).reminderId;const r=this.memos.update(ref,change);if(r.reminderCancelled)try{this.deps.onReminderChanged?.({action:'cancel',reminder:r.reminderCancelled});}catch{}if(r.reminderSet)this.syncReminder('set',r.reminderSet);void before;return r;}
  memoView(){return{ok:true,...this.memos.view()};}
  syncReminder(action,id){const reminder=this.reminders.list().find(x=>x.id===id);if(reminder)try{this.deps.onReminderChanged?.({action,reminder});}catch{}}
  requestSource(id){try{const row=this.dialog.recent({limit:80}).reverse().find(e=>e.role==='user'&&e.id===id);if(row)return(row.source==='hub'?'电脑':'手机')+(row.input==='voice'?'语音':'');}catch{}return this.inputModes?.get(id)==='voice'?'语音':'';}
  get podcasts(){
    if(!this._podcasts&&this.deps.podcast){const {PodcastStudio}=require('./podcast/studio');
      this._podcasts=new PodcastStudio({dataDir:this.deps.dataDir,...this.deps.podcast,listener:()=>{const m=this.memory?.read?.()||{};return[m.user,m.memory].filter(Boolean).join('\n');},onChange:()=>{try{this.deps.onPodcastsChanged?.();}catch{}},onDone:m=>this.podcastDone(m)});}
    return this._podcasts||null;
  }
  podcastDone(m){
    // 每日一档不单独推「做好了」：08:00 的计划通知里已带上它，避免一早连响几次。
    if(m.source==='daily-secretary')return;
    const done=m.episodes.filter(e=>e.status==='done'),failed=m.episodes.filter(e=>e.status==='failed').length,mins=Math.round(done.reduce((s,e)=>s+(e.seconds||0),0)/60);
    const text=done.length?`用户，《${m.title}》的口播做好了：${done.length} 集，约 ${mins} 分钟${failed?`（另有 ${failed} 集没做成，可以让我重做）`:''}。手机左侧菜单「资料口播」里可以听，也能看阅读版。`:`用户，《${m.title}》的口播没做成：${m.error||m.episodes.find(e=>e.error)?.error||'原因未知'}`;
    this.watches.addNotice({id:'podcast:'+m.id,title:'口播',kind:'podcast',label:'资料口播',text});
  }
  podcastSource(file){
    const p=require('node:path'),os=require('node:os'),abs=p.resolve(String(file||''));
    const roots=require('../storage-roots').trustedFileRoots({dataDir:this.deps.dataDir,home:os.homedir()}).map(r=>p.resolve(r).toLowerCase()+p.sep);
    if(!roots.some(r=>abs.toLowerCase().startsWith(r)))throw new Error('只能把工作区（含旧工作根）、产物目录（AI-Artifacts）或 Hub 数据目录里的资料做成口播');
    if(!/\.(html?|md|txt)$/i.test(abs))throw new Error('目前支持 HTML 和 Markdown 资料');
    return abs;
  }
  // 手机对话记录：写入后推给助理 Tab 实时显示。
  logDialog(entry){const row=this.dialog.append(entry);try{this.deps.onDialogEntry?.(row);}catch{}return row;}
  async directSend({sessionId,text}={}){
    if(typeof text!=='string'||!text.trim()||text.length>50000)throw new Error('请写上要对它说的话');
    const meta=this.sessionMetadata(sessionId);
    if(!meta)throw new Error('找不到这个会话');
    if(this.assistantIds().includes(sessionId)||meta.purpose==='hub-assistant')throw new Error('不能点名前台自己');
    if(!this.deps.getSession(sessionId)){
      if(!this.deps.resumeSession)throw new Error('会话已休眠，这台电脑上没法自动拉起');
      await this.deps.resumeSession(sessionId);
      if(!this.deps.getSession(sessionId))throw new Error('会话已休眠，拉起没成功，请点开它再发');
    }
    const id=randomUUID(),title=String(meta.title||sessionId.slice(0,8));
    let r;try{r=await this.deps.sendPrompt(sessionId,text.trim(),id);}catch(error){r={ok:false,error:error.message,notSent:!!error.notSent};}
    const ok=r?.ok!==false;
    try{
      this.logDialog({id,at:Date.now(),role:'user',input:'text',source:'hub',text:`@「${title}」 ${text.trim()}`});
      this.logDialog({id:id+':direct',role:'system',text:ok?`已直接发给「${title}」，没经过前台。`:`没发给「${title}」：${r?.message||r?.error||'原因不明'}`});
    }catch(error){console.warn('[assistant] direct dialog',error.message);}
    return ok?{ok:true,sessionId,title}:{ok:false,sessionId,title,notSent:!!r?.notSent,error:r?.message||r?.error||'发送结果不明'};
  }
  dialogLog({limit}={}){return{ok:true,entries:this.restartResume.view(this.dialog.recent({limit,fold:require('./progress-feed').latestOnly})),desk:this.desk?.busy()||null};}
  // 电脑上对助理说的话（助理 Tab 输入框），与手机同一套回答方式。
  get desk(){if(!this._desk)this._desk=new (require('./desk').AssistantDesk)({assistant:this,fallback:this.deps.fallback||null,store:this.feedStore||null});return this._desk;}
  ask({text,to,again}={}){return this.desk.ask(text,{to,again});}
  // 助理页右侧「助理状态」：会话、上下文用量、记忆、关注的任务。
  pageStatus(){
    const ctx=this.contextStatus(),o=this.overview(),mem=this.memory,fs=require('node:fs');
    const files=['user','memory'].map(kind=>{let entries=[],updatedAt=null;try{entries=mem.entries(kind);updatedAt=fs.statSync(mem.file(kind)).mtimeMs;}catch{}return{kind,count:entries.length,updatedAt,recent:entries.slice(-3).reverse().map(e=>e.replace(/^- /,'').slice(0,80))};});
    return{ok:true,session:{label:this.assistantLabel(),status:o.status,available:o.available},context:{tokens:ctx.tokens||null,cap:ctx.cap||null,lastActiveAt:ctx.lastActiveAt||null,lastRotation:ctx.lastRotation?{at:ctx.lastRotation.at,reason:ctx.lastRotation.reasonLabel||ctx.lastRotation.reason}:null},
      memory:files,memos:this.memos.openList().length,reminders:this.reminders.upcoming().slice(0,5).map(r=>({id:r.id,at:r.at,text:r.text})),followed:this.followedTasks().map(w=>({title:w.title,state:w.state||null,updatedAt:w.updatedAt||null})).slice(0,8),frontDesk:this.frontDesk()};
  }
  assistantLabel(){const p=this.currentProfile();let kind=p.kind;try{kind=require('../ai-kinds').getKindLabel(p.kind);}catch{}return[kind,p.label].filter(Boolean).join(' · ');}
  // 手机端选择面板的数据：当前助理设置 + 各后端可选型号与深度（手机不内置型号表）。
  async phoneProfile(){
    const defaults={};for(const kind of backends.BACKENDS)defaults[kind]=await this.deps.getDefaults?.(kind)||{};
    return{current:this.currentProfile(),kinds:profiles.phoneCatalog(backends.SELECTABLE_BACKENDS,kind=>defaults[kind]),frontDesk:require('./front-desk').catalog(this.frontDesk())};
  }
  async applyProfile(kind,id){
    if(!this.store.get('profilePending:'+kind))return;
    const want=this.store.get('profile:'+kind),session=this.deps.getSession(id);
    if(!want||!session)return;
    const {sessionModelId}=require('../session-capabilities');
    if(sessionModelId(session)===want.model&&(session.effort||null)===(want.effort||null)){this.store.set('profilePending:'+kind,false);return;}
    const busy=require('../session-runtime-truth').sessionRuntimeIsActive(session)||['running','waiting'].includes(session.status)||this.deps.hasPendingPrompt?.(id);
    if(busy||!this.deps.restartSession){console.log('[assistant] profile deferred',kind,id,JSON.stringify({status:session.status,runtimeActive:require('../session-runtime-truth').sessionRuntimeIsActive(session),pendingPrompt:!!this.deps.hasPendingPrompt?.(id),cliRuntime:session.cliRuntime?.state,restart:!!this.deps.restartSession}));return;}
    console.log('[assistant] profile restart',kind,id,sessionModelId(session),'->',want.model,want.effort);
    const defaults=await this.deps.getDefaults?.(kind)||{};
    const opts=profiles.withModel(kind,{...defaults,model:sessionModelId(session)},want);
    const result=await this.deps.restartSession(id,{model:want.model,effort:want.effort||null,...(typeof opts.contextMax==='number'?{contextMax:opts.contextMax}:{})});
    // 重启失败不能卡住后续消息：记录原因、把设置还原为实际在跑的型号，由 setProfile 如实回报。
    if(!result||result.ok===false){
      this.store.set('profile:'+kind,{model:sessionModelId(session),effort:session.effort||null});
      this.profileError='助理按新模型重启失败：'+(result?.message||'未知原因')+'；原会话和历史已保留';
    }
    this.store.set('profilePending:'+kind,false);
  }
  async switchBackend({kind}={}) {
    backends.backendKind(kind);
    if(this.switching||this.creating)throw new Error('助理正在连接或切换，请稍候');
    return this.switchUnguarded(kind);
  }
  async switchUnguarded(kind){
    const current=this.deps.getSession(this.store.get('sessionId'));
    if(current&&this.deps.hasPendingPrompt?.(current.id))throw new Error('助理上一条消息的提交仍在核对，请稍候切换；原会话和草稿已保留');
    if(current&&(require('../session-runtime-truth').sessionRuntimeIsActive(current)||['running','waiting'].includes(current.status)))throw new Error('助理正在处理请求或等待响应，请先结束当前回合；原会话和草稿已保留');
    this.captureContinuity();
    this.switching=this._ensureSession(kind);
    try {const result=await this.switching;if(result.ok){this.currentRequest=null;this.store.set('lastContext',null);}return result;}
    finally{this.switching=null;}
  }
  async _ensureSession(kind) {
    const old=backends.bindings(this.store)[kind];
    const finish=async(session,id)=>{
      if(session.id!==id||session.purpose!=='hub-assistant'||session.kind!==kind)throw new Error('助理返回的会话编号或后端与预留身份不一致，需核对创建结果');
      await this.connectBridge();backends.activate(this.store,kind,id);
      await this.applyProfile(kind,id);
      if(kind==='claude'){const m=this.sessionMetadata(id);if(m?.claudeProfile)this.store.set('frontAccount',{id:m.claudeProfile,label:m.claudeProfileLabel||m.claudeProfile,at:Date.now()});}
      return{ok:true,sessionId:id,backendKind:kind,session:this.deps.getSession(id)||session};
    };
    const started=Date.now(),timed=async(how,session,id)=>{const launchMs=Date.now()-started,result=await finish(session,id);this._cold={at:started,how};this.timing({step:'ensure',how,kind,trigger:this._ensureTrigger||'use',launchMs,totalMs:Date.now()-started});return result;};
    if(old){const session=this.deps.getSession(old);if(session)return finish(session,old);
      // 升级到前台精简启动后的第一次打开：旧会话带着整套编程行李和长历史，恢复它省不下来；
      // 改走换班（交接最近对话后新开一个精简会话），旧会话休眠可查。只换这一次。
      if(kind==='claude'&&this.store.get('frontLean:'+kind)!==old&&!this._leanRotating&&this.sessionMetadata(old)){
        this._leanRotating=true;
        try{const rotated=await this.rotate(kind,old,{reason:'lean'});if(rotated)return rotated;}finally{this._leanRotating=false;}
      }
      // A reserved launch can have succeeded even when its receipt was lost.
      if(this.deps.resumeSession){
        const want=this.store.get('profilePending:'+kind)&&this.store.get('profile:'+kind),base=want?{model:want.model,effort:want.effort||null}:null;
        // 前台换号（2026-11-25）：旧前台建时没开独立账号目录，换号入口一直灰着。恢复时顺带升级成可换号会话（同一对话原样接上）；
        // 升级没成就按原样恢复，前台照常可用，只是暂时还不能换号。
        const upgrade=this.frontNeedsAccountUpgrade(kind,old);
        if(upgrade){
          try{const session=await this.deps.resumeSession(old,this.getLaunchOptions(kind,old),{...base,claudeAutoSwitch:true});if(session){console.log('[assistant] front account upgraded on resume',old);return timed('resume',session,old);}}
          catch(error){console.warn('[assistant] front account upgrade on resume failed, resuming as before',error.message);}
        }
        const session=await this.deps.resumeSession(old,this.getLaunchOptions(kind,old),base||undefined);if(session)return timed('resume',session,old);
      }
      const pending=(this.store.get('backendCreation:'+kind)||this.store.get('assistantCreation'))?.state==='reserved';
      return{ok:false,sessionId:old,needsReconciliation:pending,error:pending?'上次助理创建结果未确认；已保留原编号，需核对该实体后恢复。':'助理原会话未打开，请从历史恢复该会话。'};
    }
    const hubDefaults=await this.deps.getDefaults?.(kind)||{};
    const defaults=profiles.withModel(kind,hubDefaults,profiles.assistantProfile(kind,this.store.get('profile:'+kind),hubDefaults));
    const id=randomUUID();backends.reserve(this.store,kind,id);
    await this.connectBridge();
    this.store.set('profilePending:'+kind,false);
    const session=await this.deps.createSession(kind,{...defaults,...(kind==='claude'?this.frontAccountLaunch():{}),id,title:'AI Hub 助理 · '+backends.getKindLabel(kind),name:'AI Hub 助理',purpose:'hub-assistant',...this.getLaunchOptions(kind,id)});
    if(kind==='claude')this.store.set('frontLean:'+kind,id);
    return timed('create',session,id);
  }
  getLaunchOptions(kind,id){return backends.launchOptions(this,backends.backendKind(kind),id);}
  // 根因：前台建会话时没要独立账号目录（claudeAccountSwitchable），Hub 的换号机制把它当「旧会话」，下拉全灰。
  // 做法：前台和普通 Claude 会话共用同一套换号（main/claude-account-switch.js）：手动下拉换号、额度用完自动换号、账号标记置灰。
  frontNeedsAccountUpgrade(kind,id){
    if(kind!=='claude'||!id||this.deps.claudeAccountSwitchReady?.()!==true)return false;
    const meta=this.sessionMetadata(id);
    return !!meta&&/^claude(?:-resume)?$/.test(meta.kind||'')&&!meta.claudeRuntimeHome;
  }
  // 新开前台（换班、换后端回来）：沿用上一任前台当前的号和自动换号开关，不回落到 Hub 默认号。
  frontAccountLaunch(){
    if(this.deps.claudeAccountSwitchReady?.()!==true)return{}; // 只有一个号（分享版、新装）或走 API：没号可换，照旧启动
    const opts={claudeAccountSwitchable:true,claudeAutoSwitch:true};
    const prev=[...(this.store.get('retiredAssistants')||[])].reverse().find(r=>r.kind==='claude');
    const meta=prev&&this.sessionMetadata(prev.id);
    // 上一任的号能用就沿用（含我的账号）；被标记了就按 Hub 推荐顺序挑一个没标记的号，不回落到可能同样被标记的默认号。
    if(meta?.claudeProfile&&!this.deps.accountBlocked?.(meta.claudeProfile))opts.claudeProfile=meta.claudeProfile;
    else{let pick=null;try{pick=this.deps.claudeAccountStatus?.()?.recommendedId||null;}catch{}if(pick&&!this.deps.accountBlocked?.(pick))opts.claudeProfile=pick;}
    if(typeof meta?.claudeAutoSwitch==='boolean')opts.claudeAutoSwitch=meta.claudeAutoSwitch;
    return opts;
  }
  // 在线把前台升级成可换号会话：空闲时按原对话重开一次（同一原生记录、守则与记忆照旧注入）；忙时不动，明说原因。
  makeFrontSwitchable(id){
    // 同一时刻只升级一次：并发的请求共用同一个结果，不重复重开。
    if(this._frontUpgrade)return this._frontUpgrade;
    this._frontUpgrade=this._makeFrontSwitchable(id).finally(()=>{this._frontUpgrade=null;});
    return this._frontUpgrade;
  }
  async _makeFrontSwitchable(id){
    const kind=this.activeKind(),bound=backends.bindings(this.store)[kind];
    if(id!==bound)return{ok:false,message:'不是当前前台会话'};
    if(!this.frontNeedsAccountUpgrade(kind,id))return{ok:true,status:'ready'};
    const busyNow=()=>{const s=this.deps.getSession(id);return !s||require('../session-runtime-truth').sessionRuntimeIsActive(s)||['running','waiting'].includes(s.status)||!!this.deps.hasPendingPrompt?.(id);};
    if(!this.deps.getSession(id))return{ok:false,message:'前台还没打开，打开后再换号'};
    if(busyNow())return{ok:false,message:'前台正在回答，这一轮结束后再换号（首次换号要把前台重开一次）'};
    if(this.creating||this.switching)return{ok:false,message:'前台正在连接或切换，请稍候'};
    if(!this.deps.restartSession)return{ok:false,message:'重开服务未就绪'};
    // 登录核验是异步的：真正停进程前再查一次，期间来了新消息或前台换了人就不重开（guard 由重开入口在停进程前调用）。
    const guard=({allowSuspended=false}={})=>backends.bindings(this.store)[kind]===id&&!this.creating&&!this.switching&&(allowSuspended||!busyNow());
    const result=await this.deps.restartSession(id,{claudeAutoSwitch:true},{guard});
    if(result?.notSwitched)return{ok:false,message:'前台刚收到新消息，这一轮结束后再换号；原会话和对话保留'};
    if(!result||result.ok===false)return{ok:false,message:'前台升级为可换号会话失败：'+(result?.message||'原因未知')+'；原会话和对话保留'};
    console.log('[assistant] front account upgraded live',id);
    return{ok:true,status:'upgraded'};
  }
  noteAccountSwitch(id,status,message){
    if(id!==this.store.get('sessionId'))return null;
    const meta=this.sessionMetadata(id)||{},label=meta.claudeProfileLabel||meta.claudeProfile||'';
    const prev=this.store.get('frontAccount')||null;
    const notify=['manual-switched','switched','continued','waiting','manual-failed','attention'].includes(status);
    if(!notify){if(!prev&&meta.claudeProfile&&['checking','manual-switching'].includes(status))this.store.set('frontAccount',{id:meta.claudeProfile,label,at:Date.now()});return null;}
    const changed=!!meta.claudeProfile&&prev?.id&&prev.id!==meta.claudeProfile;
    if(meta.claudeProfile)this.store.set('frontAccount',{id:meta.claudeProfile,label,at:Date.now()});
    // 成功类：号没变（同一次切换的后续状态）不重复记。失败类：同一句 10 分钟内只记一次。
    if(['manual-switched','switched','continued'].includes(status)&&!changed)return null;
    const key=status+'|'+message,last=this._accountNote;
    if(!changed&&last?.key===key&&Date.now()-last.at<600000)return null;
    this._accountNote={key,at:Date.now()};
    const from=changed?(prev.label||prev.id):'';
    const text=!changed?(status==='waiting'?`前台额度用完了，但没有可换的号：${message}`:`前台换号没成功（仍用${label}）：${message}`)
      :status==='attention'?`前台账号已从${from}换到${label}，但后续没完成：${message}。请打开前台核对。`
      :`前台账号已从${from}换到${label}（${status==='manual-switched'?'手动':'额度用完，自动'}）。${status==='continued'?'被额度打断的那一轮已让它接着做。':''}对话、守则、记忆和待决策/提醒/备忘都保留。`;
    const row=this.logDialog({id:'front-account:'+Date.now(),role:'system',lane:'notice',by:'前台换号',text});
    try{this.deps.onAssistantNotification?.({id:'front-account-'+Date.now(),kind:'front-account',title:'前台换号',text,at:Date.now()});}catch(error){console.warn('[assistant] front account notice',error.message);}
    return row;
  }
  async connectBridge(){await this.bridge.start();const temporary=this.endpointFile+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify({url:this.bridge.url,token:this.bridge.secret}),{mode:0o600});require('./atomic-rename').renameRetry(temporary,this.endpointFile);}
  getMcpEntry(sessionId=this.store.get('sessionId')){return{name:'hub_assistant',command:this.deps.nodeExecutable||'node',args:[path.resolve(__dirname,'../../scripts/assistant-mcp.js')],env:{HUB_ASSISTANT_ENDPOINT_FILE:this.endpointFile,HUB_ASSISTANT_SESSION_ID:sessionId||'',...(this.deps.runAsNode?{ELECTRON_RUN_AS_NODE:'1'}:{})},toolApprovalModes:{list_sessions:'approve',read_progress:'approve',update_front_rules:'approve',history_context:'approve',claim_session:'approve',watch_session:'approve',send_session:'approve',create_session:'approve',dispatch_to_assistant:'approve',update_memory:'approve',account_status:'approve',dispatch_candidates:'approve'},toolOutputTokenLimits:{history_context:8000}};}
  isAssistantSession(sessionId){return isAssistantSession(this.store,sessionId,this.deps.getSession(sessionId));}
  // 已换班的旧助理可以打开查看历史；它不再是固定助理，会话管理工具在每次调用时都会被拒绝。
  requireAssistantResume(meta){if(meta?.hubId&&(this.store.get('retiredAssistants')||[]).some(r=>r.id===meta.hubId&&r.kind===meta.kind))return;if(!meta?.hubId||!this.assistantIds().includes(meta.hubId)||(meta.kind&&backends.bindings(this.store)[meta.kind]!==meta.hubId))throw new Error('恢复实体不是固定助理，未授予专属工具');}
  context(request={}) {
    const sessionId=this.store.get('sessionId'),session=this.deps.getSession(sessionId);
    // 提问时先增量补齐账本（每个会话从上次读到的位置往后读），保证两次提问之间的答复一条不漏。
    try{this.reconcileLedger();}catch(error){console.warn('[assistant] ledger catch-up',error.message);}
    const board=this.refreshDossier();
    // Retrieval budgets limit supplemental historical excerpts, never which
    // current sessions the assistant can see or manage.
    const naturalBudget=Number(request.maxChars)||Math.max(6000,board.openedCount*1200);
    const natural=this.history.context({...request,maxChars:naturalBudget,excludeSessionId:sessionId,excludeNativeSessionId:nativeId(session),excludeSessionIds:this.assistantIds(),excludeNativeSessionIds:this.assistantIds().map(id=>nativeId(this.sessionMetadata(id))).filter(Boolean)});
    const groups=readGroupHistory({dataDir:this.deps.dataDir,since:request.query?undefined:(natural.since??request.from??((request.now||Date.now())-(request.hours||3)*3600000)),until:natural.until||natural.asOf,
      query:request.query||'',maxChars:Math.max(6000,board.openedCount*400),maxFiles:30,meetings:this.deps.getMeetings?.()});
    const {sources:groupSources,...groupCoverage}=groups;
    const groupChars=groupSources.reduce((n,s)=>n+s.text.length,0);
    const sources=[...board.sources.map(source=>({...source,timeScope:'当前原生最终答复快照；以该条timestamp为准，不代表它发生在历史检索窗口内'})),...natural.sources.filter(source=>!board.sources.some(live=>live.sessionId===source.sessionId&&source.role==='assistant'&&live.text===source.text)),...groups.sources];
    let leadBoard=null;try{leadBoard=this.leadBoard();}catch(error){console.warn('[assistant] lead board',error.message);}
    return {...natural,leadBoard,assistantContinuity:this.continuity.packet(),assistantMemory:this.sharedMemoryPacket(),workLedger:this.ledger.since(this.store.get('lastAskAt')||Date.now()-86400000),asOf:Date.now(),available:natural.available||sources.length>0,sources,
      selectedChars:sources.reduce((n,source)=>n+source.text.length,0),groupSelectedChars:groupChars,
      workbench:{revision:board.revision,mode:board.mode,markdownPath:board.markdownPath,markdown:board.markdown,
        inventory:board.openedInventory,activeCount:board.activeCount,openedCount:board.openedCount,unreadCount:board.unreadCount,needsInputCount:board.needsInputCount,knownCount:board.knownCount,timeMeaning:'这是当前工作台状态；历史变化请结合每条来源时间及请求窗口，不能把旧最终答复说成刚发生的变化。',
        catalogPath:path.join(this.dossier.directory,'ALL-SESSIONS.md'),allActiveSessionsIncluded:true,
        revisions:Object.fromEntries(board.openedInventory.map(row=>[row.id,row.revision])),
        changedSessionIds:board.changedSessionIds.filter(id=>board.openedInventory.some(row=>row.id===id)),removedSessionIds:board.removedSessionIds,
        baselineMeaning:board.baselineMeaning,fullReplyChars:board.fullReplyChars},
      truncated:natural.truncated||groups.truncated||board.sources.some(source=>source.truncated),coverage:{singleSessions:natural.coverage,groups:groups.coverage,
        currentSessions:`当前已打开的 ${board.openedCount} 个其他会话全部列出，其中活跃 ${board.activeCount} 个。最新原生答复变化优先提供；长正文可按来源读取，历史片段预算不会排除受管理会话。`,
        groupTimeMeaning:'群聊材料的文件修改时间只证明文件被观察到变化，不证明任务在该时刻完成。'},groupFileCoverage:groupCoverage};
  }
  refreshDossier(){const id=this.store.get('sessionId'),assistant=this.deps.getSession(id);if(id&&!assistant)throw new Error('助理原会话尚未在本窗口打开，工作档案保留原版本');this.captureContinuity();return this.dossier.publish(this.liveInventory(),`${id||''}:${nativeId(assistant)||''}:${assistant?.codexProfile||assistant?.kind||''}`);}
  preparePrompt(request) {
    if(this.switching)throw new Error('助理正在切换后端，请稍候；草稿已保留');
    if(!request||String(request.text||'').trimStart().startsWith('/'))return request;
    const envelope=require('../assistant-context-display').assistantContextDisplay(request.text,'hub-assistant');
    if(envelope)request={...request,text:envelope.userText};
    const active=this.deps.getSession(this.store.get('sessionId'));
    if(request.sessionId!==undefined&&!this.isAssistantSession(request.sessionId))throw new Error('请求不是固定助理会话，消息未发送');
    if(active&&(require('../session-runtime-truth').sessionRuntimeIsActive(active)||active.status==='running'))throw new Error('助理正在处理上一条请求，请等本轮结束后发送；草稿已保留');
    // 系统注入（告警、知会、交卷、拍板请求）只要前台转告一句，不需要整包资料：跳过重建，只套一层薄信封。
    // 信封带 clientSubmissionId（前台答复靠它和这次注入对上，转告才能进助理对话），界面照旧只显示原文。
    if(isSystemInjection(request.text)){const sid=request.clientSubmissionId||request.requestId||randomUUID();this.turnClock={sessionId:request.sessionId,at:Date.now(),origin:'system'};
      const payload=JSON.stringify({userText:request.text,role:'这是 Hub 程序的系统注入，不是用户原话。按前台守则转告用户一两句：结论先行，200 字以内，不读资料、不调用工具。',sessions:{sessions:[],total:0,included:0,truncated:false},history:{manifestOnly:true,systemInjection:true,clientSubmissionId:sid}});
      return{...request,text:'[AI_HUB_ASSISTANT_CONTEXT_V1]'+payload+'[/AI_HUB_ASSISTANT_CONTEXT_V1]',clientSubmissionId:sid};}
    const prepareStarted=Date.now();
    const context=this.context({...resolveTimeRange(request.text,{hours:request.hours,timeZone:this.deps.timeZone}),query:request.historyQuery||''});
    if(this._cold){this.timing({step:'first-prepare',how:this._cold.how,prepareMs:Date.now()-prepareStarted,sinceEnsureMs:prepareStarted-this._cold.at});this._cold=null;}
    // 账本增量在助理真正读取本轮资料时才算送达（见 history_context），闲聊不读资料就保留到下次。
    const id=request.clientSubmissionId||request.requestId||randomUUID();
    this.currentRequest={id,sessionId:request.sessionId,text:request.text,token:randomUUID(),createdAt:Date.now()};this.turnClock={sessionId:request.sessionId,at:this.currentRequest.createdAt,origin:'user'};
    if(request.sessionId)this.continuity.add({id:'user:'+id,sessionId:request.sessionId,provider:active?.kind||'codex',role:'user',deliveryState:'prepared',timestamp:this.currentRequest.createdAt,text:request.text});
    const manifest=this.snapshots.save({requestId:id,requestToken:this.currentRequest.token,packet:context});
    // Claude 的成长记忆在系统提示里；其他后端在新会话第一轮读一次资料包里的 assistantMemory，之后全程遵守。
    const turns=(this.store.get('turns:'+request.sessionId)||0);if(request.sessionId)this.store.set('turns:'+request.sessionId,turns+1);
    const text=buildBootstrapPrompt(request.text,{...manifest,clientSubmissionId:id},this.sessions().length,active?.kind||'codex',{inputMode:this.inputModes.get(id)||'text',readMemory:turns===0&&(active?.kind||'codex')!=='claude'});
    this.store.set('lastContext',{asOf:context.asOf,selectedChars:context.selectedChars,sources:context.sources.length,truncated:context.truncated,
      workbenchPath:context.workbench.markdownPath,workbenchRevision:context.workbench.revision,openedSessions:context.workbench.openedCount,activeSessions:context.workbench.activeCount,allActiveSessionsIncluded:true,contextMode:context.workbench.mode,
      requestToken:this.currentRequest.token,packetHash:manifest.packetHash,snapshotRead:false,snapshotReadAt:null,bootstrapChars:text.length,
      inputTransportNote:text.length>=2048?'用户原话较长，仍可能触发普通 Codex 编辑器输入通道':'短请求正文；完整资料通过本轮工具读取'});
    return{...request,text:this.withTidyInstruction(text,{...request,clientSubmissionId:id}),clientSubmissionId:id};
  }
  // 共享记忆摘要（Codex 等非 Claude 前台第一轮读；Claude 前台由 auto memory 自己加载索引）。
  sharedMemoryPacket(){
    const dir=backends.sharedMemoryDir(this),summary=require('./memory').sharedMemorySummary(dir);
    return{directory:dir,summary:summary.text,bytes:summary.bytes,available:summary.ok,...(summary.note?{note:summary.note}:{}),
      meaning:'共享记忆（Claude 共享记忆目录，所有会话共用）：用户的偏好、长期约定与资料入口。本会话全程遵守；细节读目录里对应文件。'};
  }
  // Hub 自己发起的回合不附（11-01 规定不做无人值守整理）。6 小时内只提醒一次。
  withTidyInstruction(text,request){
    try{
      const fr=require('./front-rules'),sizes=fr.mustReadBytes({rules:backends.frontRules(this),memoryDir:backends.sharedMemoryDir(this)});
      this.store.set('mustReadBytes',sizes);
      const note=fr.tidyInstruction({sizes,personal:fr.isPersonalRequest(request),lastPromptAt:this.store.get('lastTidyPromptAt')||0});
      if(!note)return text;
      this.store.set('lastTidyPromptAt',Date.now());
      return text+'\n\n'+note;
    }catch(error){console.warn('[assistant] tidy check',error.message);return text;}
  }
  accountStatus(){
    const status=this.deps.claudeAccountStatus?.();
    if(!status)return{ok:false,error:'这台电脑没有 Claude 订阅账号读数'};
    return{ok:true,...require('../claude-account-pick').describeStatus(status)};
  }
  // 所有往前台注入的程序路径（告警、知会、交卷、每日秘书）都经这里判断，不做打断。
  userWaiting(){
    const d=this._desk;if(d&&(d.queue.length||d.pending))return '用户在助理页的话还没答完';
    try{if(this.deps.userInboxPending?.())return '用户在手机上的话还没答完';}catch{}
    return null;
  }
  // 送出后重新计时（之后的系统注入再照常让路）。前台正忙、前台没开仍然不送。
  async systemSend(request){
    const wait=this.userWaiting(),maxYield=this.systemYieldMaxMs??10*60000;
    if(!wait)this._yieldSince=null;
    else{this._yieldSince??=Date.now();if(Date.now()-this._yieldSince<maxYield)return{ok:false,deferred:true,error:wait};}
    const id=this.store.get('sessionId'),front=id&&this.deps.getSession(id);
    if(!front)return{ok:false,deferred:true,error:'前台会话没开着'};
    if(this.sessionBusy(id))return{ok:false,deferred:true,error:'前台正忙'};
    if(wait)console.warn('[assistant] 系统注入已为用户的话让路超过 10 分钟，前台空闲，送一次');
    this._yieldSince=null;
    // 2026-11-21：发送前先登记。前台几秒就答完时，完成事件可能早于发送回执，后登记会永远错过这条转告。
    const tracked=!!request.requestId&&request.relay!==false,replies=this.systemReplies||=new Map();
    if(tracked)replies.set(request.requestId,{sessionId:id,at:Date.now(),codes:request.decisionCodes||[],routed:!!request.routed});
    let r;try{r=await this.send({...request,system:true});}catch(error){if(tracked)replies.delete(request.requestId);throw error;}
    if(tracked){if(r?.ok===false)replies.delete(request.requestId);else{const row=replies.get(request.requestId);if(row&&r?.sessionId)row.sessionId=r.sessionId;this.armSystemReplies();}}
    return r;
  }
  // 还有转告没配上答复时每 5 秒查一次，覆盖记录落盘比完成事件慢的情况；查完自动停。
  armSystemReplies(){
    if(this.systemReplyTimer)return;
    this.systemReplyTimer=setInterval(()=>{try{this.checkSystemReplies();}catch(error){console.warn('[assistant] system reply',error.message);}if(!this.systemReplies?.size){clearInterval(this.systemReplyTimer);this.systemReplyTimer=null;}},this.systemReplyPollMs??5000);
    this.systemReplyTimer.unref?.();
  }
  checkSystemReplies(){
    if(!this.systemReplies?.size)return;
    for(const [requestId,p] of [...this.systemReplies]){
      let found=null;try{found=this.readLiveFinal(p.sessionId).records.find(x=>x.clientSubmissionId===requestId);}catch{}
      if(found){this.systemReplies.delete(requestId);const text=String(found.text||'').trim();
        if(text&&!require('../team-silent-reply').isNoUpdateReply(text)){
          const missing=(p.codes||[]).filter(c=>!new RegExp(c+'(?!\\d)','i').test(text));
          const full=missing.length?text+'\n\n回「'+missing[0]+' 按推荐 / 选N / 先不做」'+(missing.length>1?'（另有 '+missing.slice(1).join('、')+'）':''):text;
          if(p.routed&&this.frontDoor)void this.frontDoor.push({id:'front-relay:'+requestId,text:full});
          else{const phoneText=require('./endpoints').format('phone',full);this.watches.addNotice({id:'front-relay:'+requestId,title:'前台',kind:'front-relay',label:'前台转告',text:full,...(phoneText!==full?{phoneText}:{})});}}}
      else if(Date.now()-p.at>30*60000)this.systemReplies.delete(requestId);
    }
  }
  async send(request) {
    if(typeof request.text!=='string'||!request.text.trim()||request.text.length>50000)throw new Error('请输入有效任务');
    const sendStarted=Date.now(),wasCold=!this.deps.getSession(this.store.get('sessionId'));
    const ensured=await this.ensureSession();if(!ensured.ok)return ensured;
    const ensuredAt=Date.now();
    const requestId=request.requestId||randomUUID();
    if(request.inputMode==='voice')this.inputModes.set(requestId,'voice');
    let receipt;try{receipt=await this.deps.sendPrompt(ensured.sessionId,request.text,requestId);}finally{this.inputModes.delete(requestId);}
    if(wasCold)this.timing({step:'first-send',ensureMs:ensuredAt-sendStarted,deliverMs:Date.now()-ensuredAt,ok:receipt?.ok!==false});
    return{ok:receipt?.ok!==false,sessionId:ensured.sessionId,receipt,contextSummary:this.store.get('lastContext')};
  }
  async invokeTool({name,arguments:args={},callerSessionId}) {
    if(this.switching)throw new Error('助理正在切换后端，本轮工具调用已暂停');
    // No caller is a conservative internal compatibility path only. The HTTP
    const hasCaller=callerSessionId!==undefined;
    if(hasCaller&&!this.isAssistantSession(callerSessionId))throw new Error('调用方不是固定助理会话，未授予专属工具');
    if(name==='tool_visibility')return{daily:!!this.workbench.config().enabled};
    if(name==='workbench_status')return this.workbench.refresh();
    // 2026-11-15 瘦身：先给摘要和分段编号，要细节时带 section（再带 page）按段取，单次 ≤8 KB。
    if(name==='learning_context'){const packet=require('./learning-context').learningContext(this),slim=require('./slim');
      return args.section!==undefined?slim.section(packet,args.section,args.page):slim.outline(packet,{title:'学习选题资料',keep:['asOf','available','coverage','instruction']});}
    if(name==='publish_daily_brief'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('日稿不属于当前回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      return this.workbench.publish(args,current);
    }
    if(String(this.currentRequest?.id||'').startsWith('daily-')&&!['list_sessions','read_progress','history_context','list_podcasts','list_memos','list_reminders','account_status'].includes(name))throw new Error('每日秘书任务只允许读取资料和登记日稿，不能派工或更改其他数据');
    // 2026-11-15 瘦身：一会话一行，默认只列在办和最近的，可按任务组（m2 taskGroups）或关键词过滤，≤8 KB。
    // m3 会话健康的短状态词（this.care.health.word，未跟踪返回 null 不显示）并进每行的状态列。
    // 2026-11-18 前台纯派活：不带过滤参数时给三组看板（负责人 / 你自己开的 / 其余计数，≤4 KB，见 front-board.js）。
    if(name==='list_sessions'&&!args.group&&!args.keyword&&args.all!==true)return this.frontBoard();
    if(name==='list_sessions')return require('./slim').listSessions(this.sessions().map(s=>{let word=null;try{word=this.care?.health?.word?.(s.id)||null;}catch{}return word?{...s,health:word}:s;}),{group:args.group||'',keyword:args.keyword||'',all:args.all===true,limit:Number(args.limit)||0,taskGroups:this.taskGroups||null});
    if(name==='read_progress'){const id=String(args.sessionId||'');const s=this.sessions().find(x=>x.id===id)||(id?this.sessionMetadata(id):null);
      return require('./slim').readProgress(s&&{...s,id:s.id||s.hubId||id},{cardPathFor:this.deps.progressCardPath,lastReply:sid=>this.lastReplyOf(sid)});}
    if(name==='history_context'){
      // 2026-11-15 瘦身：默认返回摘要（分段目录 + 回执），带 section（再带 page）按段取原文，单次 ≤8 KB。
      const slim=require('./slim'),{section,page,...query}=args,pick=packet=>section!==undefined?slim.section(packet,section,page):slim.outline(packet,{title:'本轮资料',keep:['asOf']});
      const implicitCurrent=hasCaller&&callerSessionId===this.currentRequest?.sessionId&&Object.keys(query).length===0;
      const requestToken=query.requestToken||(implicitCurrent?this.currentRequest.token:null);
      if(requestToken){
        if(requestToken!==this.currentRequest?.token)throw new Error('资料请求不属于当前用户回合');
        const response=this.snapshots.read(requestToken),last=this.store.get('lastContext');
        if(!String(this.currentRequest?.id||'').startsWith('handoff-')&&response.packet?.asOf)this.store.set('lastAskAt',response.packet.asOf);
        this.dossier.noteServed(response.packet.workbench);
        if(last?.requestToken===requestToken)this.store.set('lastContext',{...last,snapshotRead:true,snapshotReadAt:response.snapshotReceipt.readAt,snapshotReadReceipt:response.snapshotReceipt});
        const{packet,...receipt}=response;
        return{...pick(packet),...(section===undefined?receipt:{packetHash:receipt.packetHash||receipt.snapshotReceipt?.packetHash})};
      }
      return pick(this.context(query));
    }
    if(name==='list_podcasts'){const s=this.podcasts?.summary()||[];return{ok:true,podcasts:s.slice(0,10).map(m=>({id:m.id,title:m.title,status:m.status,episodes:m.episodes.length,done:m.episodes.filter(e=>e.status==='done').length,minutes:Math.round(m.episodes.reduce((t,e)=>t+e.seconds,0)/60)}))};}
    if(name==='make_podcast'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('口播请求不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      if(!this.podcasts)throw new Error('这台电脑还没配置口播');
      const r=await this.podcasts.start(this.podcastSource(args.path),{title:args.title||''});
      return{ok:true,...r,note:'已在后台制作：先写稿再合成，做好一集手机左侧菜单「资料口播」里就能听，全部完成会提醒用户。'};
    }
    if(name==='list_memos'){const v=this.memos.view();return{ok:true,open:v.open.map(m=>({no:m.no,id:m.id,title:m.title,kind:m.kind,group:v.groups[m.group]||m.group,due:m.dueLabel||null,recordedAt:new Date(m.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),raw:m.raw.slice(0,200)})),recentlyClosed:v.closed.slice(0,10).map(m=>({id:m.id,title:m.title,status:m.status}))};}
    if(name==='add_memo'||name==='update_memo'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('备忘写入不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      if(name==='add_memo'){const memo=this.addMemo({title:args.title,due:args.due||'',kind:args.kind||'todo',raw:current.text,source:this.requestSource(current.id)});return{ok:true,no:this.memos.openList().find(m=>m.id===memo.id)?.no,id:memo.id,title:memo.title,due:memo.due?require('./memos').whenLabel(memo.due,Date.now()):null,remind:!!memo.reminderId};}
      const r=this.memoAction(String(args.ref??''),{action:args.action,until:args.until||'',title:args.title||''});return{ok:true,id:r.memo.id,title:r.memo.title,status:r.memo.status,due:r.memo.due?require('./memos').whenLabel(r.memo.due,Date.now()):null,later:!!r.memo.later};
    }
    if(name==='list_reminders')return{ok:true,reminders:this.reminders.upcoming().map(r=>({id:r.id,when:new Date(r.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),text:r.text,...(r.repeat?{repeat:r.repeat}:{})}))};
    if(name==='set_reminder'||name==='cancel_reminder'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('提醒设置不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      if(name==='cancel_reminder'){const r=this.reminders.cancel(String(args.id||''));try{this.deps.onReminderChanged?.({action:'cancel',reminder:r});}catch{}return{ok:true,cancelled:{id:r.id,text:r.text}};}
      const r=this.reminders.add({when:args.when,text:args.text,repeat:args.repeat||''});try{this.deps.onReminderChanged?.({action:'set',reminder:r});}catch{}
      return{ok:true,id:r.id,when:new Date(r.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),text:r.text,...(r.repeat?{repeat:r.repeat}:{})};
    }
    if(name==='update_memory'){
      // 只有本轮绑定的固定助理能改成长记忆；写入由 Hub 校验长度、拦截密钥并备份。
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('记忆写入不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      // 2026-11-15 前台一期：Hub 的 USER.md / MEMORY.md 退役，改写 Claude 共享记忆目录（一事一文件 + 分类索引）。
      // Claude 前台直接用 Write 写（钩子保护）；这个工具留给 Codex 等非 Claude 前台，只支持新增，删改交给 Claude 前台整理。
      if(args.action!=='add')throw new Error('共享记忆目前只能经本工具新增；删除和整理请让用户切到 Claude 前台，或直接改共享记忆目录里的文件');
      const added=require('./shared-memory').addEntry({dir:backends.sharedMemoryDir(this),text:args.text,origin:args.file==='user'?'user':'memory',
        source:'Hub 前台'+(args.reason?'，'+String(args.reason).slice(0,40):''),history:this.memory.historyDir});
      const result={ok:true,unchanged:!!added.unchanged,file:added.file,index:added.index,appliesTo:'所有会话共用；Claude 会话下次启动读到索引'};
      if(result.ok&&!result.unchanged&&(String(current.id).startsWith('handoff-')||!/记住|记下|记一下|别忘/.test(String(current.text||''))))this.watches.addNotice({id:'memory:'+randomUUID(),title:'助理记忆',kind:'memory-update',label:'助理自动记下的偏好',
        text:'我记下了：'+String(args.text).slice(0,200).replace(/[。.\s]+$/,'')+(args.action==='add'?'':'（'+({remove:'删除',rewrite:'整理'}[args.action]||args.action)+'）')+'。不认可可以对我说，或在助理页「助理记忆」里改。'});
      return result;
    }
    if(name==='dispatch_candidates')return{candidates:dispatch.candidates(this.sessions(),this.taskGroups,args),groups:this.taskGroups.state.groups.map(g=>({id:g.id,goal:g.goal,members:g.members.map(m=>({sessionId:m.sessionId,role:m.role}))}))};
    if(name==='update_front_rules'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('守则修改不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      return backends.frontRules(this).update({action:args.action,text:args.text,reason:args.reason});
    }
    if(name==='memory_hook_event'){
      if(!hasCaller)throw new Error('记忆钩子回报需要前台身份');
      const file=path.basename(String(args.file||'')),desc=String(args.description||'').slice(0,160);
      if(args.event!=='blocked'&&/^(MEMORY\.md|index-.*\.md)$/i.test(file))return{ok:true,silent:true};
      const text=args.event==='blocked'?`前台写共享记忆时内容疑似含密钥，${args.rollback==='none'?'找不到写前记录、未自动回滚，已要求前台立刻删掉凭据':'已拦下并回滚'}（${file}）。`
        :`前台${args.created===true?'记下了':'改了'}共享记忆：${desc||file}（${file}）。${args.backup?'改前已备份，':''}不认可可以对我说。`;
      this.watches.addNotice({id:'memory:'+randomUUID(),title:'助理记忆',kind:'memory-update',label:args.event==='blocked'?'记忆写入被拦截':'前台记下的记忆',text});
      return{ok:true};
    }
    if(name==='account_status')return this.accountStatus();
    // 2026-11-18 前台纯派活：看画面、按键、停止、重启、换号、告警回报等处置不再挂在前台（health-wiring.js 的能力仍在，
    // 由会话健康模块自动补发/重建/改派，事件按认领表直送负责人）；前台这里只做收编。
    if(name==='claim_session'){
      const current=this.currentRequest;
      if(!hasCaller||!current||args.requestToken!==current.token||Date.now()-current.createdAt>30*60000)throw new Error('收编不属于当前用户回合');
      requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
      return this.claimSession(args);
    }
    // 旧工具名兼容（前台旧记忆里还写着它）：带 sessionId 走转交，否则走新建。本轮凭证照常校验，不放宽。
    if(name==='dispatch_to_assistant'){
      const text=String(args.text||args.task||args.prompt||'').trim();if(!text)throw new Error('请写清要派的任务');
      const operationKey=args.operationKey||'alias-'+require('node:crypto').createHash('sha256').update(text+'\n'+(args.sessionId||'')).digest('hex').slice(0,24);
      const common={text,operationKey,requestToken:args.requestToken};
      if(args.sessionId){name='send_session';args={...common,sessionId:args.sessionId};}
      else{name='create_session';args={...common,title:String(args.title||text).replace(/\s+/g,' ').slice(0,30)};}
    }
    if(!['send_session','create_session','watch_session'].includes(name))throw new Error('未知工具');
    const current=this.currentRequest;
    if(!current||Date.now()-current.createdAt>30*60000)throw new Error('本轮用户委托已过期，请重新发送任务');
    if(args.requestToken!==current.token)throw new Error('工具调用不属于当前用户委托');
    const manager=hasCaller&&requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
    if(name==='watch_session'){
      if(!manager){if(!reminderIntent(current.text))throw new Error('本轮没有明确要求新回复后提醒');
        requireBoundTarget(current,{targetSessionId:args.sessionId},this.sessions());}
      return this.followTask({sessionId:args.sessionId});
    }
    const action={type:name==='create_session'?'create':'send',targetSessionId:args.sessionId,title:args.title,text:args.text,
      ...(name==='create_session'?Object.fromEntries(['tier','kind','model','effort','scene','account','cwd','lead'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]])):{ }),
      ...Object.fromEntries(['group','relatedSessionId','dispatchType'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))};
    if(!manager)requireAuthorizedTarget(current,action,this.sessions());
    const secrets=this.stashSecrets(action,current.id+':'+args.operationKey);
    // 型号或深度写错时在占用本轮名额前报错，助理改正后可在同一轮重试。
    if(action.type==='create'){const kind=profiles.taskKind(action);backends.backendKind(kind);const route=profiles.resolveTask(action,await this.deps.getDefaults?.(kind)||{});this.validateTaskScene(action.scene,kind,route.opts);}
    this.validateDispatch(action);
    if(action.type==='create')dispatch.launchOptions(profiles.taskKind(action),action,this.dispatchAccounts());
    if(typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    if(this.deps.authorizeAction&&!await this.deps.authorizeAction(action,current))throw new Error('目标不在本轮授权范围内');
    const requestId=bindOperation(this.store,current,args.operationKey,action);
    // 助理新建的任务总是关注：路由的承诺是把结果带回来（手机与助理页都会收到提醒）。
    const followed=reminderIntent(current.text)||action.type==='create';
    if(followed&&action.type==='send')this.followTask({sessionId:action.targetSessionId});
    const runOptions={followNewReply:followed&&reminderIntent(current.text)?'explicit':followed,trustedDispatch:manager===true,issuerSessionId:callerSessionId};
    // 新建走开工排队；重试已入账的任务直接回原结果，不再排队。
    const result=action.type==='create'&&!this.store.has(requestId)?await this.dispatchQueue.submit({id:requestId,action:{...action,requestId},options:runOptions}):await this.execute({...action,requestId},runOptions);
    const extra={...(secrets?{secretsReplaced:secrets}:{})};
    return followed?{...result,...extra,followed:true,notificationMethod:'Hub监视原生最终回复并在助理页通知'}:{...result,...extra};
  }
  // 2026-11-19 前台行为改进：任务书里的密钥不进会话、账本和健康记录。明文另存本机受保护文件，任务书里只写位置。
  stashSecrets(action,seed=''){
    const {SECRET_RE}=require('./memory'),all=new RegExp(SECRET_RE.source,'gi');
    if(typeof action.text!=='string'||!SECRET_RE.test(action.text))return null;
    const dir=path.join(this.deps.dataDir,'assistant','secrets');fs.mkdirSync(dir,{recursive:true});
    const found=action.text.match(all)||[];
    // 文件名由本轮、操作键和密钥本身决定：前台同一操作重试时任务书一字不差，去重照常生效。
    const file=path.join(dir,'task-'+require('node:crypto').createHash('sha256').update(seed+'\n'+found.join('\n')).digest('hex').slice(0,16)+'.txt');
    fs.writeFileSync(file,found.join('\n')+'\n',{encoding:'utf8',mode:0o600});
    const where=file.replace(/\\/g,'/');
    action.text=action.text.replace(all,`（密钥已存于 ${where}，用时读取；汇报、日志、仓库里只写这个位置）`);
    return{count:found.length,file:where,note:'任务书里的密钥已换成存放位置'};
  }
  validateTaskScene(scene,kind,opts={}){
    if(scene===undefined)return;
    const scenes=require('../session-scenes'),selected=typeof scene==='string'&&scene?scenes.getScene(scene,{dataDir:this.deps.dataDir}):null;
    if(!selected)throw new Error('请选择有效场景（见 create_session 的 scene 说明）');
    if(selected.id!==scenes.DEFAULT_SCENE&&!scenes.supportsScenes(kind,opts))throw new Error('这个后端暂不支持所选场景，请使用支持场景的 Claude 或 Codex 后端');
  }
  dispatchAccounts(){
    if(this.deps.dispatchAccounts)return this.deps.dispatchAccounts();
    const status=this.deps.claudeAccountStatus?.();
    return status?{claude:{rows:status.rows}}:{};
  }
  pickAccount(options){return dispatch.pickAccount(options,this.dispatchAccounts());}
  noteTeamApproval(event){
    const text=`前台已代批「${event.goal}」：已建 ${event.created} 个，排队 ${event.queued} 个，失败 ${event.failed} 个。`;
    if(this.care)return this.care.alerts.announce({key:'auto-approve:'+event.planId,text,title:'前台已代批'});
    return{user:!!this.watches.addNotice({id:'announce:auto-approve:'+event.planId,kind:'hub-announce',title:'前台已代批',label:'前台已代批',text,pushTo:['desktop']}),front:null};
  }
  validateDispatch(action){
    if(action.dispatchType!==undefined&&!dispatch.TYPES.includes(action.dispatchType))throw Error('派工类型应为追加任务 / 相关并行 / 无关新建');
    if(action.type==='create'&&action.dispatchType==='追加任务')throw Error('追加任务请交给原会话 send_session');
    if(action.type==='send'&&action.dispatchType==='无关新建')throw Error('无关任务请新建会话 create_session');
    if(action.group!==undefined&&!this.taskGroups.get(action.group))throw Error('任务组不存在');
    if(action.relatedSessionId&&!this.sessionMetadata(action.relatedSessionId))throw Error('关联原会话不存在');
  }
  // plainTask / taskPurpose：hub 命令（core/hub-cli）建的会话不追加负责人守则、按普通会话进侧栏（taskPurpose=null）。
  // desiredSessionId：调用方事先预留并登记了谱系的新会话编号；frontOwned=false：不是前台派工，不认领为前台负责人、不进前台健康处置（hub 审查 P2-5）。
  async execute(action,{followNewReply=false,trustedDispatch=false,issuerSessionId,onLedger,plainTask=false,taskPurpose='hub-assistant-task',desiredSessionId=null,frontOwned=true}={}) {
    if(!['send','create'].includes(action.type)||typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    const {requestId,...payload}=action;
    if(this.store.has(requestId)){
      const record=this.store.begin(requestId,payload);
      return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    }
    let resumeMeta=null,route=null,selection=null;
    this.validateDispatch(action);
    if(action.type==='create'){
      // 档位解析失败（型号不存在、深度不支持）在落账前报错，助理可以换个说法重试。
      const kind=profiles.taskKind(action);backends.backendKind(kind);
      route=profiles.resolveTask(action,await this.deps.getDefaults?.(kind)||{});
      this.validateTaskScene(action.scene,kind,route.opts);
      selection=dispatch.launchOptions(kind,action,this.dispatchAccounts());
    }
    if(action.type==='send'){
      if(this.assistantIds().includes(action.targetSessionId)||this.sessionMetadata(action.targetSessionId)?.purpose==='hub-assistant')throw new Error('助理不能向自身循环派发');
      const target=this.deps.getSession(action.targetSessionId);
      if(!target){
        const stored=this.deps.getSessionMetadata?.(action.targetSessionId);
        if(!stored||!nativeId(stored)||!this.deps.resumeSession)throw new Error('原目标未打开或缺少原生身份；未创建替代会话');
        resumeMeta=stored;
      }
      const truth=require('../session-runtime-truth');
      if(target&&(truth.sessionRuntimeIsActive(target)||['running','waiting'].includes(target.status)))throw Object.assign(new Error('目标会话正在运行或等待输入，请先明确处理当前任务'),{code:'target-busy'});
    }
    const record=this.store.begin(requestId,payload);const dispatchStartedAt=Date.now();onLedger?.();
    if(record.duplicate)return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    let sessionId=action.targetSessionId;
    try {
      if(resumeMeta){
        await this.deps.resumeSession(sessionId);const target=this.deps.getSession(sessionId);
        if(!target||target.id!==sessionId||nativeId(target)!==nativeId(resumeMeta))throw new Error('原目标恢复身份未确认，未发送任务');
        // 恢复后仍忙（hub 审查 P2-3）：确定没发，撤销账目并按「忙」退回，调用方排队等空闲再用同一编号送；不记成结果不明。
        if(require('../session-runtime-truth').sessionRuntimeIsActive(target)||['running','waiting'].includes(target.status)){this.store.discard(requestId);throw Object.assign(new Error('原目标恢复后仍在运行或等待输入，未发送任务'),{code:'target-busy'});}
      }
      if(action.type==='create'){
        const desiredId=typeof desiredSessionId==='string'&&/^[\w-]{8,80}$/.test(desiredSessionId)?desiredSessionId:randomUUID();this.store.set('reserved:'+requestId,desiredId);
        // 助理新建的是后台会话，没有界面终端回应光标查询；与群聊成员一样关闭 ConPTY 继承光标，否则 Claude 会卡在启动。
        const session=await this.deps.createSession(route.kind,{...route.opts,...selection.opts,id:desiredId,title:String(action.title||'助理委托任务').slice(0,100),...(taskPurpose?{purpose:taskPurpose}:{}),...(action.scene?{scene:action.scene}:{}),openInBackground:true,noInheritCursor:true});sessionId=session.id;
        // Follow before submission: a fast target can reply before the manager
        // receives create_session's result and gets a chance to call watch.
        if(followNewReply)this.followTask({sessionId,auto:followNewReply!=='explicit'&&action.type==='create'});
      }
      const dispatchType=action.dispatchType||(action.type==='create'?'无关新建':'追加任务');
      const group=trustedDispatch?this.taskGroups.registerDispatch({group:action.group,goal:action.title||action.text,sessionId,originSessionId:action.relatedSessionId,issuerSessionId,requestId,role:dispatchType==='相关并行'&&action.type==='send'?'负责人':'成员'}):null;
      // 新开的会话就是负责人：任务正文后追加负责人守则（交卷格式、没变化时静默）。
      const taskText=dispatchType==='相关并行'&&action.type==='send'?dispatch.teamPrompt(action.text):action.type==='create'&&!plainTask?dispatch.leadPrompt(action.text):action.text;
      const wireText=require('./delegated-prompt').encodeDelegatedPrompt(taskText,this.deps.getSession(sessionId)?.kind);
      const receipt=await this.deps.sendPrompt(sessionId,wireText,requestId);
      const confirmed=receipt?.ok===true&&receipt?.receipt?.status==='confirmed'&&!receipt.notSent&&!receipt.contentMismatch;
      const sceneWarning=action.type==='create'&&action.scene?this.deps.getSession(sessionId)?.writingContextWarning:null;
      const actual=dispatch.runtime(this.deps.getSession(sessionId));
      const result={sessionId,...(frontOwned?{}:{issuerSessionId:issuerSessionId||null}),receipt,runtime:actual,dispatch:{type:dispatchType,groupId:group?.id||null,reason:selection?.reason||'交给精确原会话',summary:`判为${dispatchType}，派给${sessionId}`},...(sceneWarning?{sceneWarning}:{}),...(route?{route:{tier:route.tier,kind:route.kind,model:actual.model,effort:actual.effort,account:actual.account,cwd:actual.cwd,label:backends.getKindLabel(actual.kind||route.kind)+' · '+(actual.model?profiles.describe(actual.kind||route.kind,actual.model,actual.effort).label:'模型未读回')}}:{})};this.store.finish(requestId,confirmed?'acknowledged':'unknown',result);
      // m3：派出的会话进入 4 道检查点跟踪；没确认送达的也跟踪，由「已送达」检查点补发。
      if(frontOwned&&action.type==='create'&&action.lead===true)result.lead=this.registerLead(sessionId,action.title);
      const health=frontOwned?this.care?.track({...action,dispatchStartedAt},result,route)||null:null;
      return{ok:confirmed,state:confirmed?'acknowledged':'unknown',...result,...(health?{health:{state:health.state,summary:health.summary,checkpoints:health.checkpoints}}:{})};
    } catch(error) {if(error.code==='target-busy'&&!this.store.has(requestId))throw error;this.store.finish(requestId,'unknown',{sessionId,error:error.message});const health=frontOwned&&sessionId&&this.deps.getSession(sessionId)?this.care?.track({...action,dispatchStartedAt},{sessionId},route):null;return{ok:false,state:'unknown',sessionId,error:error.message,...(health?{health:{state:health.state,summary:health.summary}}:{})};}
  }
  close(){try{this.care?.close();}catch(error){console.warn('[assistant] session-health',error.message);}try{this.restartResume.close();}catch(error){console.warn('[assistant] restart-resume',error.message);}this.progressFeed.close();clearInterval(this.systemReplyTimer);this.systemReplyTimer=null;this.dispatchQueue?.close();this.handoff?.close();this.patrol?.close();this.frontDoor?.close();this.feedStore?.close();this.secretary?.close();this.reminders?.stop();this.memos?.stop();for(const timer of [this.startupTimer,this.prewarmTimer,this.dailyTimer,this.idleTimer])clearTimeout(timer);clearInterval(this.reconcileTimer);clearInterval(this.safetyTimer);this.bridge.close();this.store.close();}
}
module.exports={AssistantService};
