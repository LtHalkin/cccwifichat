(() => {
  const API = '';
  let token = localStorage.getItem('chat_token') || null;
  let me = null;
  let ws = null;
  let conversations = [];
  let friends = [];
  let activeConvoId = null;
  let wsReconnectTimer = null;

  // ---------- DOM refs ----------
  const authScreen = document.getElementById('authScreen');
  const mainScreen = document.getElementById('mainScreen');
  const authForm = document.getElementById('authForm');
  const authUsername = document.getElementById('authUsername');
  const authPassword = document.getElementById('authPassword');
  const authSubmit = document.getElementById('authSubmit');
  const authError = document.getElementById('authError');
  const authTabs = document.querySelectorAll('.auth-tab');

  const meLabel = document.getElementById('meLabel');
  const logoutBtn = document.getElementById('logoutBtn');

  const sidebarTabs = document.querySelectorAll('.sidebar-tab');
  const paneChats = document.getElementById('paneChats');
  const paneFriends = document.getElementById('paneFriends');
  const friendBadge = document.getElementById('friendBadge');

  const convoList = document.getElementById('convoList');
  const friendList = document.getElementById('friendList');
  const incomingRequests = document.getElementById('incomingRequests');

  const newGroupBtn = document.getElementById('newGroupBtn');
  const addFriendBtn = document.getElementById('addFriendBtn');

  const chatEmpty = document.getElementById('chatEmpty');
  const chatHeader = document.getElementById('chatHeader');
  const chatAvatar = document.getElementById('chatAvatar');
  const chatName = document.getElementById('chatName');
  const chatSub = document.getElementById('chatSub');
  const messagesEl = document.getElementById('messages');
  const composer = document.getElementById('composer');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const backBtn = document.getElementById('backBtn');
  const sidebar = document.getElementById('sidebar');
  const chatArea = document.getElementById('chatArea');

  const addFriendModal = document.getElementById('addFriendModal');
  const addFriendUsername = document.getElementById('addFriendUsername');
  const addFriendError = document.getElementById('addFriendError');
  const addFriendSubmit = document.getElementById('addFriendSubmit');

  const newGroupModal = document.getElementById('newGroupModal');
  const newGroupName = document.getElementById('newGroupName');
  const newGroupFriendList = document.getElementById('newGroupFriendList');
  const newGroupError = document.getElementById('newGroupError');
  const newGroupSubmit = document.getElementById('newGroupSubmit');

  const profileModal = document.getElementById('profileModal');
  const profileAvatar = document.getElementById('profileAvatar');
  const profileUsername = document.getElementById('profileUsername');
  const profileJoined = document.getElementById('profileJoined');
  const profileCurrentPassword = document.getElementById('profileCurrentPassword');
  const profileNewPassword = document.getElementById('profileNewPassword');
  const profileError = document.getElementById('profileError');
  const profilePasswordSubmit = document.getElementById('profilePasswordSubmit');

  const leaveGroupBtn = document.getElementById('leaveGroupBtn');

  // ---------- API helper ----------
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  }

  // ---------- Auth ----------
  let authMode = 'login';
  authTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      authTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      authMode = tab.dataset.tab;
      authSubmit.textContent = authMode === 'login' ? 'Log in' : 'Sign up';
      authPassword.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
      authError.textContent = '';
    });
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    const username = authUsername.value.trim();
    const password = authPassword.value;
    if (!username || !password) return;
    authSubmit.disabled = true;
    try {
      const data = await api(authMode === 'login' ? '/api/login' : '/api/signup', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      token = data.token;
      me = data.user;
      localStorage.setItem('chat_token', token);
      enterApp();
    } catch (err) {
      authError.textContent = err.message;
    } finally {
      authSubmit.disabled = false;
    }
  });

  logoutBtn.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('chat_token');
    token = null; me = null;
    if (ws) ws.close();
    location.reload();
  });

  // ---------- Boot ----------
  async function boot() {
    if (!token) return; // stay on auth screen
    try {
      const data = await api('/api/me');
      me = data.user;
      enterApp();
    } catch {
      localStorage.removeItem('chat_token');
      token = null;
    }
  }

  async function enterApp() {
    authScreen.style.display = 'none';
    mainScreen.classList.add('visible');
    meLabel.textContent = me.username;
    connectWs();
    await Promise.all([loadFriends(), loadConversations()]);
  }

  // ---------- Profile ----------
  meLabel.addEventListener('click', () => {
    profileAvatar.textContent = initials(me.username);
    profileUsername.textContent = me.username;
    profileJoined.textContent = me.createdAt
      ? 'Joined ' + new Date(me.createdAt).toLocaleDateString()
      : '';
    profileCurrentPassword.value = '';
    profileNewPassword.value = '';
    profileError.textContent = '';
    openModal(profileModal);
  });

  profilePasswordSubmit.addEventListener('click', async () => {
    const currentPassword = profileCurrentPassword.value;
    const newPassword = profileNewPassword.value;
    if (!currentPassword || !newPassword) {
      profileError.textContent = 'Fill in both fields.';
      return;
    }
    profileError.textContent = '';
    try {
      await api('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      profileCurrentPassword.value = '';
      profileNewPassword.value = '';
      profileError.style.color = 'var(--ok)';
      profileError.textContent = 'Password updated.';
    } catch (err) {
      profileError.style.color = 'var(--err)';
      profileError.textContent = err.message;
    }
  });

  // ---------- Sidebar tabs ----------
  sidebarTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      sidebarTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const pane = tab.dataset.pane;
      paneChats.classList.toggle('active', pane === 'chats');
      paneFriends.classList.toggle('active', pane === 'friends');
    });
  });

  // ---------- Friends ----------
  async function loadFriends() {
    const data = await api('/api/friends');
    friends = data.friends;
    renderFriendList(data.friends);
    renderIncoming(data.incoming);
    friendBadge.style.display = data.incoming.length ? 'inline-block' : 'none';
    friendBadge.textContent = data.incoming.length;
  }

  function initials(name) {
    return name.slice(0, 2).toUpperCase();
  }

  function renderFriendList(list) {
    friendList.innerHTML = '';
    if (!list.length) {
      friendList.innerHTML = '<div class="empty-list">No friends yet. Add one to start chatting.</div>';
      return;
    }
    list.forEach(f => {
      const row = document.createElement('div');
      row.className = 'friend-item';
      row.innerHTML = `
        <div class="avatar">${initials(f.username)}</div>
        <div class="friend-meta"><div class="friend-name">${escapeHtml(f.username)}</div></div>
        <button class="friend-remove-btn" title="Remove friend">Remove</button>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.friend-remove-btn')) return;
        startDm(f.username);
      });
      row.querySelector('.friend-remove-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove ${f.username} as a friend?`)) return;
        try {
          await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ username: f.username }) });
          loadFriends();
        } catch (err) {
          alert(err.message);
        }
      });
      friendList.appendChild(row);
    });
  }

  function renderIncoming(list) {
    incomingRequests.innerHTML = '';
    list.forEach(r => {
      const row = document.createElement('div');
      row.className = 'friend-request-row';
      row.innerHTML = `
        <div class="avatar">${initials(r.user.username)}</div>
        <div class="friend-name">${escapeHtml(r.user.username)}</div>
        <button class="mini-btn accept">Accept</button>
        <button class="mini-btn decline">Decline</button>
      `;
      row.querySelector('.accept').addEventListener('click', async () => {
        await api('/api/friends/accept', { method: 'POST', body: JSON.stringify({ friendshipId: r.friendshipId }) });
        loadFriends();
      });
      row.querySelector('.decline').addEventListener('click', async () => {
        await api('/api/friends/decline', { method: 'POST', body: JSON.stringify({ friendshipId: r.friendshipId }) });
        loadFriends();
      });
      incomingRequests.appendChild(row);
    });
  }

  addFriendBtn.addEventListener('click', () => {
    addFriendUsername.value = '';
    addFriendError.textContent = '';
    openModal(addFriendModal);
    addFriendUsername.focus();
  });

  addFriendSubmit.addEventListener('click', async () => {
    const username = addFriendUsername.value.trim();
    if (!username) return;
    addFriendError.textContent = '';
    try {
      await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ username }) });
      closeModal(addFriendModal);
      loadFriends();
    } catch (err) {
      addFriendError.textContent = err.message;
    }
  });

  // ---------- Conversations ----------
  async function loadConversations() {
    const data = await api('/api/conversations');
    conversations = data.conversations;
    renderConvoList();
  }

  function renderConvoList() {
    convoList.innerHTML = '';
    if (!conversations.length) {
      convoList.innerHTML = '<div class="empty-list">No chats yet. Message a friend or start a group.</div>';
      return;
    }
    conversations.forEach(c => {
      const row = document.createElement('div');
      row.className = 'convo-item' + (c.id === activeConvoId ? ' active' : '');
      const preview = c.lastMessage ? c.lastMessage.text : (c.type === 'group' ? 'Group created' : 'Say hi!');
      row.innerHTML = `
        <div class="avatar ${c.type === 'group' ? 'group' : ''}">${c.type === 'group' ? 'G' : initials(c.name)}</div>
        <div class="convo-meta">
          <div class="convo-name">${escapeHtml(c.name)}</div>
          <div class="convo-preview">${escapeHtml(preview)}</div>
        </div>
      `;
      row.addEventListener('click', () => openConversation(c.id));
      convoList.appendChild(row);
    });
  }

  async function startDm(username) {
    try {
      const data = await api('/api/conversations/dm', { method: 'POST', body: JSON.stringify({ username }) });
      await loadConversations();
      openConversation(data.conversation.id);
      sidebarTabs.forEach(t => t.classList.toggle('active', t.dataset.pane === 'chats'));
      paneChats.classList.add('active');
      paneFriends.classList.remove('active');
    } catch (err) {
      alert(err.message);
    }
  }

  newGroupBtn.addEventListener('click', () => {
    newGroupName.value = '';
    newGroupError.textContent = '';
    newGroupFriendList.innerHTML = '';
    if (!friends.length) {
      newGroupFriendList.innerHTML = '<div class="empty-list">Add some friends first.</div>';
    } else {
      friends.forEach(f => {
        const label = document.createElement('label');
        label.innerHTML = `<input type="checkbox" value="${escapeHtml(f.username)}"> ${escapeHtml(f.username)}`;
        newGroupFriendList.appendChild(label);
      });
    }
    openModal(newGroupModal);
    newGroupName.focus();
  });

  newGroupSubmit.addEventListener('click', async () => {
    const name = newGroupName.value.trim();
    const usernames = Array.from(newGroupFriendList.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
    if (!name) { newGroupError.textContent = 'Enter a group name.'; return; }
    if (!usernames.length) { newGroupError.textContent = 'Pick at least one friend.'; return; }
    newGroupError.textContent = '';
    try {
      const data = await api('/api/conversations/group', { method: 'POST', body: JSON.stringify({ name, usernames }) });
      closeModal(newGroupModal);
      await loadConversations();
      openConversation(data.conversation.id);
    } catch (err) {
      newGroupError.textContent = err.message;
    }
  });

  async function openConversation(convoId) {
    activeConvoId = convoId;
    renderConvoList();
    const convo = conversations.find(c => c.id === convoId);
    if (!convo) return;

    chatEmpty.style.display = 'none';
    chatHeader.classList.add('visible');
    messagesEl.classList.add('visible');
    composer.classList.add('visible');
    chatAvatar.textContent = convo.type === 'group' ? 'G' : initials(convo.name);
    chatAvatar.classList.toggle('group', convo.type === 'group');
    chatName.textContent = convo.name;
    chatSub.textContent = convo.type === 'group'
      ? convo.members.map(m => m.username).join(', ')
      : '';
    leaveGroupBtn.style.display = convo.type === 'group' ? 'inline-block' : 'none';

    // mobile: show chat, hide sidebar
    sidebar.classList.add('hide-mobile');
    chatArea.classList.remove('hide-mobile');

    messagesEl.innerHTML = '<div class="empty-list">Loading…</div>';
    try {
      const data = await api(`/api/conversations/${convoId}/messages`);
      renderMessages(data.messages);
    } catch (err) {
      messagesEl.innerHTML = `<div class="empty-list">${escapeHtml(err.message)}</div>`;
    }
    msgInput.focus();
  }

  leaveGroupBtn.addEventListener('click', async () => {
    const convo = conversations.find(c => c.id === activeConvoId);
    if (!convo) return;
    if (!confirm(`Leave "${convo.name}"? You'll need to be re-added to rejoin.`)) return;
    try {
      await api(`/api/conversations/${activeConvoId}/leave`, { method: 'POST' });
      conversations = conversations.filter(c => c.id !== activeConvoId);
      activeConvoId = null;
      chatHeader.classList.remove('visible');
      messagesEl.classList.remove('visible');
      composer.classList.remove('visible');
      chatEmpty.style.display = 'flex';
      renderConvoList();
    } catch (err) {
      alert(err.message);
    }
  });

  backBtn.addEventListener('click', () => {
    sidebar.classList.remove('hide-mobile');
    chatArea.classList.add('hide-mobile');
  });

  function renderMessages(list) {
    messagesEl.innerHTML = '';
    if (!list.length) {
      messagesEl.innerHTML = '<div class="empty-list">No messages yet. Say hi!</div>';
      return;
    }
    list.forEach(m => appendMessage(m));
    scrollToBottom();
  }

  function appendMessage(m) {
    if (messagesEl.querySelector('.empty-list')) messagesEl.innerHTML = '';
    const isMine = m.senderId === me.id;
    const row = document.createElement('div');
    row.className = 'bubble-row ' + (isMine ? 'sent' : 'recv');
    let senderLabelHtml = '';
    const convo = conversations.find(c => c.id === activeConvoId);
    if (!isMine && convo && convo.type === 'group') {
      const sender = convo.members.find(mm => mm.id === m.senderId);
      senderLabelHtml = `<div class="sender-label">${escapeHtml(sender ? sender.username : 'Unknown')}</div>`;
    }
    const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `
      ${senderLabelHtml}
      <div class="bubble">${escapeHtml(m.text)}<span class="timestamp">${time}</span></div>
    `;
    messagesEl.appendChild(row);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- Composer ----------
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value;
    if (!text.trim() || !activeConvoId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'message', conversationId: activeConvoId, text }));
    msgInput.value = '';
    msgInput.style.height = 'auto';
  });

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 100) + 'px';
  });

  // ---------- WebSocket ----------
  function connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    });

    ws.addEventListener('close', () => {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWs, 2000);
    });
  }

  function handleWsEvent(data) {
    if (data.type === 'message') {
      // Update conversation preview + reorder
      const convo = conversations.find(c => c.id === data.conversationId);
      if (convo) {
        convo.lastMessage = { text: data.message.text, senderId: data.message.senderId, createdAt: data.message.createdAt };
        conversations.sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
        renderConvoList();
      }
      if (data.conversationId === activeConvoId) {
        appendMessage(data.message);
        scrollToBottom();
      }
      return;
    }
    if (data.type === 'friend_request' || data.type === 'friend_accepted' || data.type === 'friend_removed') {
      loadFriends();
      return;
    }
    if (data.type === 'conversation_created') {
      loadConversations();
      return;
    }
    if (data.type === 'member_left') {
      // Refresh the member list / preview for that conversation
      loadConversations().then(() => {
        if (data.conversationId === activeConvoId) {
          const convo = conversations.find(c => c.id === activeConvoId);
          if (convo) {
            chatSub.textContent = convo.members.map(m => m.username).join(', ');
          }
        }
      });
      return;
    }
  }

  // ---------- Modals ----------
  function openModal(el) { el.classList.add('visible'); }
  function closeModal(el) { el.classList.remove('visible'); }
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(document.getElementById(btn.dataset.close)));
  });
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  boot();
})();
