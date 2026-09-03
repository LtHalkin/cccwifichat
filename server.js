const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, filePath);

  // Prevent path traversal outside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// name -> ws, used for presence + simple identity
const clients = new Map();

function broadcast(payload, exceptWs) {
  const msg = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws !== exceptWs) {
      ws.send(msg);
    }
  }
}

function presenceList() {
  return Array.from(clients.keys());
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === 'join') {
      const name = String(data.name || 'Anonymous').slice(0, 24);
      ws._name = name;
      clients.set(name, ws);
      broadcast({ type: 'system', text: `${name} joined` }, ws);
      broadcast({ type: 'presence', users: presenceList() });
      ws.send(JSON.stringify({ type: 'presence', users: presenceList() }));
      return;
    }

    if (data.type === 'message') {
      const text = String(data.text || '').slice(0, 2000);
      if (!text.trim()) return;
      broadcast({
        type: 'message',
        name: ws._name || 'Anonymous',
        text,
        ts: Date.now()
      });
      return;
    }
  });

  ws.on('close', () => {
    if (ws._name) {
      clients.delete(ws._name);
      broadcast({ type: 'system', text: `${ws._name} left` });
      broadcast({ type: 'presence', users: presenceList() });
    }
  });
});

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

server.listen(PORT, () => {
  console.log(`\nLAN Chat running.\n`);
  console.log(`On this device:  http://localhost:${PORT}`);
  const ips = getLocalIPs();
  if (ips.length) {
    console.log(`On other devices on the same WiFi:`);
    ips.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
  } else {
    console.log(`Could not detect a local network IP — check you're connected to WiFi.`);
  }
  console.log('');
});
