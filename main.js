// Ringr Web Client: main.js
// IMPORTANT: Replace this with the ngrok URL for your signaling server (port 3000)
const SERVER_URL = 'https://call-server-ueo9.onrender.com';
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const socket = io(SERVER_URL, { autoConnect: false });
let localStream = null;
let remoteStream = null;
let pc = null;
let peerId = null;

// Use window.location.hash for hash-based routing (e.g., /#/room/some-id)
const roomId = window.location.hash.split('/').pop();

if (!roomId) {
  logStatus('ERROR: No Room ID found in URL. Use format: /#/room/YOUR_ROOM_ID');
}
const statusDiv = document.getElementById('status');
const roomDiv = document.getElementById('room');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

roomDiv.textContent = `Room: ${roomId}`;

function logStatus(msg, color = '#f66') {
  statusDiv.textContent = msg;
  statusDiv.style.color = color;
}

async function getMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
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
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    event.streams[0].getTracks().forEach(track => {
      remoteStream.addTrack(track);
    });
    console.log('[WebRTC] Received remote track');
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
  alert('Call was rejected');
  pc.close();
});

socket.on('room-full', () => {
  logStatus('Room is full. Only two people can join.', '#f66');
});


socket.on('call-rejected', () => {
  alert('Call was rejected');
  pc.close();
});

socket.on('peer-joined', (pid) => {
  peerId = pid;
  console.log('[Socket] peer-joined', pid);
  createPeerConnection();
  makeOffer(); // The initiator makes the offer
});

socket.on('peer-left', () => {
  logStatus('Peer left the room.', '#ff6');
  console.log('[Socket] peer-left');
  if (pc) pc.close();
  pc = null;
  remoteStream = null;
  remoteVideo.srcObject = null;
});

btnHangup.onclick = () => {
  socket.emit('hangup-call', roomId);
  pc.close();            // close our end
  window.location.href = '/';   // or any “home” screen you want
};


socket.on('signal', async ({ from, data }) => {
  peerId = from;
  console.log('[Socket] signal', { from, data });
  if (!pc) createPeerConnection();
  if (data.sdp) {
    console.log('[WebRTC] Received SDP', data.sdp.type);
    if (data.sdp.type === 'offer') {
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

getMedia();
