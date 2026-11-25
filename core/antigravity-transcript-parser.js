'use strict';
const fs = require('fs');
const path = require('path');
const {UUID,receiptsFile,inferContextWindow} = require('./antigravity-config');
const {displayUserText,hubAttachedFields} = require('./synthetic-user-filter');
const {withTurnSpeed} = require('./turn-speed-metrics');
const hash=text=>require('crypto').createHash('sha256').update(text).digest('hex');
function decodeToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      try {
        const parsed = JSON.parse(v);
        out[k] = typeof parsed === 'string' ? parsed : v;
        continue;
      } catch {}
    }
    out[k] = v;
  }
  return out;
}
function extractMediaAttachments(media) {
  if (!Array.isArray(media) || !media.length) return [];
  const out = [];
  for (const item of media) {
    if (!item || typeof item !== 'object') continue;
    const uri = typeof item.uri === 'string' ? item.uri.trim() : '';
    const mime = typeof item.mime_type === 'string' ? item.mime_type.trim() : '';
    if (!uri) continue;
    let filePath = uri;
    if (/^file:\/\//i.test(filePath)) {
      try { filePath = decodeURIComponent(filePath.replace(/^file:\/\//i, '')); } catch { filePath = filePath.replace(/^file:\/\//i, ''); }
      filePath = filePath.replace(/^\/+([A-Za-z]:[\\/])/, '$1');
    }
    out.push({ path: filePath, ...(mime ? { mimeType: mime } : {}) });
  }
  return out;
}
function extractStepUsage(row, model) {
  const hasIn = Number.isFinite(row.input_tokens);
  const hasCache = Number.isFinite(row.cache_read_tokens);
  const hasOut = Number.isFinite(row.output_tokens);
  if (!hasIn && !hasCache && !hasOut) return null;
  const input = hasIn && row.input_tokens > 0 ? row.input_tokens : 0;
  const cacheRead = hasCache && row.cache_read_tokens > 0 ? row.cache_read_tokens : 0;
  const output = hasOut && row.output_tokens > 0 ? row.output_tokens : 0;
  const contextTokens = input + cacheRead;
  return {
    input_tokens: input,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    context_tokens: contextTokens,
    context_window: inferContextWindow(model),
  };
}
function parseAntigravityTranscriptToTurns(file, options = {}) {
  const match = /[\\/]brain[\\/]([^\\/]+)[\\/]/i.exec(file);
  if (!match || !UUID.test(match[1]) || (options.expectedSessionId && match[1] !== options.expectedSessionId))
    throw new Error('Antigravity 记录不属于当前会话');
  const candidates = ['transcript.jsonl','transcript_full.jsonl'].map(name=>path.join(path.dirname(file),name))
    .filter(candidate=>fs.existsSync(candidate)).sort((a,b)=>fs.statSync(a).mtimeMs-fs.statSync(b).mtimeMs
      // Windows can stamp adjacent writes identically. The live snapshot is
      // authoritative on a tie; its truncated fields still borrow full text.
      || (path.basename(a)==='transcript_full.jsonl' ? -1 : 1));
  const rows = new Map();
  for (const candidate of candidates) {
    const lines = fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '').split('\n');
    for (let i=0; i<lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const row=JSON.parse(lines[i]), key=row.step_index ?? i, old=rows.get(key);
        // created_at stays constant while a step streams. Snapshot mtime owns
        // freshness; only explicitly truncated fields may use the full copy.
        if (old && (!old.created_at || old.created_at===row.created_at) && old.status===row.status) {
          for(const field of Array.isArray(row.truncated_fields)?row.truncated_fields:[]) {
            if(old[field]!=null && !old.truncated_fields?.includes(field)) row[field]=old[field];
          }
        }
        rows.set(key,row);
      } catch (error) { if (i !== lines.length-1) throw error; }
    }
  }
  const turns=[];let replyKey=null;
  const receiptPath=options.receiptsFile||receiptsFile(match[1]);
  let receipts={};
  try { receipts=JSON.parse(fs.readFileSync(receiptPath,'utf8'))||{}; } catch { /* Optional completion evidence must not hide history. */ }
  for (const [index,row] of [...rows].sort((a,b)=>Number(a[0])-Number(b[0]))) {
    const user=row.type==='USER_INPUT' || row.source==='USER_EXPLICIT';
    if (!user && row.source !== 'MODEL') continue;
    let text=typeof row.content==='string'?row.content:'';
    let attached={};
    let rawUserText='';
    if(user){
      const extracted=/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text)?.[1] ?? text;
      rawUserText=extracted;
      attached=hubAttachedFields(extracted);
      const cleaned=displayUserText(extracted);
      text=cleaned===null?'':cleaned;
    }
    const id=`agy-${index}`, ts=Date.parse(row.created_at)||null;
    if(user) replyKey=id;
    // GENERIC/MODEL is a tool result, not words spoken to the user.
    if (!user && row.type !== 'PLANNER_RESPONSE') {
      turns.push({id,role:'assistant',kind:'gemini',source:'antigravity-cli',replyKey,ts,text:'',thinking:'',
        toolCalls:text?[{id:`${id}-result`,name:row.type==='GENERIC'?'执行结果':row.type||'原生活动',output:text,
          status:row.status==='ERROR'?'failed':row.status==='DONE'?'completed':'running',isError:row.status==='ERROR'}]:[],displayMessages:[]});
      continue;
    }
    const receipt=receipts[id];
    const final=!user&&receipt?.textHash===hash(text)&&receipt.ts===ts?receipt:null;
    const model=!user && typeof row.model==='string' && row.model.trim() ? row.model.trim() : null;
    const usage=!user ? extractStepUsage(row, model) : null;
    const attachments=user ? extractMediaAttachments(row.media) : [];
    turns.push({id,role:user?'user':'assistant',kind:'gemini',source:'antigravity-cli',text,ts,
      ...(user && rawUserText && rawUserText !== text ? {rawUserText} : {}),
      ...attached,
      ...(model?{model}:{}),
      ...(usage?{usage}:{}),
      ...(attachments.length?{attachments}:{}),
      thinking:typeof row.thinking==='string'?row.thinking:'',
      toolCalls:(row.tool_calls||[]).map((t,i)=>({id:`${id}-tool-${i}`,name:t.name,input:decodeToolArgs(t.args),
        status:row.status==='ERROR'?'failed':'running',isError:row.status==='ERROR'})),
      // DONE marks a step, not a whole turn. Only the native Stop hook closes a turn.
      ...(user?{}:{replyKey,nativeOutcome:final?.outcome||null,tsEnd:final?.completedAt||null,displayMessages:[
        ...(typeof row.thinking==='string' && row.thinking.trim() ? [{id:`${id}:thinking`,text:row.thinking,phase:'commentary',fromThinking:true,ts}] : []),
        ...(text?[{id:`${id}:text`,text,phase:final?.outcome==='completed'?'final_answer':'commentary',ts}]:[])]})});
  }
  const result=options.rawSteps ? turns : groupSteps(turns);
  return Number.isFinite(options.limit)&&options.limit>=0
    ?options.limit===0?[]:options.fromTail===false?result.slice(0,options.limit):result.slice(-options.limit):result;
}
function pairStepToolCalls(steps) {
  const paired = [];
  const pending = [];
  for (const step of steps) {
    const calls = step.toolCalls || [];
    if (calls.length === 1 && String(calls[0].id || '').endsWith('-result') && pending.length > 0) {
      const target = pending.shift();
      target.output = calls[0].output;
      target.status = calls[0].status;
      target.isError = calls[0].isError;
      if (Number.isFinite(step.ts) && Number.isFinite(target._startedTs) && step.ts >= target._startedTs) {
        target.durationMs = step.ts - target._startedTs;
      }
      continue;
    }
    for (const tool of calls) {
      const copy = { ...tool };
      if (Number.isFinite(step.ts)) Object.defineProperty(copy, '_startedTs', { value: step.ts, enumerable: false });
      paired.push(copy);
      if (copy.output === undefined && !String(copy.id || '').endsWith('-result')) {
        pending.push(copy);
      }
    }
  }
  return paired;
}
function aggregateStepUsage(steps, model) {
  let input = 0, cacheRead = 0, output = 0, contextTokens = 0, contextWindow = null, count = 0;
  for (const step of steps) {
    if (!step.usage) continue;
    count += 1;
    input += Number(step.usage.input_tokens) || 0;
    cacheRead += Number(step.usage.cache_read_input_tokens) || 0;
    output += Number(step.usage.output_tokens) || 0;
    if (Number.isFinite(step.usage.context_tokens) && step.usage.context_tokens > 0) {
      contextTokens = step.usage.context_tokens;
    }
    if (Number.isFinite(step.usage.context_window) && step.usage.context_window > 0) {
      contextWindow = step.usage.context_window;
    }
  }
  if (!count) return null;
  return {
    input_tokens: input,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    context_tokens: contextTokens,
    context_window: contextWindow || inferContextWindow(model),
  };
}
// Pagination counts user/answer cards, never internal model/tool steps. Keep
// the first step as the anchor while the response grows or history expands.
function groupSteps(turns) {
  const result=[];
  for(let start=0;start<turns.length;) {
    const first=turns[start];
    if(first.role==='user'){result.push(first);start++;continue;}
    let end=start+1;
    while(end<turns.length && turns[end].role==='assistant' && turns[end].replyKey===first.replyKey)end++;
    const steps=turns.slice(start,end), answer=steps.findLast(t=>t.text), last=steps.at(-1);
    const hasLaterUser = end < turns.length && turns[end].role === 'user';
    const model = steps.findLast(t => t.model)?.model || null;
    const usage = aggregateStepUsage(steps, model);
    const tsEnd = answer?.tsEnd || last.ts;
    const durationMs = Number.isFinite(first.ts) && Number.isFinite(tsEnd) && tsEnd > first.ts ? tsEnd - first.ts : undefined;
    const historicalFinal = hasLaterUser && answer && answer.text && !answer.toolCalls?.length;
    const pairedTools = pairStepToolCalls(steps);
    if (historicalFinal || answer?.nativeOutcome === 'completed') {
      for (const tc of pairedTools) { if (tc.status === 'running') tc.status = 'completed'; }
    }
    const card = withTurnSpeed({...first,text:answer?.text||'',
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      nativeOutcome:answer?.nativeOutcome||(historicalFinal?'completed':null),tsEnd,
      thinking:steps.map(t=>t.thinking).filter(Boolean).join('\n\n'),
      toolCalls:pairedTools,
      displayMessages:steps.flatMap(t=>(t.displayMessages||[]).map(m=>({...m,
        phase:t===answer ? (historicalFinal && m.id === `${t.id}:text` ? 'final_answer' : m.phase) : 'commentary'})))});
    result.push(card);
    start=end;
  }
  return result;
}
module.exports={parseAntigravityTranscriptToTurns,hash};
