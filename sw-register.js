/* Enregistrement du service worker.
   Ce code était en <script> inline dans chaque page. Il est sorti dans un
   fichier pour que la Content-Security-Policy puisse interdire tout script
   inline (`script-src 'self'`) — voir vercel.json. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err =>
      console.warn('SW non enregistré :', err));
  });
}
