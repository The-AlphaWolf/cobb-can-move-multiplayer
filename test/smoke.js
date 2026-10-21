// Smoke test: boots the real server, connects two clients, and checks the multiplayer basics.
// Run with: npm test
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function next(socket, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

async function never(socket, event, ms = 400) {
  let fired = false;
  const mark = () => { fired = true; };
  socket.on(event, mark);
  await wait(ms);
  socket.off(event, mark);
  assert(!fired, `${event} should not have fired`);
}

const ask = (socket, event, payload) => new Promise(r => socket.emit(event, payload, r));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], {
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  // Fail fast instead of hanging if the server can't start (e.g. port already in use)
  setTimeout(() => { console.error('FAIL timed out'); server.kill(); process.exit(1); }, 20000).unref();
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('URL') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
  });

  const a = io(URL, { forceNew: true });
  const b = io(URL, { forceNew: true });
  try {
    await Promise.all([next(a, 'connect'), next(b, 'connect')]);

    // Junk payloads must be ignored, not crash the process
    a.emit('room:join', null);
    a.emit('room:join', { roomCode: 123 });
    a.emit('chat:send', 5);
    a.emit('player:move', 'x');
    a.emit('game:start', null);
    a.emit('coal:pickup');
    await wait(200);
    assert.strictEqual((await (await fetch(`${URL}/health`)).json()).status, 'ok');

    // Unbuilt modes fall back to coop, and lobby payloads carry no map
    const created = await ask(a, 'room:create', { mode: 'versus', playerData: { name: 'Host' } });
    assert(created.success);
    assert.strictEqual(created.room.mode, 'coop');
    assert.strictEqual(created.room.mapData, undefined);
    const joined = await ask(b, 'room:join', { roomCode: created.roomCode.toLowerCase(), playerData: { name: 'Joiner' } });
    assert(joined.success, joined.message);

    // Host can't start until everyone else is ready
    const early = await ask(a, 'game:start', {});
    assert(!early.success && /Joiner/.test(early.message));

    b.emit('room:ready', { ready: true });
    await next(a, 'room:updated');
    const startedA = next(a, 'game:started');
    const startedB = next(b, 'game:started');
    a.emit('game:start', {});
    const { room } = await startedB;
    await startedA;

    const pa = room.players.find(p => p.id === a.id);
    const pb = room.players.find(p => p.id === b.id);
    assert(pa.x !== pb.x || pa.y !== pb.y, 'players should spawn apart');
    assert.notStrictEqual(pa.color, pb.color);
    assert(room.mapData, 'game:started carries the map');

    // A late-booting client can fetch the full round state
    const synced = await ask(b, 'game:sync', {});
    assert.strictEqual(synced.room.state, 'PLAYING');
    assert.strictEqual(synced.room.mapData.coal.length, room.mapData.coal.length);

    // Restarting mid-game is ignored
    a.emit('game:start', {});
    await never(b, 'game:started');

    // A normal step is relayed to the other player
    const moved = next(b, 'player:moved');
    a.emit('player:move', { x: pa.x + 5, y: pa.y, flipX: true });
    const m = await moved;
    assert.strictEqual(m.id, a.id);
    assert.strictEqual(m.x, pa.x + 5);

    // Of two back-to-back moves, the second (faster than the send rate) is dropped
    await wait(60);
    let relayed = 0;
    const countMove = () => relayed++;
    b.on('player:moved', countMove);
    a.emit('player:move', { x: pa.x + 6, y: pa.y });
    a.emit('player:move', { x: pa.x + 7, y: pa.y });
    await wait(200);
    b.off('player:moved', countMove);
    assert.strictEqual(relayed, 1);

    // A teleport is rejected and corrected
    const correct = next(a, 'player:correct');
    a.emit('player:move', { x: pa.x + 900, y: pa.y });
    assert.strictEqual((await correct).x, pa.x + 6);

    // Escaping through a locked exit, or grabbing far-away coal, does nothing
    b.emit('player:escape');
    await never(a, 'player:escaped');
    b.emit('coal:pickup', { coalId: 'coal_0' });
    await never(a, 'coal:updated');

    // Chat is capped in length
    const chat = next(b, 'chat:received');
    a.emit('chat:send', { message: 'x'.repeat(300) });
    assert.strictEqual((await chat).message.length, 100);

    assert.strictEqual((await (await fetch(`${URL}/health`)).json()).status, 'ok');
    console.log('PASS smoke test');
  } finally {
    a.close();
    b.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
