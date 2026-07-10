/* =============================================================================
   LYRICS — synchronisation de paroles au toucher, 100 % locale.

   Principe : la chanson joue, l'utilisateur appuie sur le gros bouton au début
   de chaque ligne. Chaque appui horodate la ligne courante et passe à la
   suivante. La fin d'une ligne = le début de la suivante (ou +4 s pour la
   dernière), comme dans les éditeurs de karaoké.

   - Export .lrc (lecteurs de musique, karaoké) et .srt (sous-titres vidéo).
   - Import .lrc pour corriger une synchro existante.
   - Sauvegarde automatique dans localStorage : rien n'est perdu si la page
     se ferme.
   ========================================================================== */

import { ui, wireDropZone, makeStatus, isVideo } from './media.js';

const els = ui(['dropZone','fileInput','lyricsText','loadLinesBtn','lrcInput','status',
  'syncBox','player','syncLines','tapBtn','backBtn','rewindBtn','restartBtn',
  'exportBox','dlLrc','dlSrt','logOutput']);

const setStatus = makeStatus(els.status);

let file = null;
let mediaURL = null;
let lines = [];      // [{ text, t: seconds|null }]
let cursor = 0;      // prochaine ligne à horodater
const STORE = 'lyrics-session-v1';

// ---------- Fichier média ----------
wireDropZone(els.dropZone, els.fileInput, f => {
  file = f;
  if (mediaURL) URL.revokeObjectURL(mediaURL);
  mediaURL = URL.createObjectURL(f);
  els.player.src = mediaURL;
  setStatus(`✅ ${f.name}${isVideo(f) ? ' — la piste audio de la vidéo sera utilisée.' : ''}`);
  els.loadLinesBtn.disabled = false;
  restoreSession(f);
});

els.lyricsText.addEventListener('input', () => {
  els.loadLinesBtn.disabled = !file || !els.lyricsText.value.trim();
});

// ---------- Préparation ----------
els.loadLinesBtn.addEventListener('click', () => {
  const raw = els.lyricsText.value.split('\n').map(s => s.trim());
  lines = raw.filter(Boolean).map(text => ({ text, t: null }));
  if (!lines.length) { setStatus('❌ Aucune ligne de paroles.', 'err'); return; }
  cursor = 0;
  renderLines();
  els.syncBox.classList.remove('hidden');
  els.exportBox.classList.add('hidden');
  els.player.currentTime = 0;
  setStatus(`📝 ${lines.length} lignes prêtes. Lancez la lecture puis tapez le gros bouton à chaque début de ligne.`);
  saveSession();
  els.syncBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------- Affichage des lignes ----------
function renderLines() {
  els.syncLines.innerHTML = '';
  lines.forEach((l, i) => {
    const div = document.createElement('div');
    div.className = 'sync-line' + (i === cursor ? ' current' : '') + (l.t !== null ? ' stamped' : '');
    div.innerHTML = `<span class="sync-time">${l.t !== null ? fmtLrc(l.t) : '--:--.--'}</span>
                     <span class="sync-text"></span>`;
    div.querySelector('.sync-text').textContent = l.text;
    div.addEventListener('click', () => {                 // reprendre à cette ligne
      cursor = i;
      if (l.t !== null) els.player.currentTime = Math.max(0, l.t - 2);
      renderLines();
    });
    els.syncLines.appendChild(div);
  });
  const cur = els.syncLines.children[cursor];
  if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  refreshExport();
}

const fmtLrc = t => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

// ---------- Synchronisation ----------
els.tapBtn.addEventListener('click', () => {
  if (cursor >= lines.length) return;
  if (els.player.paused) { els.player.play().catch(() => {}); }
  lines[cursor].t = els.player.currentTime;
  cursor++;
  renderLines();
  saveSession();
  if (cursor >= lines.length) {
    els.player.pause();
    setStatus('🎉 Toutes les lignes sont synchronisées. Exportez ou corrigez en tapant une ligne.');
  }
});

els.backBtn.addEventListener('click', () => {
  if (cursor === 0) return;
  cursor--;
  lines[cursor].t = null;
  const prev = cursor > 0 ? lines[cursor - 1].t : 0;
  els.player.currentTime = Math.max(0, (prev ?? 0));
  renderLines();
  saveSession();
});

els.rewindBtn.addEventListener('click', () => {
  els.player.currentTime = Math.max(0, els.player.currentTime - 5);
});

els.restartBtn.addEventListener('click', () => {
  lines.forEach(l => (l.t = null));
  cursor = 0;
  els.player.currentTime = 0;
  renderLines();
  saveSession();
});

// Barre espace = taper, sur clavier physique.
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !els.syncBox.classList.contains('hidden')
      && document.activeElement !== els.lyricsText) {
    e.preventDefault();
    els.tapBtn.click();
  }
});

// ---------- Import .lrc ----------
els.lrcInput.addEventListener('change', async () => {
  const f = els.lrcInput.files[0];
  if (!f) return;
  const text = await f.text();
  const parsed = [];
  for (const row of text.split('\n')) {
    const m = row.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) parsed.push({ t: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3].trim() });
    else if (row.trim() && !row.trim().startsWith('[')) parsed.push({ t: null, text: row.trim() });
  }
  if (!parsed.length) { setStatus('❌ Aucune ligne exploitable dans ce fichier.', 'err'); return; }
  lines = parsed.filter(l => l.text);
  els.lyricsText.value = lines.map(l => l.text).join('\n');
  cursor = lines.findIndex(l => l.t === null);
  if (cursor < 0) cursor = lines.length;
  els.syncBox.classList.remove('hidden');
  renderLines();
  setStatus(`📥 ${lines.length} lignes importées${cursor < lines.length ? `, reprise à la ligne ${cursor + 1}` : ' (déjà toutes synchronisées)'}.`);
  saveSession();
});

// ---------- Exports ----------
function refreshExport() {
  const stamped = lines.filter(l => l.t !== null).length;
  els.exportBox.classList.toggle('hidden', stamped === 0);
}

function download(name, text) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const baseName = () => (file ? file.name.replace(/\.[^.]+$/, '') : 'paroles');

els.dlLrc.addEventListener('click', () => {
  const stamped = lines.filter(l => l.t !== null);
  if (!stamped.length) return;
  const body = stamped
    .slice().sort((a, b) => a.t - b.t)
    .map(l => `[${fmtLrc(l.t)}]${l.text}`)
    .join('\n');
  download(`${baseName()}.lrc`, body + '\n');
  setStatus('✅ Fichier .lrc exporté.');
});

const fmtSrt = t => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
};

els.dlSrt.addEventListener('click', () => {
  const stamped = lines.filter(l => l.t !== null).slice().sort((a, b) => a.t - b.t);
  if (!stamped.length) return;
  const dur = els.player.duration || (stamped[stamped.length - 1].t + 4);
  const rows = stamped.map((l, i) => {
    const end = i + 1 < stamped.length ? Math.max(l.t + 0.5, stamped[i + 1].t - 0.05) : Math.min(l.t + 4, dur);
    return `${i + 1}\n${fmtSrt(l.t)} --> ${fmtSrt(end)}\n${l.text}\n`;
  });
  download(`${baseName()}.srt`, rows.join('\n'));
  setStatus('✅ Fichier .srt exporté. Utilisable comme sous-titres dans n\u2019importe quel lecteur vidéo.');
});

// ---------- Sauvegarde automatique ----------
function saveSession() {
  if (!file) return;
  try {
    localStorage.setItem(STORE, JSON.stringify({
      key: `${file.name}|${file.size}`,
      lines, cursor,
    }));
  } catch {}
}
function restoreSession(f) {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.key !== `${f.name}|${f.size}` || !Array.isArray(s.lines) || !s.lines.length) return;
    lines = s.lines;
    cursor = Math.min(s.cursor || 0, lines.length);
    els.lyricsText.value = lines.map(l => l.text).join('\n');
    els.syncBox.classList.remove('hidden');
    renderLines();
    setStatus(`🔄 Session retrouvée : ${lines.filter(l => l.t !== null).length}/${lines.length} lignes déjà synchronisées.`);
  } catch {}
}

window.addEventListener('beforeunload', () => { if (mediaURL) URL.revokeObjectURL(mediaURL); });
