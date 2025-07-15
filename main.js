// Ringr Web Client: main.js
// IMPORTANT: Replace this with the ngrok URL for your signaling server (port 3000)
const SERVER_URL = 'https://call-server-ueo9.onrender.com';
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
  confirmationMessage.textContent = 'No Room ID Found!';
  btnConfirmYes.style.display = 'none';
  btnConfirmNo.style.display = 'none';
} else {
  confirmationMessage.textContent = `Call ${roomId}?`;
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
}

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
    // Now that we have media, we can connect to the server and join the room.
    socket.connect();
  } catch (err) {
    logStatus('Could not access camera/mic: ' + err.message);
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
  logStatus('Call was rejected.', '#ff6');
  stopRinging();
  stopTimer();
  if (pc) pc.close();
  pc = null;
  remoteStream = null;
  window.location.href = '/call-ended.html';
});

socket.on('room-full', () => {
  logStatus('Room is full. Only two people can join.', '#f66');
});

socket.on('peer-joined', (pid) => {
  peerId = pid;
  console.log('[Socket] peer-joined', pid);
  playRinging();
  callStatusDiv.textContent = 'Ringing...';
  createPeerConnection();
  makeOffer(); // The initiator makes the offer
});

socket.on('peer-left', () => {
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
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, data: { sdp: offer } });
}

// Event Listeners for confirmation
btnConfirmYes.onclick = () => {
  confirmationContainer.style.display = 'none';
  callContainer.style.display = 'flex';
  getMedia();
};

btnConfirmNo.onclick = () => {
  window.location.href = '/call-ended.html';
};
