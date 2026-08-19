import { bootstrap } from './bootstrap';
import '@specter-core/ui/styles.css';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

bootstrap(root).catch((error) => {
  console.error('[specter-core] bootstrap failed', error);
  root.innerHTML =
    '<div style="padding:24px;font-family:sans-serif;color:#b00">' +
    '<h2>SpecterCore failed to start</h2>' +
    `<pre style="white-space:pre-wrap">${String(error)}</pre>` +
    '</div>';
});