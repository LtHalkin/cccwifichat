const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// userId -> Set of open sockets (a user can have multiple tabs/devices)
const socketsByUser = new Map();

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---------- Auth helpers ----------
const authMiddleware = asyncRoute(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = await db.findSession(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });
  const user = await db.findUserById(session.userId);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  req.user = user;
  req.token = token;
  next();
});

function publicUser(user) {
  return { id: user.id, username: user.username };
}

// ---------- Auth routes ----------
app.post('/api/signup', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const cleanUsername = String(username).trim().slice(0, 24);
  if (cleanUsername.length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  }
  if (String(password).length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  if (await db.findUserByUsername(cleanUsername)) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.createUser(cleanUsername, passwordHash);
  const token = await db.createSession(user.id);
  res.json({ token, user: publicUser(user) });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const user = await db.findUserByUsername(String(username).trim());
  if (!user) return res.status(401).json({ error: 'Incorrect username or password' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });
  const token = await db.createSession(user.id);
  res.json({ token, user: publicUser(user) });
}));

app.post('/api/logout', authMiddleware, asyncRoute(async (req, res) => {
  await db.deleteSession(req.token);
  res.json({ ok: true });
}));

app.get('/api/me', authMiddleware, asyncRoute(async (req, res) => {
  res.json({ user: { ...publicUser(req.user), createdAt: Number(req.user.created_at) } });
}));

app.post('/api/me/password', authMiddleware, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (String(newPassword).length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  const ok = await bcrypt.compare(currentPassword, req.user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
  const newHash = await bcrypt.hash(newPassword, 10);
  await db.updatePasswordHash(req.user.id, newHash);
  res.json({ ok: true });
}));

// ---------- Friends ----------
app.get('/api/friends', authMiddleware, asyncRoute(async (req, res) => {
  const [friendsRaw, incomingRaw, outgoingRaw] = await Promise.all([
    db.getFriendsFor(req.user.id),
    db.getIncomingRequests(req.user.id),
    db.getOutgoingRequests(req.user.id)
  ]);
  res.json({
    friends: friendsRaw.map(publicUser),
    incoming: incomingRaw.map(r => ({ friendshipId: r.friendshipId, user: publicUser(r.user) })),
    outgoing: outgoingRaw.map(r => ({ friendshipId: r.friendshipId, user: publicUser(r.user) }))
  });
}));

app.post('/api/friends/request', authMiddleware, asyncRoute(async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username is required' });
  const target = await db.findUserByUsername(String(username).trim());
  if (!target) return res.status(404).json({ error: 'No user with that username' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't add yourself" });

  const existing = await db.findFriendship(req.user.id, target.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
    return res.status(409).json({ error: 'A request already exists between you two' });
  }
  const fr = await db.createFriendRequest(req.user.id, target.id);
  notifyUser(target.id, { type: 'friend_request', from: publicUser(req.user), friendshipId: fr.id });
  res.json({ ok: true });
}));

app.post('/api/friends/accept', authMiddleware, asyncRoute(async (req, res) => {
  const { friendshipId } = req.body || {};
  const fr = await db.acceptFriendRequest(friendshipId);
  if (!fr) return res.status(404).json({ error: 'Request not found' });
  const otherId = fr.requester_id === req.user.id ? fr.addressee_id : fr.requester_id;
  notifyUser(otherId, { type: 'friend_accepted', by: publicUser(req.user) });
  res.json({ ok: true });
}));

app.post('/api/friends/decline', authMiddleware, asyncRoute(async (req, res) => {
  const { friendshipId } = req.body || {};
  await db.declineFriendRequest(friendshipId);
  res.json({ ok: true });
}));

app.post('/api/friends/remove', authMiddleware, asyncRoute(async (req, res) => {
  const { username } = req.body || {};
  const target = await db.findUserByUsername(String(username || '').trim());
  if (!target) return res.status(404).json({ error: 'No user with that username' });
  await db.removeFriendship(req.user.id, target.id);
  notifyUser(target.id, { type: 'friend_removed', by: publicUser(req.user) });
  res.json({ ok: true });
}));

// ---------- Conversations ----------
async function serializeConversation(convo, forUserId) {
  const memberUsers = await Promise.all(convo.memberIds.map(db.findUserById));
  const members = memberUsers.filter(Boolean).map(publicUser);
  const last = await db.lastMessageFor(convo.id);
  let displayName = convo.name;
  if (convo.type === 'dm') {
    const other = members.find(m => m.id !== forUserId);
    displayName = other ? other.username : 'Unknown';
  }
  return {
    id: convo.id,
    type: convo.type,
    name: displayName,
    members,
    lastMessage: last ? { text: last.text, senderId: last.senderId, createdAt: last.createdAt } : null
  };
}

app.get('/api/conversations', authMiddleware, asyncRoute(async (req, res) => {
  const convos = await db.getConversationsFor(req.user.id);
  const serialized = await Promise.all(convos.map(c => serializeConversation(c, req.user.id)));
  serialized.sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
  res.json({ conversations: serialized });
}));

app.post('/api/conversations/dm', authMiddleware, asyncRoute(async (req, res) => {
  const { username } = req.body || {};
  const target = await db.findUserByUsername(String(username || '').trim());
  if (!target) return res.status(404).json({ error: 'No user with that username' });
  if (!(await db.areFriends(req.user.id, target.id))) {
    return res.status(403).json({ error: 'You can only message friends' });
  }
  let convo = await db.findDmConversation(req.user.id, target.id);
  if (!convo) convo = await db.createDmConversation(req.user.id, target.id);
  res.json({ conversation: await serializeConversation(convo, req.user.id) });
}));

app.post('/api/conversations/group', authMiddleware, asyncRoute(async (req, res) => {
  const { name, usernames } = req.body || {};
  if (!name || !Array.isArray(usernames) || usernames.length === 0) {
    return res.status(400).json({ error: 'Group name and at least one member are required' });
  }
  const memberIds = [req.user.id];
  for (const uname of usernames) {
    const u = await db.findUserByUsername(String(uname).trim());
    if (!u) return res.status(404).json({ error: `No user named "${uname}"` });
    if (!(await db.areFriends(req.user.id, u.id))) {
      return res.status(403).json({ error: `You can only add friends (${uname} isn't one yet)` });
    }
    memberIds.push(u.id);
  }
  const convo = await db.createGroupConversation(String(name).trim().slice(0, 40), memberIds);
  const serialized = await serializeConversation(convo, req.user.id);
  memberIds.forEach(uid => notifyUser(uid, { type: 'conversation_created', conversation: serialized }));
  res.json({ conversation: serialized });
}));

app.get('/api/conversations/:id/messages', authMiddleware, asyncRoute(async (req, res) => {
  const convoId = req.params.id;
  if (!(await db.isMember(convoId, req.user.id))) {
    return res.status(403).json({ error: 'Not a member of this conversation' });
  }
  const messages = await db.getMessagesFor(convoId);
  res.json({ messages: messages.map(m => ({ id: m.id, senderId: m.senderId, text: m.text, createdAt: m.createdAt })) });
}));

app.post('/api/conversations/:id/leave', authMiddleware, asyncRoute(async (req, res) => {
  const convoId = req.params.id;
  const convo = await db.findConversationById(convoId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  if (convo.type !== 'group') return res.status(400).json({ error: 'You can only leave group chats' });
  if (!convo.memberIds.includes(req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this conversation' });
  }
  await db.removeMember(convoId, req.user.id);
  convo.memberIds
    .filter(uid => uid !== req.user.id)
    .forEach(uid => notifyUser(uid, { type: 'member_left', conversationId: convoId, user: publicUser(req.user) }));
  res.json({ ok: true });
}));

// ---------- WebSocket (auth via first message) ----------
function notifyUser(userId, payload) {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.userId = null;

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'auth') {
      const session = await db.findSession(data.token).catch(() => null);
      if (!session) {
        ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid session' }));
        ws.close();
        return;
      }
      ws.userId = session.userId;
      if (!socketsByUser.has(ws.userId)) socketsByUser.set(ws.userId, new Set());
      socketsByUser.get(ws.userId).add(ws);
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      return;
    }

    if (!ws.userId) return; // must auth first

    if (data.type === 'message') {
      const { conversationId, text } = data;
      if (!conversationId || !text || !String(text).trim()) return;
      if (!(await db.isMember(conversationId, ws.userId))) return;
      const msg = await db.addMessage(conversationId, ws.userId, String(text).slice(0, 4000));
      const payload = {
        type: 'message',
        conversationId,
        message: { id: msg.id, senderId: msg.senderId, text: msg.text, createdAt: msg.createdAt }
      };
      const convo = await db.findConversationById(conversationId);
      convo.memberIds.forEach(uid => notifyUser(uid, payload));
    }
  });

  ws.on('close', () => {
    if (ws.userId && socketsByUser.has(ws.userId)) {
      socketsByUser.get(ws.userId).delete(ws);
      if (socketsByUser.get(ws.userId).size === 0) socketsByUser.delete(ws.userId);
    }
  });
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`\nChat server running.\n`);
    console.log(`On this device:  http://localhost:${PORT}`);
    const ips = getLocalIPs();
    if (ips.length) {
      console.log(`On other devices on the same WiFi:`);
      ips.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
    }
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err.message);
  process.exit(1);
});
