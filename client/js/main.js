// Main client entry and UI controller for COBB CAN MOVE
document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Socket.IO connection
  const socket = io();
  window.gameSocket = socket;

  // 2. DOM Elements
  const uiOverlay = document.getElementById('ui-overlay');
  const viewInitial = document.getElementById('view-initial');
  const viewLobby = document.getElementById('view-lobby');
  const gameHud = document.getElementById('game-hud');

  const inputPlayerName = document.getElementById('player-name');
  const btnSolo = document.getElementById('btn-solo');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const inputRoomCode = document.getElementById('input-room-code');

  const displayRoomCode = document.getElementById('display-room-code');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const lobbyPlayerList = document.getElementById('lobby-player-list');
  const playerCountElem = document.getElementById('player-count');
  const selectGameMode = document.getElementById('select-game-mode');
  const btnLobbyLeave = document.getElementById('btn-lobby-leave');
  const btnLobbyReady = document.getElementById('btn-lobby-ready');
  const btnLobbyStart = document.getElementById('btn-lobby-start');

  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnChatSend = document.getElementById('btn-chat-send');

  let currentRoom = null;
  let isReady = false;
  let phaserGame = null;

  // 3. Initialize Phaser 3 Game
  function initPhaser(roomData = null) {
    if (phaserGame) {
      phaserGame.destroy(true);
    }

    const config = {
      type: Phaser.WEBGL, // Required for Light2D pipeline
      width: 960,
      height: 640,
      parent: 'game-container',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH
      },
      pixelArt: true,
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

    // Pass room data when starting GameScene
    phaserGame.events.once('ready', () => {
      // Scene manager takes over
    });
  }

  // 4. Solo Offline Run
  btnSolo.addEventListener('click', () => {
    uiOverlay.classList.add('hidden');
    gameHud.classList.remove('hidden');
    initPhaser(null);
  });

  // 5. Create Multiplayer Room
  btnCreateRoom.addEventListener('click', () => {
    const name = inputPlayerName.value.trim() || 'Warden';
    socket.emit('room:create', {
      mode: selectGameMode.value,
      playerData: { name }
    }, (res) => {
      if (res && res.success) {
        currentRoom = res.room;
        showLobbyView(res.room);
      }
    });
  });

  // 6. Join Multiplayer Room
  btnJoinRoom.addEventListener('click', () => {
    const code = inputRoomCode.value.trim().toUpperCase();
    const name = inputPlayerName.value.trim() || 'Warden';
    if (!code || code.length !== 4) {
      alert('Please enter a valid 4-character Room Code!');
      return;
    }

    socket.emit('room:join', {
      roomCode: code,
      playerData: { name }
    }, (res) => {
      if (res && res.success) {
        currentRoom = res.room;
        showLobbyView(res.room);
      } else {
        alert(res ? res.message : 'Could not join room.');
      }
    });
  });

  // 7. Copy Room Code
  btnCopyCode.addEventListener('click', () => {
    if (currentRoom) {
      navigator.clipboard.writeText(currentRoom.code);
      btnCopyCode.textContent = 'COPIED!';
      setTimeout(() => btnCopyCode.textContent = 'COPY LINK', 1500);
    }
  });

  // 8. Ready Toggle
  btnLobbyReady.addEventListener('click', () => {
    isReady = !isReady;
    btnLobbyReady.textContent = isReady ? 'NOT READY' : 'READY';
    btnLobbyReady.className = isReady ? 'btn btn-secondary' : 'btn btn-accent';
    socket.emit('room:ready', { ready: isReady });
  });

  // 9. Host Start Game
  btnLobbyStart.addEventListener('click', () => {
    socket.emit('game:start');
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

  // Helper: Transition to Lobby View
  function showLobbyView(room) {
    viewInitial.classList.remove('active');
    viewLobby.classList.add('active');
    displayRoomCode.textContent = room.code;
    updateLobbyUI(room);
  }

  function updateLobbyUI(room) {
    currentRoom = room;
    playerCountElem.textContent = room.players.length;
    lobbyPlayerList.innerHTML = '';

    const isHost = room.hostId === socket.id;
    if (isHost) {
      btnLobbyStart.classList.remove('hidden');
    } else {
      btnLobbyStart.classList.add('hidden');
    }

    room.players.forEach(p => {
      const card = document.createElement('div');
      card.className = 'player-card';
      card.style.borderLeftColor = `#${p.color.toString(16).padStart(6, '0')}`;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name + (p.isHost ? ' (HOST)' : '');

      const statusSpan = document.createElement('span');
      statusSpan.className = `player-status-tag ${p.ready ? 'ready' : ''}`;
      statusSpan.textContent = p.ready ? 'READY' : 'WAITING';

      card.appendChild(nameSpan);
      card.appendChild(statusSpan);
      lobbyPlayerList.appendChild(card);
    });
  }

  // Socket Events
  socket.on('room:updated', ({ room }) => {
    updateLobbyUI(room);
  });

  socket.on('game:started', ({ room }) => {
    console.log('[Socket] Game started! Launching dungeon...');
    uiOverlay.classList.add('hidden');
    gameHud.classList.remove('hidden');
    initPhaser(room);
  });

  socket.on('chat:received', (data) => {
    const msg = document.createElement('div');
    msg.className = 'chat-msg';
    msg.innerHTML = `<span class="time">[${data.time}]</span> <span class="sender">${data.sender}:</span> ${data.message}`;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
});
