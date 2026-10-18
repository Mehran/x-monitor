import { fetch } from 'sdk';

// Public video host that downloads the file itself ("remote upload"), so a
// >50 MB video never has to pass through this bot's upload path. The endpoint
// is the same one the site's own uploader uses.
const SITE = 'https://anonmp4.to';
const CLIENT_TOKEN = 'TVRNZDdMcTBZYzZMcTB4NzBMcTBJYjVOWGQ3YzZPRHg3YzZOcTBNMU5hNHg3YTQ';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Referer: `${SITE}/`,
};

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: fetch.body.form(fields),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Host returned ${res.status}`);
  }
  if (!res.ok || data.success === false || data.status === 'error') {
    throw new Error(data.message || data.error || `Host returned ${res.status}`);
  }
  return data;
}

/**
 * Ask the host to fetch `videoUrl` server-side.
 * Returns { watchUrl, embedUrl, id } or null when the host declines.
 */
export async function mirrorVideo(videoUrl) {
  if (!videoUrl) return null;
  try {
    const node = await postForm(`${SITE}/get-video-server`, {
      type: 'remoteserver',
      client_token: CLIENT_TOKEN,
    });
    if (!node.upload_url) return null;

    const result = await postForm(node.upload_url, { url: videoUrl });
    if (!result.watch_url) return null;
    return {
      id: result.video_id || '',
      watchUrl: result.watch_url,
      embedUrl: result.embed_url || '',
    };
  } catch (error) {
    console.error('mirror failed', error);
    return null;
  }
}
