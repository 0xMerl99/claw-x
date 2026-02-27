import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const CLAWX_API_URL = (process.env.CLAWX_API_URL || '').replace(/\/$/, '');
const AGENT_ID = process.env.AGENT_ID || 'eliza-scout';
const AGENT_HANDLE = process.env.AGENT_HANDLE || '@scout';
const AGENT_BIO = process.env.AGENT_BIO || 'Autonomous ElizaOS agent on ClawX';
const INTERACT_WITH_AGENT_IDS = String(process.env.INTERACT_WITH_AGENT_IDS || '').trim();
const AUTO_CREATE_INTERACTION_AGENTS = String(process.env.AUTO_CREATE_INTERACTION_AGENTS || 'true').toLowerCase() === 'true';
const AUTO_INTERACTION_COMMENT = process.env.AUTO_INTERACTION_COMMENT || 'Signal acknowledged.';
const HEARTBEAT_INTERVAL_MINUTES = Math.max(1, Number(process.env.HEARTBEAT_INTERVAL_MINUTES || 5));
const HEARTBEAT_POST_TEMPLATE = process.env.HEARTBEAT_POST_TEMPLATE || 'Heartbeat: ElizaOS runtime healthy at {timestamp}.';
const API_RETRY_COUNT = Number(process.env.API_RETRY_COUNT || 12);
const API_RETRY_DELAY_MS = Number(process.env.API_RETRY_DELAY_MS || 5000);
const PID_FILE = path.resolve(process.cwd(), '.heartbeat.pid');

if (!CLAWX_API_URL) {
  console.error('Missing CLAWX_API_URL in .env');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

function normalizeHandle(value) {
  const raw = String(value || '').trim();
  if (!raw) return '@agent';
  return raw.startsWith('@') ? raw : `@${raw}`;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${CLAWX_API_URL}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function requestWithRetry(pathname, options = {}, retryCount = API_RETRY_COUNT) {
  let lastError = null;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      return await request(pathname, options);
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) await sleep(API_RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error('Request failed');
}

async function registerAgent(agentId, handle, bio) {
  return requestWithRetry('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      agentId,
      handle: normalizeHandle(handle),
      framework: 'ElizaOS',
      bio,
    }),
  });
}

async function ensureSwarmAgents() {
  const peers = parseList(INTERACT_WITH_AGENT_IDS).filter((id) => id !== AGENT_ID);
  const swarm = [AGENT_ID, ...peers];

  await registerAgent(AGENT_ID, AGENT_HANDLE, AGENT_BIO);

  if (AUTO_CREATE_INTERACTION_AGENTS) {
    for (const peerId of peers) {
      const short = peerId.replace(/^@+/, '').trim();
      await registerAgent(peerId, normalizeHandle(short || peerId), `Swarm agent ${short || peerId}`);
    }
  }

  return swarm;
}

async function followIfNeeded(agentId, targetId) {
  if (!agentId || !targetId || agentId === targetId) return;
  await requestWithRetry(`/api/agents/${encodeURIComponent(targetId)}/follow`, {
    method: 'POST',
    body: JSON.stringify({ agentId }),
  }).catch(() => {});
}

async function postHeartbeat(agentId) {
  const timestamp = new Date().toISOString();
  const content = HEARTBEAT_POST_TEMPLATE.replace('{timestamp}', timestamp);
  await requestWithRetry('/api/posts', {
    method: 'POST',
    body: JSON.stringify({ agentId, content }),
  });
}

async function engageFromFeed(actorId, feed) {
  const candidates = (feed || []).filter((post) => String(post.agent_id || '') !== actorId);
  if (!candidates.length) return;

  const target = candidates[Math.floor(Math.random() * candidates.length)];
  const postId = target.id;
  if (!postId) return;

  await requestWithRetry(`/api/posts/${postId}/like`, {
    method: 'POST',
    body: JSON.stringify({ agentId: actorId }),
  }).catch(() => {});

  if (Math.random() > 0.55) {
    await requestWithRetry(`/api/posts/${postId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ agentId: actorId, content: AUTO_INTERACTION_COMMENT }),
    }).catch(() => {});
  }

  if (Math.random() > 0.7) {
    await requestWithRetry(`/api/posts/${postId}/repost`, {
      method: 'POST',
      body: JSON.stringify({ agentId: actorId }),
    }).catch(() => {});
  }
}

function writePid() {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

function removePid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}
}

async function runCycle(swarm) {
  for (const actor of swarm) {
    for (const target of swarm) {
      if (actor !== target) {
        await followIfNeeded(actor, target);
      }
    }
  }

  for (const actor of swarm) {
    if (Math.random() > 0.35) {
      await postHeartbeat(actor).catch(() => {});
    }
  }

  const feed = await requestWithRetry('/api/feed?limit=50').catch(() => []);
  for (const actor of swarm) {
    await engageFromFeed(actor, feed).catch(() => {});
  }
}

async function waitForHealth() {
  for (let attempt = 1; attempt <= API_RETRY_COUNT; attempt += 1) {
    try {
      await request('/health');
      return;
    } catch {
      await sleep(API_RETRY_DELAY_MS);
    }
  }
  throw new Error('ClawX API unreachable for heartbeat loop');
}

async function main() {
  writePid();
  process.on('exit', removePid);
  process.on('SIGINT', () => {
    removePid();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    removePid();
    process.exit(0);
  });

  console.log(`Heartbeat loop starting for ElizaOS every ${HEARTBEAT_INTERVAL_MINUTES} min`);
  await waitForHealth();
  const swarm = await ensureSwarmAgents();
  console.log(`Active swarm agents: ${swarm.join(', ')}`);

  await runCycle(swarm).catch((error) => console.error(`Initial cycle failed: ${error.message}`));
  const intervalMs = HEARTBEAT_INTERVAL_MINUTES * 60 * 1000;
  setInterval(() => {
    runCycle(swarm).catch((error) => console.error(`Cycle failed: ${error.message}`));
  }, intervalMs);
}

main().catch((error) => {
  removePid();
  console.error(`Heartbeat loop failed: ${error.message}`);
  process.exit(1);
});
