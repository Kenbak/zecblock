'use strict';

/**
 * CipherScan Data Bot — X API Client
 *
 * OAuth2 user-context posting via the X API v2.
 * Supports dry-run mode (logs posts without publishing).
 */

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;

class XClient {
  constructor({ accessToken, refreshToken, clientId, clientSecret, tokenFile, dryRun = false, logger = console }) {
    this.accessToken = accessToken;
    this.refreshTokenValue = refreshToken || '';
    this.clientId = clientId || '';
    this.clientSecret = clientSecret || '';
    this.tokenFile = tokenFile || null;
    this.dryRun = dryRun;
    this.logger = logger;
    this._refreshing = null;
  }

  /**
   * Attempt to refresh the token, retry once on 401.
   * Wraps any async post/upload operation.
   */
  async _withAutoRefresh(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.statusCode === 401 && this.refreshTokenValue && this.clientId) {
        this.logger.info('[XClient] Got 401, attempting token refresh...');
        await this._doRefresh();
        return await fn();
      }
      throw err;
    }
  }

  async _doRefresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      try {
        const result = await this.refreshToken({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          refreshToken: this.refreshTokenValue,
        });
        if (result.refresh_token) {
          this.refreshTokenValue = result.refresh_token;
        }
        this._persistTokens();
      } finally {
        this._refreshing = null;
      }
    })();
    return this._refreshing;
  }

  _persistTokens() {
    if (!this.tokenFile) return;
    try {
      let content = fs.readFileSync(this.tokenFile, 'utf8');
      content = content.replace(/^X_ACCESS_TOKEN=.*$/m, `X_ACCESS_TOKEN=${this.accessToken}`);
      if (this.refreshTokenValue) {
        content = content.replace(/^X_REFRESH_TOKEN=.*$/m, `X_REFRESH_TOKEN=${this.refreshTokenValue}`);
      }
      fs.writeFileSync(this.tokenFile, content, 'utf8');
      this.logger.info('[XClient] Tokens persisted to .env');
    } catch (err) {
      this.logger.warn(`[XClient] Failed to persist tokens: ${err.message}`);
    }
  }

  /**
   * Upload an image or MP4 video to X and return the media ID.
   * v2 chunked upload: initialize, append, finalize. A video is then
   * processed by X and is attachable only once that reports "succeeded".
   */
  async uploadMedia(filePath) {
    const data = fs.readFileSync(filePath);
    const video = filePath.endsWith('.mp4');
    const mediaType = video ? 'video/mp4' : filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const initBody = JSON.stringify({
      media_type: mediaType,
      media_category: video ? 'tweet_video' : 'tweet_image',
      total_bytes: data.length,
    });

    const mediaId = await this._apiRequest('api.x.com', '/2/media/upload/initialize', 'POST', initBody, {
      'Content-Type': 'application/json',
    }).then(res => {
      const id = res.data?.id || res.id || res.media_id_string;
      if (!id) throw new Error(`Init failed: ${JSON.stringify(res).slice(0, 200)}`);
      return id;
    });

    this.logger.info(`[XClient] Media init: ${mediaId}`);

    // X accepts segments up to 5 MB; images and short cards fit in one.
    for (let index = 0, offset = 0; offset < data.length; index++, offset += MEDIA_CHUNK_BYTES) {
      await this._appendChunk(mediaId, index, data.subarray(offset, offset + MEDIA_CHUNK_BYTES), mediaType, video ? 'video.mp4' : 'image.png');
    }

    this.logger.info(`[XClient] Media appended`);

    const finalRes = await this._apiRequest('api.x.com', `/2/media/upload/${mediaId}/finalize`, 'POST', '{}', {
      'Content-Type': 'application/json',
    });

    const finalId = finalRes.data?.id || finalRes.id || mediaId;
    const processing = finalRes.data?.processing_info || finalRes.processing_info;
    if (video || processing) await this._waitForProcessing(finalId, processing);
    this.logger.info(`[XClient] Media finalized: ${finalId}`);
    return finalId;
  }

  _appendChunk(mediaId, index, chunk, mediaType, filename) {
    const boundary = `----CipherScan${crypto.randomBytes(8).toString('hex')}`;
    const segIndexPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="segment_index"\r\n\r\n` +
      `${index}\r\n`
    );
    const mediaPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
      `Content-Type: ${mediaType}\r\n\r\n`
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([segIndexPart, mediaPart, chunk, suffix]);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.x.com',
        path: `/2/media/upload/${mediaId}/append`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(Object.assign(new Error(`Append failed (${res.statusCode}): ${data.slice(0, 200)}`), { statusCode: res.statusCode }));
          }
        });
      });
      req.setTimeout(20000, () => req.destroy(new Error('X API request timed out')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Poll X until an uploaded video is processed. A video that is still
   * pending after the deadline is not attached: the caller posts nothing.
   */
  async _waitForProcessing(mediaId, info, { deadlineMs = 120000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const started = Date.now();
    let state = info;
    for (;;) {
      if (!state || state.state === 'succeeded') return;
      if (state.state === 'failed') throw new Error(`Media processing failed: ${JSON.stringify(state.error || {}).slice(0, 200)}`);
      if (!['pending', 'in_progress'].includes(state.state)) throw new Error(`Unexpected media processing state: ${String(state.state).slice(0, 40)}`);
      if (Date.now() - started > deadlineMs) throw new Error('Media processing timed out');
      const wait = Number.isFinite(state.check_after_secs) ? Math.min(Math.max(state.check_after_secs, 1), 30) : 5;
      await sleep(wait * 1000);
      const res = await this._apiRequest('api.x.com', `/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`, 'GET');
      state = res.data?.processing_info || res.processing_info;
    }
  }

  _apiRequest(hostname, path, method, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname,
        path,
        method,
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          ...extraHeaders,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(Object.assign(new Error(`API ${path} (${res.statusCode}): ${data.slice(0, 300)}`), { statusCode: res.statusCode }));
            }
          } catch {
            reject(Object.assign(new Error(`API parse error ${path}: ${data.slice(0, 200)}`), { statusCode: res.statusCode }));
          }
        });
      });
      req.setTimeout(20000, () => req.destroy(new Error('X API request timed out')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * Post a tweet with an attached image card.
   * Uploads the image, then creates the tweet referencing it.
   * Falls back to text-only post if upload fails.
   */
  async postWithMedia(text, imagePath) {
    if (this.dryRun) {
      this.logger.info(`[XClient DRY RUN] Would post with media:\n${text}\nImage: ${imagePath}\n---`);
      return { id: `dry_run_${Date.now()}`, text };
    }

    return this._withAutoRefresh(async () => {
      let mediaId = null;
      try {
        mediaId = await this.uploadMedia(imagePath);
      } catch (err) {
        this.logger.warn(`[XClient] Media upload failed, falling back to text-only: ${err.message}`);
      }

      if (text.length > 280) {
        this.logger.warn(`[XClient] Post exceeds 280 chars (${text.length}), truncating`);
        text = text.slice(0, 277) + '...';
      }

      const tweetPayload = { text };
      if (mediaId) {
        tweetPayload.media = { media_ids: [mediaId] };
      }

      const body = JSON.stringify(tweetPayload);

      return new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.x.com',
            path: '/2/tweets',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (res.statusCode === 201 && parsed.data) {
                  this.logger.info(`[XClient] Posted tweet ${parsed.data.id}${mediaId ? ' (with media)' : ''}`);
                  resolve({ id: parsed.data.id, text: parsed.data.text });
                } else {
                  const errMsg = parsed.detail || parsed.title || JSON.stringify(parsed);
                  this.logger.error(`[XClient] Post failed (${res.statusCode}): ${errMsg}`);
                  reject(Object.assign(new Error(`X API ${res.statusCode}: ${errMsg}`), { statusCode: res.statusCode }));
                }
              } catch {
                reject(Object.assign(new Error(`X API response parse error: ${data.slice(0, 200)}`), { statusCode: res.statusCode }));
              }
            });
          }
        );
        req.setTimeout(20000, () => req.destroy(new Error('X API request timed out')));
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    });
  }

  /**
   * Post a tweet. Returns { id, text } on success, or throws on failure.
   */
  async post(text) {
    if (text.length > 280) {
      this.logger.warn(`[XClient] Post exceeds 280 chars (${text.length}), truncating`);
      text = text.slice(0, 277) + '...';
    }

    if (this.dryRun) {
      this.logger.info(`[XClient DRY RUN] Would post:\n${text}\n---`);
      return { id: `dry_run_${Date.now()}`, text };
    }

    return this._withAutoRefresh(() => this._postTweet(text));
  }

  /** Upload a video with token refresh. Nothing is posted by this call. */
  async uploadVideo(videoPath) {
    if (this.dryRun) return `dry_run_${Date.now()}`;
    return this._withAutoRefresh(() => this.uploadMedia(videoPath));
  }

  /**
   * Post with media that is already uploaded. Unlike postWithMedia there is
   * no text-only fallback: a replay without its video is not worth posting.
   */
  async postUploaded(text, mediaId) {
    if (!/^\d+$/.test(String(mediaId))) throw new Error('Invalid media ID');
    if (!text || text.length > 280) throw new Error('Invalid post copy');
    if (this.dryRun) return { id: `dry_run_${Date.now()}`, text };
    return this._withAutoRefresh(() => this._postTweet(text, undefined, [String(mediaId)]));
  }

  /** Reply only to a known parent. Source delivery persists its claim first. */
  async reply(text, parentId) {
    if (!/^\d+$/.test(String(parentId))) throw new Error('Invalid reply parent ID');
    if (!text || text.length > 280) throw new Error('Invalid source reply copy');
    if (this.dryRun) return { id: `dry_run_${Date.now()}`, text };
    return this._withAutoRefresh(() => this._postTweet(text, String(parentId)));
  }

  async _postTweet(text, parentId, mediaIds) {
    const payload = { text };
    if (parentId) payload.reply = { in_reply_to_tweet_id: parentId };
    if (mediaIds?.length) payload.media = { media_ids: mediaIds };
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.x.com',
          path: '/2/tweets',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode === 201 && parsed.data) {
                this.logger.info(`[XClient] Posted tweet ${parsed.data.id}`);
                resolve({ id: parsed.data.id, text: parsed.data.text });
              } else {
                const errMsg = parsed.detail || parsed.title || JSON.stringify(parsed);
                this.logger.error(`[XClient] Post failed (${res.statusCode}): ${errMsg}`);
                reject(Object.assign(new Error(`X API ${res.statusCode}: ${errMsg}`), { statusCode: res.statusCode }));
              }
            } catch {
              reject(Object.assign(new Error(`X API response parse error: ${data.slice(0, 200)}`), { statusCode: res.statusCode }));
            }
          });
        }
      );
      req.setTimeout(20000, () => req.destroy(new Error('X API request timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Refresh the OAuth2 access token using a refresh token.
   * Returns { access_token, refresh_token } or throws.
   */
  async refreshToken({ clientId, clientSecret, refreshToken }) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString();

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.x.com',
          path: '/2/oauth2/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode === 200 && parsed.access_token) {
                this.accessToken = parsed.access_token;
                this.logger.info('[XClient] Token refreshed successfully');
                resolve({
                  access_token: parsed.access_token,
                  refresh_token: parsed.refresh_token,
                });
              } else {
                reject(new Error(`Token refresh failed (${res.statusCode}): ${data.slice(0, 200)}`));
              }
            } catch {
              reject(new Error(`Token refresh parse error: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.setTimeout(20000, () => req.destroy(new Error('X API request timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = { XClient };
