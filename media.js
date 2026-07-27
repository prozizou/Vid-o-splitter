/* =============================================================================
   MEDIA.JS — boîte à outils partagée par le Splitter.
   - Formatage (taille, durée), détection du type de fichier.
   - Sondage de durée sans décodage complet.
   - Outils du journal (copie / enregistrement).
   ========================================================================== */

// ==================== JOURNAL : COPIE ET ENREGISTREMENT ====================
// Les journaux sont longs et c'est presque toujours eux qui expliquent une
// lenteur ou un repli de moteur. Les sélectionner à la main sur téléphone est
// pénible : on ajoute un bouton de copie et un enregistrement en .txt.

/** Contexte technique joint à la copie : sans lui, un journal seul est ambigu. */
function diagnosticHeader() {
  const oui = b => (b ? 'oui' : 'non');
  const webcodecs = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'
    && typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
  return [
    `— Studio Vidéo · ${new Date().toISOString()}`,
    `page          : ${location.pathname}`,
    `navigateur    : ${navigator.userAgent}`,
    `WebCodecs     : ${oui(webcodecs)}`,
    `isolation COOP/COEP (multi-thread ffmpeg) : ${oui(self.crossOriginIsolated === true)}`,
    `coeurs        : ${navigator.hardwareConcurrency || '?'}`,
    `mémoire (Go)  : ${navigator.deviceMemory || '?'}`,
    '—',
    '',
  ].join('\n');
}

/**
 * Ajoute une barre « Copier / Enregistrer » au-dessus d'un journal.
 * La barre n'apparaît que lorsque le journal contient quelque chose.
 */
export function attachLogTools(logEl, filename = 'journal-studio-video.txt') {
  if (!logEl || logEl.dataset.toolsReady) return;
  logEl.dataset.toolsReady = '1';

  const bar = document.createElement('div');
  bar.className = 'log-tools hidden';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn btn-ghost btn-small';
  copyBtn.textContent = '📋 Copier le journal';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-ghost btn-small';
  saveBtn.textContent = '💾 Enregistrer (.txt)';

  const fullText = () => diagnosticHeader() + logEl.textContent;

  copyBtn.addEventListener('click', async () => {
    const texte = fullText();
    let ok = false;
    try {
      await navigator.clipboard.writeText(texte);
      ok = true;
    } catch {
      // Repli pour les contextes où l'API presse-papiers est refusée.
      const ta = document.createElement('textarea');
      ta.value = texte;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    copyBtn.textContent = ok ? '✅ Copié' : '❌ Copie refusée';
    setTimeout(() => { copyBtn.textContent = '📋 Copier le journal'; }, 2000);
  });

  saveBtn.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([fullText()], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  bar.append(copyBtn, saveBtn);
  logEl.parentNode.insertBefore(bar, logEl);

  // Le journal est rempli par du texte brut un peu partout dans le code :
  // plutôt que de modifier chaque appelant, on observe son contenu.
  const sync = () => bar.classList.toggle('hidden', !logEl.textContent.trim());
  new MutationObserver(sync).observe(logEl, { childList: true, characterData: true, subtree: true });
  sync();
}

export const fmtSize = b => `${(b / 1048576).toFixed(1)} Mo`;
export const fmtTime = s => {
  if (!isFinite(s) || s < 0) return '—';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
};
const isVideo = f => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name);

export function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(isVideo(file) ? 'video' : 'audio');
    const u = URL.createObjectURL(file);
    el.preload = 'metadata';
    el.onloadedmetadata = () => { URL.revokeObjectURL(u); resolve(el.duration || 0); };
    el.onerror = () => { URL.revokeObjectURL(u); reject(new Error('metadata')); };
    el.src = u;
  });
}
