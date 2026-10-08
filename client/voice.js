export function createVoice({ button, prompt, status, error, onChange, browser = window }) {
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  let session = null;
  const available = Boolean(Recognition) && browser.isSecureContext !== false;
  button.hidden = !available;
  button.disabled = !available;
  const unsupported = 'Voice dictation is unavailable in this browser. Open this chat in Chrome or Safari and allow microphone access.';
  const clearStartup = current => { if (current?.timer) browser.clearTimeout(current.timer); };
  const update = () => {
    button.textContent = session ? 'Stop mic' : 'Mic';
    button.setAttribute('aria-pressed', String(Boolean(session)));
    prompt.readOnly = Boolean(session);
    status.textContent = session ? (session.started ? 'Listening… Stop the mic to edit and send.' : 'Starting microphone… Allow access if your browser asks.') : '';
  };
  button.title = Recognition ? 'Dictate a message (microphone permission required)' : 'Speech recognition is unavailable in this browser';
  update();
  function stop() { if (session) { session.stopped = true; session.recognition.stop(); } }
  function cancel() {
    const previous = session;
    session = null;
    clearStartup(previous);
    previous?.recognition.abort();
    update();
  }
  button.onclick = () => {
    if (!Recognition) { error(unsupported); return; }
    if (browser.isSecureContext === false) { error('Microphone access requires localhost or HTTPS. Open the chat at http://127.0.0.1:5173 (or port 3001 for production).'); return; }
    if (session) return stop();
    let recognition;
    try { recognition = new Recognition(); }
    catch (e) { error('Speech recognition is unavailable: ' + e.message); return; }
    const current = { recognition, base: prompt.value };
    recognition.lang = browser.navigator?.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onaudiostart = () => {
      if (session !== current) return;
      current.started = true; clearStartup(current); update();
    };
    recognition.onresult = event => {
      if (session !== current) return;
      current.received = true;
      current.started = true; clearStartup(current); update();
      const transcript = Array.from(event.results, result => result[0].transcript).join(' ');
      prompt.value = current.base + (current.base && !/\s$/.test(current.base) ? ' ' : '') + transcript;
      onChange();
    };
    recognition.onerror = event => {
      if (session !== current || event.error === 'aborted') return;
      current.failed = true;
      clearStartup(current);
      const messages = {
        'not-allowed': 'Microphone access was denied. Allow microphone access in your browser and try again.',
        'service-not-allowed': 'Your browser blocked speech recognition.',
        'audio-capture': 'No microphone is available. Connect a microphone and try again.',
        'no-speech': 'No speech detected. Try the microphone again.',
        network: 'Speech recognition could not connect. Check your connection and try again.',
      };
      error(messages[event.error] || 'Speech recognition failed: ' + event.error);
    };
    recognition.onend = () => {
      if (session !== current) return;
      clearStartup(current);
      if (!current.received && !current.failed && !current.stopped) error('No speech was captured. Check microphone permission for this site and your system, then try again.');
      session = null; update(); onChange(); prompt.focus();
    };
    session = current; error(); update();
    try {
      current.timer = browser.setTimeout(() => {
        if (session !== current || current.started) return;
        error('The microphone did not start. Check microphone permission in your browser and system settings. If you are using an embedded browser, open this chat in Chrome or Safari.');
        cancel();
      }, 15000);
      recognition.start();
    }
    catch (e) { clearStartup(current); session = null; update(); error('Could not start the microphone: ' + e.message); }
  };
  browser.addEventListener('pagehide', cancel);
  return { stop, cancel, get listening() { return Boolean(session); } };
}
