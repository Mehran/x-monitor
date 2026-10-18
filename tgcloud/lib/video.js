import { api, fetch, InputFile } from 'sdk';
import { DOWNLOAD_CHUNK_BYTES, MAX_UPLOAD_BYTES } from './config.js';

async function headSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) {
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 0) return len;
    }
  } catch {
    // fall through to a one-byte range probe
  }
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const match = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    if (match) return Number(match[1]);
  } catch {
    // size stays unknown
  }
  return 0;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Download a video in ranges. A single response is capped at 30 MB by the
 * platform, so anything bigger is fetched chunk by chunk and stitched here.
 */
export async function fetchVideo(url) {
  const size = await headSize(url);
  if (size > MAX_UPLOAD_BYTES) return { tooBig: true, size };
  if (size > 0) {
    const buffer = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const end = Math.min(offset + DOWNLOAD_CHUNK_BYTES, size) - 1;
      const res = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
      if (res.status !== 206) throw new Error(`Range request failed (${res.status})`);
      let written = 0;
      for await (const chunk of res.body) {
        const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (offset + written + view.length > size) throw new Error('Received more bytes than expected');
        buffer.set(view, offset + written);
        written += view.length;
      }
      if (written !== end - offset + 1) throw new Error('Incomplete range response');
      offset = end + 1;
    }
    return { bytes: buffer, size };
  }

  // Unknown length: read once, but refuse to upload a possibly truncated file.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) return { tooBig: true, size: total };
    chunks.push(chunk);
  }
  return { bytes: concat(chunks, total), size: total };
}

/** Small JPEG preview (Telegram wants < 200 kB and <= 320x320). */
export async function fetchThumbnail(url) {
  if (!url) return null;
  const thumbUrl = `${url}${url.includes('?') ? '&' : '?'}name=thumb`;
  try {
    const res = await fetch(thumbUrl);
    if (!res.ok) return null;
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > 200 * 1024) return null;
      chunks.push(chunk);
    }
    return total ? concat(chunks, total) : null;
  } catch {
    return null;
  }
}

export async function sendVideo(chatId, bytes, filename, caption, media, thumbBytes) {
  const params = {
    chat_id: chatId,
    video: new InputFile(bytes, filename, { type: 'video/mp4' }),
    caption,
    parse_mode: 'HTML',
    supports_streaming: true,
  };
  if (thumbBytes) params.thumbnail = new InputFile(thumbBytes, 'thumb.jpg', { type: 'image/jpeg' });
  if (media.width && media.height) {
    params.width = media.width;
    params.height = media.height;
  }
  if (media.duration) params.duration = Math.round(media.duration);
  return api.sendVideo(params);
}

/**
 * Large videos cannot be uploaded by a bot (50 MB cap), so they arrive as a
 * poster + caption with buttons: the play button streams the full-quality mp4
 * in Telegram's built-in player, the optional mirror button opens the public
 * copy made by the hosting service.
 */
export async function sendLinkCard(chatId, thumbBytes, caption, { playUrl, playLabel, mirrorUrl }) {
  const keyboard = [];
  if (playUrl) keyboard.push([{ text: playLabel, url: playUrl }]);
  if (mirrorUrl) keyboard.push([{ text: '🌐 Mirror', url: mirrorUrl }]);
  const reply_markup = keyboard.length ? { inline_keyboard: keyboard } : undefined;

  if (thumbBytes) {
    return api.sendPhoto({
      chat_id: chatId,
      photo: new InputFile(thumbBytes, 'thumb.jpg', { type: 'image/jpeg' }),
      caption,
      parse_mode: 'HTML',
      reply_markup,
    });
  }
  return api.sendMessage({
    chat_id: chatId,
    text: caption,
    parse_mode: 'HTML',
    reply_markup,
    disable_web_page_preview: true,
  });
}
