const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const REQUIREMENTS_MAX = 4000;

const elements = {
  cvForm: document.getElementById('cv-form'),
  cvFileInput: document.getElementById('cv-file-input'),
  requirementsInput: document.getElementById('requirements-input'),
  requirementsCount: document.getElementById('requirements-count'),
  analyzeBtn: document.getElementById('analyze-btn'),
  analyzeStatus: document.getElementById('analyze-status'),
  extractMeta: document.getElementById('extract-meta'),
  reviewMeta: document.getElementById('review-meta'),
  cvTextOutput: document.getElementById('cv-text-output'),
  reviewOutput: document.getElementById('review-output'),
  onlineCount: document.getElementById('online-count'),
  nameInput: document.getElementById('name-input'),
  nameSaveBtn: document.getElementById('name-save-btn'),
  presenceNote: document.getElementById('presence-note'),
  chatList: document.getElementById('chat-list'),
  chatInput: document.getElementById('chat-input'),
  chatSendBtn: document.getElementById('chat-send-btn'),
  usersList: document.getElementById('users-list'),
};

let ws = null;
let reconnectTimer = null;
let analyzePending = false;
let selfUser = null;
let users = [];

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setPresenceNote('Da ket noi chat realtime.');
  };

  ws.onclose = () => {
    setPresenceNote('Mat ket noi chat. Dang thu ket noi lai...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 2500);
  };

  ws.onerror = () => {};

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    handleServerMessage(data);
  };
}

function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'init':
      hydrateInitState(data);
      break;
    case 'presence':
      users = data.users || [];
      renderUsers();
      setOnlineCount(data.onlineCount ?? users.length);
      if (data.statusMessage) {
        setPresenceNote(data.statusMessage);
      }
      break;
    case 'chat':
      appendChatEntry(data.entry);
      break;
    default:
      break;
  }
}

function hydrateInitState(data) {
  selfUser = data.self || null;
  users = data.users || [];

  elements.chatList.innerHTML = '';
  (data.chatHistory || []).forEach((entry) => appendChatEntry(entry));

  elements.nameInput.value = selfUser?.name || '';
  renderUsers();
  setOnlineCount(data.onlineCount ?? users.length);
}

function setOnlineCount(count) {
  elements.onlineCount.textContent = `Online: ${count}`;
}

function setPresenceNote(message) {
  elements.presenceNote.textContent = message || '';
}

function renderUsers() {
  elements.usersList.innerHTML = '';

  users.forEach((user) => {
    const item = document.createElement('li');
    item.className = 'user-item';
    const isMe = selfUser && user.id === selfUser.id;
    item.innerHTML = `
      <span>${escapeHtml(user.name || 'Unknown')}</span>
      <span class="tag">${isMe ? 'You' : 'Online'}</span>
    `;
    elements.usersList.appendChild(item);
  });
}

function appendChatEntry(entry) {
  if (!entry) {
    return;
  }

  const node = document.createElement('article');
  const isSystem = entry.kind === 'system';
  const isMine = !isSystem && selfUser && entry.senderId === selfUser.id;

  node.className = `chat-item${isSystem ? ' system' : ''}${isMine ? ' mine' : ''}`;

  if (isSystem) {
    node.innerHTML = `<p>${renderText(entry.text || '')}</p>`;
  } else {
    const sender = escapeHtml(entry.senderName || 'Unknown');
    const timestamp = formatTimestamp(entry.createdAt);
    node.innerHTML = `
      <header>
        <strong>${sender}</strong>
        <time>${timestamp}</time>
      </header>
      <p>${renderText(entry.text || '')}</p>
    `;
  }

  elements.chatList.appendChild(node);
  elements.chatList.scrollTop = elements.chatList.scrollHeight;
}

function sendChat() {
  const text = elements.chatInput.value.trim();
  if (!text) {
    return;
  }

  sendWs({
    type: 'chat',
    text,
  });

  elements.chatInput.value = '';
}

function updateName() {
  const name = elements.nameInput.value.trim();
  if (!name) {
    return;
  }

  sendWs({
    type: 'set_name',
    name,
  });
}

function setAnalyzePendingState(isPending, statusText = '') {
  analyzePending = isPending;
  elements.analyzeBtn.disabled = isPending;
  elements.cvFileInput.disabled = isPending;
  elements.requirementsInput.disabled = isPending;
  elements.analyzeStatus.textContent = statusText;
}

function resetResultBoxes() {
  elements.extractMeta.textContent = '';
  elements.reviewMeta.textContent = '';
  elements.cvTextOutput.textContent = 'Dang trich xuat text...';
  elements.reviewOutput.textContent = 'Dang danh gia voi Gemini...';
  elements.cvTextOutput.classList.remove('empty');
  elements.reviewOutput.classList.remove('empty');
}

function renderAnalyzeResult(result) {
  elements.cvTextOutput.textContent = result.extractedText || '(Khong co text)';
  elements.reviewOutput.textContent = result.evaluation || '(Khong co ket qua)';
  elements.cvTextOutput.classList.remove('empty');
  elements.reviewOutput.classList.remove('empty');

  const extractMeta = `${result.fileName || 'Unknown file'} | ${result.extractedChars || 0} ky tu`;
  const reviewMeta = result.trimmedForModel
    ? `Gui ${result.charsSentToModel || 0} ky tu len Gemini (da cat bot)`
    : `Gui ${result.charsSentToModel || 0} ky tu len Gemini`;

  elements.extractMeta.textContent = extractMeta;
  elements.reviewMeta.textContent = reviewMeta;
}

async function submitCvForEvaluation(event) {
  event.preventDefault();

  if (analyzePending) {
    return;
  }

  const file = elements.cvFileInput.files?.[0];
  if (!file) {
    setAnalyzePendingState(false, 'Hay chon file CV truoc.');
    return;
  }

  const formData = new FormData();
  formData.append('cvFile', file);
  formData.append('requirements', elements.requirementsInput.value.trim());

  setAnalyzePendingState(true, 'Dang xu ly CV...');
  resetResultBoxes();

  try {
    const response = await fetch('/api/cv/evaluate', {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }

    renderAnalyzeResult(payload);
    setAnalyzePendingState(false, 'Da xu ly xong.');
  } catch (error) {
    elements.cvTextOutput.textContent = 'Khong the trich xuat text CV.';
    elements.reviewOutput.textContent = `Loi: ${error.message || 'Khong ro nguyen nhan'}`;
    elements.cvTextOutput.classList.add('empty');
    elements.reviewOutput.classList.add('empty');
    setAnalyzePendingState(false, error.message || 'Khong xu ly duoc CV.');
  }
}

function updateRequirementsCounter() {
  const currentLength = elements.requirementsInput.value.length;
  elements.requirementsCount.textContent = `${currentLength} / ${REQUIREMENTS_MAX}`;
}

function formatTimestamp(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) {
    return '';
  }

  const date = new Date(value);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderText(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

elements.cvForm.addEventListener('submit', submitCvForEvaluation);

elements.chatSendBtn.addEventListener('click', sendChat);
elements.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sendChat();
  }
});

elements.nameSaveBtn.addEventListener('click', updateName);
elements.nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    updateName();
  }
});

elements.requirementsInput.addEventListener('input', updateRequirementsCounter);

updateRequirementsCounter();
connectWebSocket();

// ==== VIDEO CALL (WebRTC + signaling) ====
const MAX_PEERS = 4; // ngoài local
const peerConnections = {};
let localStream = null;
let cameraOn = true;
let micOn = true;

const videoElements = [
  document.getElementById('local-video'),
  document.getElementById('remote-video-1'),
  document.getElementById('remote-video-2'),
  document.getElementById('remote-video-3'),
  document.getElementById('remote-video-4'),
];

async function startLocalMedia() {
  try {
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const isHttps = location.protocol === 'https:';
    if (!isLocalhost && !isHttps) {
      alert('⚠️ Trình duyệt chỉ cho phép truy cập camera/mic qua HTTPS hoặc localhost.');
    }
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    videoElements[0].srcObject = localStream;
  } catch (err) {
    alert('Không truy cập được camera/mic: ' + err.message);
  }
}

function stopLocalMedia() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    videoElements[0].srcObject = null;
  }
}

function toggleCamera() {
  cameraOn = !cameraOn;
  if (localStream) {
    localStream.getVideoTracks().forEach(track => (track.enabled = cameraOn));
  }
}

function toggleMic() {
  micOn = !micOn;
  if (localStream) {
    localStream.getAudioTracks().forEach(track => (track.enabled = micOn));
  }
}

document.getElementById('toggle-camera').onclick = toggleCamera;
document.getElementById('toggle-mic').onclick = toggleMic;

function sendSignal(to, data) {
  sendWs({ type: 'signal', to, data });
}

function handleSignal(from, data) {
  if (!selfUser || from === selfUser.id) return;
  let pc = peerConnections[from];
  if (!pc) {
    pc = createPeerConnection(from);
  }
  if (data.sdp) {
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
      if (pc.remoteDescription.type === 'offer') {
        pc.createAnswer().then(answer => {
          pc.setLocalDescription(answer).then(() => {
            sendSignal(from, { sdp: pc.localDescription });
          });
        });
      }
    });
  } else if (data.candidate) {
    pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  peerConnections[peerId] = pc;
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(peerId, { candidate: event.candidate });
    }
  };
  pc.ontrack = (event) => {
    const idx = getRemoteVideoIndex(peerId);
    if (idx > 0 && idx < videoElements.length) {
      videoElements[idx].srcObject = event.streams[0];
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupPeer(peerId);
    }
  };
  return pc;
}

function getRemoteVideoIndex(peerId) {
  if (!users || !selfUser) return 0;
  const idx = users.findIndex(u => u.id === peerId);
  if (idx === -1) return 0;
  let vIdx = 1;
  for (let i = 0; i < users.length; ++i) {
    if (users[i].id === selfUser.id) continue;
    if (users[i].id === peerId) return vIdx;
    vIdx++;
  }
  return 0;
}

function cleanupPeer(peerId) {
  if (peerConnections[peerId]) {
    peerConnections[peerId].close();
    delete peerConnections[peerId];
    const idx = getRemoteVideoIndex(peerId);
    if (idx > 0 && idx < videoElements.length) {
      videoElements[idx].srcObject = null;
    }
  }
}

function connectToPeers() {
  if (!selfUser) return;
  let count = 0;
  for (const user of users) {
    if (user.id === selfUser.id) continue;
    if (!peerConnections[user.id] && count < MAX_PEERS) {
      const pc = createPeerConnection(user.id);
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer).then(() => {
          sendSignal(user.id, { sdp: pc.localDescription });
        });
      });
      count++;
    }
  }
}

function disconnectAllPeers() {
  Object.keys(peerConnections).forEach(cleanupPeer);
}

const _oldRenderUsers = renderUsers;
renderUsers = function() {
  _oldRenderUsers.apply(this, arguments);
  setTimeout(connectToPeers, 200);
};

const _oldHandleServerMessage = handleServerMessage;
handleServerMessage = function(data) {
  if (data.type === 'signal' && data.from && data.data) {
    handleSignal(data.from, data.data);
    return;
  }
  if (data.type === 'chess_move' && data.move) {
    applyRemoteChessMove(data.move);
    return;
  }
  _oldHandleServerMessage.apply(this, arguments);
};

window.addEventListener('beforeunload', disconnectAllPeers);
startLocalMedia();

// ==== BÀN CỜ VUA ONLINE ====
const PIECES = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};
let chessState = null;
let selectedSquare = null;

function getInitialChessState() {
  return [
    ['bR','bN','bB','bQ','bK','bB','bN','bR'],
    ['bP','bP','bP','bP','bP','bP','bP','bP'],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    ['wP','wP','wP','wP','wP','wP','wP','wP'],
    ['wR','wN','wB','wQ','wK','wB','wN','wR'],
  ];
}

function renderChessboard() {
  const board = document.getElementById('chessboard');
  board.innerHTML = '';
  for (let row = 0; row < 8; ++row) {
    for (let col = 0; col < 8; ++col) {
      const sq = document.createElement('div');
      sq.className = 'chess-square ' + ((row+col)%2===0 ? 'white' : 'black');
      sq.dataset.row = row;
      sq.dataset.col = col;
      if (selectedSquare && selectedSquare[0] === row && selectedSquare[1] === col) {
        sq.classList.add('selected');
      }
      const piece = chessState[row][col];
      if (piece) sq.textContent = PIECES[piece] || '';
      sq.onclick = () => onChessSquareClick(row, col);
      board.appendChild(sq);
    }
  }
}

function onChessSquareClick(row, col) {
  const piece = chessState[row][col];
  if (selectedSquare) {
    const [fromRow, fromCol] = selectedSquare;
    if (fromRow !== row || fromCol !== col) {
      const move = { from: [fromRow, fromCol], to: [row, col], piece: chessState[fromRow][fromCol], captured: chessState[row][col] };
      chessState[row][col] = chessState[fromRow][fromCol];
      chessState[fromRow][fromCol] = null;
      selectedSquare = null;
      renderChessboard();
      updateChessStatus('');
      sendWs({ type: 'chess_move', move });
    } else {
      selectedSquare = null;
      renderChessboard();
      updateChessStatus('');
    }
  } else if (piece) {
    selectedSquare = [row, col];
    renderChessboard();
    updateChessStatus('Chọn ô đích để di chuyển.');
  }
}

function applyRemoteChessMove(move) {
  if (!move || !move.from || !move.to) return;
  const [fromRow, fromCol] = move.from;
  const [toRow, toCol] = move.to;
  chessState[toRow][toCol] = chessState[fromRow][fromCol];
  chessState[fromRow][fromCol] = null;
  selectedSquare = null;
  renderChessboard();
  updateChessStatus('Đối thủ vừa đi nước mới.');
}

function resetChessboard() {
  chessState = getInitialChessState();
  selectedSquare = null;
  renderChessboard();
  updateChessStatus('Bàn cờ đã được reset.');
  sendWs({ type: 'chess_move', move: { reset: true } });
}

document.getElementById('reset-chess').onclick = resetChessboard;

function updateChessStatus(msg) {
  document.getElementById('chess-status').textContent = msg;
}

// Nhận reset từ người khác
function applyRemoteChessMove(move) {
  if (move && move.reset) {
    chessState = getInitialChessState();
    selectedSquare = null;
    renderChessboard();
    updateChessStatus('Đối thủ vừa reset bàn cờ.');
    return;
  }
  if (!move || !move.from || !move.to) return;
  const [fromRow, fromCol] = move.from;
  const [toRow, toCol] = move.to;
  chessState[toRow][toCol] = chessState[fromRow][fromCol];
  chessState[fromRow][fromCol] = null;
  selectedSquare = null;
  renderChessboard();
  updateChessStatus('Đối thủ vừa đi nước mới.');
}

// Khởi tạo bàn cờ khi load trang
chessState = getInitialChessState();
renderChessboard();
