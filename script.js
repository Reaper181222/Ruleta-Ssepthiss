/* =====================================================================
   Ruleta de Sorteos ssephtiss — script.js
   ---------------------------------------------------------------------
   Cómo funciona la mecánica del sorteo (OJO, esto es al revés de lo
   que parece a primera vista): la ruleta NO elige un ganador y lo
   saca. Cada giro ELIMINA una vida. Si alguien tiene 2 chances (por
   ser sub), tiene que perder las 2 para quedar afuera — un giro le
   saca una nomás. Se sigue girando hasta que queda una sola persona
   en la rueda: esa es la campeona del sorteo.

   El resto sigue igual que antes:
   - La gente se anota escribiendo "!sorteo" en el chat de Twitch
     (leído de forma anónima con tmi.js, sin login).
   - Todo se guarda en Supabase, en vivo, para streamer/mods y
     espectadores por igual.
   - Cuando el mod gira, elijo la vida que se pierde ACÁ y le aviso a
     todo el mundo por "broadcast" para que la rueda de todos gire
     igual, al mismo tiempo, y frene en el mismo lugar.
   ===================================================================== */

/* ============ CONFIG FIJA ============ */
const TWITCH_CHANNEL = 'ssephtiss';
const CHAT_COMMAND = '!sorteo';
const DISCORD_INVITE = 'https://discord.gg/xKbvyFtxE';
const SPIN_DURATION_MS = 5500;
const SPIN_DURATION_S = SPIN_DURATION_MS / 1000;
const MY_CLIENT_ID = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

// Paleta de violetas para las porciones de la rueda — cada participante
// siempre cae en el mismo tono, calculado a partir de su nombre.
const WHEEL_PALETTE = ['#3a1160','#4c1d95','#5b21b6','#6d28d9','#7c3aed','#8b3ff0','#9d4ef0','#a855f7','#b46bfa','#c084fc'];

/* ============ CLIENTE DE SUPABASE ============ */
let sb = null;
let dbOk = false;
try{
  if(window.SUPABASE_URL && window.SUPABASE_URL.indexOf('PONÉ_ACÁ') === -1){
    sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    dbOk = true;
  }
}catch(e){
  dbOk = false;
}

/* ============ ESTADO EN MEMORIA ============ */
let role = sessionStorage.getItem('ssephtiss-ruleta-role') || null; // null | 'espectador' | 'editor'
let streamerCode = 'R34P3R';
let participants = []; // [{username, chances, subscriber, entered_at}] — chances = vidas que le quedan
let winnersHistory = []; // acá guardo a los que van QUEDANDO AFUERA (no al campeón)
let prize = { pokemon_name: null, prize_label: '', is_shiny: false };
let spriteCache = {}; // pokemon_name -> {id, default, shiny, animated, animatedShiny} | 'loading' | 'error'
let currentRotation = 0;
let isSpinning = false;
let lastEliminationMsg = null; // { username, stillIn }
let championCelebrated = false;
let chatClient = null;
let chatConnected = false;
let spinChannel = null;

/* ============ HELPERS CHIQUITOS ============ */
function $(id){ return document.getElementById(id); }
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function truncate(s, n){ return s.length > n ? s.slice(0, n-1)+'…' : s; }
function hashStr(s){
  let h = 0;
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
function paletteIndexForUsername(name){
  return hashStr(name.toLowerCase()) % WHEEL_PALETTE.length;
}

// Chispitas de fondo del cartel de premio — se generan UNA sola vez
// (posiciones al azar) para que no salten de lugar en cada render.
function buildSparksHtml(){
  let out = '';
  for(let i=0;i<9;i++){
    const top = (Math.random()*88+4).toFixed(1);
    const left = (Math.random()*88+4).toFixed(1);
    const delay = (Math.random()*4).toFixed(1);
    const size = (2 + Math.random()*3).toFixed(1);
    out += `<span class="spark" style="top:${top}%; left:${left}%; width:${size}px; height:${size}px; animation-delay:${delay}s;"></span>`;
  }
  return out;
}
const SPARKS_HTML = buildSparksHtml();

/* ============ CARGA DESDE LA BASE ============ */
async function fetchAll(){
  const [settingsRes, participantsRes, winnersRes, prizeRes] = await Promise.all([
    sb.from('settings').select('*').eq('id',1).single(),
    sb.from('participants').select('*').order('entered_at', { ascending:true }),
    sb.from('winners').select('*').order('won_at', { ascending:false }),
    sb.from('prize').select('*').eq('id',1).single()
  ]);
  if(settingsRes.error) console.error('Error leyendo settings:', settingsRes.error);
  if(participantsRes.error) console.error('Error leyendo participants:', participantsRes.error);
  if(winnersRes.error) console.error('Error leyendo winners:', winnersRes.error);
  if(prizeRes.error) console.error('Error leyendo prize:', prizeRes.error);

  if(settingsRes.data) streamerCode = settingsRes.data.streamer_code || 'R34P3R';
  if(participantsRes.data) participants = participantsRes.data;
  if(winnersRes.data) winnersHistory = winnersRes.data;
  if(prizeRes.data){
    prize = {
      pokemon_name: prizeRes.data.pokemon_name || null,
      prize_label: prizeRes.data.prize_label || '',
      is_shiny: !!prizeRes.data.is_shiny
    };
  }
}

function showSaveError(err){
  console.error('Error guardando en Supabase:', err);
  alert('No se pudo guardar en la base de datos.\n\nMotivo: ' + (err && err.message ? err.message : 'desconocido') +
    '\n\nRevisá los permisos (RLS) de la tabla en Supabase.');
}

/* =====================================================================
   ESCRITURA A LA BASE — acciones manuales del mod (con fetch+render)
   ===================================================================== */
async function addParticipant(username, isSub){
  const clean = username.trim();
  if(!clean) return;
  const { error } = await sb.from('participants').upsert(
    { username: clean, chances: isSub ? 2 : 1, subscriber: !!isSub },
    { onConflict: 'username', ignoreDuplicates: true }
  );
  if(error){ console.error('Error anotando participante:', error); return; }
  await fetchAll();
  if(role) renderApp();
}
async function removeParticipant(username){
  const { error } = await sb.from('participants').delete().eq('username', username);
  if(error){ showSaveError(error); return; }
  await fetchAll();
  renderApp();
}
async function setParticipantChances(username, chances){
  const { error } = await sb.from('participants').update({ chances }).eq('username', username);
  if(error){ showSaveError(error); return; }
  await fetchAll();
  renderApp();
}
async function savePrize(newPrize){
  const { error } = await sb.from('prize').update(newPrize).eq('id', 1);
  if(error){ showSaveError(error); return; }
  await fetchAll();
  renderApp();
}
async function resetGiveaway(){
  if(!confirm('¿Reiniciar el sorteo? Esto borra a todos los participantes anotados y el historial de eliminados de esta tanda.')) return;
  const d1 = await sb.from('participants').delete().neq('username', '__nunca__');
  if(d1.error){ showSaveError(d1.error); return; }
  const d2 = await sb.from('winners').delete().gt('id', 0);
  if(d2.error){ showSaveError(d2.error); return; }
  currentRotation = 0;
  lastEliminationMsg = null;
  championCelebrated = false;
  await fetchAll();
  renderApp();
}

/* ---------- Escrituras "crudas" que usa la eliminación de la ruleta ----------
   Estas NO hacen fetch ni render: eso lo maneja resolveElimination() una
   sola vez, al final, para que no se pisen renders en medio del giro. */
async function setParticipantChancesRaw(username, chances){
  const { error } = await sb.from('participants').update({ chances }).eq('username', username);
  if(error) showSaveError(error);
}
async function removeParticipantRaw(username){
  const { error } = await sb.from('participants').delete().eq('username', username);
  if(error) showSaveError(error);
}
async function logEliminated(username){
  const { error } = await sb.from('winners').insert({ username, prize_label: null });
  if(error) console.error('Error guardando eliminado:', error);
}

/* =====================================================================
   POKEAPI — sprite animado del cartel de premio (pública, sin key)
   ===================================================================== */
function ensureSpriteLoaded(name){
  if(!name) return;
  const key = name.trim().toLowerCase().replace(/\s+/g,'-');
  if(spriteCache[key]) return;
  spriteCache[key] = 'loading';
  fetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(key)}`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error('no encontrado')))
    .then(data=>{
      const anim = (data.sprites && data.sprites.versions && data.sprites.versions['generation-v'] &&
        data.sprites.versions['generation-v']['black-white'] &&
        data.sprites.versions['generation-v']['black-white'].animated) || {};
      spriteCache[key] = {
        id: data.id,
        default: data.sprites && data.sprites.front_default,
        shiny: data.sprites && data.sprites.front_shiny,
        // sprite animado (gif) — si la PokeAPI no lo trae en la respuesta,
        // lo arma con el id, que es el mismo repo de sprites
        animated: anim.front_default || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${data.id}.gif`,
        animatedShiny: anim.front_shiny || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/shiny/${data.id}.gif`
      };
      renderApp();
    })
    .catch(()=>{ spriteCache[key] = 'error'; renderApp(); });
}

/* =====================================================================
   TWITCH CHAT — escucha anónima y de solo lectura con tmi.js
   ===================================================================== */
function startChatListener(){
  if(chatClient || typeof tmi === 'undefined') return;
  chatClient = new tmi.Client({ channels: [TWITCH_CHANNEL] });
  chatClient.on('message', (channel, tags, message, self)=>{
    if(self) return;
    const text = (message || '').trim().toLowerCase();
    if(text !== CHAT_COMMAND) return;
    const username = tags['display-name'] || tags.username;
    if(!username) return;
    const isSub = !!(tags.subscriber || (tags.badges && tags.badges.subscriber));
    addParticipant(username, isSub);
  });
  chatClient.on('connected', ()=>{ chatConnected = true; renderApp(); });
  chatClient.on('disconnected', ()=>{ chatConnected = false; renderApp(); });
  chatClient.connect().catch(err=> console.error('No se pudo conectar al chat de Twitch:', err));
}

/* =====================================================================
   LA RUEDA — armado de las porciones, dibujo y matemática del giro
   ===================================================================== */
function buildSegments(){
  const segs = [];
  participants.forEach(p=>{
    const n = p.chances === 2 ? 2 : 1;
    for(let i=0;i<n;i++) segs.push({ username: p.username });
  });
  return segs;
}
function pickWeightedTarget(segments){
  const idx = Math.floor(Math.random() * segments.length);
  return segments[idx].username;
}
function polarPoint(cx, cy, r, angleDeg){
  const a = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function sliceWedgePath(cx, cy, r, startAngle, endAngle){
  const start = polarPoint(cx, cy, r, endAngle);
  const end = polarPoint(cx, cy, r, startAngle);
  const largeArc = (endAngle - startAngle) <= 180 ? 0 : 1;
  return `M ${cx} ${cy} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

// Rueda con gradientes violetas translúcidos por porción, aro de
// puntitos neón fijo (no gira) alrededor, y un brillo tipo vidrio
// adentro del grupo que sí gira con la rueda.
function buildWheelSvg(segments){
  const N = segments.length;
  const cx = 200, cy = 200, r = 190;
  const anglePerSeg = 360 / N;

  let defs = '<defs>';
  WHEEL_PALETTE.forEach((color, i)=>{
    defs += `<radialGradient id="slice-grad-${i}" cx="50%" cy="50%" r="75%">
      <stop offset="0%" stop-color="#160530" stop-opacity="0.5"/>
      <stop offset="55%" stop-color="${color}" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.96"/>
    </radialGradient>`;
  });
  defs += '</defs>';

  let slices = '';
  let labels = '';
  segments.forEach((seg, i)=>{
    const start = i * anglePerSeg, end = (i+1) * anglePerSeg;
    const gi = paletteIndexForUsername(seg.username);
    slices += `<path d="${sliceWedgePath(cx,cy,r,start,end)}" fill="url(#slice-grad-${gi})" stroke="rgba(233,222,255,0.5)" stroke-width="1.3"></path>`;
    if(anglePerSeg >= 8){
      const mid = start + anglePerSeg/2;
      const pos = polarPoint(cx, cy, r*0.62, mid);
      const textRot = (mid > 90 && mid < 270) ? mid + 180 : mid;
      const fontSize = Math.min(12, Math.max(7, anglePerSeg * 0.55));
      labels += `<text class="wheel-slice-label" x="${pos.x.toFixed(2)}" y="${pos.y.toFixed(2)}" font-size="${fontSize.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${textRot.toFixed(1)} ${pos.x.toFixed(2)} ${pos.y.toFixed(2)})">${escapeHtml(truncate(seg.username, 12))}</text>`;
    }
  });
  // brillo tipo vidrio, gira junto con la rueda
  const shine = `<ellipse cx="150" cy="120" rx="72" ry="42" fill="#ffffff" opacity="0.07" transform="rotate(-25 150 120)"></ellipse>`;

  // aro de puntitos neón FIJO — va afuera del <g> que rota, así queda
  // quieto como marco mientras la rueda gira adentro
  let dots = '';
  const dotCount = 44;
  for(let i=0;i<dotCount;i++){
    const ang = (360/dotCount)*i;
    const pos = polarPoint(cx, cy, r+7, ang);
    dots += `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(2)}" r="2" fill="#c9a8ff" opacity="0.55"></circle>`;
  }

  return `<svg class="wheel-svg" viewBox="0 0 400 400">
    ${defs}
    <g class="wheel-svg-group" id="wheel-group">${slices}${shine}${labels}</g>
    <g class="wheel-dots">${dots}</g>
  </svg>`;
}

function rotationToLandOn(segments, idx){
  const anglePerSeg = 360 / segments.length;
  const targetMid = (idx + 0.5) * anglePerSeg;
  const wantMod = (360 - targetMid + 360) % 360;
  const currentMod = ((currentRotation % 360) + 360) % 360;
  const delta = ((wantMod - currentMod) + 360) % 360;
  const spins = 7 + Math.floor(Math.random() * 4); // 7 a 10 vueltas, para que no gire siempre igual
  return currentRotation + spins * 360 + delta;
}

// Acá está el arreglo clave para que SE VEA girar: no puedo simplemente
// re-dibujar el SVG ya en la posición final (eso es lo que hacía antes
// y por eso "saltaba" directo al resultado). Tengo que: dejar el grupo
// fijo en su rotación VIEJA, forzar al navegador a "asentarla" (reflow),
// y recién ahí prenderle la transición CSS y moverlo a la nueva.
function applyWheelRotation(newRotation){
  const group = $('wheel-group');
  if(!group){ currentRotation = newRotation; return; }
  group.style.transition = 'none';
  group.style.transform = `rotate(${currentRotation}deg)`;
  void group.getBoundingClientRect(); // fuerzo el reflow
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      group.style.transition = `transform ${SPIN_DURATION_S}s cubic-bezier(0.1,0.78,0.15,1)`;
      group.style.transform = `rotate(${newRotation}deg)`;
    });
  });
  currentRotation = newRotation;
}

/* Arranca la animación (la llaman tanto el que apretó Girar como los
   que reciben el aviso por broadcast). Al terminar, resuelve quién
   pierde una vida y quién queda eliminado. */
function startSpin(targetUsername, isOrigin){
  const segments = buildSegments();
  const idx = segments.findIndex(s => s.username === targetUsername);
  if(idx === -1) return; // ya no está en mi rueda local, no puedo animar bien

  isSpinning = true;
  lastEliminationMsg = null;
  renderApp(); // dibuja la rueda en su rotación VIEJA + botón deshabilitado

  const newRotation = rotationToLandOn(segments, idx);
  applyWheelRotation(newRotation);

  setTimeout(async ()=>{
    isSpinning = false;
    await resolveElimination(targetUsername, isOrigin);
    renderApp();
  }, SPIN_DURATION_MS);
}

async function resolveElimination(username, isOrigin){
  const before = participants.find(p => p.username === username);
  const hadTwoChances = !!(before && before.chances === 2);

  if(isOrigin){
    if(hadTwoChances){
      await setParticipantChancesRaw(username, 1);
    } else {
      await removeParticipantRaw(username);
      await logEliminated(username);
    }
  } else {
    // le doy un instante al Realtime para que traiga el cambio que
    // hizo el mod, antes de refrescar mi propio estado
    await new Promise(r => setTimeout(r, 400));
  }

  await fetchAll();
  const stillHere = participants.some(p => p.username === username);
  lastEliminationMsg = { username, stillIn: stillHere };

  if(participants.length === 1 && !championCelebrated){
    championCelebrated = true;
    launchConfetti();
    playVictoryJingle();
  }
}

async function onSpinClick(){
  if(isSpinning) return;
  if(participants.length < 2){
    alert('Hace falta que queden al menos 2 en la rueda para girar.');
    return;
  }
  const segments = buildSegments();
  const targetUsername = pickWeightedTarget(segments);
  if(spinChannel){
    spinChannel.send({ type:'broadcast', event:'spin', payload:{ username: targetUsername, clientId: MY_CLIENT_ID } });
  }
  startSpin(targetUsername, true);
}

/* =====================================================================
   TIEMPO REAL — datos de la base (para todos) + aviso de giro (mod)
   ===================================================================== */
function subscribeRealtime(){
  sb.channel('ssephtiss-ruleta-data')
    .on('postgres_changes', { event:'*', schema:'public', table:'participants' }, syncAndRender)
    .on('postgres_changes', { event:'*', schema:'public', table:'winners' }, syncAndRender)
    .on('postgres_changes', { event:'*', schema:'public', table:'prize' }, syncAndRender)
    .on('postgres_changes', { event:'*', schema:'public', table:'settings' }, syncAndRender)
    .subscribe();

  spinChannel = sb.channel('ssephtiss-ruleta-spin');
  spinChannel.on('broadcast', { event:'spin' }, ({ payload })=>{
    if(!payload || payload.clientId === MY_CLIENT_ID) return; // ese giro ya lo animé yo
    startSpin(payload.username, false);
  });
  spinChannel.subscribe();
}
async function syncAndRender(){
  if(isSpinning) return; // no le muevo el piso a la animación mientras gira
  await fetchAll();
  if(role) renderApp();
}

/* =====================================================================
   FESTEJO: confeti + musiquita
   ===================================================================== */
function launchConfetti(){
  const canvas = $('confetti-canvas');
  if(!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const colors = ['#c9a8ff', '#a855f7', '#7c3aed', '#f2e9ff', '#e6c65c'];
  const particles = [];
  const count = 160;
  for(let i=0; i<count; i++){
    particles.push({
      x: Math.random()*canvas.width,
      y: -20 - Math.random()*canvas.height*0.5,
      w: 6 + Math.random()*6,
      h: 8 + Math.random()*10,
      color: colors[Math.floor(Math.random()*colors.length)],
      speedY: 2 + Math.random()*3,
      speedX: -1.5 + Math.random()*3,
      rotation: Math.random()*360,
      rotSpeed: -6 + Math.random()*12
    });
  }
  const duration = 4200;
  const start = performance.now();
  function frame(now){
    const elapsed = now - start;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    particles.forEach(p=>{
      p.x += p.speedX; p.y += p.speedY; p.rotation += p.rotSpeed;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI/180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      ctx.restore();
    });
    if(elapsed < duration) requestAnimationFrame(frame);
    else ctx.clearRect(0,0,canvas.width,canvas.height);
  }
  requestAnimationFrame(frame);
}
function playVictoryJingle(){
  try{
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const notes = [523.25, 659.25, 783.99, 1046.50];
    const now = ctx.currentTime;
    notes.forEach((freq, i)=>{
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t0 = now + i*0.14;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.55);
    });
  }catch(e){ /* si el navegador no deja, sigo sin sonido */ }
}

/* =====================================================================
   RENDER — pantalla de rol
   ===================================================================== */
function renderRoleGate(){
  const app = $('app');
  app.innerHTML = `
    <h1 class="title">Ruleta de Sorteos</h1>
    <p class="subtitle">ssephtiss</p>
    <div class="divider"><span class="line"></span><span class="diamond"></span><span class="line"></span></div>
    ${!dbOk ? `
      <div class="empty-state">
        <h2>Falta configurar la base</h2>
        <p>Todavía no cargaste los datos de Supabase en config.js.</p>
      </div>
    ` : `
      <div class="role-gate">
        <div class="role-btn" id="btn-espectador">
          <span class="role-badge">Espectador</span>
          <span class="role-hint">Solo mirás la rueda girar</span>
        </div>
        <div class="role-btn" id="btn-editor">
          <span class="role-badge">Streamer / Mod</span>
          <span class="role-hint">Manejás premio, participantes y el giro</span>
        </div>
      </div>
    `}
  `;
  if(!dbOk) return;
  $('btn-espectador').onclick = ()=>{
    role = 'espectador';
    sessionStorage.setItem('ssephtiss-ruleta-role', role);
    renderApp();
  };
  $('btn-editor').onclick = ()=> renderPinScreen();
}
function renderPinScreen(){
  const app = $('app');
  app.innerHTML = `
    <h1 class="title">Ruleta de Sorteos</h1>
    <div class="pin-box">
      <h2>Código de Streamer/Mod</h2>
      <input type="password" id="pin-input" placeholder="Código" />
      <div style="margin-top:14px; display:flex; gap:10px; justify-content:center;">
        <button class="btn" id="pin-ok">Entrar</button>
        <button class="btn btn-small" id="pin-back">Volver</button>
      </div>
      <div class="pin-error" id="pin-error"></div>
    </div>
  `;
  $('pin-back').onclick = renderRoleGate;
  $('pin-ok').onclick = ()=>{
    const val = $('pin-input').value.trim();
    if(val === streamerCode){
      role = 'editor';
      sessionStorage.setItem('ssephtiss-ruleta-role', role);
      startChatListener();
      renderApp();
    } else {
      $('pin-error').textContent = 'Código incorrecto.';
    }
  };
  $('pin-input').addEventListener('keydown', e=>{ if(e.key==='Enter') $('pin-ok').click(); });
}

/* =====================================================================
   RENDER — app principal
   ===================================================================== */
const POKEBALL_SVG = `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="20" cy="20" r="17.5" stroke="currentColor" stroke-width="2.2"/>
  <path d="M2.5 20h11.3a6.2 6.2 0 0012.4 0h11.3" stroke="currentColor" stroke-width="2.2"/>
  <circle cx="20" cy="20" r="5" fill="currentColor"/>
  <circle cx="20" cy="20" r="2.2" fill="#0d0416"/>
  <path d="M20 2.5v6.5M20 31v6.5M2.5 20h6M31.5 20h6" stroke="currentColor" stroke-width="1.3" opacity="0.6"/>
</svg>`;

function prizeCardHtml(isEditor){
  const key = prize.pokemon_name ? prize.pokemon_name.trim().toLowerCase().replace(/\s+/g,'-') : null;
  if(key) ensureSpriteLoaded(prize.pokemon_name);
  const cached = key ? spriteCache[key] : null;

  let spriteHtml;
  if(!prize.pokemon_name){
    spriteHtml = `<div class="prize-empty">Sin premio cargado todavía</div>`;
  } else if(cached === 'loading' || !cached){
    spriteHtml = `<div class="prize-empty">Buscando a ${escapeHtml(prize.pokemon_name)}…</div>`;
  } else if(cached === 'error'){
    spriteHtml = `<div class="prize-empty">No encontré ese pokémon en la Pokédex.</div>`;
  } else {
    const primary = prize.is_shiny ? cached.animatedShiny : cached.animated;
    const fallback = prize.is_shiny ? cached.shiny : cached.default;
    spriteHtml = `
      <div class="prize-sprite-wrap">
        <div class="prize-sprite-ring"></div>
        <div class="prize-sprite-glow"></div>
        <img class="prize-sprite" src="${primary}" onerror="this.onerror=null;this.src='${fallback}';" alt="${escapeHtml(prize.pokemon_name)}" />
      </div>
      <div class="prize-name">${escapeHtml(prize.pokemon_name)}</div>
    `;
  }

  return `
    <div class="prize-card">
      <div class="prize-orbit">
        <div class="prize-neon-lines"><span class="neon-line a"></span><span class="neon-line b"></span></div>
        ${SPARKS_HTML}
        <div class="pokeball p1">${POKEBALL_SVG}</div>
        <div class="pokeball p2">${POKEBALL_SVG}</div>
        <div class="pokeball p3">${POKEBALL_SVG}</div>
        <div class="pokeball p4">${POKEBALL_SVG}</div>
      </div>
      <div class="prize-label">◈ Premio actual ◈</div>
      ${spriteHtml}
      ${prize.pokemon_name ? `
        <button class="shiny-toggle ${prize.is_shiny ? 'active':''}" id="shiny-toggle">
          <span class="star">★</span> ${prize.is_shiny ? 'Shiny' : 'Normal'}
        </button>
      ` : ''}
      ${isEditor ? `
        <div class="prize-edit-row">
          <input type="text" id="prize-input" placeholder="Nombre del pokémon (ej: gengar)" value="${prize.pokemon_name ? escapeHtml(prize.pokemon_name) : ''}" />
          <button class="btn btn-small" id="prize-save">Guardar</button>
        </div>
      ` : ''}
    </div>
  `;
}

function wheelSectionHtml(isEditor){
  const segments = buildSegments();
  const isChampion = participants.length === 1;
  const canSpin = participants.length >= 2 && !isSpinning;
  const wheelInner = segments.length
    ? buildWheelSvg(segments)
    : `<div class="wheel-empty-msg"><span>La rueda se llena con la gente que escribe<br><strong>${CHAT_COMMAND}</strong> en el chat.</span></div>`;

  return `
    <div class="wheel-section">
      <div class="wheel-stage">
        <div class="wheel-holder">
          <div class="wheel-pointer"></div>
          <div class="wheel-ring"></div>
          ${wheelInner}
          ${segments.length ? '<div class="wheel-hub"></div>' : ''}
        </div>
        ${isEditor && !isChampion ? `
          <button class="btn btn-spin" id="spin-btn" ${!canSpin ? 'disabled' : ''}>
            ${isSpinning ? 'Girando…' : '◈ Girar ◈'}
          </button>
        ` : ''}
        ${isChampion ? `
          <div class="champion-box">
            <div class="label">◈ Ganador/a ◈</div>
            <div class="name">${escapeHtml(participants[0].username)}</div>
          </div>
        ` : lastEliminationMsg ? `
          <div class="winner-announce">
            <div class="label">${lastEliminationMsg.stillIn ? 'Perdió una vida' : 'Eliminado'}</div>
            <div class="name">${escapeHtml(lastEliminationMsg.username)}</div>
          </div>
        ` : ''}
      </div>
      <div class="side-panels">
        ${participantsPanelHtml(isEditor)}
        ${eliminatedPanelHtml()}
      </div>
    </div>
  `;
}

function participantsPanelHtml(isEditor){
  const rows = participants.length
    ? participants.map(p => `
      <li class="panel-row">
        <span>${escapeHtml(p.username)}</span>
        <span style="display:flex; align-items:center; gap:6px;">
          ${isEditor
            ? `<button class="chip chip-toggle ${p.chances===2 ? 'x2':''}" data-toggle="${escapeHtml(p.username)}" data-current="${p.chances}" title="Click para cambiar">${p.chances===2 ? 'x2 sub' : 'x1'}</button>`
            : `<span class="chip ${p.chances===2 ? 'x2':''}">${p.chances===2 ? 'x2 sub' : 'x1'}</span>`
          }
          ${isEditor ? `<button class="rm-btn" data-rm="${escapeHtml(p.username)}" title="Quitar">✕</button>` : ''}
        </span>
      </li>
    `).join('')
    : `<li class="panel-empty">Nadie anotado todavía.</li>`;

  return `
    <div class="panel">
      <h3>En la rueda <span class="chip">${participants.length}</span></h3>
      <ul class="panel-list">${rows}</ul>
      ${isEditor ? `
        <div class="add-participant-row">
          <input type="text" id="add-name" placeholder="Agregar a mano" maxlength="26" />
          <button class="btn btn-small" id="add-name-btn">+</button>
        </div>
        <div style="margin-top:12px; display:flex; gap:8px;">
          <button class="btn btn-small btn-danger" id="reset-btn" style="flex:1;">Reiniciar sorteo</button>
        </div>
      ` : ''}
    </div>
  `;
}

function eliminatedPanelHtml(){
  const rows = winnersHistory.length
    ? winnersHistory.map(w => `
      <li class="panel-row">
        <span>${escapeHtml(w.username)}</span>
        <span class="chip">☠</span>
      </li>
    `).join('')
    : `<li class="panel-empty">Todavía no quedó nadie afuera.</li>`;

  return `
    <div class="panel">
      <h3>Eliminados</h3>
      <ul class="panel-list">${rows}</ul>
    </div>
  `;
}

function renderApp(){
  const app = $('app');
  const isEditor = role === 'editor';
  app.innerHTML = `
    <h1 class="title">Ruleta de Sorteos</h1>
    <p class="subtitle">ssephtiss · escribí <strong>${CHAT_COMMAND}</strong> en el chat para anotarte</p>
    <div class="divider"><span class="line"></span><span class="diamond"></span><span class="line"></span></div>

    <div class="toolbar">
      <span class="role-badge">${isEditor ? 'Streamer / Mod' : 'Espectador'}</span>
      ${isEditor ? `
        <span class="status-pill">
          <span class="status-dot ${chatConnected ? 'on':'off'}"></span>
          ${chatConnected ? 'Conectado al chat' : 'Conectando al chat…'}
        </span>
      ` : ''}
    </div>

    ${prizeCardHtml(isEditor)}
    ${wheelSectionHtml(isEditor)}

    <div class="discord-wrap">
      <a class="discord-btn" href="${DISCORD_INVITE}" target="_blank" rel="noopener">
        <svg class="discord-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.369A19.79 19.79 0 0 0 15.885 3c-.211.375-.444.87-.608 1.262a18.27 18.27 0 0 0-5.487 0A12.6 12.6 0 0 0 9.182 3a19.74 19.74 0 0 0-4.435 1.37C1.578 9.046.838 13.58 1.208 18.058a19.9 19.9 0 0 0 5.993 3.03c.483-.66.914-1.36 1.285-2.096a12.9 12.9 0 0 1-2.023-.975c.17-.124.336-.253.497-.386a14.19 14.19 0 0 0 12.078 0c.163.133.328.262.497.386a12.9 12.9 0 0 1-2.026.977c.371.735.801 1.435 1.285 2.095a19.86 19.86 0 0 0 5.998-3.031c.435-5.177-.826-9.673-3.475-13.69ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.42 2.157-2.42 1.21 0 2.176 1.096 2.157 2.42 0 1.334-.947 2.42-2.157 2.42Zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.42 2.157-2.42 1.21 0 2.176 1.096 2.157 2.42 0 1.334-.946 2.42-2.157 2.42Z"/></svg>
        Unite al Discord
      </a>
    </div>
    <footer class="note">ssephtiss · ruleta en vivo</footer>
  `;

  if(!isEditor) return;

  const shinyBtn = $('shiny-toggle');
  if(shinyBtn) shinyBtn.onclick = ()=> savePrize({ is_shiny: !prize.is_shiny });

  const prizeSave = $('prize-save');
  if(prizeSave) prizeSave.onclick = ()=>{
    const val = $('prize-input').value.trim();
    if(!val) return;
    savePrize({ pokemon_name: val });
  };

  const spinBtn = $('spin-btn');
  if(spinBtn) spinBtn.onclick = onSpinClick;

  const resetBtn = $('reset-btn');
  if(resetBtn) resetBtn.onclick = resetGiveaway;

  const addBtn = $('add-name-btn');
  if(addBtn) addBtn.onclick = ()=>{
    const val = $('add-name').value.trim();
    if(!val) return;
    addParticipant(val, false);
  };
  const addInput = $('add-name');
  if(addInput) addInput.addEventListener('keydown', e=>{ if(e.key==='Enter') addBtn.click(); });

  app.querySelectorAll('[data-rm]').forEach(btn=>{
    btn.onclick = ()=> removeParticipant(btn.getAttribute('data-rm'));
  });
  app.querySelectorAll('[data-toggle]').forEach(btn=>{
    btn.onclick = ()=>{
      const current = parseInt(btn.getAttribute('data-current'), 10);
      setParticipantChances(btn.getAttribute('data-toggle'), current === 2 ? 1 : 2);
    };
  });
}

/* ============ ARRANQUE ============ */
async function boot(){
  if(!dbOk){
    renderRoleGate();
    return;
  }
  await fetchAll();
  subscribeRealtime();
  if(role === 'editor' || role === 'espectador'){
    renderApp();
    if(role === 'editor') startChatListener();
  } else {
    renderRoleGate();
  }
}

boot();
