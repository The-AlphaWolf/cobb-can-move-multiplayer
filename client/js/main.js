// Main client entry and UI controller for COBB CAN MOVE
document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Socket.IO connection
  const socket = io();
  window.gameSocket = socket;

  // Browsers only start audio after the player interacts with the page
  document.addEventListener('pointerdown', () => window.Sound.unlock());
  document.addEventListener('keydown', () => window.Sound.unlock());

  // 2. DOM Elements
  const uiOverlay = document.getElementById('ui-overlay');
  const viewInitial = document.getElementById('view-initial');
  const viewLobby = document.getElementById('view-lobby');
  const viewResults = document.getElementById('view-results');
  const gameHud = document.getElementById('game-hud');
  const menuStatus = document.getElementById('menu-status');

  const inputPlayerName = document.getElementById('player-name');
  const btnSolo = document.getElementById('btn-solo');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const inputRoomCode = document.getElementById('input-room-code');

  const displayRoomCode = document.getElementById('display-room-code');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const lobbyPlayerList = document.getElementById('lobby-player-list');
  const playerCountElem = document.getElementById('player-count');
  const maxPlayersElem = document.getElementById('max-players');
  const selectGameMode = document.getElementById('select-game-mode');
  const btnLobbyLeave = document.getElementById('btn-lobby-leave');
  const btnLobbyReady = document.getElementById('btn-lobby-ready');
  const btnLobbyStart = document.getElementById('btn-lobby-start');

  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnChatSend = document.getElementById('btn-chat-send');

  const resultsTitle = document.getElementById('results-title');
  const resultsTime = document.getElementById('results-time');
  const resultsList = document.getElementById('results-list');
  const resultsTip = document.getElementById('results-tip');
  const btnResultsContinue = document.getElementById('btn-results-continue');

  let currentRoom = null;
  let isReady = false;
  let phaserGame = null;

  const colorHex = (color) => `#${color.toString(16).padStart(6, '0')}`;

  // A secret this browser keeps so it can reclaim its seat after a dropped connection
  const playerId = (() => {
    // randomUUID only exists on https and localhost; LAN play over plain http needs the fallback
    const fresh = () => (crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
    try {
      let id = localStorage.getItem('cobbPlayerId');
      if (!id) {
        id = fresh();
        localStorage.setItem('cobbPlayerId', id);
      }
      return id;
    } catch (e) {
      return fresh(); // storage blocked: still unique for this page
    }
  })();

  function setStatus(message) {
    menuStatus.textContent = message || '';
  }

  function showView(view) {
    [viewInitial, viewLobby, viewResults].forEach(v => v.classList.toggle('active', v === view));
    setStatus('');
  }

  // 3. Initialize Phaser 3 Game
  function initPhaser(room) {
    stopPhaser();

    const config = {
      // Light2D darkness needs WebGL; without it Phaser falls back to Canvas and the map is fully lit
      type: Phaser.AUTO,
      width: 960,
      height: 640,
      parent: 'game-container',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH
      },
      // pixelArt lives in `render` because supplying `render` stops Phaser reading it from the top level
      render: {
        pixelArt: true,
        maxLights: CONSTANTS.LIGHTS.MAX_LIGHTS
      },
      input: { gamepad: true },
      physics: {
        default: 'arcade',
        arcade: {
          gravity: { y: 0 },
          debug: false
        }
      },
      scene: [BootScene, GameScene]
    };

    phaserGame = new Phaser.Game(config);
    // BootScene hands this to GameScene once textures are ready
    phaserGame.registry.set('room', room);
  }

  function stopPhaser() {
    if (phaserGame) {
      phaserGame.destroy(true);
      phaserGame = null;
    }
  }

  function playerName() {
    return inputPlayerName.value.trim() || 'Warden';
  }

  // 4. Solo Run: a private one-player room that starts straight away
  btnSolo.addEventListener('click', () => {
    socket.emit('room:create', { mode: 'coop', playerData: { name: playerName() }, playerId }, (res) => {
      if (!res || !res.success) return setStatus(res ? res.message : 'Could not start solo run.');
      currentRoom = res.room;
      socket.emit('game:start');
    });
  });

  // 5. Create Multiplayer Room
  btnCreateRoom.addEventListener('click', () => {
    socket.emit('room:create', { mode: 'coop', playerData: { name: playerName() }, playerId }, (res) => {
      if (res && res.success) {
        showLobbyView(res.room);
      } else {
        setStatus(res ? res.message : 'Could not create room.');
      }
    });
  });

  // 6. Join Multiplayer Room
  btnJoinRoom.addEventListener('click', () => {
    const code = inputRoomCode.value.trim().toUpperCase();
    if (code.length !== 4) {
      setStatus('Please enter a valid 4-character Room Code!');
      return;
    }

    socket.emit('room:join', { roomCode: code, playerData: { name: playerName() }, playerId }, (res) => {
      if (res && res.success) {
        showLobbyView(res.room);
      } else {
        setStatus(res ? res.message : 'Could not join room.');
      }
    });
  });

  // 7. Copy Room Code
  btnCopyCode.addEventListener('click', () => {
    if (!currentRoom) return;
    const flash = (text) => {
      btnCopyCode.textContent = text;
      setTimeout(() => btnCopyCode.textContent = 'COPY LINK', 1500);
    };
    // A link that opens the menu with this room's code filled in
    const link = `${location.origin}/?room=${currentRoom.code}`;
    // navigator.clipboard is missing on plain-http LAN addresses
    if (!navigator.clipboard) return flash('COPY BLOCKED');
    navigator.clipboard.writeText(link).then(() => flash('COPIED!'), () => flash('COPY BLOCKED'));
  });

  // 8. Ready Toggle
  function setReady(ready) {
    isReady = ready;
    btnLobbyReady.textContent = isReady ? 'NOT READY' : 'READY';
    btnLobbyReady.className = isReady ? 'btn btn-secondary' : 'btn btn-accent';
  }

  btnLobbyReady.addEventListener('click', () => {
    setReady(!isReady);
    socket.emit('room:ready', { ready: isReady });
  });

  // 9. Host Start Game
  btnLobbyStart.addEventListener('click', () => {
    socket.emit('game:start', {}, (res) => {
      if (res && !res.success) setStatus(res.message);
    });
  });

  // Host-only game mode
  selectGameMode.addEventListener('change', () => {
    socket.emit('room:settings', { mode: selectGameMode.value });
  });

  // 10. Leave Lobby
  btnLobbyLeave.addEventListener('click', () => {
    window.location.reload();
  });

  // 11. Chat Messaging
  function sendChat() {
    const text = chatInput.value.trim();
    if (text) {
      socket.emit('chat:send', { message: text });
      chatInput.value = '';
    }
  }

  btnChatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  btnResultsContinue.addEventListener('click', () => {
    showLobbyView(currentRoom);
  });

  // Helper: Transition to Lobby View
  function showLobbyView(room) {
    showView(viewLobby);
    displayRoomCode.textContent = room.code;
    updateLobbyUI(room);
  }

  function updateLobbyUI(room) {
    currentRoom = room;
    playerCountElem.textContent = room.players.length;
    maxPlayersElem.textContent = room.maxPlayers;
    document.getElementById('display-level').textContent = room.level;
    lobbyPlayerList.innerHTML = '';

    const isHost = room.hostId === socket.id;
    btnLobbyStart.classList.toggle('hidden', !isHost);
    btnLobbyReady.classList.toggle('hidden', isHost); // the host starts instead of readying
    selectGameMode.disabled = !isHost;
    selectGameMode.value = room.mode;

    room.players.forEach(p => {
      const card = document.createElement('div');
      card.className = 'player-card';
      card.style.borderLeftColor = colorHex(p.color);

      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name;

      const statusSpan = document.createElement('span');
      const ready = p.isHost || p.ready;
      statusSpan.className = `player-status-tag ${ready && !p.away ? 'ready' : ''}`;
      statusSpan.textContent = p.away ? 'RECONNECTING' : (p.isHost ? 'HOST' : (p.ready ? 'READY' : 'WAITING'));

      card.appendChild(nameSpan);
      card.appendChild(statusSpan);
      lobbyPlayerList.appendChild(card);
    });
  }

  function showResults({ won, mode, winnerId, level, storyComplete, tip, durationMs, players }) {
    const winner = players.find(p => p.id === winnerId);
    let title = storyComplete ? 'YOU ESCAPED THE FACILITY' : (won ? `LEVEL ${level} CLEARED` : `CAUGHT ON LEVEL ${level}`);
    if (mode === 'versus') title = won ? 'THE SURVIVORS ESCAPED' : 'COBB WINS';
    if (mode === 'race') title = winner ? `${winner.name.toUpperCase()} WINS THE RACE` : 'NOBODY MADE IT OUT';
    // Green when this player came out on top
    const me = players.find(p => p.id === socket.id);
    const iWon = mode === 'race' ? winnerId === socket.id : (me && me.status === 'cobb' ? !won : won);
    resultsTitle.textContent = title;
    resultsTitle.className = `results-title ${iWon ? 'won' : 'lost'}`;
    const secs = Math.round(durationMs / 1000);
    resultsTime.textContent = `ROUND TIME ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    resultsTip.textContent = tip
      ? `TIP: ${tip}`
      : (storyComplete ? 'All seven levels cleared. Keep going: endless mode stacks two rules every level.' : '');
    btnResultsContinue.textContent = won ? 'BACK TO LOBBY' : 'BACK TO LOBBY TO RETRY';

    resultsList.innerHTML = '';
    players.forEach(p => {
      const card = document.createElement('div');
      card.className = 'player-card';
      card.style.borderLeftColor = colorHex(p.color);

      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name;

      const statusSpan = document.createElement('span');
      statusSpan.className = `player-status-tag ${p.status === 'escaped' ? 'ready' : ''}`;
      statusSpan.textContent = { escaped: 'ESCAPED', caught: 'CAUGHT', cobb: 'WAS COBB' }[p.status];

      card.appendChild(nameSpan);
      card.appendChild(statusSpan);
      resultsList.appendChild(card);
    });
    showView(viewResults);
  }

  // Socket Events
  socket.on('room:updated', ({ room }) => {
    updateLobbyUI(room);
  });

  socket.on('game:started', ({ room }) => {
    console.log('[Socket] Game started! Launching dungeon...');
    currentRoom = room;
    uiOverlay.classList.add('hidden');
    gameHud.classList.remove('hidden');
    initPhaser(room);
  });

  socket.on('game:round_over', ({ results, room }) => {
    stopPhaser();
    gameHud.classList.add('hidden');
    uiOverlay.classList.remove('hidden');
    updateLobbyUI(room);
    showResults(results);
  });

  socket.on('chat:received', (data) => {
    const msg = document.createElement('div');
    msg.className = 'chat-msg';

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `[${data.time}]`;

    const sender = document.createElement('span');
    sender.className = 'sender';
    sender.textContent = `${data.sender}:`;

    msg.append(time, ' ', sender, ' ', data.message);
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  // Dropped connection: Socket.IO reconnects on its own; then we reclaim our seat
  socket.on('disconnect', () => {
    stopPhaser();
    gameHud.classList.add('hidden');
    uiOverlay.classList.remove('hidden');
    setStatus(currentRoom ? 'Connection lost. Reconnecting...' : 'Lost connection to the server.');
  });

  socket.on('connect', () => {
    if (!currentRoom) return;
    socket.emit('room:rejoin', { roomCode: currentRoom.code, playerId }, (res) => {
      if (!res || !res.success) {
        currentRoom = null;
        showView(viewInitial);
        setStatus(res ? res.message : 'Could not get back into the room.');
        return;
      }
      if (res.room.state === 'PLAYING') {
        currentRoom = res.room;
        uiOverlay.classList.add('hidden');
        gameHud.classList.remove('hidden');
        initPhaser(res.room);
      } else {
        showLobbyView(res.room);
      }
    });
  });

  // Opened from a shared link: fill in the room code
  const linkedRoom = new URLSearchParams(location.search).get('room');
  if (linkedRoom) {
    inputRoomCode.value = linkedRoom.slice(0, 4).toUpperCase();
    setStatus('Pick a codename, then press JOIN ROOM.');
  }
});
