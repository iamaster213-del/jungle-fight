// Jungle Fight · servidor de partidas en línea (internet o red local)
//
// En tu ordenador:   node server.js          (puerto 8080)
//                    node server.js 3000     (otro puerto)
// En Render u otro hosting usa la variable de entorno PORT automáticamente.
// Solo usa módulos que trae Node.js: no hay que instalar nada más.
//
// Sirve el juego y reenvía los mensajes entre los dos jugadores de cada sala por WebSocket.
// Quien crea la sala es el anfitrión (Jugador 1); quien se une con el código, el Jugador 2.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8080;
const GAME = path.join(__dirname, 'duelo-en-la-selva.html');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I ni O para no confundirlas con 1 y 0

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map(i => `http://${i.address}:${PORT}`);
}

// ---------- página del juego ----------
let pageCache = null;
function page(cb) {
  if (pageCache && !process.env.DEV) return cb(null, pageCache);
  fs.readFile(GAME, 'utf8', (err, html) => {
    if (err) return cb(err);
    pageCache =
      '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
      '<style>body{margin:0}[hidden]{display:none!important}</style></head><body>' +
      html + '</body></html>';
    cb(null, pageCache);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/salud') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url !== '/' && url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  page((err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No se encontró duelo-en-la-selva.html junto a server.js');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
});

// ---------- WebSocket mínimo (texto) ----------
function frame(payload, op = 0x1) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function sendJSON(sock, obj) {
  if (!sock.destroyed) sock.write(frame(Buffer.from(JSON.stringify(obj))));
}

// ---------- salas ----------
const rooms = new Map(); // código -> [{ sock, role }]
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join(''); } while (rooms.has(c));
  return c;
}
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws' || !req.headers['sec-websocket-key']) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  sock.setNoDelay(true);

  // crear sala o unirse a una existente
  const wantsJoin = u.searchParams.get('modo') === 'unirse';
  let code = cleanCode(u.searchParams.get('sala'));
  if (wantsJoin) {
    if (!rooms.has(code)) { sendJSON(sock, { t: 'nosala', sala: code }); sock.end(); return; }
    if (rooms.get(code).length >= 2) { sendJSON(sock, { t: 'full' }); sock.end(); return; }
  } else {
    code = newCode();
    rooms.set(code, []);
  }
  const room = rooms.get(code);
  const me = { sock, role: room.some(c => c.role === 'host') ? 'guest' : 'host' };
  room.push(me);
  console.log(`[${code}] entra ${me.role === 'host' ? 'el Jugador 1' : 'el Jugador 2'} (${rooms.size} salas activas)`);
  sendJSON(sock, { t: 'role', role: me.role, sala: code, addrs: lanAddresses() });
  if (room.length === 2) room.forEach(c => sendJSON(c.sock, { t: 'start' }));

  // mantiene viva la conexión mientras se espera al rival (algunos hostings cortan las conexiones calladas)
  const ping = setInterval(() => { if (!sock.destroyed) sock.write(frame(Buffer.alloc(0), 0x9)); }, 25000);

  let buf = Buffer.alloc(0);
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { sock.destroy(); return; } // mensajes de más de 1 MB: fuera
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const m = buf.subarray(maskAt, maskAt + 4), out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i % 4];
        payload = out;
      }
      buf = buf.subarray(off + len);
      if (op === 0x8) { sock.end(); return; }                       // cerrar
      if (op === 0x9) { sock.write(frame(payload, 0xA)); continue; } // ping -> pong
      if (op === 0x1) {                                              // texto: reenviar al otro jugador de la sala
        const other = room.find(c => c !== me);
        if (other && !other.sock.destroyed) other.sock.write(frame(payload));
      }
    }
  });

  const bye = () => {
    clearInterval(ping);
    const i = room.indexOf(me);
    if (i < 0) return;
    room.splice(i, 1);
    console.log(`[${code}] sale un jugador`);
    if (!room.length) { rooms.delete(code); return; }
    room.forEach(c => {
      c.role = 'host';
      sendJSON(c.sock, { t: 'left' });
      sendJSON(c.sock, { t: 'role', role: 'host', sala: code, addrs: lanAddresses() });
    });
  };
  sock.on('close', bye);
  sock.on('error', bye);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  El puerto ${PORT} ya está en uso: seguramente el servidor ya está abierto en otra ventana.`);
    console.error(`  Ciérrala o usa otro puerto, por ejemplo:  node server.js ${PORT + 1}\n`);
  } else console.error(err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  JUNGLE FIGHT · servidor de partidas en línea');
  console.log('  -------------------------------------------');
  console.log(`  Escuchando en el puerto ${PORT}.`);
  const a = lanAddresses();
  if (a.length) {
    console.log('  Para jugar en tu red local, abrid en los navegadores:');
    a.forEach(x => console.log('    ' + x));
  }
  console.log(`  En este mismo ordenador: http://localhost:${PORT}`);
  console.log('  En el menú del juego elegid "EN LÍNEA": uno crea la sala y el otro se une con el código.');
  console.log('  Para cerrar el servidor: Ctrl + C');
  console.log('');
});
