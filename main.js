// Ringr Web Client: main.js
// Production server configuration
const SERVER_URL = 'https://visionai.site';
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const socket = io(SERVER_URL, {
  autoConnect: false,
  transports: ['websocket'], // polling triggers CSP 'unsafe-eval' in some environments
  timeout: 10000,
});


socket.io.on('error', (err) => console.warn('[Socket] connection error', err));

let localStream = null;
let remoteStream = null;
let pc = null;
let peerId = null;
let isMuted = false;
let timerInterval = null;
let startTime = null;
let callRejectTimeout = null; // Timer to reject call if not answered
let callHasTimedOut = false; // Flag to prevent timeout race conditions

// Grab DOM elements first so logStatus can access them safely
const statusDiv = document.getElementById('status');
const roomDiv = document.getElementById('room');
const btnHangup = document.getElementById('btnHangup');
const btnMute = document.getElementById('btnMute');
const callStatusDiv = document.getElementById('call-status');
const timerDiv = document.getElementById('timer');
const ringingAudio = document.getElementById('ringing-audio');
const confirmationContainer = document.getElementById('confirmation-container');
const callContainer = document.getElementById('call-container');
const confirmationMessage = document.getElementById('confirmation-message');
const btnConfirmYes = document.getElementById('btn-confirm-yes');
const btnConfirmNo = document.getElementById('btn-confirm-no');

// Use window.location.hash for hash-based routing (e.g., /#/room/some-id)
const roomId = window.location.hash.split('/').pop();

if (!roomId) {
  confirmationMessage.textContent = 'No User Found!';
  btnConfirmYes.style.display = 'none';
  btnConfirmNo.style.display = 'none';
} else {
  confirmationMessage.textContent = `Call?`;
  roomDiv.textContent = `Room: ${roomId}`;
}

function logStatus(msg, color = '#f66') {
  statusDiv.textContent = msg;
  statusDiv.style.color = color;
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function startTimer() {
  stopTimer(); // Ensure no multiple intervals
  startTime = Date.now();
  timerDiv.textContent = '00:00';
  timerDiv.style.display = 'block';
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerDiv.textContent = formatTime(elapsed);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerDiv.style.display = 'none';
}

//---------------modal----      
function showModal(message, onClose = () => {}) {
  const overlay = document.getElementById('modal-overlay');
  const msgBox = document.getElementById('modal-message');
  const okBtn = document.getElementById('modal-ok');

  msgBox.innerHTML = message;
  overlay.style.display = 'flex';

  okBtn.onclick = () => {
    overlay.style.display = 'none';
    onClose();
  };
}


//---------------modal----

function playRinging() {
  ringingAudio.play().catch(e => console.warn("Ringing play failed", e));
}

function stopRinging() {
  ringingAudio.pause();
  ringingAudio.currentTime = 0;
}

async function getMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Now that we have media access, start the ringback and connect to server
    playRinging();
    callStatusDiv.textContent = 'Ringing...';
    socket.connect();
  } catch (err) {
    console.error('getUserMedia error:', err);
    stopRinging();
    showModal(
      `Failed to access microphone. <br><br> Please grant permission and try again.`,
      () => { window.location.href = '/call-ended.html'; }
    );
  }
}

function createPeerConnection() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = (event) => {
    if (event.candidate && peerId) {
      console.log('[WebRTC] Sending ICE candidate');
      socket.emit('signal', { to: peerId, data: { candidate: event.candidate } });
    }
  };
  pc.ontrack = (event) => {
    stopRinging();
    startTimer();
    callStatusDiv.textContent = 'Ongoing Call...';

    // No UI for remote stream; just ensure audio plays
    if (!remoteStream) {
      remoteStream = new MediaStream();
      const audioElem = new Audio();
      audioElem.srcObject = remoteStream;
      audioElem.play().catch(e => console.error('Audio play failed', e));
    }
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
    console.log('[WebRTC] Received remote audio track');
  };
  pc.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      if (callRejectTimeout) clearTimeout(callRejectTimeout);
      stopRinging();
      startTimer();
      callStatusDiv.textContent = 'Connected';
    }
  };
  return pc;
}

socket.on('connect', () => {
  logStatus('Connected to signaling server', '#6f6');
  socket.emit('join-room', roomId);
});

socket.on('joined-room', (id) => {
  logStatus('Joined room. Waiting for peer...', '#6f6');
  console.log('[Socket] joined-room', id);
  // Only set up peer connection and wait for offer; do NOT create offer here.
});

socket.on('call-rejected', () => {
  if (callHasTimedOut) return;
  if (callRejectTimeout) clearTimeout(callRejectTimeout);
  logStatus('Call was rejected.', '#ff6');
  stopRinging();
  stopTimer();
  if (pc) pc.close();
  pc = null;
  remoteStream = null;
  showModal('The call was rejected', () => {
    window.location.href = '/call-ended.html';
  });
});


socket.on('room-full', () => {
  stopRinging();
  showModal('The other person is busy.', () => {
    window.location.href = '/call-ended.html';
  });
});

socket.on('peer-joined', (pid) => {
  peerId = pid;
  console.log('[Socket] peer-joined', pid);
  // Ringing has already started, now we create the connection.
  createPeerConnection();
  makeOffer(); // The initiator makes the offer
});

socket.on('peer-left', () => {
  if (callRejectTimeout) clearTimeout(callRejectTimeout);
  logStatus('Peer left the room.', '#ff6');
  console.log('[Socket] peer-left');
  stopRinging();
  stopTimer();
  if (pc) pc.close();
  pc = null;
  remoteStream = null;
  window.location.href = '/call-ended.html';
});

btnHangup.onclick = () => {
  socket.emit('hangup-call', roomId);
  if (pc) pc.close();
  stopRinging();
  stopTimer();
  // Update the button to show the call has ended
  btnHangup.innerHTML = '<i class="fa-solid fa-phone-slash"></i>';
  btnHangup.classList.add('disabled');
  btnHangup.onclick = null; // Disable further clicks

  // Redirect after a short delay to show the change
  setTimeout(() => {
    window.location.href = '/call-ended.html';
  }, 500);
};

btnMute.onclick = () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
  btnMute.classList.toggle('muted', isMuted);
  // Toggle the icon
  const icon = btnMute.querySelector('i');
  if (isMuted) {
    icon.classList.remove('fa-microphone');
    icon.classList.add('fa-microphone-slash');
  } else {
    icon.classList.remove('fa-microphone-slash');
    icon.classList.add('fa-microphone');
  }
};

socket.on('signal', async ({ from, data }) => {
  peerId = from;
  console.log('[Socket] signal', { from, data });
  if (!pc) createPeerConnection();
  if (data.sdp) {
    console.log('[WebRTC] Received SDP', data.sdp.type);
    if (data.sdp.type === 'offer') {
      playRinging();
      callStatusDiv.textContent = 'Ringing...';
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: answer } });
      console.log('[WebRTC] Sent answer');
    } else if (data.sdp.type === 'answer') {
      if (callRejectTimeout) clearTimeout(callRejectTimeout); // Clear the timeout on answer
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      console.log('[WebRTC] Set remote answer');
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      console.log('[WebRTC] Added ICE candidate');
    } catch (err) {
      console.warn('[WebRTC] Failed to add ICE candidate', err);
    }
  }
});

async function makeOffer() {
  if (!pc) createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, data: { sdp: offer } });
  console.log('[WebRTC] Sent offer');

  // Send push notification to the callee
  try {
    // The peerId is the actual ID of the user who joined the room.
    const calleeId = peerId;
    const callerName = 'Web Caller'; // You can customize this

    console.log(`[Push] Attempting to send push to user ${calleeId} for room ${roomId}`);

    const response = await fetch(`${SERVER_URL}/send-call-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toUserId: calleeId,
        roomId: roomId,
        callerName: callerName // You can customize this
      })
    });
    const result = await response.json();
    if (result.success) {
      console.log('[Push] Push notification sent successfully.');
    } else {
      console.warn('[Push] Server failed to send push notification:', result.message);
    }
  } catch (error) {
    console.error('[Push] Error sending push notification request:', error);
  }
}

// Event Listeners for confirmation
if (btnConfirmYes) {
  btnConfirmYes.addEventListener('click', () => {
    const callerEmail = document.getElementById('caller-email').value.trim();
    if (!callerEmail || !/^\S+@\S+\.\S+$/.test(callerEmail)) {
      showModal('Please enter a valid email address to continue.');
      return;
    }

    // Step 1: Update UI immediately for user feedback
    confirmationContainer.style.display = 'none';
    callContainer.style.display = 'flex';
    callStatusDiv.textContent = 'Sending notification...';

    // Step 2: Send the push notification immediately since the web client is the initiator.
    try {
      const calleeId = roomId.replace('4323', ''); // Correctly extract user ID from custom room ID
      const callerName = 'Web Caller';
      console.log(`[Push] Initiating call. Sending push to user ${calleeId} for room ${roomId}`);
      
      fetch(`${SERVER_URL}/send-call-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: calleeId, roomId: roomId, callerName: callerName })
      })
      .then(res => res.json())
      .then(result => {
        if (result.success) {
          console.log('[Push] Push notification sent successfully.');
        } else {
          console.warn('[Push] Server failed to send push notification:', result.message);
        }
      })
      .catch(error => console.error('[Push] Error sending push notification request:', error));

    } catch (error) {
      console.error('[Push] Failed to construct push notification request:', error);
    }

    // Step 3: Now, request media and connect to the signaling server.
 
    callStatusDiv.textContent = 'Requesting microphone access...';
    getMedia();
    
    // Set a timeout to reject the call if not answered in 30 seconds
    callRejectTimeout = setTimeout(() => {
      if (!callHasTimedOut) {
        callHasTimedOut = true;
        socket.emit('hangup-call', roomId);
        stopRinging();
        showModal('The call was not answered.', () => {
          window.location.href = '/call-ended.html';
        });
      }
    }, 30000);
  });
}

if (btnConfirmNo) {
  btnConfirmNo.addEventListener('click', () => {
    window.location.href = '/call-ended.html';
  });
}
