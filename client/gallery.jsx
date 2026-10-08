import React, { useEffect, useRef, useState } from 'react';

export function ImagePreview({ image, onOpen }) {
  return <button type="button" className="image-preview" aria-label="Open image gallery" onClick={() => onOpen(image.id)}><img src={image.url} alt="Chat image" loading="lazy" /></button>;
}

export function Gallery({ images, imageId, onClose }) {
  const dialog = useRef(null);
  const [index, setIndex] = useState(() => Math.max(0, images.findIndex(image => image.id === imageId)));
  const [copyStatus, setCopyStatus] = useState('Copy prompt');
  const image = images[Math.min(index, images.length - 1)];
  useEffect(() => { const node = dialog.current; node.showModal(); return () => node.close(); }, []);
  useEffect(() => { setCopyStatus('Copy prompt'); }, [image?.id]);
  if (!image) return null;
  const move = direction => setIndex(current => (current + direction + images.length) % images.length);
  const canCopy = image.prompt || (image.name && !['Generated image', 'Image'].includes(image.name) && !/\.(png|jpe?g|webp|gif)$/i.test(image.name));
  return <dialog ref={dialog} className="gallery" aria-label="Thread image gallery" onCancel={onClose} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); }
  }}>
    <div className="gallery-controls"><button type="button" onClick={onClose}>Close</button>
      {canCopy && <button type="button" className="copy-prompt" aria-live="polite" onClick={async () => {
        try { await navigator.clipboard.writeText(image.prompt || image.name); setCopyStatus('Copied'); } catch { setCopyStatus('Could not copy'); }
      }}>{copyStatus}</button>}
      <a href={image.url} download={image.id}>Download</a>
    </div>
    <div className="gallery-stage"><img className="gallery-full" src={image.url} alt={`Image ${index + 1}`} />
      <button type="button" className="gallery-step gallery-previous" aria-label="Previous image" disabled={images.length < 2} onClick={() => move(-1)}>◀</button>
      <button type="button" className="gallery-step gallery-next" aria-label="Next image" disabled={images.length < 2} onClick={() => move(1)}>▶</button>
    </div>
    <p className="gallery-caption">{index + 1} / {images.length}</p>
    <div className="gallery-thumbnails">{images.map((item, position) => <button key={item.id} type="button" aria-label={`View image ${position + 1}`} aria-pressed={position === index} onClick={() => setIndex(position)}><img src={item.url} alt={`Image ${position + 1}`} loading="lazy" /></button>)}</div>
  </dialog>;
}
