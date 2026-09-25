// The panel is a thin shell: the bot already serves the whole view, so this only points at it and says so
// plainly when nothing is listening. Nothing here reads or touches the Showdown page.
const frame = document.getElementById('frame');
const off = document.getElementById('off');
const port = document.getElementById('port');

async function connect() {
  const value = Number(port.value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return;
  chrome.storage.local.set({ port: value });
  const base = `http://127.0.0.1:${value}`;
  try {
    // Ask for the state first: a dead port should show the instructions, not a browser error page.
    const response = await fetch(`${base}/state`, { cache: 'no-store' });
    if (!response.ok) throw new Error('bad status');
    off.classList.remove('on');
    frame.style.display = '';
    if (frame.src !== `${base}/`) frame.src = `${base}/`;
  } catch {
    frame.style.display = 'none';
    frame.removeAttribute('src');
    off.classList.add('on');
  }
}
document.getElementById('go').addEventListener('click', connect);
port.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
chrome.storage.local.get('port').then(({ port: saved }) => {
  if (saved) port.value = saved;
  connect();
});
// While it is offline, keep looking: the bot is usually started after the panel is opened.
setInterval(() => { if (off.classList.contains('on')) connect(); }, 3000);
