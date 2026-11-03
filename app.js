'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  WebRTC Inspector – full mesh: every person has their own RTCPeerConnection
//  to every other person in the room. A 1:1 call is simply a room of size 2.
// ════════════════════════════════════════════════════════════════════════════

// ───────────── helpers ─────────────
const $ = (s) => document.querySelector(s);
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(2);
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : (e[k] = v);
  for (const k of kids) e.append(k);
  return e;
}
function logTo(id, text, cls = '') {
  const box = $(id);
  box.append(h('div', { class: cls, textContent: `${secs().padStart(7)}  ${text}` }));
  while (box.childNodes.length > 600) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
const logState = (t, c) => logTo('#stateLog', t, c);
const plog = (p, t, c) => logState(`[${p.name}] ${t}`, c);
const fmtBytes = (n) => (n == null ? '–' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);
const fmtBps = (n) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(2)} Mbit/s` : `${(n / 1e3).toFixed(0)} kbit/s`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

function toast(msg, kind = 'error') {
  const t = h('div', { class: 'toast ' + (kind === 'info' ? 'info' : ''), textContent: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}

// ───────────── state ─────────────
const ZOOM_NONE = 'Grid';
let ws = null;
let joined = false;
// flip      = flipped for EVERYONE (sent to the others, who draw our tile flipped)
// localFlip = flipped only in MY OWN view of my camera (never sent)
const me = { id: null, name: '', flip: { h: false, v: false }, localFlip: { h: false, v: false } };
try { Object.assign(me.localFlip, JSON.parse(localStorage.getItem('rtc-localflip') || '{}')); } catch {}
let room = { name: '', capacity: 2, count: 0, host: null, max: 50 };
/** @type {Map<string, any>} one entry per remote person */
const peers = new Map();
let localStream = new MediaStream();
let lastScreenKey = '';
let screenStream = null; // our shared screen (video, maybe audio), sent on dedicated transceivers
let unread = 0;
let zoomId = null;     // null = grid, otherwise 'local' or a peer id
let detailId = null;   // which peer the Details tab is inspecting
let sendQueue = Promise.resolve();

const newLive = () => ({ pair: null, local: null, remote: null, rtt: null, used: { out: {}, in: {} }, bps: { out: {}, in: {} }, dim: { out: {}, in: {} }, scr: { out: {}, in: {} } });
const detailPeer = () => peers.get(detailId) || null;
const peerList = () => [...peers.values()];
const openChatPeers = () => peerList().filter((p) => p.dcs.chat?.readyState === 'open');
const isHost = () => joined && room.host === me.id;

// ───────────── connection-state badges (Details tab) ─────────────
const badgeEls = {};
for (const k of ['ws', 'signalingState', 'iceGatheringState', 'iceConnectionState', 'connectionState']) {
  const b = h('span', { class: 'badge2' }, `${k}: `, h('b', { textContent: '–' }));
  badgeEls[k] = b;
  $('#badges').append(b);
}
function setBadge(k, v) {
  const b = badgeEls[k];
  b.querySelector('b').textContent = v;
  b.className = 'badge2' + (['connected', 'completed', 'open', 'stable', 'complete'].includes(v) ? ' good' :
    ['failed', 'closed', 'disconnected'].includes(v) ? ' bad' : ['checking', 'connecting', 'gathering', 'new'].includes(v) ? ' warn' : '');
}
function renderBadges() {
  setBadge('ws', ws && ws.readyState === 1 ? 'open' : 'closed');
  const pc = detailPeer()?.pc;
  for (const k of ['signalingState', 'iceGatheringState', 'iceConnectionState', 'connectionState']) setBadge(k, pc ? pc[k] : '–');
}

// ───────────── ICE config UI ─────────────
async function loadIceConfig() {
  try {
    const cfg = await (await fetch('/api/ice-config')).json();
    $('#iceCfg').value = JSON.stringify(cfg.iceServers, null, 2);
  } catch (e) { $('#iceCfg').value = '[]'; }
}
$('#btnReloadCfg').onclick = loadIceConfig;
$('#btnGoogleStun').onclick = () => {
  let arr = [];
  try { arr = JSON.parse($('#iceCfg').value); } catch {}
  arr.push({ urls: 'stun:stun.l.google.com:19302' });
  $('#iceCfg').value = JSON.stringify(arr, null, 2);
};
function readRtcConfig() {
  let iceServers = [];
  try { iceServers = JSON.parse($('#iceCfg').value); } catch (e) { logState('Invalid ICE JSON, using none: ' + e.message, 'err'); }
  return { iceServers, iceTransportPolicy: $('#relayOnly').checked ? 'relay' : 'all' };
}
loadIceConfig();

// Every connection has four transceivers, in this order. Using fixed slots means starting a screen share is
// just replaceTrack() (no renegotiation) and either side of a pair can share, even the one that did not make the offer.
const ROLES = ['mic', 'cam', 'screen', 'screenAudio'];
function localTrackForRole(role) {
  switch (role) {
    case 'mic': return localStream.getAudioTracks()[0] || null;
    case 'cam': return localStream.getVideoTracks()[0] || null;
    case 'screen': return screenStream?.getVideoTracks()[0] || null;
    case 'screenAudio': return screenStream?.getAudioTracks()[0] || null;
  }
  return null;
}
function roleForStat(p, r) {
  const ts = p.pc?.getTransceivers() || [];
  const i = ts.findIndex((t) => t.mid != null && t.mid === r.mid);
  if (i >= 0 && ROLES[i]) return ROLES[i];
  return r.kind === 'video' ? 'cam' : 'mic';
}

// How much the shared screen is scaled down before sending, so it fits inside the chosen size (never scaled up).
function screenScale() {
  const st = screenStream?.getVideoTracks()[0]?.getSettings();
  if (!st?.width) return null;
  const sel = $('#setSRes').value;
  let factor = 1;
  if (sel !== 'orig') { const [mw, mh] = sel.split('x').map(Number); factor = Math.max(1, st.width / mw, st.height / mh); }
  return { w: st.width, h: st.height, factor, sw: Math.round(st.width / factor), sh: Math.round(st.height / factor) };
}

// ───────────── settings ─────────────
const S = () => {
  const [w, hh] = $('#setRes').value.split('x').map(Number);
  return {
    w, h: hh, fps: +$('#setFps').value, vKbps: +$('#setVBitrate').value, scale: +$('#setScale').value,
    degr: $('#setDegr').value, hint: $('#setHint').value, vCodec: $('#setVCodec').value, aCodec: $('#setACodec').value,
    sRes: $('#setSRes').value, sKbps: +$('#setSBitrate').value, sFps: +$('#setSFps').value, sAudio: $('#setSAudio').checked,
    aKbps: +$('#setABitrate').value, aec: $('#setAec').checked, ns: $('#setNs').checked, agc: $('#setAgc').checked,
    cam: $('#setCam').value, mic: $('#setMic').value,
  };
};
function mediaConstraints() {
  const s = S();
  return {
    audio: { deviceId: s.mic ? { exact: s.mic } : undefined, echoCancellation: s.aec, noiseSuppression: s.ns, autoGainControl: s.agc },
    video: { deviceId: s.cam ? { exact: s.cam } : undefined, width: { ideal: s.w }, height: { ideal: s.h }, frameRate: { ideal: s.fps } },
  };
}
for (const id of ['#setCam', '#setRes', '#setFps']) $(id).addEventListener('change', () => { if (camOn()) enableKind('video'); });
for (const id of ['#setMic', '#setAec', '#setNs', '#setAgc']) $(id).addEventListener('change', () => { if (micOn()) enableKind('audio'); });
for (const id of ['#setVBitrate', '#setScale', '#setDegr', '#setABitrate', '#setSBitrate', '#setSRes']) $(id).addEventListener('change', () => peerList().forEach(applySenderParams));
$('#setHint').addEventListener('change', () => applyContentHint());
$('#setSFps').addEventListener('change', () => { screenStream?.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: S().sFps } }).catch(() => {}); });
for (const id of ['#setVCodec', '#setACodec']) $(id).addEventListener('change', () => { peerList().forEach(applyCodecPrefs); requestRenegotiation(); });
$('#setFlipH').addEventListener('change', () => setFlip($('#setFlipH').checked, me.flip.v));
$('#setFlipV').addEventListener('change', () => setFlip(me.flip.h, $('#setFlipV').checked));
$('#setLocalFlipH').addEventListener('change', () => setLocalFlip($('#setLocalFlipH').checked, me.localFlip.v));
$('#setLocalFlipV').addEventListener('change', () => setLocalFlip(me.localFlip.h, $('#setLocalFlipV').checked));

async function applySenderParams(p) {
  if (!p.pc || !p.pc.currentLocalDescription) return; // not negotiated yet
  const s = S();
  const ts = p.pc.getTransceivers();
  for (let i = 0; i < ts.length; i++) {
    const sender = ts[i].sender, role = ROLES[i] || 'cam';
    if (!sender.track) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      const isVideo = role === 'cam' || role === 'screen';
      const kbps = role === 'screen' ? s.sKbps : isVideo ? s.vKbps : s.aKbps;
      if (kbps > 0) enc.maxBitrate = kbps * 1000; else delete enc.maxBitrate;
      if (role === 'cam') {
        enc.scaleResolutionDownBy = s.scale;
        if (s.degr !== 'default') params.degradationPreference = s.degr; else delete params.degradationPreference;
      } else if (role === 'screen') {
        enc.scaleResolutionDownBy = screenScale()?.factor ?? 1;
        params.degradationPreference = 'maintain-resolution'; // keep text readable, drop frames instead
      }
      await sender.setParameters(params);
      plog(p, `${role} sender: maxBitrate ${kbps > 0 ? kbps + ' kbit/s' : 'auto'}${role === 'cam' ? ', downscale ÷' + s.scale + ', degradation ' + s.degr : ''}${role === 'screen' ? ', downscale ÷' + (screenScale()?.factor ?? 1).toFixed(2) : ''}`, 'evt');
    } catch (e) { plog(p, `setParameters(${role}) failed: ${e.message}`, 'err'); }
  }
}
function applyContentHint() {
  const t = localStream.getVideoTracks()[0];
  if (t && 'contentHint' in t) t.contentHint = S().hint;
}

// ───────────── codecs ─────────────
const SKIP_CODEC = /^(rtx|red|ulpfec|flexfec-03|cn|telephone-event)$/i;
const CODEC_INFO = {
  vp8: 'Classic, works everywhere. Software encoding is fine up to about 720p.',
  vp9: 'Better quality per bit than VP8, but heavier on the CPU.',
  av1: 'Best compression, very CPU-heavy unless there is hardware support.',
  h264: 'Often hardware-accelerated (phones, Safari). Good for battery life.',
  h265: 'High efficiency, but very limited browser support.',
  opus: 'The best audio codec: voice and music, adapts to bandwidth.',
  g722: 'Older wide-band voice codec.',
  pcmu: 'G.711 µ-law, old telephone quality.',
  pcma: 'G.711 A-law, old telephone quality.',
  isac: 'Legacy voice codec.', ilbc: 'Legacy low-bitrate voice codec.',
};
const codecName = (mime) => mime.split('/')[1];
const simplify = (caps) => (caps?.codecs ?? []).map((c) => ({ mime: c.mimeType, name: codecName(c.mimeType), clock: c.clockRate, ch: c.channels, fmtp: c.sdpFmtpLine }));
function localCodecs() {
  const g = (obj, kind) => (obj.getCapabilities ? simplify(obj.getCapabilities(kind)) : []);
  return {
    video: { send: g(RTCRtpSender, 'video'), recv: g(RTCRtpReceiver, 'video') },
    audio: { send: g(RTCRtpSender, 'audio'), recv: g(RTCRtpReceiver, 'audio') },
  };
}
function groupCodecs(list) {
  const m = new Map();
  for (const c of list) { if (SKIP_CODEC.test(c.name)) continue; const k = c.name.toLowerCase(); const e = m.get(k) || { label: c.name, n: 0 }; e.n++; m.set(k, e); }
  return m;
}
function populateCodecSelects() {
  const lc = localCodecs();
  for (const [kind, id] of [['video', '#setVCodec'], ['audio', '#setACodec']]) {
    const sel = $(id);
    sel.replaceChildren(h('option', { value: 'auto', textContent: 'Automatic' }));
    const names = new Map([...groupCodecs(lc[kind].send), ...groupCodecs(lc[kind].recv)]);
    for (const e of names.values()) sel.append(h('option', { value: `${kind}/${e.label}`, textContent: e.label }));
  }
}
populateCodecSelects();

function applyCodecPrefs(p) {
  if (!p.pc) return;
  const s = S();
  for (const t of p.pc.getTransceivers()) {
    if (!t.setCodecPreferences || t.stopped) continue;
    const kind = t.receiver.track.kind;
    const want = kind === 'video' ? s.vCodec : s.aCodec;
    try {
      if (want === 'auto') { t.setCodecPreferences([]); continue; }
      const caps = RTCRtpReceiver.getCapabilities(kind).codecs;
      const chosen = caps.filter((c) => c.mimeType.toLowerCase() === want.toLowerCase());
      if (!chosen.length) continue;
      t.setCodecPreferences([...chosen, ...caps.filter((c) => !chosen.includes(c))]);
      plog(p, `${kind} codec preference: ${want}`, 'evt');
    } catch (e) { plog(p, `setCodecPreferences(${kind}) failed: ${e.message}`, 'err'); }
  }
}
async function requestRenegotiation(only) {
  for (const p of only ? [only] : peerList()) {
    if (!p.pc || !p.pc.currentRemoteDescription) continue;
    if (p.isOfferer) await makeOffer(p);
    else if (p.dcs.chat?.readyState === 'open') p.dcs.chat.send(JSON.stringify({ t: 'renegotiate' }));
    else plog(p, 'codec change will apply at the next negotiation (data channel not open)', 'err');
  }
}

// ───────────── room menu ─────────────
const menuOpen = (open) => { $('#roomMenu').hidden = !open; $('#btnRoom').setAttribute('aria-expanded', String(open)); };
$('#btnRoom').onclick = (e) => { e.stopPropagation(); menuOpen($('#roomMenu').hidden); };
document.addEventListener('click', (e) => { if (!e.target.closest('.menuwrap')) menuOpen(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menuOpen(false); });

function modeChanged() {
  const group = document.querySelector('input[name=mode]:checked').value === 'group';
  $('#capSub').hidden = !group;
  const n = parseInt($('#capacity').value, 10);
  $('#meshWarn').hidden = !(group && (n === 0 || n > 4 || Number.isNaN(n)));
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', modeChanged));
$('#capacity').addEventListener('input', modeChanged);

function chosenCapacity() {
  if (document.querySelector('input[name=mode]:checked').value === '1to1') return 2;
  const n = parseInt($('#capacity').value, 10);
  return Number.isNaN(n) ? 6 : Math.max(0, n);
}

const inviteLink = () => `${location.origin}${location.pathname}?room=${encodeURIComponent(room.name)}`;
$('#btnCopyLink').onclick = async () => {
  try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied', 'info'); }
  catch { toast('Copy this link: ' + inviteLink(), 'info'); }
};
$('#btnApplyCap').onclick = () => {
  const n = parseInt($('#capLive').value, 10);
  if (ws?.readyState === 1 && !Number.isNaN(n)) sigSend({ type: 'set-capacity', capacity: n });
};

function renderRoomMenu() {
  $('#roomPre').style.display = joined ? 'none' : 'flex';
  $('#roomLive').style.display = joined ? 'flex' : 'none';
  $('#btnRoom').textContent = joined ? `${room.name} · ${room.count}/${room.capacity || '∞'} ▾` : 'Room ▾';
  if (!joined) return;
  const hostName = room.host === me.id ? 'you' : peers.get(room.host)?.name || '…';
  const kind = room.capacity === 2 ? '1:1 call' : `group call (${room.capacity ? 'max ' + room.capacity : 'no limit'})`;
  $('#roomInfo').replaceChildren(
    h('div', { textContent: `Room “${room.name}” · ${kind}` }),
    h('div', { textContent: `${room.count} ${room.count === 1 ? 'person' : 'people'} here · host: ${hostName}` }),
  );
  $('#capLive').disabled = $('#btnApplyCap').disabled = !isHost();
  if (document.activeElement !== $('#capLive')) $('#capLive').value = room.capacity;
  $('#capLive').title = isHost() ? '' : 'Only the host can change the room size';
}

// ───────────── signaling ─────────────
function sigSummary(m) {
  return JSON.stringify(m, (k, v) => (k === 'sdp' && typeof v === 'string' ? `<${v.length} chars>` : v));
}
function sigSend(m) {
  ws.send(JSON.stringify(m));
  logTo('#sigLog', '→ ' + sigSummary(m), 'out');
}

function joinRoom() {
  const roomName = $('#room').value.trim();
  if (!roomName) return toast('Enter a room name first');
  me.name = $('#nameInput').value.trim().slice(0, 32) || 'Guest-' + Math.random().toString(36).slice(2, 6);
  $('#nameInput').value = me.name;
  store.set('rtc-name', me.name);
  const capacity = chosenCapacity();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { sigSend({ type: 'join', room: roomName, name: me.name, capacity }); renderAll(); };
  ws.onclose = () => {
    const wasJoined = joined;
    joined = false; me.id = null;
    peerList().forEach((p) => removePeer(p.id));
    room = { name: '', capacity: 2, count: 0, host: null, max: 50 };
    $('#btnHangup').disabled = true;
    $('#btnJoin').disabled = false;
    if (wasJoined) chatSystem('You left the room.');
    renderAll();
  };
  ws.onerror = () => logState('WebSocket error (is the server running / is /ws proxied?)', 'err');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    logTo('#sigLog', '← ' + sigSummary(msg), 'in');
    onSignal(msg).catch((e) => logState('signal handler error: ' + (e.stack || e), 'err'));
  };
  $('#btnJoin').disabled = true;
}
$('#btnJoin').onclick = joinRoom;
$('#btnHangup').onclick = () => ws?.close();

async function onSignal(msg) {
  const from = msg.from ? peers.get(msg.from) : null;
  switch (msg.type) {
    case 'joined':
      joined = true;
      me.id = msg.id;
      room = { name: msg.room, capacity: msg.capacity, count: msg.peers.length + 1, host: msg.host, max: msg.max };
      $('#btnHangup').disabled = false;
      $('#btnJoin').disabled = false;
      menuOpen(false);
      logState(`joined "${msg.room}" as ${me.id}; people already here: ${msg.peers.length}`, 'evt');
      chatSystem(`You joined “${msg.room}”.`);
      for (const q of msg.peers) addPeer(q.id, q.name); // they will send us offers
      break;
    case 'room-info':
      room = { name: msg.room, capacity: msg.capacity, count: msg.count, host: msg.host, max: msg.max };
      break;
    case 'peer-joined': {
      const p = addPeer(msg.id, msg.name);
      plog(p, 'joined; we are the OFFERER', 'evt');
      chatSystem(`${p.name} joined.`);
      createPc(p, true);
      await makeOffer(p);
      break;
    }
    case 'offer': {
      const p = from || addPeer(msg.from, msg.from);
      if (!p.pc) createPc(p, false);
      await p.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await flushPending(p);
      attachLocalTracks(p, true); // transceivers created from an offer default to recvonly
      applyCodecPrefs(p);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      sigSend({ type: 'answer', to: p.id, sdp: p.pc.localDescription.sdp });
      refreshSdp();
      break;
    }
    case 'answer':
      if (!from?.pc) break;
      await from.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      await flushPending(from);
      refreshSdp();
      break;
    case 'candidate':
      if (!from || !msg.candidate) break; // null = end-of-candidates marker
      addCandidateRow(from, 'remote', msg.candidate.candidate);
      if (from.pc?.remoteDescription) await from.pc.addIceCandidate(msg.candidate).catch((e) => plog(from, 'addIceCandidate failed: ' + e, 'err'));
      else from.pending.push(msg.candidate);
      break;
    case 'peer-left': {
      const p = peers.get(msg.id);
      room.host = msg.host;
      if (p) { chatSystem(`${p.name} left.`); removePeer(p.id); }
      break;
    }
    case 'error':
      logState(`server: ${msg.message}`, 'err');
      toast(msg.message);
      if (msg.code === 'room-full' || msg.code === 'bad-room') ws.close();
      break;
  }
  renderAll();
}

async function flushPending(p) {
  for (const c of p.pending) await p.pc.addIceCandidate(c).catch((e) => plog(p, 'addIceCandidate failed: ' + e, 'err'));
  p.pending = [];
}

// ───────────── people (one entry per remote participant) ─────────────
function addPeer(id, name) {
  if (peers.has(id)) return peers.get(id);
  const p = {
    id, name: name || id, pc: null, isOfferer: false, dcs: {}, remoteStream: new MediaStream(), pending: [],
    cands: [], caps: null, live: newLive(), prev: new Map(), iceCheckingSince: null, pingTimer: null, pingRtt: null,
    incomingFile: null, vol: { cam: { v: 1, m: false }, screen: { v: 1, m: false } }, detail: null, screenStream: new MediaStream(),
  };
  p.tile = makeTile(p, 'cam');
  p.stile = makeTile(p, 'screen');
  peers.set(id, p);
  if (!detailId) detailId = id;
  refreshPeerSelect();
  layoutStage();
  return p;
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  closePc(p);
  p.tile.el.remove();
  p.stile.el.remove();
  peers.delete(id);
  if (zoomId === id || zoomId === id + ':screen') zoomId = null;
  if (detailId === id) detailId = peers.keys().next().value ?? null;
  refreshPeerSelect();
  layoutStage();
  renderAll();
}

function makeTile(p, kind = 'cam') {
  const screen = kind === 'screen';
  const video = h('video', { autoplay: true, playsInline: true });
  const ov = h('div', { class: 'overlay' });
  const cap = h('div', { class: 'cap' });
  const muteBtn = h('button', { title: 'Mute (only for you)', textContent: '🔊' });
  const slider = h('input', { type: 'range', min: 0, max: 100, value: 100, title: 'Volume (only for you)' });
  const vol = h('div', { class: 'vol' }, muteBtn, slider);
  const el = h('div', { class: 'tile remote' + (screen ? ' screen' : ''), title: 'Click to zoom in / out' }, video, ov, cap, vol);
  if (screen) { el.hidden = true; ov.hidden = true; }
  vol.onclick = (e) => e.stopPropagation(); // don't zoom when touching the volume controls
  const tile = { el, video, ov, cap, muteBtn, slider, kind };
  p[screen ? 'stile' : 'tile'] = tile; // so applyVolume can find it before makeTile returns
  slider.oninput = () => { p.vol[kind].v = slider.value / 100; p.vol[kind].m = false; applyVolume(p, kind); };
  muteBtn.onclick = () => { p.vol[kind].m = !p.vol[kind].m; applyVolume(p, kind); };
  el.onclick = () => toggleZoom(screen ? p.id + ':screen' : p.id);
  $('#stage').insertBefore(el, $('#tileLocal'));
  applyVolume(p, kind);
  return tile;
}

function applyVolume(p, kind = 'cam') {
  const t = kind === 'screen' ? p.stile : p.tile, v = p.vol[kind];
  t.video.volume = v.v;
  t.video.muted = v.m;
  t.slider.value = v.m ? 0 : Math.round(v.v * 100);
  t.muteBtn.textContent = v.m || v.v === 0 ? '🔇' : v.v < 0.4 ? '🔈' : '🔊';
  t.muteBtn.title = v.m ? 'Unmute' : 'Mute (only for you)';
}

function refreshPeerSelect() {
  const sel = $('#detailPeer');
  sel.replaceChildren(...(peers.size ? peerList().map((p) => h('option', { value: p.id, textContent: p.name })) : [h('option', { value: '', textContent: '(nobody yet)' })]));
  if (detailId) sel.value = detailId;
}
$('#detailPeer').onchange = () => { detailId = $('#detailPeer').value || null; renderDetails(); pollAll(); };

// ───────────── layout: grid or zoom ─────────────
function tilesInOrder() {
  const list = [];
  for (const p of peerList()) {
    list.push({ id: p.id, el: p.tile.el });
    const sharing = !!p.caps?.screen;
    p.stile.el.hidden = !sharing;
    if (sharing) list.push({ id: p.id + ':screen', el: p.stile.el });
  }
  if (!peers.size) list.push({ id: 'ghost', el: $('#tileGhost') });
  list.push({ id: 'local', el: $('#tileLocal') });
  $('#tileScreenLocal').hidden = !screenStream;
  if (screenStream) list.push({ id: 'local:screen', el: $('#tileScreenLocal') });
  return list;
}
function tileLabel(id) {
  if (id === 'local') return 'you';
  if (id === 'local:screen') return 'your screen';
  if (id.endsWith(':screen')) return `${peers.get(id.slice(0, -7))?.name ?? '?'}'s screen`;
  return peers.get(id)?.name ?? '?';
}
function layoutStage() {
  const stage = $('#stage');
  const list = tilesInOrder();
  $('#tileGhost').hidden = peers.size > 0;
  if (zoomId && !list.some((t) => t.id === zoomId && t.id !== 'ghost')) zoomId = null;
  const n = list.length;
  if (!zoomId) {
    stage.dataset.zoom = 'none';
    const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    stage.style.setProperty('--cols', cols);
    stage.style.setProperty('--rows', Math.ceil(n / cols));
    stage.style.setProperty('--n', n);
    stage.classList.remove('many');
    for (const t of list) { t.el.classList.remove('zoomed', 'thumb'); t.el.style.removeProperty('--i'); }
  } else {
    stage.dataset.zoom = 'on';
    let i = 0;
    for (const t of list) {
      if (t.id === zoomId) { t.el.classList.add('zoomed'); t.el.classList.remove('thumb'); t.el.style.removeProperty('--i'); }
      else { t.el.classList.add('thumb'); t.el.classList.remove('zoomed'); t.el.style.setProperty('--i', i++); }
    }
    stage.classList.toggle('many', i > 3);
  }
}
function toggleZoom(id) { zoomId = zoomId === id ? null : id; layoutStage(); renderCallUi(); }
$('#tileLocal').onclick = () => toggleZoom('local');
$('#tileScreenLocal').onclick = () => toggleZoom('local:screen');
$('#btnLayout').onclick = () => {
  const order = [null, ...tilesInOrder().map((t) => t.id).filter((id) => id !== 'ghost')];
  zoomId = order[(order.indexOf(zoomId) + 1) % order.length];
  layoutStage(); renderCallUi();
};

// ───────────── peer connections ─────────────
function createPc(p, offerer) {
  const cfg = readRtcConfig();
  plog(p, 'new RTCPeerConnection ' + JSON.stringify(cfg), 'evt');
  p.isOfferer = offerer;
  p.cands = []; p.caps = null; p.iceCheckingSince = null; p.pending = [];
  p.remoteStream = new MediaStream();
  p.screenStream = new MediaStream();
  p.tile.video.srcObject = null;
  p.stile.video.srcObject = null;
  const pc = new RTCPeerConnection(cfg);
  p.pc = pc;

  const evs = {
    signalingstatechange: 'signalingState', icegatheringstatechange: 'iceGatheringState',
    iceconnectionstatechange: 'iceConnectionState', connectionstatechange: 'connectionState',
  };
  for (const [ev, key] of Object.entries(evs)) {
    pc.addEventListener(ev, () => {
      const v = pc[key];
      plog(p, `${key} → ${v}`, v === 'failed' ? 'err' : 'evt');
      if (key === 'iceConnectionState') p.iceCheckingSince = v === 'checking' ? performance.now() : v === 'new' ? null : p.iceCheckingSince;
      if (key === 'signalingState' && v === 'stable') applySenderParams(p);
      if (key === 'iceGatheringState') refreshSdp();
      renderBadges();
      renderAll();
    });
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      addCandidateRow(p, 'local', e.candidate.candidate);
      sigSend({ type: 'candidate', to: p.id, candidate: e.candidate.toJSON() });
    } else {
      plog(p, 'ICE gathering finished (end-of-candidates)', 'evt');
      sigSend({ type: 'candidate', to: p.id, candidate: null });
    }
    refreshSdp();
  };
  pc.onicecandidateerror = (e) => plog(p, `ICE candidate ERROR ${e.errorCode} ${e.errorText} (url: ${e.url}, address: ${e.address}:${e.port})`, 'err');
  pc.ontrack = (e) => {
    const idx = pc.getTransceivers().indexOf(e.transceiver);
    const role = ROLES[idx] || (e.track.kind === 'video' ? 'cam' : 'mic');
    const screen = role === 'screen' || role === 'screenAudio';
    const stream = screen ? p.screenStream : p.remoteStream, tile = screen ? p.stile : p.tile;
    plog(p, `remote track: ${role} (${e.track.kind}, mid ${e.transceiver.mid})`, 'evt');
    stream.addTrack(e.track);
    // set lazily: an empty stream on a <video> keeps the browser tab "loading"
    if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.video.play().catch(() => {});
  };
  pc.ondatachannel = (e) => setupChannel(p, e.channel);

  if (offerer) {
    for (const kind of ['audio', 'video', 'video', 'audio']) pc.addTransceiver(kind, { direction: 'sendrecv' }); // = ROLES
    setupChannel(p, pc.createDataChannel('chat'));
    setupChannel(p, pc.createDataChannel('ping', { ordered: false, maxRetransmits: 0 }));
    attachLocalTracks(p, false);
  }
  renderBadges();
}

async function makeOffer(p, opts) {
  applyCodecPrefs(p);
  await p.pc.setLocalDescription(await p.pc.createOffer(opts));
  sigSend({ type: 'offer', to: p.id, sdp: p.pc.localDescription.sdp });
  refreshSdp();
}

async function attachLocalTracks(p, forceDirection) {
  if (!p.pc) return;
  const jobs = [];
  p.pc.getTransceivers().forEach((t, i) => {
    const track = localTrackForRole(ROLES[i]);
    if (forceDirection && t.direction !== 'sendrecv') t.direction = 'sendrecv';
    jobs.push(t.sender.replaceTrack(track).catch((e) => plog(p, 'replaceTrack: ' + e, 'err')));
  });
  await Promise.all(jobs);
  applySenderParams(p);
}

function closePc(p) {
  if (p.pc) { p.pc.close(); p.pc = null; }
  for (const k of Object.keys(p.dcs)) delete p.dcs[k];
  clearInterval(p.pingTimer);
  p.pending = []; p.caps = null; p.prev.clear(); p.live = newLive(); p.detail = null;
  p.tile.video.srcObject = null;
  p.stile.video.srcObject = null;
  p.screenStream = new MediaStream();
}

function refreshSdp() {
  const pc = detailPeer()?.pc;
  $('#sdpLocal').textContent = pc?.localDescription?.sdp || '–';
  $('#sdpRemote').textContent = pc?.remoteDescription?.sdp || '–';
}

// ───────────── ICE candidates ─────────────
function parseCandidate(str) {
  const p = str.replace(/^a=/, '').replace(/^candidate:/, '').split(' ');
  const o = { foundation: p[0], component: p[1], protocol: p[2].toLowerCase(), priority: +p[3], address: p[4], port: +p[5], type: p[7] };
  for (let i = 8; i < p.length; i += 2) o[p[i]] = p[i + 1];
  return o;
}
function addCandidateRow(p, dir, str) {
  p.cands.push({ dir, t: secs(), c: parseCandidate(str), str });
  if (p.id === detailId) renderCandTable();
}
function renderCandTable() {
  const p = detailPeer();
  const tb = $('#candTable tbody');
  tb.replaceChildren();
  const counts = {};
  for (const { dir, t, c, str } of p?.cands ?? []) {
    const typePref = c.priority >>> 24, localPref = (c.priority >>> 8) & 0xffff;
    const notes = [];
    if (c.address.endsWith('.local')) notes.push('mDNS-obfuscated host IP');
    if (c.address.includes(':')) notes.push('IPv6');
    if (c.tcptype) notes.push('tcp ' + c.tcptype);
    if (c.type === 'relay') notes.push('via TURN');
    if (c.type === 'srflx') notes.push('NAT-mapped');
    tb.append(h('tr', { class: 't-' + c.type, title: str },
      h('td', { textContent: t }), h('td', { textContent: dir === 'local' ? '⬆ local' : '⬇ remote' }),
      h('td', { textContent: c.type }), h('td', { textContent: c.protocol }),
      h('td', { textContent: c.address }), h('td', { textContent: c.port }),
      h('td', { textContent: c.raddr ? `${c.raddr}:${c.rport}` : '' }),
      h('td', { textContent: `${c.priority} (type ${typePref}, local ${localPref})` }),
      h('td', { textContent: c.foundation }), h('td', { textContent: notes.join(', ') })));
    const k = `${dir} ${c.type}`; counts[k] = (counts[k] || 0) + 1;
  }
  $('#candNote').textContent = Object.keys(counts).length ? '— ' + Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  ') : '';
}

// ───────────── data channels ─────────────
function setupChannel(p, dc) {
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 256 * 1024;
  p.dcs[dc.label] = dc;
  plog(p, `datachannel "${dc.label}" created (id ${dc.id}, ordered ${dc.ordered}, maxRetransmits ${dc.maxRetransmits})`, 'evt');
  dc.onopen = () => {
    plog(p, `datachannel "${dc.label}" open`, 'evt');
    if (dc.label === 'chat') { chatSystem(`${p.name} is connected.`); sendCaps(p); }
    if (dc.label === 'ping') {
      clearInterval(p.pingTimer);
      p.pingTimer = setInterval(() => dc.readyState === 'open' && dc.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 1000);
    }
    renderAll();
  };
  dc.onclose = () => { plog(p, `datachannel "${dc.label}" closed`, 'evt'); renderAll(); };
  dc.onerror = (e) => plog(p, `datachannel "${dc.label}" error: ${e.error?.message || e}`, 'err');
  dc.onmessage = (e) => onChannelMessage(p, dc, e.data);
}

function onChannelMessage(p, dc, data) {
  if (typeof data !== 'string') { // binary file chunk
    const f = p.incomingFile;
    if (f) {
      f.chunks.push(data); f.got += data.byteLength;
      $('#fileProg').hidden = false; $('#fileProg').max = f.size; $('#fileProg').value = f.got;
      $('#fileProgText').textContent = `Receiving ${f.name} from ${p.name}…`;
    }
    return;
  }
  const m = JSON.parse(data);
  switch (m.t) {
    case 'chat': {
      const body = h('div', { class: 'body' });
      body.innerHTML = richHtml(m.text);
      addMsg('peer', p.name, body);
      break;
    }
    case 'image-url': {
      // Never auto-load a link somebody sends us: loading it would tell that website our IP address.
      let u; try { u = new URL(m.url); } catch { break; }
      if (!/^https?:$/.test(u.protocol)) break;
      const btn = h('button', { textContent: 'Show image' });
      btn.onclick = () => {
        const img = h('img', { class: 'pic', src: u.href, referrerPolicy: 'no-referrer', title: 'Click to view bigger' });
        img.onclick = () => openLightbox(img);
        btn.replaceWith(img);
      };
      addMsg('peer', p.name, h('div', { class: 'body' }, h('div', { textContent: `🖼 ${p.name} shared an image from ${u.hostname}` }), btn, ' ',
        h('a', { href: u.href, target: '_blank', rel: 'noopener noreferrer', textContent: 'open link' })));
      break;
    }
    case 'ping': dc.send(JSON.stringify({ t: 'pong', ts: m.ts })); break;
    case 'pong': p.pingRtt = performance.now() - m.ts; break;
    case 'caps': {
      const before = p.caps?.flip, wasSharing = !!p.caps?.screen;
      p.caps = m;
      const a = before || { h: false, v: false }, b = m.flip || { h: false, v: false };
      if (a.h !== b.h || a.v !== b.v) {
        const how = b.h && b.v ? 'left↔right and upside down' : b.h ? 'left↔right' : b.v ? 'upside down' : 'back to normal';
        toast(b.h || b.v ? `${p.name} flipped their camera (${how})` : `${p.name} un-flipped their camera`, 'info');
      }
      if (m.screen && !wasSharing) { toast(`${p.name} is sharing their screen`, 'info'); chatSystem(`${p.name} started sharing their screen.`); zoomId = p.id + ':screen'; }
      if (!m.screen && wasSharing) { toast(`${p.name} stopped sharing their screen`, 'info'); chatSystem(`${p.name} stopped sharing their screen.`); if (zoomId === p.id + ':screen') zoomId = null; }
      renderCompat(); renderCallUi(); renderSummary();
      break;
    }
    case 'renegotiate': if (p.isOfferer) makeOffer(p); break;
    case 'file-start':
      p.incomingFile = { ...m, chunks: [], got: 0 };
      break;
    case 'file-end': {
      const f = p.incomingFile;
      if (!f) break;
      p.incomingFile = null;
      const blob = new Blob(f.chunks, { type: f.mime });
      const url = URL.createObjectURL(blob);
      const body = h('div', { class: 'body' }, h('a', { href: url, download: f.name, textContent: `📎 ${f.name} (${fmtBytes(blob.size)})` }));
      if (/^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(f.mime)) body.append(makeImg(url, f.name));
      addMsg('peer', p.name, body);
      $('#fileProg').hidden = true; $('#fileProgText').textContent = '';
      break;
    }
  }
}

// ───────────── image viewer (instead of opening a new window) ─────────────
const lb = $('#imgDlg');
let lbList = [], lbIdx = 0;
function showLightbox() {
  const img = lbList[lbIdx];
  if (!img) { lb.close(); return; }
  const src = img.currentSrc || img.src, isBlob = src.startsWith('blob:');
  $('#lbImg').referrerPolicy = 'no-referrer';
  $('#lbImg').src = src;
  $('#lbBody').classList.remove('actual');
  $('#lbBody').scrollTo(0, 0);
  $('#lbTitle').textContent = img.dataset.name || (isBlob ? 'image' : decodeURIComponent(new URL(src).pathname.split('/').pop() || hostOf(src)));
  $('#lbCount').textContent = lbList.length > 1 ? `${lbIdx + 1} / ${lbList.length}` : '';
  const dl = $('#lbDownload'), op = $('#lbOpen');
  dl.hidden = !isBlob; if (isBlob) { dl.href = src; dl.download = img.dataset.name || 'image'; }
  op.hidden = isBlob; if (!isBlob) op.href = src;
  $('#lbPrev').hidden = lbIdx === 0; $('#lbNext').hidden = lbIdx === lbList.length - 1;
}
function openLightbox(img) {
  lbList = [...document.querySelectorAll('#chatlog img.pic')];
  lbIdx = Math.max(0, lbList.indexOf(img));
  showLightbox();
  if (!lb.open) lb.showModal();
}
const lbStep = (d) => { const n = lbIdx + d; if (n >= 0 && n < lbList.length) { lbIdx = n; showLightbox(); } };
$('#lbPrev').onclick = () => lbStep(-1);
$('#lbNext').onclick = () => lbStep(1);
$('#lbClose').onclick = () => lb.close();
$('#lbImg').onclick = () => $('#lbBody').classList.toggle('actual'); // fit ↔ actual size
lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
lb.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') lbStep(-1); else if (e.key === 'ArrowRight') lbStep(1); });
lb.addEventListener('close', () => { $('#lbImg').removeAttribute('src'); });

// ───────────── chat: rich text ─────────────
// Supported: **bold**  *italic*  _italic_  ~~strike~~  `code`  ```code block```  links  line breaks.
// Everything is HTML-escaped FIRST, then the formatting is added, so messages can't inject markup.
function richHtml(src) {
  const stash = [];
  const keep = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  let s = esc(String(src).replace(/\u0000/g, ''));
  s = s.replace(/```([\s\S]*?)```/g, (m, c) => keep(`<pre class="code">${c.replace(/^\n/, '')}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (m, c) => keep(`<code>${c}</code>`));
  s = s.replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)\]]/g, (u) => keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[i]);
}

function addMsg(kind, who, bodyNode) {
  const box = $('#chatlog');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const el = h('div', { class: 'msg ' + kind });
  if (kind !== 'system') el.append(h('div', { class: 'who', textContent: `${kind === 'me' ? 'You' : who} · ${time}` }));
  el.append(bodyNode);
  box.append(el);
  box.scrollTop = box.scrollHeight;
  if (kind === 'peer' && $('#chatPanel').hidden) { unread++; renderCallUi(); }
}
const chatSystem = (text) => addMsg('system', '', h('div', { class: 'body', textContent: text }));
function makeImg(url, name = '') {
  const img = h('img', { class: 'pic', src: url, title: 'Click to view bigger' });
  img.dataset.name = name;
  img.onclick = () => openLightbox(img);
  img.onload = () => ($('#chatlog').scrollTop = $('#chatlog').scrollHeight);
  return img;
}

function notConnectedMsg() {
  if (!peers.size) chatSystem(joined ? 'Not sent: nobody else is in the room yet.' : 'Not sent: you are not in a room. Open the Room menu to join one.');
  else chatSystem(`Not sent: no data channel is open yet. ${hintText() || ''}`);
}

function sendChat() {
  const text = $('#chatInput').value.replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (!text.trim()) return;
  const targets = openChatPeers();
  if (!targets.length) return notConnectedMsg();
  const payload = JSON.stringify({ t: 'chat', text });
  targets.forEach((p) => p.dcs.chat.send(payload));
  const body = h('div', { class: 'body' });
  body.innerHTML = richHtml(text);
  addMsg('me', me.name, body);
  $('#chatInput').value = '';
  autosize();
}
$('#btnSend').onclick = sendChat;

// composer: Enter = new line, Ctrl/Cmd+Enter = send
const ta = $('#chatInput');
function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 96), 240) + 'px'; }
ta.addEventListener('input', autosize);
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSel('**'); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSel('*'); }
});
function wrapSel(a, b = a) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e) || 'text';
  ta.setRangeText(a + sel + b, s, e, 'end');
  ta.setSelectionRange(s + a.length, s + a.length + sel.length);
  ta.focus(); autosize();
}
for (const [id, a] of [['#fmtB', '**'], ['#fmtI', '*'], ['#fmtC', '`']]) {
  $(id).onmousedown = (e) => e.preventDefault(); // keep the text selection
  $(id).onclick = () => wrapSel(a);
}

// ───────────── sending files: drag & drop anywhere, paste, or the 📎 button ─────────────
const sendDlg = $('#sendDlg');
let pending = null, pendingUrls = [];  // pending = { files } or { url }
const isImage = (f) => /^image\//.test(f.type);
const fileIcon = (f) => (/^audio\//.test(f.type) ? '🎵' : /^video\//.test(f.type) ? '🎬' : /zip|compressed|tar/.test(f.type) ? '🗜️' : /pdf/.test(f.type) ? '📕' : '📄');
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };

function sendTargetsOrToast() {
  const targets = openChatPeers();
  if (!targets.length) toast(peers.size ? 'Nobody is fully connected yet, so there is nobody to send this to.' : 'Nobody else is in the room to send this to.');
  return targets;
}
function resetSendDialog() { pendingUrls.forEach((u) => URL.revokeObjectURL(u)); pendingUrls = []; $('#sendList').replaceChildren(); }

function askSend(files) {
  files = files.filter(Boolean);
  if (!files.length) return;
  const targets = sendTargetsOrToast();
  if (!targets.length) return;
  resetSendDialog();
  pending = { files };
  const list = $('#sendList');
  for (const f of files) {
    let thumb;
    if (isImage(f)) { const u = URL.createObjectURL(f); pendingUrls.push(u); thumb = h('img', { src: u }); }
    else thumb = h('div', { class: 'ficon', textContent: fileIcon(f) });
    list.append(h('div', { class: 'fileitem' }, thumb, h('div', { class: 'meta' }, h('b', { textContent: f.name || 'pasted image' }), h('span', { class: 'note', textContent: `${f.type || 'unknown type'} · ${fmtBytes(f.size)}` }))));
  }
  $('#sendTitle').textContent = files.length === 1 ? 'Are you sure you want to send this file?' : `Are you sure you want to send these ${files.length} files?`;
  $('#sendTo').textContent = `It will be sent to ${targets.map((p) => p.name).join(', ')}.`;
  const total = files.reduce((a, f) => a + f.size, 0);
  $('#sendWarn').textContent = total > 25 * 1048576 ? `That is ${fmtBytes(total)}. It is sent to each person separately, so it may take a while.` : '';
  if (!sendDlg.open) sendDlg.showModal();
}

// An image that the browser may show but not copy (the website doesn't allow it): we can only send the link.
function askSendUrl(url) {
  const targets = sendTargetsOrToast();
  if (!targets.length) return;
  resetSendDialog();
  pending = { url };
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
  $('#sendList').append(h('div', { class: 'fileitem' }, h('img', { src: url, referrerPolicy: 'no-referrer' }),
    h('div', { class: 'meta' }, h('b', { textContent: name }), h('span', { class: 'note', textContent: `image link · from ${u.hostname}` }))));
  $('#sendTitle').textContent = 'Are you sure you want to send this image?';
  $('#sendTo').textContent = `It will be sent to ${targets.map((p) => p.name).join(', ')}.`;
  $('#sendWarn').textContent = `${u.hostname} does not let your browser copy the image, so it is sent as a link. Each person can choose to show it, and then their browser loads it from ${u.hostname}.`;
  if (!sendDlg.open) sendDlg.showModal();
}
sendDlg.addEventListener('close', () => { resetSendDialog(); pending = null; });
$('#sendCancel').onclick = () => sendDlg.close();
$('#sendOk').onclick = () => { const p = pending; sendDlg.close(); if (p?.files) sendFiles(p.files); else if (p?.url) sendImageUrl(p.url); };

$('#btnAttach').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { askSend([...e.target.files]); e.target.value = ''; };
ta.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); askSend(files); }
});

// ── dropping onto the page ──
// Files: accepted anywhere on the page. Text and links: refused everywhere, except in the text boxes
// (where the browser inserts them as usual; the message box additionally turns image links into images).
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const isTextField = (el) => !!el?.closest?.('textarea, input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button])');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; $('#dropZone').hidden = false; } });
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  else if (!isTextField(e.target)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } // shows the "not allowed" cursor
});
window.addEventListener('dragleave', (e) => { if (hasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropZone').hidden = true; } });
window.addEventListener('drop', (e) => {
  if (hasFiles(e)) { e.preventDefault(); dragDepth = 0; $('#dropZone').hidden = true; askSend([...e.dataTransfer.files]); }
  else if (!isTextField(e.target)) e.preventDefault(); // otherwise the browser would navigate to a dropped link
});

// ── dropping a link onto the message box: if it points to an image, send the image ──
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;
function urlFromDrop(dt) {
  const fromList = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  const cand = (fromList || dt.getData('text/plain') || '').trim();
  return /^https?:\/\/\S+$/i.test(cand) && cand.length <= 2000 ? cand : null;
}
async function fetchImageFile(url) { // works when the website allows cross-site reads (CORS) or is our own origin
  try {
    const r = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' });
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!blob.type.startsWith('image/')) return { notImage: true };
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
    return new File([blob], /\.\w{2,5}$/.test(last) ? last : `${last}.${blob.type.split('/')[1].replace('svg+xml', 'svg')}`, { type: blob.type });
  } catch { return null; }
}
const probeImage = (url) => new Promise((resolve) => { // can the browser at least DISPLAY it? (no CORS needed for that)
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  const t = setTimeout(() => { img.src = ''; resolve(false); }, 5000);
  img.onload = () => { clearTimeout(t); resolve(true); };
  img.onerror = () => { clearTimeout(t); resolve(false); };
  img.src = url;
});
async function tryImageUrl(url) { // → true if it was an image and the "send this?" dialog is showing
  const f = await fetchImageFile(url);
  if (f?.notImage) return false;
  if (f) { askSend([f]); return true; }
  if (await probeImage(url)) { askSendUrl(url); return true; }
  return false;
}
function insertAtCaret(text) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus(); autosize(); }
ta.addEventListener('drop', (e) => {
  if (hasFiles(e)) return; // files are handled by the page-wide handler above
  const url = urlFromDrop(e.dataTransfer);
  if (!url) return;        // ordinary text: the browser inserts it
  if (IMG_EXT.test(url)) { // obviously an image: don't even insert the text
    e.preventDefault();
    tryImageUrl(url).then((ok) => { if (!ok) insertAtCaret(url); });
    return;
  }
  // unknown: let the browser insert it as text, then check; if it turns out to be an image, take the text back out again
  const before = ta.value;
  setTimeout(() => {
    const after = ta.value;
    tryImageUrl(url).then((ok) => { if (ok && ta.value === after) { ta.value = before; autosize(); } });
  }, 0);
});

function sendFiles(files) {
  // one at a time, so chunks from different files never interleave on a channel
  sendQueue = sendQueue.then(async () => { for (const f of files) await sendOneFile(f); })
    .catch((e) => toast('Sending failed: ' + e.message));
}
async function sendOneFile(file) {
  const targets = openChatPeers();
  if (!targets.length) return toast(`Could not send ${file.name}: nobody is connected any more.`);
  const url = URL.createObjectURL(file);
  const body = h('div', { class: 'body' }, h('div', { textContent: `📎 ${file.name || 'image'} (${fmtBytes(file.size)})` }));
  if (isImage(file)) body.append(makeImg(url, file.name || 'image.png'));
  addMsg('me', me.name, body);
  const start = performance.now();
  for (const p of targets) await sendFileTo(p, file);
  const s = (performance.now() - start) / 1000;
  chatSystem(`Sent ${file.name || 'image'} to ${targets.map((p) => p.name).join(', ')} in ${s.toFixed(1)}s.`);
  $('#fileProg').hidden = true; $('#fileProgText').textContent = '';
}
async function sendFileTo(p, file) {
  const dc = p.dcs.chat;
  if (dc?.readyState !== 'open') return;
  const CH = 16 * 1024;
  dc.send(JSON.stringify({ t: 'file-start', name: file.name || 'image.png', size: file.size, mime: file.type }));
  $('#fileProg').hidden = false; $('#fileProg').max = file.size;
  for (let off = 0; off < file.size; off += CH) {
    if (dc.readyState !== 'open') return;
    if (dc.bufferedAmount > 1024 * 1024) await new Promise((r) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); }; });
    dc.send(await file.slice(off, off + CH).arrayBuffer());
    $('#fileProg').value = off;
    $('#fileProgText').textContent = `Sending ${file.name} to ${p.name}…`;
  }
  dc.send(JSON.stringify({ t: 'file-end' }));
}

function sendImageUrl(url) {
  const targets = sendTargetsOrToast();
  if (!targets.length) return;
  const payload = JSON.stringify({ t: 'image-url', url });
  targets.forEach((p) => p.dcs.chat.send(payload));
  const img = h('img', { class: 'pic', src: url, referrerPolicy: 'no-referrer', title: 'Click to view bigger' });
  img.onclick = () => openLightbox(img);
  addMsg('me', me.name, h('div', { class: 'body' }, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: `🖼 image from ${hostOf(url)}` }), img));
}

// ───────────── media: mic and camera are two separate switches ─────────────
const camOn = () => localStream.getVideoTracks().length > 0;
const micOn = () => localStream.getAudioTracks().length > 0;
const hasLocalMedia = () => localStream.getTracks().length > 0;

function stopKind(kind) {
  for (const t of kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks()) { t.stop(); localStream.removeTrack(t); }
}
async function enableKind(kind) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const m = 'Camera/mic are unavailable: this page must be opened over HTTPS (or on localhost).';
    logState(m, 'err'); toast(m);
    return false;
  }
  const c = mediaConstraints();
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: c.audio } : { video: c.video });
  } catch (e) {
    logState(`getUserMedia(${kind}) failed: ${e}`, 'err');
    toast(`Could not start the ${kind === 'audio' ? 'microphone' : 'camera'}: ${e.message || e.name}`);
    renderCallUi();
    return false;
  }
  stopKind(kind);
  const t = s.getTracks()[0];
  t.onended = () => { // device unplugged / permission revoked
    if (localStream.getTracks().includes(t)) { localStream.removeTrack(t); logState(`${kind} track ended by the device or browser`, 'err'); onMediaChanged(); }
  };
  localStream.addTrack(t);
  if (kind === 'video') applyContentHint();
  logState(`${kind} started: ${t.label}`, 'evt');
  await populateDevices();
  await onMediaChanged();
  return true;
}
async function disableKind(kind) { stopKind(kind); logState(`${kind} stopped`, 'evt'); await onMediaChanged(); }
async function onMediaChanged() {
  $('#localVideo').srcObject = hasLocalMedia() ? localStream : null; // only when it has tracks, see ontrack
  await Promise.all(peerList().map((p) => attachLocalTracks(p, false)));
  updateMediaInfo();
  sendCaps();      // lets everybody know whether our camera/mic are on
  renderAll();
}
$('#btnMic').onclick = () => { micOn() ? disableKind('audio') : enableKind('audio'); };
$('#btnCam').onclick = () => { camOn() ? disableKind('video') : enableKind('video'); };

async function populateDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (id, kind, def) => {
      const sel = $(id), cur = sel.value;
      sel.replaceChildren(h('option', { value: '', textContent: def }));
      devs.filter((d) => d.kind === kind).forEach((d, i) => sel.append(h('option', { value: d.deviceId, textContent: d.label || `${kind} ${i + 1}` })));
      if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    };
    fill('#setCam', 'videoinput', 'Default camera');
    fill('#setMic', 'audioinput', 'Default microphone');
  } catch {}
}
function updateMediaInfo() {
  const v = localStream.getVideoTracks()[0]?.getSettings(), a = localStream.getAudioTracks()[0]?.getSettings();
  const onoff = (x) => (x ? 'on' : 'off');
  $('#mediaInfo').textContent =
    (v ? `Camera is delivering ${v.width}×${v.height} @ ${Math.round(v.frameRate || 0)} fps.` : 'Camera is off.') + ' ' +
    (a ? `Mic: echo-cancel ${onoff(a.echoCancellation)}, noise reduction ${onoff(a.noiseSuppression)}, auto volume ${onoff(a.autoGainControl)}.` : 'Mic is off.') +
    (() => { const sc = screenScale(); return sc ? ` Screen share: captured at ${sc.w}×${sc.h}, sent at ${sc.sw}×${sc.sh}.` : ''; })();
}

// ───────────── sharing your screen ─────────────
async function startShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Screen sharing is not available here. It needs HTTPS (or localhost) and a desktop browser; phones usually cannot do it.');
  const s = S();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: s.sFps } }, audio: s.sAudio });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Could not start screen sharing: ' + (e.message || e.name));
    else logState('screen sharing cancelled', 'evt');
    return;
  }
  screenStream = stream;
  const v = stream.getVideoTracks()[0];
  if ('contentHint' in v) v.contentHint = 'detail'; // text and slides, not motion
  v.onended = () => stopShare();                   // the browser's own "Stop sharing" bar
  $('#screenVideo').srcObject = stream;
  logState(`screen sharing started: ${v.label} ${JSON.stringify({ w: v.getSettings().width, h: v.getSettings().height })}${stream.getAudioTracks().length ? ' (with sound)' : ''}`, 'evt');
  await Promise.all(peerList().map((p) => attachLocalTracks(p, false)));
  sendCaps();
  renderAll();
}
async function stopShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  screenStream = null;
  $('#screenVideo').srcObject = null;
  logState('screen sharing stopped', 'evt');
  await Promise.all(peerList().map((p) => attachLocalTracks(p, false)));
  sendCaps();
  renderAll();
}
$('#btnShare').onclick = () => (screenStream ? stopShare() : startShare());

// ───────────── flipping your camera ─────────────
// Two independent switches:
//  • Flip for everyone: we still send the normal picture; the flip is a flag in our "caps" message and
//    every viewer applies it when drawing our tile (and is told about it).
//  • Flip only for me: changes how *I* see my own preview. Nothing is sent, nobody is told.
// Your own preview is a selfie-style mirror of what the others see; the local flip toggles that view.
function setFlip(hh, v) {
  me.flip = { h: !!hh, v: !!v };
  $('#setFlipH').checked = me.flip.h; $('#setFlipV').checked = me.flip.v;
  sendCaps();
  renderCallUi();
}
function setLocalFlip(hh, v) {
  me.localFlip = { h: !!hh, v: !!v };
  $('#setLocalFlipH').checked = me.localFlip.h; $('#setLocalFlipV').checked = me.localFlip.v;
  store.set('rtc-localflip', JSON.stringify(me.localFlip));
  renderCallUi();
}
$('#btnFlip').onclick = () => setFlip(!me.flip.h, me.flip.v);
$('#btnFlipMenu').onclick = (e) => { e.stopPropagation(); $('#flipPop').hidden = !$('#flipPop').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.flipwrap')) $('#flipPop').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#flipPop').hidden = true; });
$('#btnFlipLocal').onclick = () => setLocalFlip(!me.localFlip.h, me.localFlip.v);

// ───────────── capability exchange ─────────────
function buildCaps(p) {
  const c = {
    t: 'caps', ua: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform, cores: navigator.hardwareConcurrency,
    screen: `${screen.width}×${screen.height}`, lang: navigator.language, codecs: localCodecs(), sctpMax: p?.pc?.sctp?.maxMessageSize, dev: {}, flip: me.flip, screen: !!screenStream,
  };
  const vt = localStream.getVideoTracks()[0];
  if (vt) { const cap = vt.getCapabilities?.() || {}; c.dev.cam = { label: vt.label, settings: vt.getSettings(), maxW: cap.width?.max, maxH: cap.height?.max, maxFps: cap.frameRate?.max }; }
  const at = localStream.getAudioTracks()[0];
  if (at) c.dev.mic = { label: at.label, settings: at.getSettings() };
  return c;
}
function sendCaps(only) {
  for (const p of only ? [only] : peerList()) if (p.dcs.chat?.readyState === 'open') p.dcs.chat.send(JSON.stringify(buildCaps(p)));
}

function browserName(ua) {
  const m = (re) => ua.match(re)?.[1];
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  const b = m(/Edg\/(\d+)/) ? `Edge ${m(/Edg\/(\d+)/)}` : m(/Firefox\/(\d+)/) ? `Firefox ${m(/Firefox\/(\d+)/)}` : m(/Chrome\/(\d+)/) ? `Chrome ${m(/Chrome\/(\d+)/)}` : m(/Version\/(\d+).*Safari/) ? `Safari ${m(/Version\/(\d+).*Safari/)}` : 'unknown browser';
  return `${b} on ${os}`;
}

// ───────────── Details tab: what each side supports ─────────────
function renderCompat() {
  const p = detailPeer();
  const note = $('#compatNote'), peerBox = $('#compatPeer');
  peerBox.replaceChildren();
  if (!p || !p.pc || !p.caps) {
    note.textContent = p?.pc ? `Waiting for ${p.name} to tell us what they support (this travels over the data channel, so it needs to be open)…` : 'Connect with someone to compare what you both support.';
    $('#compatVideo').replaceChildren(); $('#compatAudio').replaceChildren();
    return;
  }
  note.textContent = `You and ${p.name} told each other what you support. A codec is only usable when one side can send it and the other can receive it.`;
  const mine = buildCaps(p), pr = p.caps;
  const kv = h('div', { class: 'kv' });
  const add = (k, v) => kv.append(h('span', { textContent: k }), h('span', { textContent: v }));
  const camStr = (d) => d?.cam ? `${d.cam.label || 'camera'}: now ${d.cam.settings.width}×${d.cam.settings.height} @ ${Math.round(d.cam.settings.frameRate || 0)} fps${d.cam.maxW ? `, up to ${d.cam.maxW}×${d.cam.maxH}${d.cam.maxFps ? ' @ ' + Math.round(d.cam.maxFps) + ' fps' : ''}` : ''}` : 'off / none';
  const micStr = (d) => d?.mic ? `${d.mic.label || 'microphone'}: echo-cancel ${d.mic.settings.echoCancellation ? 'on' : 'off'}, noise reduction ${d.mic.settings.noiseSuppression ? 'on' : 'off'}` : 'off / none';
  const flipStr = (f) => (f?.h || f?.v ? [f.h && 'left↔right', f.v && 'upside down'].filter(Boolean).join(' + ') : 'no');
  add(p.name, browserName(pr.ua) + (pr.cores ? `, ${pr.cores} CPU threads` : '') + `, screen ${pr.screen}`);
  add('  camera', camStr(pr.dev));
  add('  microphone', micStr(pr.dev));
  add('  camera flipped', flipStr(pr.flip));
  add('  max data message', pr.sctpMax ? fmtBytes(pr.sctpMax) : 'unknown');
  add('You', browserName(mine.ua) + (mine.cores ? `, ${mine.cores} CPU threads` : '') + `, screen ${mine.screen}`);
  add('  camera', camStr(mine.dev));
  add('  camera flipped', flipStr(mine.flip));
  peerBox.append(kv);

  for (const [kind, id] of [['video', '#compatVideo'], ['audio', '#compatAudio']]) {
    const A = { s: groupCodecs(mine.codecs[kind].send), r: groupCodecs(mine.codecs[kind].recv) };
    const B = { s: groupCodecs(pr.codecs[kind].send), r: groupCodecs(pr.codecs[kind].recv) };
    const names = new Set([...A.s.keys(), ...A.r.keys(), ...B.s.keys(), ...B.r.keys()]);
    const cap = (X, key) => `${X.s.has(key) ? '↑' : '·'}${X.r.has(key) ? '↓' : '·'}`;
    const tbl = $(id);
    tbl.replaceChildren(h('tr', {}, ...['Codec', 'What it is', 'You (↑send ↓receive)', p.name, 'Usable?', 'In use right now'].map((x) => h('th', { textContent: x }))));
    const rows = [...names].map((key) => {
      const out = A.s.has(key) && B.r.has(key), inn = B.s.has(key) && A.r.has(key);
      const label = (A.s.get(key) || A.r.get(key) || B.s.get(key) || B.r.get(key)).label;
      const variants = Math.max(A.s.get(key)?.n || 0, B.r.get(key)?.n || 0);
      return { key, label, out, inn, variants };
    }).sort((x, y) => (y.out + y.inn) - (x.out + x.inn) || x.label.localeCompare(y.label));
    for (const r of rows) {
      const usable = r.out && r.inn ? ['✅ both directions', 'yes'] : r.out ? ['➡ you → them only', 'warn'] : r.inn ? ['⬅ them → you only', 'warn'] : ['✖ not usable', 'no'];
      const inUse = h('td');
      if (p.live.used.out[kind] === r.key) inUse.append(h('span', { class: 'pill use', textContent: '↑ you send' }), ' ');
      if (p.live.used.in[kind] === r.key) inUse.append(h('span', { class: 'pill use', textContent: '↓ you receive' }));
      tbl.append(h('tr', {},
        h('td', { textContent: r.label + (r.variants > 1 ? ` (${r.variants} variants)` : ''), style: 'font-weight:600' }),
        h('td', { textContent: CODEC_INFO[r.key] || '', className: 'note' }),
        h('td', { textContent: cap(A, r.key), style: 'font-family:monospace' }),
        h('td', { textContent: cap(B, r.key), style: 'font-family:monospace' }),
        h('td', { textContent: usable[0], className: usable[1] }), inUse));
    }
  }
}

// ───────────── plain-English status ─────────────
function diagnose(p) {
  if (!p.pc) return 'Waiting for them to start the connection…';
  const st = p.pc.iceConnectionState;
  const checking = p.iceCheckingSince && performance.now() - p.iceCheckingSince > 6000;
  if (st === 'failed' || (st === 'checking' && checking)) {
    const why = [];
    const loc = p.cands.filter((x) => x.dir === 'local').map((x) => x.c), rem = p.cands.filter((x) => x.dir === 'remote').map((x) => x.c);
    if (!rem.length) why.push('No ICE candidates arrived from the other side (they may have a signaling problem).');
    if (p.cands.some((x) => x.c.address.endsWith('.local'))) why.push('Some addresses are hidden behind mDNS (.local names). Devices on different machines often cannot resolve these. Allow camera/mic first (needs HTTPS) so real IPs are used, or use TURN.');
    if (!loc.some((c) => c.type === 'srflx' || c.type === 'relay')) why.push('No public address was found (no srflx/relay candidate): STUN is unreachable. Is UDP port 3478 open on the server?');
    if (!loc.some((c) => c.type === 'relay')) why.push('There is no TURN relay, so strict NATs/firewalls between you two cannot be crossed.');
    return (st === 'failed' ? 'Connection FAILED. ' : 'Still trying to connect… ') + why.join(' ');
  }
  if (st === 'new' || st === 'checking') return 'Connecting… (exchanging candidates and testing paths)';
  if (!navigator.mediaDevices) return 'Connected. Camera/mic are disabled because this page is not on HTTPS (or localhost).';
  return 'All good.';
}
// The first problem worth showing, naming who it is about.
function hintText() {
  for (const p of peerList()) { const d = diagnose(p); if (d !== 'All good.') return peers.size > 1 ? `${p.name}: ${d}` : d; }
  return '';
}
function peerStatus(p) {
  if (!p.pc) return { text: 'waiting…', cls: 'warn' };
  switch (p.pc.connectionState) {
    case 'connected': return { text: 'Connected ✅', cls: 'ok' };
    case 'failed': return { text: 'Failed ❌', cls: 'bad' };
    case 'disconnected': return { text: 'Disconnected', cls: 'warn' };
    case 'closed': return { text: 'Closed', cls: '' };
    default: return { text: 'Connecting…', cls: 'warn' };
  }
}
function peerLine(p, dir) {
  const parts = [];
  for (const kind of ['video', 'audio']) {
    const c = p.live.used[dir][kind]; if (!c) continue;
    const dm = p.live.dim[dir].video;
    parts.push(`${kind === 'video' ? 'Video' : 'Audio'} ${c.toUpperCase()}${kind === 'video' && dm?.w ? ` ${dm.w}×${dm.h}${dm.fps ? '@' + Math.round(dm.fps) : ''}` : ''} ${fmtBps(p.live.bps[dir][kind])}`);
  }
  const sv = p.live.scr[dir].video;
  if (sv && sv.bps > 1000) parts.push(`Screen ${sv.codec.toUpperCase()}${sv.w ? ` ${sv.w}×${sv.h}${sv.fps ? '@' + Math.round(sv.fps) : ''}` : ''} ${fmtBps(sv.bps)}`);
  return parts.join(' · ') || '–';
}
const pathText = (p) => {
  if (!p.live.pair) return '–';
  const t = [p.live.local?.candidateType, p.live.remote?.candidateType];
  return t.includes('relay') ? 'relayed (TURN)' : t.includes('srflx') || t.includes('prflx') ? 'direct (NAT)' : 'direct (same network)';
};

// Is this person's media (video, audio, chat, files) going straight to them, or through a TURN relay server?
// It is relayed if either end ended up using a "relay" candidate. Our own server only does signaling and never carries media.
const isRelayed = (p) => [p.live.local?.candidateType, p.live.remote?.candidateType].includes('relay');
function renderPathBadge() {
  const b = $('#pathBadge');
  const conn = peerList().filter((p) => p.pc?.connectionState === 'connected' && p.live.pair);
  const note = 'Our signaling server only helps people find each other; it never carries video, audio, chat or files. Everything is encrypted end to end between browsers (DTLS-SRTP), even when a TURN relay forwards it.';
  if (!conn.length) {
    b.className = 'pathbadge';
    b.textContent = peers.size ? 'Media: connecting…' : 'Media: no connection yet';
    b.title = 'Once connected, this tells you whether media goes directly between browsers or through a relay server.\n\n' + note;
    return;
  }
  const rel = conn.filter(isRelayed).length;
  b.className = 'pathbadge ' + (rel === 0 ? 'direct' : rel === conn.length ? 'relay' : 'mixed');
  b.textContent = rel === 0 ? '🔒 Media: direct (peer-to-peer, no server in between)'
    : rel === conn.length ? '↪ Media: relayed through a TURN server'
    : `Media: ${conn.length - rel} direct · ${rel} relayed`;
  b.title = conn.map((p) => {
    const l = p.live.local, r = p.live.remote;
    const how = isRelayed(p) ? `RELAYED through a TURN server${(l?.relayProtocol || r?.relayProtocol) ? ' (over ' + (l?.relayProtocol || r?.relayProtocol) + ')' : ''}` : pathText(p).replace('direct', 'DIRECT');
    return `${p.name}: ${how}  [you: ${l?.candidateType ?? '?'}, them: ${r?.candidateType ?? '?'}]`;
  }).join('\n') + '\n\n' + note;
}
$('#pathBadge').onclick = () => showTab('details');

function renderSummary() {
  const box = $('#summary');
  box.replaceChildren();
  const row = (k, v, cls = '') => box.append(h('span', { textContent: k }), h('span', { textContent: v, className: cls }));
  const wsOpen = ws && ws.readyState === 1;
  if (!wsOpen) row('Status', 'Not in a room', '');
  else if (!joined) row('Status', 'Joining…', 'warn');
  else {
    row('Room', `“${room.name}” · ${room.capacity === 2 ? '1:1 call' : 'group call'} · ${room.count}/${room.capacity || '∞'} people${isHost() ? ' · you are the host' : ''}`);
    row('You', `${me.name} (${me.id})`);
  }
  const hint = hintText();
  if (joined) row('What to know', hint || (peers.size ? 'All good.' : 'Waiting for others to join.'), hint ? (peerList().some((p) => p.pc?.iceConnectionState === 'failed') ? 'bad' : 'warn') : 'ok');

  const t = $('#partTable');
  t.replaceChildren(h('tr', {}, ...['Person', 'Status', 'Chat', 'Path', 'Latency', 'You send them', 'You receive', 'Browser'].map((x) => h('th', { textContent: x }))));
  if (!peers.size) t.append(h('tr', {}, h('td', { colSpan: 8, className: 'note', textContent: 'Nobody else is here yet.' })));
  for (const p of peerList()) {
    const st = peerStatus(p);
    t.append(h('tr', {},
      h('td', { textContent: p.name, style: 'font-weight:600' }), h('td', { textContent: st.text, className: st.cls }),
      h('td', { textContent: p.dcs.chat?.readyState === 'open' ? 'open ✅' : 'not open', className: p.dcs.chat?.readyState === 'open' ? 'ok' : 'warn' }),
      h('td', { textContent: pathText(p) }),
      h('td', { textContent: p.live.rtt != null ? `${p.live.rtt.toFixed(0)} ms` : '–' }),
      h('td', { textContent: peerLine(p, 'out') }), h('td', { textContent: peerLine(p, 'in') }),
      h('td', { textContent: p.caps ? browserName(p.caps.ua) : '–' })));
  }

  // status pill + hint banner on the Call tab
  let pill, cls = '';
  if (!wsOpen) pill = 'Not in a room';
  else if (!joined) { pill = 'Joining…'; cls = 'warn'; }
  else if (!peers.size) { pill = `Room “${room.name}” · waiting for others (${room.count}/${room.capacity || '∞'})`; cls = 'warn'; }
  else {
    const conn = peerList().filter((p) => p.pc?.connectionState === 'connected').length;
    const failed = peerList().some((p) => p.pc?.connectionState === 'failed');
    const bits = [`${conn}/${peers.size} connected`];
    if (peers.size === 1 && conn === 1) {
      const p = peerList()[0];
      bits.push(pathText(p).replace(/ \(.*\)/, ''));
      if (p.live.rtt != null) bits.push(`${p.live.rtt.toFixed(0)} ms`);
      const ov = p.live.used.out.video, dm = p.live.dim.out.video;
      if (ov) bits.push(`${ov.toUpperCase()}${dm?.w ? ` ${dm.w}×${dm.h}` : ''}`);
    }
    pill = bits.join(' · ');
    cls = failed ? 'bad' : conn === peers.size ? 'ok' : 'warn';
  }
  renderPathBadge();
  $('#statusPill').textContent = pill;
  $('#statusPill').className = 'statuspill ' + cls;
  const hb = $('#callHint');
  hb.hidden = !hint;
  hb.textContent = hint;
  renderCallUi();
}

// ───────────── Call tab rendering ─────────────
function renderCallUi() {
  $('#btnMic').classList.toggle('off', !micOn()); $('#btnMic').classList.toggle('active', micOn());
  $('#btnCam').classList.toggle('off', !camOn()); $('#btnCam').classList.toggle('active', camOn());
  $('#btnMic').querySelector('span').textContent = micOn() ? 'Mic on' : 'Mic off';
  $('#btnCam').querySelector('span').textContent = camOn() ? 'Camera on' : 'Camera off';
  $('#btnShare').classList.toggle('active', !!screenStream);
  $('#btnShare').querySelector('span').textContent = screenStream ? 'Stop sharing' : 'Share screen';
  const fo = me.flip.h || me.flip.v, fl = me.localFlip.h || me.localFlip.v;
  $('#btnFlip').classList.toggle('active', fo);
  $('#btnFlip .state').textContent = fo ? 'on' : 'off';
  $('#btnFlipLocal').classList.toggle('active', fl);
  $('#btnFlipLocal .state').textContent = fl ? 'on' : 'off';
  $('#btnFlipMenu').classList.toggle('active', fo || fl);
  $('#setLocalFlipH').checked = me.localFlip.h; $('#setLocalFlipV').checked = me.localFlip.v;
  $('#btnChat').classList.toggle('active', !$('#chatPanel').hidden);
  $('#chatBadge').hidden = unread === 0;
  $('#chatBadge').textContent = unread > 9 ? '9+' : unread;
  $('#layoutLabel').textContent = !zoomId ? ZOOM_NONE : `Zoom: ${tileLabel(zoomId)}`;

  // your own tile (always shown mirrored relative to what others see, like a selfie camera)
  const lt = $('#tileLocal');
  lt.style.setProperty('--fx', (me.flip.h ? 1 : -1) * (me.localFlip.h ? -1 : 1));
  lt.style.setProperty('--fy', (me.flip.v ? -1 : 1) * (me.localFlip.v ? -1 : 1));
  $('#ovLocal').hidden = camOn();
  $('#ovLocal').textContent = micOn() ? 'Camera off (audio only)' : 'Camera and mic off';
  $('#capLocal').textContent = `you${me.name ? ' (' + me.name + ')' : ''}${micOn() ? '' : ' · mic off'}${me.flip.h || me.flip.v ? ' · flipped for others ' + (me.flip.h ? '↔' : '') + (me.flip.v ? '↕' : '') : ''}${me.localFlip.h || me.localFlip.v ? ' · flipped for myself ' + (me.localFlip.h ? '↔' : '') + (me.localFlip.v ? '↕' : '') : ''}`;

  // empty-room placeholder
  const wsOpen = ws && ws.readyState === 1;
  $('#ovGhost').textContent = !wsOpen ? 'Not in a room.\nOpen the “Room” menu at the top to join or create one.' : !joined ? 'Joining…' : `Waiting for someone to join room “${room.name}”…\nShare the invite link from the Room menu.`;

  // each remote person's tile
  for (const p of peerList()) {
    const f = p.caps?.flip || { h: false, v: false };
    p.tile.el.style.setProperty('--fx', f.h ? -1 : 1);
    p.tile.el.style.setProperty('--fy', f.v ? -1 : 1);
    let msg = '';
    if (!p.pc) msg = `${p.name}\nwaiting for them to connect…`;
    else if (p.pc.connectionState === 'failed') msg = `Connection with ${p.name} failed.\nSee the hint below.`;
    else if (p.pc.connectionState !== 'connected') msg = `Connecting to ${p.name}…`;
    else if (p.caps && !p.caps.dev.cam) msg = `${p.name}: ` + (p.caps.dev.mic ? 'camera is off (audio only)' : 'camera and mic are off');
    p.tile.ov.hidden = !msg;
    p.tile.ov.textContent = msg;
    p.tile.cap.textContent = p.name + (p.caps && !p.caps.dev.mic ? ' · mic off' : '') + (f.h || f.v ? ' · flipped ' + (f.h ? '↔' : '') + (f.v ? '↕' : '') : '');
  }
  for (const p of peerList()) p.stile.cap.textContent = `${p.name}'s screen${p.caps?.screen ? '' : ''}`;
  layoutStage();
  renderRoomMenu();
}

// ───────────── Details tab rendering ─────────────
function renderDcTable() {
  const p = detailPeer();
  const t = $('#dcTable');
  t.replaceChildren(h('tr', {}, ...['label', 'id', 'state', 'ordered', 'maxRetransmits', 'buffered'].map((x) => h('th', { textContent: x }))));
  for (const dc of Object.values(p?.dcs ?? {})) {
    t.append(h('tr', {}, ...[dc.label, dc.id, dc.readyState, dc.ordered, dc.maxRetransmits ?? '∞', fmtBytes(dc.bufferedAmount)].map((x) => h('td', { textContent: String(x) }))));
  }
}
function renderDetailTables() {
  const p = detailPeer();
  const d = p?.detail;
  const kv = $('#selected');
  kv.replaceChildren();
  const add = (k, v) => kv.append(h('span', { textContent: k }), h('span', { textContent: String(v) }));
  if (!p) add('status', 'nobody connected');
  else if (!d) add('status', 'no stats yet');
  else d.sel.forEach(([k, v]) => add(k, v));
  if (p) add('data-channel ping RTT', p.pingRtt != null ? `${p.pingRtt.toFixed(1)} ms` : '–');

  const pt = $('#pairTable');
  pt.replaceChildren(h('tr', {}, ...['local', 'remote', 'state', 'nominated', 'prio', 'RTT ms', 'sent', 'recv', 'checks req s/r'].map((x) => h('th', { textContent: x }))));
  for (const r of d?.pairs ?? []) pt.append(h('tr', { style: r.selected ? 'color:var(--ok);font-weight:600' : '' }, ...r.cells.map((x) => h('td', { textContent: String(x ?? '') }))));

  const rt = $('#rtpTable');
  rt.replaceChildren(h('tr', {}, ...['dir', 'kind', 'codec', 'bitrate', 'packets', 'lost', 'jitter ms', 'resolution', 'fps', 'extra'].map((x) => h('th', { textContent: x }))));
  for (const r of d?.rtp ?? []) rt.append(h('tr', {}, ...r.map((x) => h('td', { textContent: String(x ?? '') }))));
  renderDcTable();
}
function renderDetails() {
  renderBadges(); renderCandTable(); refreshSdp(); renderCompat(); renderDetailTables(); renderSummary();
}

// ───────────── stats ─────────────
function rate(p, id, field, r) {
  const prev = p.prev.get(id + field);
  p.prev.set(id + field, { v: r[field], t: r.timestamp });
  if (!prev || r.timestamp <= prev.t) return null;
  return ((r[field] - prev.v) * 8000) / (r.timestamp - prev.t);
}

async function pollPeer(p) {
  if (!p.pc) return;
  const report = await p.pc.getStats();
  const by = {};
  report.forEach((r) => (by[r.id] = r));

  const transport = Object.values(by).find((r) => r.type === 'transport');
  let pair = transport && by[transport.selectedCandidatePairId];
  if (!pair) pair = Object.values(by).find((r) => r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded')));
  const candStr = (c) => c ? `${c.candidateType} ${c.protocol} ${c.address ?? c.ip}:${c.port}${c.relayProtocol ? ' (TURN over ' + c.relayProtocol + ')' : ''}${c.networkType ? ' [' + c.networkType + ']' : ''}${c.url ? ' via ' + c.url : ''}` : '–';
  const sel = [];
  if (pair) {
    const l = by[pair.localCandidateId], rm = by[pair.remoteCandidateId];
    p.live.pair = pair; p.live.local = l; p.live.remote = rm;
    p.live.rtt = pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null;
    sel.push(['local candidate', candStr(l)], ['remote candidate', candStr(rm)],
      ['pair state', `${pair.state}${pair.nominated ? ', nominated' : ''}`],
      ['RTT (current / total avg)', `${pair.currentRoundTripTime != null ? (pair.currentRoundTripTime * 1000).toFixed(1) : '–'} ms / ${pair.totalRoundTripTime && pair.responsesReceived ? ((pair.totalRoundTripTime / pair.responsesReceived) * 1000).toFixed(1) : '–'} ms`],
      ['available outgoing bitrate', fmtBps(pair.availableOutgoingBitrate)],
      ['bytes sent / received', `${fmtBytes(pair.bytesSent)} / ${fmtBytes(pair.bytesReceived)}`],
      ['STUN checks sent/recv', `req ${pair.requestsSent}/${pair.requestsReceived}  resp ${pair.responsesSent}/${pair.responsesReceived}  consent ${pair.consentRequestsSent ?? '–'}`]);
  } else sel.push(['status', 'no pair selected yet']);
  if (transport) sel.push(['ICE role / state', `${transport.iceRole ?? '–'} / ${transport.iceState ?? '–'}`], ['DTLS state / version', `${transport.dtlsState} / ${transport.tlsVersion ?? '–'}`], ['DTLS cipher / SRTP cipher', `${transport.dtlsCipher ?? '–'} / ${transport.srtpCipher ?? '–'}`]);

  const pairs = Object.values(by).filter((r) => r.type === 'candidate-pair').sort((a, b) => (b.priority || 0) - (a.priority || 0)).map((r) => ({
    selected: pair && r.id === pair.id,
    cells: [candStr(by[r.localCandidateId]), candStr(by[r.remoteCandidateId]), r.state, r.nominated ? 'yes' : '', r.priority, r.currentRoundTripTime != null ? (r.currentRoundTripTime * 1000).toFixed(1) : '', fmtBytes(r.bytesSent), fmtBytes(r.bytesReceived), `${r.requestsSent}/${r.requestsReceived}`],
  }));

  const used = { out: {}, in: {} }, bps = { out: {}, in: {} }, dim = { out: {}, in: {} }, scr = { out: {}, in: {} }, rtp = [];
  for (const r of Object.values(by)) {
    if ((r.type !== 'inbound-rtp' && r.type !== 'outbound-rtp') || (r.kind !== 'video' && r.kind !== 'audio')) continue;
    const inbound = r.type === 'inbound-rtp', dir = inbound ? 'in' : 'out';
    const role = roleForStat(p, r);
    const isScreen = role === 'screen' || role === 'screenAudio';
    const mime = by[r.codecId]?.mimeType;
    const bitrate = rate(p, r.id, inbound ? 'bytesReceived' : 'bytesSent', r);
    if (isScreen) {
      if (r.kind === 'video') scr[dir].video = { codec: mime ? codecName(mime).toLowerCase() : '?', bps: bitrate, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond };
      else scr[dir].audio = { codec: mime ? codecName(mime).toLowerCase() : '?', bps: bitrate };
    } else {
      if (mime) used[dir][r.kind] = codecName(mime).toLowerCase();
      bps[dir][r.kind] = bitrate;
      if (r.kind === 'video') dim[dir].video = { w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond };
    }
    const extra = [];
    if (!inbound && r.qualityLimitationReason && r.qualityLimitationReason !== 'none') extra.push('limited by ' + r.qualityLimitationReason);
    if (inbound && r.freezeCount) extra.push(`freezes ${r.freezeCount}`);
    if (r.nackCount) extra.push(`NACK ${r.nackCount}`);
    if (r.pliCount) extra.push(`PLI ${r.pliCount}`);
    rtp.push([inbound ? '⬇ in' : '⬆ out', isScreen ? `${r.kind} (screen)` : r.kind, mime ? codecName(mime) : '–', fmtBps(bitrate), inbound ? r.packetsReceived : r.packetsSent, inbound ? r.packetsLost : '',
      r.jitter != null ? (r.jitter * 1000).toFixed(1) : '', r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : '', r.framesPerSecond ?? '', extra.join(', ')]);
  }
  const usedChanged = JSON.stringify(used) !== JSON.stringify(p.live.used);
  p.live.used = used; p.live.bps = bps; p.live.dim = dim; p.live.scr = scr;
  p.detail = { sel, pairs, rtp };
  if (usedChanged && p.id === detailId) renderCompat();
}

async function pollAll() {
  await Promise.all(peerList().map((p) => pollPeer(p).catch(() => {})));
  if (!$('#tab-details').hidden) renderDetailTables();
  const sc = screenScale(), key = sc ? `${sc.w}x${sc.h}|${$('#setSRes').value}` : '';
  if (key !== lastScreenKey) { lastScreenKey = key; if (sc) peerList().forEach(applySenderParams); } // shared window got resized
  updateMediaInfo();
  renderSummary();
}
setInterval(pollAll, 1000);

$('#btnRestart').onclick = async () => {
  const p = detailPeer();
  if (!p?.pc || !p.isOfferer) return toast('Only the person who made the offer can restart ICE. Pick someone in the dropdown that you made the offer to.');
  plog(p, 'ICE restart requested', 'evt');
  await makeOffer(p, { iceRestart: true });
};
$('#btnDump').onclick = async () => {
  const p = detailPeer();
  if (!p?.pc) return;
  const out = [];
  (await p.pc.getStats()).forEach((r) => out.push(r));
  $('#rawStats').textContent = JSON.stringify(out, null, 2);
};

// ───────────── tabs, chat panel, fullscreen, settings ─────────────
function showTab(name) {
  for (const t of ['call', 'details']) {
    $('#tab-' + t).hidden = t !== name;
    document.querySelector(`[data-tab=${t}]`).classList.toggle('active', t === name);
  }
  history.replaceState(null, '', location.pathname + location.search + '#' + name);
  if (name === 'details') renderDetails();
}
document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function setChat(open) {
  $('#chatPanel').hidden = !open;
  if (open) { unread = 0; $('#chatlog').scrollTop = $('#chatlog').scrollHeight; ta.focus(); }
  renderCallUi();
}
$('#btnChat').onclick = () => setChat($('#chatPanel').hidden);

$('#btnFull').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#tab-call').requestFullscreen?.().catch((e) => toast('Fullscreen not available: ' + e.message)); // whole call view: chat + toasts included
};

const dlg = $('#settings');
$('#btnSettings').onclick = async () => { await populateDevices(); updateMediaInfo(); dlg.showModal(); };
$('#btnCloseSettings').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

// ───────────── init ─────────────
function renderAll() {
  renderBadges();
  renderSummary();
  renderRoomMenu();
  if (!$('#tab-details').hidden) { renderDetailTables(); renderCandTable(); }
}
{
  const params = new URLSearchParams(location.search);
  $('#nameInput').value = store.get('rtc-name') || '';
  if (params.get('room')) $('#room').value = params.get('room');
  modeChanged();
  showTab(location.hash === '#details' ? 'details' : 'call');
  renderAll();
  menuOpen(true); // the first thing a new visitor needs is the join form
}
