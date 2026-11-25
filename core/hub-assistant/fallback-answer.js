'use strict';
// 前台会话连续收不下消息（启动失败、账号不可用等）时，才用 DeepSeek 官方 API 的 deepseek-flash 当场答一句，
const BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-flash';
const LABEL = 'DeepSeek Flash 兜底';

function systemPrompt(now = new Date()) {
  const day = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return [
    `你是 AI Hub 助理的临时兜底。现在是北京时间 ${day}。平时由 Claude 前台会话回答，它此刻暂时收不下消息，所以由你先答。`,
    '能直接答的（常识、计算、翻译、写一段话、出主意）就直接答，口语，先给结论。',
    '你看不到 Hub 里的会话、文件和任务，也不能派活或改东西；遇到这类要求，一句话说明「前台暂时不可用，等它恢复后再办」，不要编造进展或结果。',
  ].join('\n');
}

class FallbackAnswer {
  constructor({ apiKey, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    this.apiKey = apiKey; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  available() { return !!String((typeof this.apiKey === 'function' ? this.apiKey() : this.apiKey) || '').trim(); }
  async answer(question, { history = [], now = new Date() } = {}) {
    const key = String((typeof this.apiKey === 'function' ? this.apiKey() : this.apiKey) || '').trim();
    if (!key) throw new Error('没有配置 DeepSeek API Key，无法兜底');
    const messages = [{ role: 'system', content: systemPrompt(now) }];
    for (const row of history.slice(-6)) if (row?.text) messages.push({ role: row.role === 'user' ? 'user' : 'assistant', content: String(row.text).slice(0, 400) });
    messages.push({ role: 'user', content: String(question) });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs), started = Date.now();
    try {
      const r = await this.fetch(BASE + '/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, stream: false, temperature: 0.3, messages }),
      });
      if (!r.ok) throw new Error('DeepSeek 兜底请求失败（' + r.status + '）');
      const text = String((await r.json())?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('DeepSeek 兜底没有返回内容');
      return { text, model: MODEL, by: LABEL, ms: Date.now() - started };
    } finally { clearTimeout(timer); }
  }
}
module.exports = { FallbackAnswer, systemPrompt, MODEL, LABEL, BASE };
