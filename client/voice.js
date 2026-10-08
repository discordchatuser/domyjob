import { useEffect, useRef, useState } from 'react';

export function useVoice({ value, onChange, onError, onFocus }) {
  const session = useRef(null);
  const callbacks = useRef({ value, onChange, onError, onFocus });
  callbacks.current = { value, onChange, onError, onFocus };
  const [status, setStatus] = useState('');
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const available = Boolean(Recognition) && window.isSecureContext !== false;
  function clearStartup(current) { if (current?.timer) clearTimeout(current.timer); }
  function cancel() {
    const previous = session.current; session.current = null;
    clearStartup(previous); previous?.recognition.abort(); setStatus('');
  }
  function stop() {
    if (session.current) { session.current.stopped = true; session.current.recognition.stop(); }
  }
  useEffect(() => {
    window.addEventListener('pagehide', cancel);
    return () => { window.removeEventListener('pagehide', cancel); cancel(); };
  }, []);
  function toggle() {
    if (session.current) return stop();
    if (!available) return callbacks.current.onError('Voice dictation is unavailable in this browser. Open this chat in Chrome or Safari and allow microphone access.');
    let recognition;
    try { recognition = new Recognition(); }
    catch (error) { callbacks.current.onError('Speech recognition is unavailable: ' + error.message); return; }
    const current = { recognition, base: callbacks.current.value };
    recognition.lang = navigator.language || 'en-US'; recognition.continuous = true; recognition.interimResults = true;
    const started = () => {
      if (session.current !== current) return;
      current.started = true; clearStartup(current); setStatus('Listening… Stop the mic to edit and send.');
    };
    recognition.onaudiostart = started;
    recognition.onresult = event => {
      if (session.current !== current) return;
      current.received = true; started();
      const transcript = Array.from(event.results, result => result[0].transcript).join(' ');
      callbacks.current.onChange(current.base + (current.base && !/\s$/.test(current.base) ? ' ' : '') + transcript);
    };
    recognition.onerror = event => {
      if (session.current !== current || event.error === 'aborted') return;
      current.failed = true; clearStartup(current);
      const messages = {
        'not-allowed': 'Microphone access was denied. Allow microphone access in your browser and try again.',
        'service-not-allowed': 'Your browser blocked speech recognition.',
        'audio-capture': 'No microphone is available. Connect a microphone and try again.',
        'no-speech': 'No speech detected. Try the microphone again.',
        network: 'Speech recognition could not connect. Check your connection and try again.',
      };
      callbacks.current.onError(messages[event.error] || 'Speech recognition failed: ' + event.error);
    };
    recognition.onend = () => {
      if (session.current !== current) return;
      clearStartup(current);
      if (!current.received && !current.failed && !current.stopped) callbacks.current.onError('No speech was captured. Check microphone permission for this site and your system, then try again.');
      session.current = null; setStatus(''); callbacks.current.onFocus();
    };
    session.current = current; callbacks.current.onError('');
    setStatus('Starting microphone… Allow access if your browser asks.');
    try {
      current.timer = setTimeout(() => {
        if (session.current !== current || current.started) return;
        callbacks.current.onError('The microphone did not start. Check microphone permission in your browser and system settings. If you are using an embedded browser, open this chat in Chrome or Safari.');
        cancel();
      }, 15000);
      recognition.start();
    } catch (error) { clearStartup(current); session.current = null; setStatus(''); callbacks.current.onError('Could not start the microphone: ' + error.message); }
  }
  return { available, listening: Boolean(status), status, toggle, stop, cancel };
}
