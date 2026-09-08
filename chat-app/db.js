const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable is not set. See README for setup.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

function id() {
  return crypto.randomUUID();
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friendships (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT,
      dm_key TEXT UNIQUE,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
  `);
}

// ---- Users ----
async function findUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0] || null;
}

async function findUserById(userId) {
  if (!userId) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

async function createUser(username, passwordHash) {
  const user = { id: id(), username, passwordHash, createdAt: Date.now() };
  await pool.query(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES ($1,$2,$3,$4)',
    [user.id, user.username, user.passwordHash, user.createdAt]
  );
  return user;
}

async function updatePasswordHash(userId, newHash) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
}

// ---- Sessions ----
async function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1,$2,$3)', [token, userId, Date.now()]);
  return token;
}

async function findSession(token) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
  if (!rows[0]) return null;
  return { token: rows[0].token, userId: rows[0].user_id, createdAt: Number(rows[0].created_at) };
}

async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// ---- Friendships ----
async function findFriendship(userIdA, userIdB) {
  const { rows } = await pool.query(
    `SELECT * FROM friendships WHERE
      (requester_id = $1 AND addressee_id = $2) OR
      (requester_id = $2 AND addressee_id = $1)`,
    [userIdA, userIdB]
  );
  return rows[0] || null;
}

async function createFriendRequest(requesterId, addresseeId) {
  const fr = { id: id(), requesterId, addresseeId, status: 'pending', createdAt: Date.now() };
  await pool.query(
    'INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES ($1,$2,$3,$4,$5)',
    [fr.id, fr.requesterId, fr.addresseeId, fr.status, fr.createdAt]
  );
  return fr;
}

async function acceptFriendRequest(friendshipId) {
  const { rows } = await pool.query(
    "UPDATE friendships SET status = 'accepted' WHERE id = $1 RETURNING *",
    [friendshipId]
  );
  return rows[0] || null;
}

async function declineFriendRequest(friendshipId) {
  await pool.query('DELETE FROM friendships WHERE id = $1', [friendshipId]);
}

async function removeFriendship(userIdA, userIdB) {
  await pool.query(
    `DELETE FROM friendships WHERE
      (requester_id = $1 AND addressee_id = $2) OR
      (requester_id = $2 AND addressee_id = $1)`,
    [userIdA, userIdB]
  );
}

async function getFriendsFor(userId) {
  const { rows } = await pool.query(
    `SELECT u.* FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
     WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)`,
    [userId]
  );
  return rows;
}

async function getIncomingRequests(userId) {
  const { rows } = await pool.query(
    `SELECT f.id as friendship_id, u.* FROM friendships f
     JOIN users u ON u.id = f.requester_id
     WHERE f.status = 'pending' AND f.addressee_id = $1`,
    [userId]
  );
  return rows.map(r => ({ friendshipId: r.friendship_id, user: r }));
}

async function getOutgoingRequests(userId) {
  const { rows } = await pool.query(
    `SELECT f.id as friendship_id, u.* FROM friendships f
     JOIN users u ON u.id = f.addressee_id
     WHERE f.status = 'pending' AND f.requester_id = $1`,
    [userId]
  );
  return rows.map(r => ({ friendshipId: r.friendship_id, user: r }));
}

async function areFriends(userIdA, userIdB) {
  const f = await findFriendship(userIdA, userIdB);
  return !!(f && f.status === 'accepted');
}

// ---- Conversations ----
function dmKeyFor(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join(':');
}

async function findDmConversation(userIdA, userIdB) {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE dm_key = $1', [dmKeyFor(userIdA, userIdB)]);
  if (!rows[0]) return null;
  return hydrateConversation(rows[0]);
}

async function createDmConversation(userIdA, userIdB) {
  const convo = { id: id(), type: 'dm', name: null, dmKey: dmKeyFor(userIdA, userIdB), createdAt: Date.now() };
  await pool.query(
    'INSERT INTO conversations (id, type, name, dm_key, created_at) VALUES ($1,$2,$3,$4,$5)',
    [convo.id, convo.type, convo.name, convo.dmKey, convo.createdAt]
  );
  await addMembers(convo.id, [userIdA, userIdB]);
  return hydrateConversation({ id: convo.id, type: convo.type, name: convo.name, dm_key: convo.dmKey, created_at: convo.createdAt });
}

async function createGroupConversation(name, memberIds) {
  const convo = { id: id(), type: 'group', name, createdAt: Date.now() };
  await pool.query(
    'INSERT INTO conversations (id, type, name, dm_key, created_at) VALUES ($1,$2,$3,NULL,$4)',
    [convo.id, convo.type, convo.name, convo.createdAt]
  );
  await addMembers(convo.id, [...new Set(memberIds)]);
  return hydrateConversation({ id: convo.id, type: convo.type, name: convo.name, dm_key: null, created_at: convo.createdAt });
}

async function addMembers(conversationId, userIds) {
  for (const uid of userIds) {
    await pool.query(
      'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [conversationId, uid]
    );
  }
}

async function hydrateConversation(row) {
  const { rows } = await pool.query('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [row.id]);
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    dmKey: row.dm_key ?? null,
    memberIds: rows.map(r => r.user_id),
    createdAt: Number(row.created_at)
  };
}

async function findConversationById(convoId) {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1', [convoId]);
  if (!rows[0]) return null;
  return hydrateConversation(rows[0]);
}

async function getConversationsFor(userId) {
  const { rows } = await pool.query(
    `SELECT c.* FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE cm.user_id = $1`,
    [userId]
  );
  return Promise.all(rows.map(hydrateConversation));
}

async function isMember(convoId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [convoId, userId]
  );
  return rows.length > 0;
}

async function removeMember(convoId, userId) {
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convoId, userId]);
}

// ---- Messages ----
async function addMessage(conversationId, senderId, text) {
  const msg = { id: id(), conversationId, senderId, text, createdAt: Date.now() };
  await pool.query(
    'INSERT INTO messages (id, conversation_id, sender_id, text, created_at) VALUES ($1,$2,$3,$4,$5)',
    [msg.id, msg.conversationId, msg.senderId, msg.text, msg.createdAt]
  );
  return msg;
}

async function getMessagesFor(conversationId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2
     ) sub ORDER BY created_at ASC`,
    [conversationId, limit]
  );
  return rows.map(r => ({ id: r.id, conversationId: r.conversation_id, senderId: r.sender_id, text: r.text, createdAt: Number(r.created_at) }));
}

async function lastMessageFor(conversationId) {
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
    [conversationId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return { id: r.id, conversationId: r.conversation_id, senderId: r.sender_id, text: r.text, createdAt: Number(r.created_at) };
}

module.exports = {
  init,
  findUserByUsername, findUserById, createUser, updatePasswordHash,
  createSession, findSession, deleteSession,
  findFriendship, createFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriendship,
  getFriendsFor, getIncomingRequests, getOutgoingRequests, areFriends,
  findDmConversation, createDmConversation, createGroupConversation,
  findConversationById, getConversationsFor, isMember, removeMember,
  addMessage, getMessagesFor, lastMessageFor
};
