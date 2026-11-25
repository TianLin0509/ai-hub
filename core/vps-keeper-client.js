'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ORIGIN = 'http://127.0.0.1:17950';

function createKeeperClient({ fetch: request = globalThis.fetch, snapshotPath = path.join(os.homedir(), '.vps-keeper', 'snapshot.json'), timeoutMs = 1500 } = {}) {
  async function api(endpoint, method = 'GET', limitMs = timeoutMs) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await request(ORIGIN + endpoint, { method, signal: controller.signal, redirect: 'error' });
          if (!response.ok) throw new Error('keeper unavailable');
          return await response.json();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('keeper timeout')); }, limitMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  function snapshot() {
    try { return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch { return null; }
  }
  const valid = (data, key) => Array.isArray(data?.[key]) && data[key].every(v => v && typeof v.id === 'string' && v.id);
  async function list(key) {
    try {
      const data = await api('/v1/' + key);
      if (!valid(data, key)) throw new Error('invalid keeper data');
      return { source: 'api', at: new Date().toISOString(), [key]: data[key] };
    } catch {
      const data = snapshot();
      if (valid(data, key) && data.writtenAt) return { source: 'snapshot', at: data.writtenAt, [key]: data[key] };
      return { source: 'none', at: null, [key]: [] };
    }
  }
  return {
    async health(limitMs = timeoutMs) {
      try { return (await api('/v1/health', 'GET', limitMs))?.ok === true; } catch { return false; }
    },
    async account(id) {
      if (typeof id !== 'string' || !/^(claude|codex):[a-zA-Z0-9_-]+$/.test(id)) throw Error('账号标识无效');
      // Older keepers have no single-account endpoint. Do not substitute stale browser state.
      try { const data = await api('/v1/accounts/' + encodeURIComponent(id)); return data?.id === id ? data : data?.account?.id === id ? data.account : null; }
      catch { return null; }
    },
    exits: () => list('exits'),
    hosts: () => list('hosts'),
    async check(id) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('出口标识无效');
      try {
        const check = await api('/v1/exits/' + encodeURIComponent(id) + '/check', 'POST');
        if (!check || typeof check.status !== 'string') throw new Error('invalid check');
        return { source: 'api', at: check.at || new Date().toISOString(), check };
      } catch {
        const data = snapshot(), check = Array.isArray(data?.exits) ? data.exits.find(e => e?.id === id)?.check : null;
        return check && data.writtenAt ? { source: 'snapshot', at: data.writtenAt, check } : { source: 'none', at: null, check: null };
      }
    },
  };
}

function createDefaultClient() {
  let client = null;
  return client;
}

module.exports = { createKeeperClient, createDefaultClient, ORIGIN };
