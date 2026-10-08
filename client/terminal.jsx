import React, { useEffect, useRef, useState } from 'react';
import { terminalUpdate } from './terminal-state.js';

export function TerminalOutput({ server }) {
  const container = useRef(null);
  const terminal = useRef(null);
  const cursor = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false, observer, term;
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return;
      term = new Terminal({ convertEol: true, disableStdin: true, cursorBlink: false, scrollback: 10000, fontSize: 12, fontFamily: 'Menlo, Consolas, monospace', theme: { background: '#101214', foreground: '#d7dce2', black: '#15181c', red: '#f39791', green: '#b6d5a9', yellow: '#e8bf84', blue: '#8bb9ea', magenta: '#cfadf0', cyan: '#87d4d8', white: '#d7dce2', brightBlack: '#75808d', brightRed: '#ffada6', brightGreen: '#c6ebba', brightYellow: '#ffdb9d', brightBlue: '#aad0ff', brightMagenta: '#e4c7ff', brightCyan: '#a4eff3', brightWhite: '#ffffff' } });
      const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current);
      const resize = () => { if (container.current?.clientWidth && container.current?.clientHeight) fit.fit(); };
      resize();
      observer = new ResizeObserver(resize); observer.observe(container.current);
      terminal.current = term; cursor.current = null; setReady(true);
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; observer?.disconnect(); term?.dispose(); terminal.current = null; };
  }, []);
  useEffect(() => {
    if (!ready || !terminal.current) return;
    const update = terminalUpdate(cursor.current, server);
    if (update.reset) terminal.current.reset();
    if (update.text) terminal.current.write(update.text);
    cursor.current = update.cursor;
  }, [ready, server]);
  return <div className="terminal-output-wrapper">{error && <p role="alert">Could not load terminal: {error}</p>}<div ref={container} className="terminal-output" role="region" aria-label="Server console output" />{!server.output && <p className="terminal-empty">Start the server to see its output here.</p>}</div>;
}
