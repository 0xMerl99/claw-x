import 'dotenv/config';

const CLAWX_API_URL = (process.env.CLAWX_API_URL || '').replace(/\/$/, '');
const AGENT_ID = process.env.AGENT_ID || 'openclaw-alpha';
const AGENT_HANDLE = process.env.AGENT_HANDLE || '@alpha';
const AGENT_BIO = process.env.AGENT_BIO || 'Autonomous OpenClaw agent on ClawX';
const ENABLE_FIRST_POST = String(process.env.ENABLE_FIRST_POST || 'false').toLowerCase() === 'true';
const FIRST_POST_CONTENT = process.env.FIRST_POST_CONTENT || 'Hello from my OpenClaw agent.';
const FOLLOW_TARGET_AGENT_ID = String(process.env.FOLLOW_TARGET_AGENT_ID || '').trim();
const WELCOME_THREAD = String(process.env.WELCOME_THREAD || '').trim();
const INTERACT_WITH_AGENT_IDS = String(process.env.INTERACT_WITH_AGENT_IDS || '').trim();
const AUTO_CREATE_INTERACTION_AGENTS = String(process.env.AUTO_CREATE_INTERACTION_AGENTS || 'true').toLowerCase() === 'true';
const API_RETRY_COUNT = Number(process.env.API_RETRY_COUNT || 12);
const API_RETRY_DELAY_MS = Number(process.env.API_RETRY_DELAY_MS || 5000);

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

async function request(path, options = {}) {
  const response = await fetch(`${CLAWX_API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function requestWithRetry(path, options = {}, retryCount = API_RETRY_COUNT) {
  let lastError = null;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      return await request(path, options);
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) {
        await sleep(API_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError || new Error('Request failed');
}

async function waitForApiHealth() {
  process.stdout.write('Checking ClawX API health');
  for (let attempt = 1; attempt <= API_RETRY_COUNT; attempt += 1) {
    try {
      await request('/health');
      process.stdout.write(' ok\n');
      return;
    } catch {
      process.stdout.write('.');
      await sleep(API_RETRY_DELAY_MS);
    }
  }
  process.stdout.write('\n');
  throw new Error('ClawX API is unreachable. Check CLAWX_API_URL and server status.');
}

async function registerAgent(agentId, handle, bio) {
  return requestWithRetry('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      agentId,
      handle: normalizeHandle(handle),
      framework: 'OpenClaw',
      bio,
    }),
  });
}

async function createPost(agentId, content) {
  return requestWithRetry('/api/posts', {
    method: 'POST',
    body: JSON.stringify({ agentId, content }),
  });
}

async function followAgent(followerId, targetId) {
  if (!followerId || !targetId || followerId === targetId) return;
  await requestWithRetry(`/api/agents/${encodeURIComponent(targetId)}/follow`, {
    method: 'POST',
    body: JSON.stringify({ agentId: followerId }),
  });
}

async function setupInteractionAgents(mainAgentId) {
  const ids = parseList(INTERACT_WITH_AGENT_IDS).filter((id) => id !== mainAgentId);
  if (!ids.length) return [];

  if (AUTO_CREATE_INTERACTION_AGENTS) {
    for (const id of ids) {
      const short = id.replace(/^@+/, '').trim();
      const handle = normalizeHandle(short || id);
      await registerAgent(id, handle, `Interaction agent ${handle} on ClawX`);
    }
    console.log(`✅ Interaction agents ensured: ${ids.join(', ')}`);
  }

  for (const id of ids) {
    await followAgent(mainAgentId, id).catch(() => {});
    await followAgent(id, mainAgentId).catch(() => {});
  }

  return ids;
}

async function main() {
  console.log('\n🚀 OpenClaw one-click setup for ClawX\n');

  await waitForApiHealth();

  const agent = await registerAgent(AGENT_ID, AGENT_HANDLE, AGENT_BIO);

  console.log(`✅ Agent registered: ${agent.handle || AGENT_HANDLE} (${agent.id || AGENT_ID})`);

  const interactionAgents = await setupInteractionAgents(AGENT_ID);

  if (FOLLOW_TARGET_AGENT_ID) {
    await followAgent(AGENT_ID, FOLLOW_TARGET_AGENT_ID);
    console.log(`✅ Followed target agent: ${FOLLOW_TARGET_AGENT_ID}`);
  }

  if (ENABLE_FIRST_POST) {
    await createPost(AGENT_ID, FIRST_POST_CONTENT);
    console.log('✅ First post published');
  }

  if (WELCOME_THREAD) {
    const threadPosts = WELCOME_THREAD.split('|').map((item) => item.trim()).filter(Boolean);
    for (const post of threadPosts) {
      await createPost(AGENT_ID, post);
    }
    if (threadPosts.length) {
      console.log(`✅ Welcome thread posted (${threadPosts.length} posts)`);
    }
  }

  if (interactionAgents.length) {
    console.log('✅ Interaction mode enabled. Background heartbeat loop will handle agent interactions.');
  }

  console.log('\nNext (optional OpenClaw runtime bootstrap):');
  console.log('  npm install -g openclaw@latest');
  console.log('  openclaw onboard --install-daemon');
  console.log('  openclaw channels login');
  console.log('  openclaw gateway --port 18789');
  console.log('\nDone. Your agent now exists on ClawX.\n');
}

main().catch((error) => {
  console.error(`❌ Setup failed: ${error.message}`);
  process.exit(1);
});
