'use strict';

// Encodes canvas frames to a looping GIF with ffmpeg. One palette is built
// from every frame and applied without dithering: the cards use flat colours,
// and dithering would add noise and size. Frames are piped, so nothing is
// written but the output file. Rejects when ffmpeg is missing or fails, or
// when the result is over X's 15 MB GIF limit.
const fs = require('fs');
const { spawn } = require('child_process');

const GIF_MAX_BYTES = 15 * 1024 * 1024;

async function encodeGif({ width, height, inputFps, outputFps = inputFps, count, frame, output, ffmpeg = 'ffmpeg', colors = 128 }) {
  if (!Number.isInteger(count) || count < 1) throw new Error('A GIF needs at least one frame');
  const filter = `${outputFps !== inputFps ? `fps=${outputFps},` : ''}split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full[p];[b][p]paletteuse=dither=none`;
  const child = spawn(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`,
    '-r', String(inputFps), '-i', '-', '-filter_complex', filter, '-loop', '0', output], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`))));
  });
  child.stdin.on('error', () => {});
  for (let i = 0; i < count; i++) {
    const buffer = await frame(i);
    if (!child.stdin.write(buffer)) await new Promise(resolve => child.stdin.once('drain', resolve));
  }
  child.stdin.end();
  await done;
  const bytes = fs.statSync(output).size;
  if (bytes > GIF_MAX_BYTES) throw new Error(`GIF is ${bytes} bytes, over X's 15 MB limit`);
  return { output, frames: count, fps: outputFps, seconds: count / inputFps, bytes };
}

module.exports = { encodeGif, GIF_MAX_BYTES };
