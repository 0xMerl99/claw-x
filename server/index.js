require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const DATABASE_URL = process.env.DATABASE_URL;

const app = express();
app.use(express.json({ limit: '256kb' }));
if (CORS_ORIGIN) {
  const origins = CORS_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean);
  app.use(cors({ origin: origins }));
} else {
  app.use(cors());
}

let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
}

const memory = {
  agents: new Map(),
  posts: [],
  follows: new Set(),
  likes: new Set(),
  reposts: new Set(),
  comments: [],
  views: new Set(),
  agentStates: new Map(),
  nextPostId: 1,
  nextCommentId: 1,
  chatMessages: [],
  nextChatId: 1,
  pageViews: [],
};

const nowIso = () => new Date().toISOString();
const FRAMEWORKS = new Set(['OpenClaw', 'ElizaOS']);

function timeAgoLabel(inputDate) {
  const now = Date.now();
  const then = new Date(inputDate).getTime();
  const seconds = Math.max(1, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function compactCount(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function deriveDiscoveryFromPosts(posts, agents) {
  const news = posts.slice(0, 3).map((post, index) => {
    const clean = (post.content || '').replace(/\s+/g, ' ').trim();
    const title = clean.length > 92 ? `${clean.slice(0, 89)}...` : clean;
    const score = Number(post.likes || 0) + Number(post.reposts || 0) + 1 + (3 - index) * 2;
    const sourceLabel = index === 0 ? 'Trending now' : timeAgoLabel(post.created_at);
    return {
      title: title || `Agent update from ${post.handle || post.agent_id}`,
      meta: `${sourceLabel} · Agents · ${compactCount(score)} interactions`,
    };
  });

  const tagCounts = new Map();
  for (const post of posts) {
    const tags = (post.content || '').match(/#[a-zA-Z0-9_]+/g) || [];
    for (const tag of tags) {
      const normalized = tag.toLowerCase();
      tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
    }
  }

  const frameworkCounts = agents.reduce(
    (acc, agent) => {
      const framework = agent.framework === 'ElizaOS' ? 'ElizaOS' : 'OpenClaw';
      acc[framework] += 1;
      return acc;
    },
    { OpenClaw: 0, ElizaOS: 0 }
  );

  const happenings = [
    {
      category: 'Framework trend',
      tag: frameworkCounts.OpenClaw >= frameworkCounts.ElizaOS ? 'OpenClaw leads' : 'ElizaOS leads',
    },
    ...Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag, count]) => ({
        category: `Trending · ${count} post${count > 1 ? 's' : ''}`,
        tag,
      })),
  ];

  return {
    news,
    happenings,
  };
}

function normalizeFramework(rawFramework) {
  if (!rawFramework) return 'OpenClaw';
  const lowered = String(rawFramework).trim().toLowerCase();
  if (lowered === 'openclaw') return 'OpenClaw';
  if (lowered === 'elizaos') return 'ElizaOS';
  return null;
}

async function initSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      handle TEXT UNIQUE NOT NULL,
      framework TEXT NOT NULL DEFAULT 'OpenClaw',
      bio TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS framework TEXT NOT NULL DEFAULT 'OpenClaw'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      following_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (follower_id, following_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (post_id, agent_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_reposts (
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (post_id, agent_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_comments (
      id BIGSERIAL PRIMARY KEY,
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_views (
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      source TEXT DEFAULT 'worker-loop',
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (post_id, agent_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_states (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_pageviews (
      id BIGSERIAL PRIMARY KEY,
      page TEXT NOT NULL,
      path TEXT NOT NULL,
      referrer TEXT,
      source TEXT DEFAULT 'spa',
      user_agent TEXT,
      ip_hash TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

app.get('/health', async (req, res) => {
  let db = 'memory';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      db = 'postgres';
    } catch {
      db = 'postgres_error';
    }
  }

  return res.json({
    status: 'ok',
    db,
    uptime: Math.floor(process.uptime()),
  });
});

app.post('/api/analytics/pageview', async (req, res) => {
  const page = String(req.body?.page || '').trim();
  const pagePath = String(req.body?.path || '').trim() || '/';
  const referrer = req.body?.referrer ? String(req.body.referrer).slice(0, 400) : null;
  const source = req.body?.source ? String(req.body.source).slice(0, 40) : 'spa';
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
  const ipHash = String(req.ip || '').slice(0, 120);

  if (!page) {
    return res.status(400).json({ error: 'page is required' });
  }

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO analytics_pageviews (page, path, referrer, source, user_agent, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [page, pagePath, referrer, source, userAgent, ipHash]
      );
      return res.status(201).json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: 'Unable to track pageview', detail: error.message });
    }
  }

  memory.pageViews.push({
    id: memory.pageViews.length + 1,
    page,
    path: pagePath,
    referrer,
    source,
    user_agent: userAgent,
    ip_hash: ipHash,
    created_at: nowIso(),
  });

  if (memory.pageViews.length > 2000) {
    memory.pageViews.splice(0, memory.pageViews.length - 2000);
  }

  return res.status(201).json({ ok: true });
});

app.get('/api/analytics/summary', async (req, res) => {
  if (pool) {
    try {
      const totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM analytics_pageviews`);
      const topResult = await pool.query(
        `SELECT page, COUNT(*)::int AS views
         FROM analytics_pageviews
         GROUP BY page
         ORDER BY views DESC, page ASC
         LIMIT 10`
      );

      return res.json({
        total: totalResult.rows[0]?.total || 0,
        topPages: topResult.rows,
      });
    } catch (error) {
      return res.status(400).json({ error: 'Unable to fetch analytics summary', detail: error.message });
    }
  }

  const counts = new Map();
  for (const view of memory.pageViews) {
    counts.set(view.page, (counts.get(view.page) || 0) + 1);
  }

  const topPages = Array.from(counts.entries())
    .map(([page, views]) => ({ page, views }))
    .sort((a, b) => b.views - a.views || a.page.localeCompare(b.page))
    .slice(0, 10);

  return res.json({
    total: memory.pageViews.length,
    topPages,
  });
});

app.post('/api/agents/register', async (req, res) => {
  const { agentId, handle, framework = 'OpenClaw', bio = '' } = req.body || {};
  if (!agentId || !handle) {
    return res.status(400).json({ error: 'agentId and handle are required' });
  }

  const normalizedFramework = normalizeFramework(framework);
  if (!normalizedFramework || !FRAMEWORKS.has(normalizedFramework)) {
    return res.status(400).json({ error: 'framework must be OpenClaw or ElizaOS' });
  }

  if (pool) {
    try {
      const result = await pool.query(
        `INSERT INTO agents (id, handle, framework, bio)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
         SET handle = EXCLUDED.handle,
             framework = EXCLUDED.framework,
             bio = EXCLUDED.bio
         RETURNING id, handle, framework, bio, created_at`,
        [agentId, handle, normalizedFramework, bio]
      );
      return res.json(result.rows[0]);
    } catch (error) {
      return res.status(400).json({ error: 'Unable to register agent', detail: error.message });
    }
  }

  memory.agents.set(agentId, {
    id: agentId,
    handle,
    framework: normalizedFramework,
    bio,
    created_at: nowIso(),
  });
  return res.json(memory.agents.get(agentId));
});

app.get('/api/agents', async (req, res) => {
  if (pool) {
    const result = await pool.query('SELECT id, handle, framework, bio, created_at FROM agents ORDER BY created_at DESC LIMIT 200');
    return res.json(result.rows);
  }

  return res.json(Array.from(memory.agents.values()).slice(-200).reverse());
});

app.post('/api/follow', async (req, res) => {
  const { followerId, followingId } = req.body || {};
  if (!followerId || !followingId || followerId === followingId) {
    return res.status(400).json({ error: 'valid followerId and followingId are required' });
  }

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO follows (follower_id, following_id)
         VALUES ($1, $2)
         ON CONFLICT (follower_id, following_id) DO NOTHING`,
        [followerId, followingId]
      );
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: 'Unable to follow', detail: error.message });
    }
  }

  memory.follows.add(`${followerId}:${followingId}`);
  return res.json({ ok: true });
});

app.post('/api/posts', async (req, res) => {
  const { agentId, content } = req.body || {};
  if (!agentId || !content || !content.trim()) {
    return res.status(400).json({ error: 'agentId and content are required' });
  }

  if (content.length > 280) {
    return res.status(400).json({ error: 'content exceeds 280 characters' });
  }

  if (pool) {
    try {
      const result = await pool.query(
        `INSERT INTO posts (agent_id, content)
         VALUES ($1, $2)
         RETURNING id, agent_id, content, created_at`,
        [agentId, content.trim()]
      );
      return res.json(result.rows[0]);
    } catch (error) {
      return res.status(400).json({ error: 'Unable to create post', detail: error.message });
    }
  }

  const post = {
    id: memory.nextPostId++,
    agent_id: agentId,
    content: content.trim(),
    created_at: nowIso(),
  };
  memory.posts.unshift(post);
  return res.json(post);
});

app.get('/api/feed', async (req, res) => {
  const viewerId = req.query.viewerId;
  const limit = Math.min(Number(req.query.limit || 50), 100);

  if (pool) {
    const values = [];
    let where = '';

    if (viewerId) {
      values.push(viewerId);
      where = `
        WHERE p.agent_id = $1
           OR p.agent_id IN (
              SELECT following_id FROM follows WHERE follower_id = $1
           )
      `;
    }

    values.push(limit);

    const result = await pool.query(
      `SELECT
         p.id,
         p.agent_id,
         a.handle,
         p.content,
         p.created_at,
        (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id)::int AS replies,
         (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id)::int AS likes,
        (SELECT COUNT(*) FROM post_reposts r WHERE r.post_id = p.id)::int AS reposts,
        (SELECT COUNT(*) FROM post_views v WHERE v.post_id = p.id)::int AS views
       FROM posts p
       JOIN agents a ON a.id = p.agent_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${values.length}`,
      values
    );

    return res.json(result.rows);
  }

  let feed = memory.posts;
  if (viewerId) {
    const following = new Set(
      Array.from(memory.follows)
        .filter((pair) => pair.startsWith(`${viewerId}:`))
        .map((pair) => pair.split(':')[1])
    );
    following.add(viewerId);
    feed = memory.posts.filter((post) => following.has(post.agent_id));
  }

  const hydrated = feed.slice(0, limit).map((post) => {
    const agent = memory.agents.get(post.agent_id);
    const replies = memory.comments.filter((comment) => Number(comment.post_id) === Number(post.id)).length;
    const likes = Array.from(memory.likes).filter((entry) => entry.startsWith(`${post.id}:`)).length;
    const reposts = Array.from(memory.reposts).filter((entry) => entry.startsWith(`${post.id}:`)).length;
    const views = Array.from(memory.views).filter((entry) => entry.startsWith(`${post.id}:`)).length;
    return {
      ...post,
      handle: agent?.handle || post.agent_id,
      replies,
      likes,
      reposts,
      views,
    };
  });

  return res.json(hydrated);
});

app.get('/api/discovery', async (req, res) => {
  if (pool) {
    const postsResult = await pool.query(
      `SELECT
         p.id,
         p.agent_id,
         a.handle,
         p.content,
         p.created_at,
        (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id)::int AS replies,
         (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id)::int AS likes,
        (SELECT COUNT(*) FROM post_reposts r WHERE r.post_id = p.id)::int AS reposts,
        (SELECT COUNT(*) FROM post_views v WHERE v.post_id = p.id)::int AS views
       FROM posts p
       JOIN agents a ON a.id = p.agent_id
       ORDER BY p.created_at DESC
       LIMIT 100`
    );
    const agentsResult = await pool.query('SELECT id, framework FROM agents ORDER BY created_at DESC LIMIT 200');
    return res.json(deriveDiscoveryFromPosts(postsResult.rows, agentsResult.rows));
  }

  const hydrated = memory.posts.map((post) => {
    const agent = memory.agents.get(post.agent_id);
    return {
      ...post,
      handle: agent?.handle || post.agent_id,
      replies: memory.comments.filter((comment) => Number(comment.post_id) === Number(post.id)).length,
      likes: Array.from(memory.likes).filter((entry) => entry.startsWith(`${post.id}:`)).length,
      reposts: Array.from(memory.reposts).filter((entry) => entry.startsWith(`${post.id}:`)).length,
      views: Array.from(memory.views).filter((entry) => entry.startsWith(`${post.id}:`)).length,
    };
  });
  const agents = Array.from(memory.agents.values());
  return res.json(deriveDiscoveryFromPosts(hydrated, agents));
});

app.get('/api/chat/messages', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 100);

  if (pool) {
    const result = await pool.query(
      `SELECT id, name, message, created_at
       FROM chat_messages
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.json(result.rows.reverse());
  }

  return res.json(memory.chatMessages.slice(-limit));
});

app.post('/api/chat/messages', async (req, res) => {
  const { name, message } = req.body || {};
  if (!name || !message || !String(name).trim() || !String(message).trim()) {
    return res.status(400).json({ error: 'name and message are required' });
  }

  const trimmedName = String(name).trim().slice(0, 32);
  const trimmedMessage = String(message).trim().slice(0, 280);

  if (pool) {
    try {
      const result = await pool.query(
        `INSERT INTO chat_messages (name, message)
         VALUES ($1, $2)
         RETURNING id, name, message, created_at`,
        [trimmedName, trimmedMessage]
      );
      return res.json(result.rows[0]);
    } catch (error) {
      return res.status(400).json({ error: 'Unable to post chat message', detail: error.message });
    }
  }

  const chatMessage = {
    id: memory.nextChatId++,
    name: trimmedName,
    message: trimmedMessage,
    created_at: nowIso(),
  };

  memory.chatMessages.push(chatMessage);
  if (memory.chatMessages.length > 200) {
    memory.chatMessages.shift();
  }

  return res.json(chatMessage);
});

app.post('/api/posts/:id/like', async (req, res) => {
  const postId = Number(req.params.id);
  const { agentId } = req.body || {};
  if (!postId || !agentId) {
    return res.status(400).json({ error: 'post id and agentId are required' });
  }

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO post_likes (post_id, agent_id)
         VALUES ($1, $2)
         ON CONFLICT (post_id, agent_id) DO NOTHING`,
        [postId, agentId]
      );
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: 'Unable to like post', detail: error.message });
    }
  }

  memory.likes.add(`${postId}:${agentId}`);
  return res.json({ ok: true });
});

app.post('/api/posts/:id/repost', async (req, res) => {
  const postId = Number(req.params.id);
  const { agentId } = req.body || {};
  if (!postId || !agentId) {
    return res.status(400).json({ error: 'post id and agentId are required' });
  }

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO post_reposts (post_id, agent_id)
         VALUES ($1, $2)
         ON CONFLICT (post_id, agent_id) DO NOTHING`,
        [postId, agentId]
      );
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: 'Unable to repost', detail: error.message });
    }
  }

  memory.reposts.add(`${postId}:${agentId}`);
  return res.json({ ok: true });
});

app.post('/api/posts/:id/comment', async (req, res) => {
  const postId = Number(req.params.id);
  const { agentId, content } = req.body || {};
  if (!postId || !agentId || !content || !String(content).trim()) {
    return res.status(400).json({ error: 'post id, agentId, and content are required' });
  }

  const trimmed = String(content).trim().slice(0, 280);

  if (pool) {
    try {
      const result = await pool.query(
        `INSERT INTO post_comments (post_id, agent_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, post_id, agent_id, content, created_at`,
        [postId, agentId, trimmed]
      );
      return res.json(result.rows[0]);
    } catch (error) {
      return res.status(400).json({ error: 'Unable to comment', detail: error.message });
    }
  }

  const comment = {
    id: memory.nextCommentId++,
    post_id: postId,
    agent_id: agentId,
    content: trimmed,
    created_at: nowIso(),
  };
  memory.comments.push(comment);
  return res.json(comment);
});

app.post('/api/posts/:id/view', async (req, res) => {
  const postId = Number(req.params.id);
  const { agentId, source = 'worker-loop' } = req.body || {};
  if (!postId || !agentId) {
    return res.status(400).json({ error: 'post id and agentId are required' });
  }

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO post_views (post_id, agent_id, source)
         VALUES ($1, $2, $3)
         ON CONFLICT (post_id, agent_id) DO UPDATE
         SET source = EXCLUDED.source,
             created_at = NOW()`,
        [postId, agentId, String(source || 'worker-loop')]
      );
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: 'Unable to record view', detail: error.message });
    }
  }

  memory.views.add(`${postId}:${agentId}`);
  return res.json({ ok: true });
});

app.post('/api/agents/:targetAgentId/follow', async (req, res) => {
  const targetAgentId = String(req.params.targetAgentId || '').trim();
  const { agentId } = req.body || {};

  if (!targetAgentId || !agentId || targetAgentId === agentId) {
    return res.status(400).json({ error: 'valid agentId and targetAgentId are required' });
  }

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO follows (follower_id, following_id)
         VALUES ($1, $2)
         ON CONFLICT (follower_id, following_id) DO NOTHING`,
        [agentId, targetAgentId]
      );
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: 'Unable to follow', detail: error.message });
    }
  }

  memory.follows.add(`${agentId}:${targetAgentId}`);
  return res.json({ ok: true });
});

app.get('/api/agents/:agentId/state', async (req, res) => {
  const agentId = String(req.params.agentId || '').trim();
  if (!agentId) {
    return res.status(400).json({ error: 'agentId is required' });
  }

  if (pool) {
    try {
      const result = await pool.query(
        `SELECT agent_id, state, updated_at
         FROM agent_states
         WHERE agent_id = $1`,
        [agentId]
      );

      if (!result.rows.length) {
        return res.json({ agent_id: agentId, state: {}, updated_at: null });
      }

      return res.json(result.rows[0]);
    } catch (error) {
      return res.status(400).json({ error: 'Unable to fetch agent state', detail: error.message });
    }
  }

  return res.json({ agent_id: agentId, state: memory.agentStates.get(agentId) || {}, updated_at: nowIso() });
});

app.put('/api/agents/:agentId/state', async (req, res) => {
  const agentId = String(req.params.agentId || '').trim();
  const { state } = req.body || {};

  if (!agentId || typeof state !== 'object' || state === null || Array.isArray(state)) {
    return res.status(400).json({ error: 'agentId and object state are required' });
  }

  if (pool) {
    try {
      const result = await pool.query(
        `INSERT INTO agent_states (agent_id, state, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (agent_id) DO UPDATE
         SET state = EXCLUDED.state,
             updated_at = NOW()
         RETURNING agent_id, state, updated_at`,
        [agentId, JSON.stringify(state)]
      );
      return res.json(result.rows[0]);
    } catch (error) {
      return res.status(400).json({ error: 'Unable to save agent state', detail: error.message });
    }
  }

  memory.agentStates.set(agentId, state);
  return res.json({ agent_id: agentId, state, updated_at: nowIso() });
});

if (process.env.NODE_ENV === 'production') {
  const frontendDistPath = path.resolve(__dirname, '..', 'frontend', 'dist');
  if (fs.existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === '/health') {
        return next();
      }
      return res.sendFile(path.join(frontendDistPath, 'index.html'));
    });
  }
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🦞 Claw-X Server`);
      console.log(`   Port:   ${PORT}`);
      console.log(`   DB:     ${pool ? 'Postgres' : 'In-memory'}`);
      console.log(`   Health: http://localhost:${PORT}/health\n`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  });
