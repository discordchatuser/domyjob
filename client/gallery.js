let dialog, images = [], index = 0, owner;
function show() {
  const image = images[index];
  const thumbnails = dialog.querySelector('.gallery-thumbnails');
  thumbnails.replaceChildren(...images.map((item, position) => {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-label', 'View image ' + (position + 1)); button.setAttribute('aria-pressed', String(position === index));
    const thumb = document.createElement('img'); thumb.src = item.url; thumb.alt = 'Image ' + (position + 1); thumb.loading = 'lazy'; button.append(thumb);
    button.onclick = () => { index = position; show(); }; return button;
  }));
  dialog.querySelector('.gallery-full').src = image.url;
  dialog.querySelector('.gallery-full').alt = 'Image ' + (index + 1);
  dialog.querySelector('.gallery-caption').textContent = `${index + 1} / ${images.length}`;
  const copy = dialog.querySelector('.copy-prompt');
  copy.textContent = 'Copy prompt';
  copy.hidden = !image.prompt && (!image.name || ['Generated image', 'Image'].includes(image.name) || /\.(png|jpe?g|webp|gif)$/i.test(image.name));
  const download = dialog.querySelector('a'); download.href = image.url; download.download = image.id;
  dialog.querySelectorAll('.gallery-step').forEach(button => { button.disabled = images.length < 2; });
}
export function closeGallery() { dialog?.close(); owner = null; }
export function syncGallery(chat) { if (owner && owner !== chat?.id) closeGallery(); }
export function openGallery(chat, imageId) {
  if (!chat?.images?.length) return;
  images = chat.images; owner = chat.id; index = Math.max(0, images.findIndex(image => image.id === imageId));
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.className = 'gallery'; dialog.setAttribute('aria-label', 'Thread image gallery');
    const controls = document.createElement('div'); controls.className = 'gallery-controls';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = closeGallery; controls.append(close);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-prompt'; copy.textContent = 'Copy prompt'; copy.setAttribute('aria-live', 'polite');
    copy.onclick = async () => {
      const image = images[index];
      try {
        await navigator.clipboard.writeText(image.prompt || image.name);
        if (images[index] === image) copy.textContent = 'Copied';
      } catch { if (images[index] === image) copy.textContent = 'Could not copy'; }
    };
    controls.append(copy);
    const download = document.createElement('a'); download.textContent = 'Download'; controls.append(download);
    const image = document.createElement('img'); image.className = 'gallery-full';
    const stage = document.createElement('div'); stage.className = 'gallery-stage'; stage.append(image);
    for (const [label, triangle, direction] of [['Previous image', '◀', -1], ['Next image', '▶', 1]]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'gallery-step ' + (direction === -1 ? 'gallery-previous' : 'gallery-next');
      button.textContent = triangle; button.setAttribute('aria-label', label); button.onclick = () => { index = (index + direction + images.length) % images.length; show(); }; stage.append(button);
    }
    const thumbnails = document.createElement('div'); thumbnails.className = 'gallery-thumbnails';
    const caption = document.createElement('p'); caption.className = 'gallery-caption';
    dialog.append(controls, stage, caption, thumbnails); document.body.append(dialog);
    dialog.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); index = (index + (event.key === 'ArrowLeft' ? -1 : 1) + images.length) % images.length; show(); }
    });
    dialog.addEventListener('click', event => { if (event.target === dialog) closeGallery(); });
  }
  show(); if (!dialog.open) dialog.showModal();
}
export function imagePreview(image, chat) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'image-preview'; button.setAttribute('aria-label', 'Open image gallery');
  const preview = document.createElement('img'); preview.src = image.url; preview.alt = 'Chat image'; preview.loading = 'lazy';
  button.append(preview); button.onclick = () => openGallery(chat, image.id); return button;
}
