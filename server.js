'use strict';

const express = require('express');
const multer  = require('multer');
const ffmpeg  = require('fluent-ffmpeg');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { execSync, execFile } = require('child_process');
const { createCanvas, loadImage } = require('canvas');

const PORT = process.env.PORT || 3000;
const app  = express();

// ── Security / COOP-COEP headers ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(__dirname, { index: false }));

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const startPage = process.env.START_PAGE;
  if (startPage) return res.sendFile(path.join(__dirname, startPage));
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/shapesshifter', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  dest:   os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 }, // 500 MB files, 10 MB fields
});

// ── Quality map ───────────────────────────────────────────────────────────────
const QUALITY_MAP = {
  high:   { crf: 18, webpQ: 90 },
  medium: { crf: 23, webpQ: 75 },
  low:    { crf: 28, webpQ: 55 },
};

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Scale filter builder ──────────────────────────────────────────────────────
function buildScaleFilter(width, aspect) {
  const noAspect = !aspect || aspect === 'original';

  if (!width && noAspect) return null;

  if (!noAspect) {
    const [aw, ah] = aspect.split(':').map(Number);
    if (width) {
      let scaleH = Math.round(width * ah / aw);
      if (scaleH % 2 !== 0) scaleH += 1;
      return `scale=${width}:${scaleH}`;
    }
    return `scale=iw:iw*${ah}/${aw}`;
  }

  // Only width provided
  return `scale=${width}:-2`;
}

// ── Auto-detect tool paths ────────────────────────────────────────────────────
function findBin(candidates) {
  for (const bin of candidates) {
    try {
      if (bin.startsWith('/')) {
        if (fs.existsSync(bin)) return bin;
      } else {
        execSync(`which ${bin}`, { stdio: 'ignore' });
        return bin;
      }
    } catch {}
  }
  return candidates[candidates.length - 1]; // fallback to last
}

const FFMPEG_BIN  = findBin(['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']);
const FFPROBE_BIN = findBin(['/opt/homebrew/opt/ffmpeg-full/bin/ffprobe', '/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe']);
const CONVERT_BIN = findBin(['/opt/homebrew/bin/convert', '/usr/bin/convert', '/usr/local/bin/convert', 'convert']);
const FONT_PATH   = findBin([
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]);

ffmpeg.setFfmpegPath(FFMPEG_BIN);
console.log('  FFMPEG_BIN:', FFMPEG_BIN);
console.log('  FFPROBE_BIN:', FFPROBE_BIN);
console.log('  CONVERT_BIN:', CONVERT_BIN);
console.log('  FONT_PATH:', FONT_PATH);

// Wrap execFile in a promise for async/await use
function run(bin, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    console.log('exec:', bin, args.join(' '));
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (stderr) console.log('stderr:', stderr);
      if (err) {
        const detail = stderr ? `\nffmpeg stderr:\n${stderr}` : '';
        reject(new Error(err.message + detail));
      } else {
        resolve();
      }
    });
  });
}

// ── Conversion runner ─────────────────────────────────────────────────────────
async function runConversion({ inputPath, inputFormat, outputPath, outputFormat, width, aspect, fps, qv }) {
  const scaleFilter = buildScaleFilter(width, aspect);

  console.log('Input file exists:', fs.existsSync(inputPath));
  console.log('Input file size:', fs.statSync(inputPath).size);
  console.log('Input file path:', inputPath);

  // ── WEBP → Video (ImageMagick WEBP→GIF, then ffmpeg GIF→MP4) ─────────────
  if (inputFormat === 'webp' && (outputFormat === 'mp4' || outputFormat === 'webm')) {
    if (!fs.existsSync(CONVERT_BIN)) {
      throw new Error('ImageMagick is required. Please run: brew install imagemagick');
    }
    const rand = Math.random().toString(36).slice(2, 8);
    const tempGif = path.join(os.tmpdir(), `vfe_tmp_${Date.now()}_${rand}.gif`);
    try {
      await run(CONVERT_BIN, [inputPath, '-coalesce', tempGif]);
      const vfParts = [];
      if (scaleFilter) vfParts.push(scaleFilter);
      if (fps) vfParts.push(`fps=${fps}`);
      const ffArgs = ['-i', tempGif];
      if (vfParts.length) ffArgs.push('-vf', vfParts.join(','));
      ffArgs.push('-c:v', 'libx264', '-crf', String(qv.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath);
      await run(FFMPEG_BIN, ffArgs);
    } finally {
      try { fs.unlinkSync(tempGif); } catch (_) {}
    }
    return;
  }

  // ── WEBP → GIF (ImageMagick directly) ────────────────────────────────────
  if (inputFormat === 'webp' && outputFormat === 'gif') {
    if (!fs.existsSync(CONVERT_BIN)) {
      throw new Error('ImageMagick is required. Please run: brew install imagemagick');
    }
    const imArgs = [inputPath, '-coalesce'];
    if (width) imArgs.push('-resize', `${width}x`);
    imArgs.push(outputPath);
    await run(CONVERT_BIN, imArgs);
    return;
  }

  // ── All other formats (fluent-ffmpeg) ───────────────────────────────────────
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    cmd.on('stderr', (line) => console.log('ffmpeg:', line));

    if (outputFormat === 'gif') {
      // Quality affects palette size: high=256 colours, medium=128, low=64
      const maxColors = qv.crf <= 18 ? 256 : qv.crf <= 23 ? 128 : 64;
      const dither    = qv.crf <= 18 ? 'bayer:bayer_scale=5' : qv.crf <= 23 ? 'bayer' : 'none';
      const parts   = [fps ? `fps=${fps}` : null, scaleFilter].filter(Boolean);
      const pre     = parts.join(',');
      const complex = pre
        ? `${pre},split[s0][s1];[s0]palettegen=max_colors=${maxColors}[p];[s1][p]paletteuse=dither=${dither}`
        : `split[s0][s1];[s0]palettegen=max_colors=${maxColors}[p];[s1][p]paletteuse=dither=${dither}`;
      cmd.complexFilter(complex).outputOptions(['-loop', '0']);

    } else if (outputFormat === 'webp') {
      const scaleW  = width || 'iw';
      const fpsVal  = fps   || 15;
      const vf      = `fps=${fpsVal},scale=${scaleW}:-1:flags=lanczos`;
      cmd
        .outputOptions([
          '-vf',               vf,
          '-vcodec',           'libwebp',
          '-lossless',         '0',
          '-compression_level','6',
          '-q:v',              String(qv.webpQ),
          '-loop',             '0',
          '-preset',           'picture',
          '-an',
          '-vsync',            '0',
        ]);

    } else {
      // mp4 / webm
      if (scaleFilter) cmd.videoFilters(scaleFilter);
      cmd.outputOptions(['-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-crf', String(qv.crf)]);
    }

    // 2-minute timeout — kill ffmpeg if it hangs
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        cmd.kill('SIGKILL');
        reject(new Error('Conversion timed out after 120 seconds'));
      }
    }, 120_000);

    cmd
      .output(outputPath)
      .on('end', () => {
        if (!done) { done = true; clearTimeout(timer); resolve(); }
      })
      .on('error', (err) => {
        if (!done) { done = true; clearTimeout(timer); reject(err); }
      })
      .run();
  });
}

// ── Convert endpoint ──────────────────────────────────────────────────────────
app.post('/convert', upload.single('file'), async (req, res) => {
  let inputPath = req.file ? req.file.path : null;
  let renamedInputPath = null;
  let outputPath  = null;
  let outputFormat = 'mp4';

  try {
    if (!inputPath) throw new Error('No file uploaded');

    outputFormat = (req.body.outputFormat || 'mp4').toLowerCase();
    const width        = parseInt(req.body.width)  || null;
    const aspect       = req.body.aspect || 'original';
    const fps          = parseInt(req.body.fps)    || null;
    const quality      = req.body.quality || 'medium';
    const outputName   = req.body.outputName || ('output.' + outputFormat);

    const qv = QUALITY_MAP[quality] || QUALITY_MAP.medium;

    // Detect input format from original filename and rename temp file so ffmpeg
    // can detect the container (multer strips extensions from temp files)
    const origExt = path.extname(req.file.originalname || '').slice(1).toLowerCase();
    console.log(`[convert] ${origExt || '?'} → ${outputFormat} | input: ${inputPath}`);
    const inputFormat = origExt || null;
    if (origExt) {
      renamedInputPath = `${inputPath}.${origExt}`;
      fs.renameSync(inputPath, renamedInputPath);
      inputPath = renamedInputPath;
    }

    const rand = Math.random().toString(36).slice(2, 8);
    outputPath = path.join(os.tmpdir(), `vfe_${Date.now()}_${rand}.${outputFormat}`);

    await runConversion({ inputPath, inputFormat, outputPath, outputFormat, width, aspect, fps, qv });

    res.download(outputPath, outputName, (err) => {
      try { fs.unlinkSync(inputPath);  } catch (_) {}
      try { fs.unlinkSync(outputPath); } catch (_) {}
      if (err && !res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

  } catch (err) {
    try { if (inputPath)  fs.unlinkSync(inputPath);  } catch (_) {}
    try { if (outputPath) fs.unlinkSync(outputPath); } catch (_) {}
    const msg = (err.message || '').toLowerCase().includes('encoder not found') && outputFormat === 'webp'
      ? 'WEBP encoding requires ffmpeg with libwebp support. Please run: brew reinstall ffmpeg — Then restart the server.'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

// ── Progress tracking for burn-captions jobs ──────────────────────────────────
const burnProgress = new Map();

app.get('/api/burn-progress', (req, res) => {
  const pct = burnProgress.get(req.query.id);
  res.json({ pct: pct !== undefined ? pct : -1 });
});

// ── Preview conversion progress + endpoint ────────────────────────────────────
const previewProgress = new Map();

app.get('/api/preview-progress', (req, res) => {
  const pct = previewProgress.get(req.query.id);
  res.json({ pct: pct !== undefined ? pct : -1 });
});

app.post('/api/preview-convert', upload.single('file'), async (req, res) => {
  let inputPath = req.file ? req.file.path : null;
  let step0Path = null, step1Path = null;
  const jobId = (req.body && req.body.jobId) || Math.random().toString(36).slice(2);
  const ext   = ((req.body && req.body.ext) || '').toLowerCase();

  previewProgress.set(jobId, 5);

  function cleanPrev() {
    for (const p of [inputPath, step0Path, step1Path]) {
      if (p) try { fs.unlinkSync(p); } catch(_) {}
    }
  }

  try {
    if (!inputPath) throw new Error('No file uploaded');

    const renamed = `${inputPath}.${ext || 'bin'}`;
    fs.renameSync(inputPath, renamed);
    inputPath = renamed;

    const rand  = Math.random().toString(36).slice(2, 8);
    const mkTmp = (tag) => path.join(os.tmpdir(), `vfe_prev_${Date.now()}_${rand}_${tag}`);

    let mp4Input = inputPath;
    previewProgress.set(jobId, 20);

    if (ext === 'webp') {
      // WEBP → GIF via ImageMagick, then GIF → MP4
      if (!fs.existsSync(CONVERT_BIN)) throw new Error('ImageMagick not found at ' + CONVERT_BIN);
      step0Path = mkTmp('s0.gif');
      await run(CONVERT_BIN, [inputPath, '-coalesce', step0Path]);
      mp4Input = step0Path;
    }
    previewProgress.set(jobId, 55);

    step1Path = mkTmp('preview.mp4');
    await run(FFMPEG_BIN, [
      '-i', mp4Input,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart',
      step1Path
    ]);
    previewProgress.set(jobId, 95);

    if (!fs.existsSync(step1Path)) throw new Error('Preview output missing');

    res.download(step1Path, 'preview.mp4', () => {
      previewProgress.delete(jobId);
      cleanPrev();
    });
  } catch(err) {
    console.error('[preview-convert] ERROR:', err.message);
    previewProgress.delete(jobId);
    cleanPrev();
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Burn-captions endpoint ────────────────────────────────────────────────────
app.post('/api/burn-captions', upload.single('video'), async (req, res) => {
  let inputPath  = req.file ? req.file.path : null;
  let capPngPath = null;
  let ctaPngPath = null;
  let ptrPngPath = null;
  let step0Path  = null;
  let step1Path  = null;
  let step2Path  = null;
  let step3Path  = null;
  let step4Path  = null;

  const jobId = (req.body && req.body.jobId) || Math.random().toString(36).slice(2);
  burnProgress.set(jobId, 0);

  function setProgress(pct) {
    burnProgress.set(jobId, pct);
    console.log(`[burn:${jobId}] ${pct}%`);
  }

  function cleanupAll(keep) {
    for (const p of [inputPath, capPngPath, ctaPngPath, ptrPngPath, step0Path, step1Path, step2Path, step3Path, step4Path]) {
      if (p && p !== keep) try { fs.unlinkSync(p); } catch (_) {}
    }
    if (keep) try { fs.unlinkSync(keep); } catch (_) {}
  }

  function runStep(args) {
    return new Promise((resolve, reject) => {
      console.log('[burn] ffmpeg', args.join(' '));
      let done = false;
      const proc = execFile(FFMPEG_BIN, args, { timeout: 120000 }, (err, stdout, stderr) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (stderr) console.log('[burn] stderr:', stderr.slice(-400));
        if (err) reject(new Error(err.message + (stderr ? '\n' + stderr.slice(-300) : '')));
        else resolve();
      });
      const timer = setTimeout(() => {
        if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }
      }, 120000);
    });
  }

  // node-canvas helper: draw rounded rect path
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Wrap text using fixed 32px reference size for consistent line breaks (matches preview)
  function wrapLines(ctx, text, maxW) {
    const saved = ctx.font;
    ctx.font = 'bold 32px Arial, sans-serif';
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; }
      else { line = test; }
    }
    if (line) lines.push(line);
    ctx.font = saved;
    return lines.length ? lines : [''];
  }

  try {
    if (!inputPath) throw new Error('No video uploaded');

    const origExt = path.extname(req.file.originalname || '').slice(1).toLowerCase() || 'mp4';
    const renamed = `${inputPath}.${origExt}`;
    fs.renameSync(inputPath, renamed);
    inputPath = renamed;

    const {
      captionText, captionStyle, captionFontSize, captionPosX, captionPosY, captionMaxWidth,
      ctaEnabled, ctaText, ctaFontSize, ctaBgColor, ctaTextColor, ctaPosX, ctaPosY,
      pointerEnabled, pointerType, pointerSize, pointerPosX, pointerPosY,
      ctaSpeed, pointerSpeed, outputName,
      videoSpeed: videoSpeedStr, trimStart: trimStartStr, trimEnd: trimEndStr,
      outputWidth: outputWidthStr, outputHeight: outputHeightStr,
    } = req.body;

    const rand = Math.random().toString(36).slice(2, 8);
    const mkTmp = (tag) => path.join(os.tmpdir(), `vfe_burn_${Date.now()}_${rand}_${tag}`);
    const encodeArgs = ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

    // ── ffprobe ───────────────────────────────────────────────────────────────
    setProgress(5);
    const { videoW, videoH, hasAudio } = await new Promise((resolve, reject) => {
      execFile(FFPROBE_BIN, ['-v', 'quiet', '-print_format', 'json', '-show_streams', inputPath],
        { timeout: 15000 }, (err, stdout) => {
          if (err) return reject(new Error('ffprobe: ' + err.message));
          try {
            const data = JSON.parse(stdout);
            const vs = data.streams.find(s => s.codec_type === 'video');
            if (!vs) return reject(new Error('No video stream'));
            const as = data.streams.find(s => s.codec_type === 'audio');
            resolve({ videoW: vs.width, videoH: vs.height, hasAudio: !!as });
          } catch (e) { reject(new Error('ffprobe parse: ' + e.message)); }
        });
    });
    console.log(`[burn] ${videoW}x${videoH}`);

    const hasCaption = !!(captionText && captionText.trim());
    const useCTA     = ctaEnabled === 'true' && !!(ctaText && ctaText.trim());
    const usePointer = pointerEnabled === 'true' && !!pointerType;

    let currentInput = inputPath;

    // ── STEP 0: Trim / Speed ──────────────────────────────────────────────────
    const videoSpeed = parseFloat(videoSpeedStr) || 1.0;
    const trimStart  = parseFloat(trimStartStr)  || 0;
    const trimEnd    = parseFloat(trimEndStr)    || 0;

    function buildAtempoChain(spd) {
      const parts = [];
      let s = spd;
      while (s < 0.499) { parts.push('atempo=0.5'); s /= 0.5; }
      while (s > 2.001) { parts.push('atempo=2.0'); s /= 2.0; }
      if (Math.abs(s - 1.0) > 0.001) parts.push(`atempo=${s.toFixed(4)}`);
      return parts;
    }

    const needsStep0 = Math.abs(videoSpeed - 1.0) > 0.001 || trimStart > 0 || (trimEnd > 0 && trimEnd > trimStart);
    if (needsStep0) {
      setProgress(8);
      const s0Args = [];
      if (trimStart > 0)                      s0Args.push('-ss', String(trimStart));
      if (trimEnd > 0 && trimEnd > trimStart) s0Args.push('-to', String(trimEnd));
      s0Args.push('-i', currentInput);

      const vfParts = [];
      const afParts = [];
      if (Math.abs(videoSpeed - 1.0) > 0.001) {
        vfParts.push(`setpts=${(1 / videoSpeed).toFixed(4)}*PTS`);
        if (hasAudio) afParts.push(...buildAtempoChain(videoSpeed));
      }
      if (vfParts.length) s0Args.push('-vf', vfParts.join(','));
      if (afParts.length) {
        s0Args.push('-af', afParts.join(','), '-map', '0:a?');
      } else {
        s0Args.push('-map', '0:a?', '-c:a', 'copy');
      }
      step0Path = mkTmp('s0.mp4');
      s0Args.push(...encodeArgs, step0Path);
      await runStep(s0Args);
      currentInput = step0Path;
    }

    // ── STEP 1 (0–30%): overlay caption PNG ─────────────────────────────────────
    setProgress(10);
    if (hasCaption) {
      const { captionOverlayData } = req.body;
      if (captionOverlayData && captionOverlayData.startsWith('data:image/png;base64,')) {
        // Use browser-rendered overlay (exact font metrics match)
        const base64 = captionOverlayData.slice('data:image/png;base64,'.length);
        capPngPath = mkTmp('cap.png');
        fs.writeFileSync(capPngPath, Buffer.from(base64, 'base64'));
      } else {
        // Fallback: render via node-canvas
        const fontSize = parseInt(captionFontSize) || 32;
        const maxWpct  = parseFloat(captionMaxWidth) || 60;
        const posX     = parseFloat(captionPosX) || 50;
        const posY     = parseFloat(captionPosY) || 75;
        const isBow    = captionStyle !== 'wob';
        const padX = 16, padY = 8;
        const maxW = videoW * (maxWpct / 100);

        const capCv  = createCanvas(videoW, videoH);
        const capCtx = capCv.getContext('2d');
        capCtx.font = `bold ${fontSize}px Arial, sans-serif`;
        capCtx.textBaseline = 'middle';
        capCtx.textAlign    = 'center';

        const lines  = wrapLines(capCtx, captionText.trim(), maxW - padX * 2);
        const pillH  = fontSize + padY * 2;
        const blockH = lines.length * pillH;
        const centerX = videoW * (posX / 100);
        const blockY  = videoH * (posY / 100) - blockH / 2;

        lines.forEach((ln, i) => {
          const lineW = capCtx.measureText(ln).width + padX * 2;
          const pillX = centerX - lineW / 2;
          const pillY = blockY + i * pillH;
          capCtx.fillStyle = isBow ? '#ffffff' : '#000000';
          roundRectPath(capCtx, pillX, pillY, lineW, pillH, 8);
          capCtx.fill();
          capCtx.fillStyle = isBow ? '#000000' : '#ffffff';
          capCtx.fillText(ln, centerX, pillY + pillH / 2);
        });

        capPngPath = mkTmp('cap.png');
        fs.writeFileSync(capPngPath, capCv.toBuffer('image/png'));
      }

      step1Path = mkTmp('s1.mp4');
      await runStep([
        '-i', currentInput, '-i', capPngPath,
        '-filter_complex', '[0:v][1:v]overlay=0:0',
        '-map', '0:a?', '-c:a', 'copy', '-shortest',
        ...encodeArgs, step1Path,
      ]);
      currentInput = step1Path;
    }
    setProgress(35);

    // ── STEP 2 (30–60%): CTA pre-rendered animation via node-canvas + chromakey ──
    if (useCTA) {
      const fontSize  = parseInt(ctaFontSize) || 28;
      const btnPadX   = fontSize;
      const btnPadY   = Math.round(fontSize * 0.5);

      // Measure text for button dimensions
      const mCv  = createCanvas(1, 1);
      const mCtx = mCv.getContext('2d');
      mCtx.font  = `bold ${fontSize}px Arial, sans-serif`;
      const textW = mCtx.measureText(ctaText.trim()).width;
      const btnW  = Math.ceil(textW + btnPadX * 2);
      const btnH  = Math.ceil(fontSize + btnPadY * 2);

      // Frame canvas: 1.5× button size so the scaled button never clips at 1.18×
      // Must be even for libx264
      const cvW = Math.ceil(btnW * 1.5 / 2) * 2;
      const cvH = Math.ceil(btnH * 1.5 / 2) * 2;

      const speedVal   = { slow: 1.5, medium: 2.5, fast: 4.0 }[ctaSpeed] || 2.5;
      const fps        = 30;
      const totalFrames = Math.round(fps / speedVal); // one full abs(sin) pulse cycle

      // Temp directory for PNG frames
      const frameDir = path.join(os.tmpdir(), `vfe_ctaf_${Date.now()}_${rand}`);
      fs.mkdirSync(frameDir);

      try {
        for (let i = 0; i < totalFrames; i++) {
          const t     = i / fps;
          const scale = 1 + 0.09 * (1 - Math.cos(2 * Math.PI * t * speedVal));

          const fCv  = createCanvas(cvW, cvH);
          const fCtx = fCv.getContext('2d');

          // Green background for chromakey
          fCtx.fillStyle = '#00ff00';
          fCtx.fillRect(0, 0, cvW, cvH);

          // Scale the entire button (box + text together) around the canvas center
          fCtx.save();
          fCtx.translate(cvW / 2, cvH / 2);
          fCtx.scale(scale, scale);
          fCtx.font         = `bold ${fontSize}px Arial, sans-serif`;
          fCtx.textBaseline = 'middle';
          fCtx.textAlign    = 'center';
          fCtx.fillStyle    = ctaBgColor || '#FFD700';
          roundRectPath(fCtx, -btnW / 2, -btnH / 2, btnW, btnH, 12);
          fCtx.fill();
          fCtx.fillStyle = ctaTextColor || '#000000';
          fCtx.fillText(ctaText.trim(), 0, 0);
          fCtx.restore();

          fs.writeFileSync(
            path.join(frameDir, `frame_${String(i).padStart(3, '0')}.png`),
            fCv.toBuffer('image/png'),
          );
        }

        // PNG sequence → looping MP4
        const ctaAnimPath = mkTmp('cta_anim.mp4');
        ctaPngPath = ctaAnimPath; // so cleanupAll removes it
        await runStep([
          '-framerate', String(fps),
          '-i', path.join(frameDir, 'frame_%03d.png'),
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ctaAnimPath,
        ]);
      } finally {
        try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (_) {}
      }

      // pixelX = (xPercent / 100) * actualVideoWidth  (ffprobe dims)
      // elementLeft = pixelX - elementWidth / 2
      const ctaCX  = Math.round((parseFloat(ctaPosX) / 100) * videoW);
      const ctaCY  = Math.round((parseFloat(ctaPosY) / 100) * videoH);
      const ovX    = ctaCX - Math.floor(cvW / 2);
      const ovY    = ctaCY - Math.floor(cvH / 2);

      step2Path = mkTmp('s2.mp4');
      await runStep([
        '-i', currentInput,
        '-stream_loop', '-1', '-i', ctaPngPath,
        '-filter_complex',
          `[1:v]colorkey=0x00ff00:0.3:0.1[ctakeyed];` +
          `[0:v][ctakeyed]overlay=x=${ovX}:y=${ovY}:shortest=1[out]`,
        '-map', '[out]', '-map', '0:a?', '-c:a', 'copy',
        ...encodeArgs, step2Path,
      ]);
      currentInput = step2Path;
    }
    setProgress(65);

    // ── STEP 3 (60–90%): render pointer PNG, bounce animation ────────────────
    if (usePointer) {
      const imgFile = pointerType === 'hand' ? 'handCTA.png' : 'arrowCTA.png';
      const imgPath = path.join(__dirname, imgFile);
      if (!fs.existsSync(imgPath)) throw new Error(`Pointer image not found: ${imgFile}`);

      const ptrW = parseInt(pointerSize) || 80;
      // pixelX = (xPercent / 100) * actualVideoWidth  (ffprobe dims)
      const ptrX = Math.round((parseFloat(pointerPosX) / 100) * videoW);
      const ptrY = Math.round((parseFloat(pointerPosY) / 100) * videoH);
      const ctaX = Math.round((parseFloat(ctaPosX) / 100) * videoW);
      const ctaY = Math.round((parseFloat(ctaPosY) / 100) * videoH);
      // PSPEED: frequency in Hz — offsetX = offsetY = 10 * sin(2π * t * PSPEED)
      const pspeed = { slow: 0.8, medium: 1.5, fast: 3.0 }[pointerSpeed] || 1.5;

      // Direction toward CTA
      const dx = ctaX - ptrX, dy = ctaY - ptrY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = (dx / len).toFixed(4), ny = (dy / len).toFixed(4);

      // Render pointer at target size, rotated toward CTA for arrow type
      const srcImg = await loadImage(imgPath);
      const ratio  = srcImg.naturalHeight / srcImg.naturalWidth;
      const ptrH   = Math.round(ptrW * ratio) || ptrW;
      const angle  = pointerType === 'arrow' ? Math.atan2(dy, dx) : 0;

      // Use diagonal canvas so rotation doesn't clip corners
      const diag  = Math.ceil(Math.sqrt(ptrW * ptrW + ptrH * ptrH));
      const ptrCv = createCanvas(diag, diag);
      const pCtx  = ptrCv.getContext('2d');
      pCtx.translate(diag / 2, diag / 2);
      pCtx.rotate(angle);
      pCtx.drawImage(srcImg, -ptrW / 2, -ptrH / 2, ptrW, ptrH);

      ptrPngPath = mkTmp('ptr.png');
      fs.writeFileSync(ptrPngPath, ptrCv.toBuffer('image/png'));

      // Center of diagonal canvas = center of pointer image
      const half = Math.floor(diag / 2);

      step3Path = mkTmp('s3.mp4');
      await runStep([
        '-i', currentInput, '-i', ptrPngPath,
        '-filter_complex',
          `[0:v][1:v]overlay=` +
          `x='${ptrX - half}+${nx}*10*sin(2*PI*t*${pspeed})':` +
          `y='${ptrY - half}+${ny}*10*sin(2*PI*t*${pspeed})':eval=frame`,
        '-map', '0:a?', '-c:a', 'copy', '-shortest',
        ...encodeArgs, step3Path,
      ]);
      currentInput = step3Path;
    }
    setProgress(90);

    // ── STEP 4: Crop / Scale to output resolution ─────────────────────────────
    const outputWidth  = parseInt(outputWidthStr)  || 0;
    const outputHeight = parseInt(outputHeightStr) || 0;
    const cropW = parseInt(req.body.cropW) || 0;
    const cropH = parseInt(req.body.cropH) || 0;
    // Clamp crop offset so it never causes an out-of-bounds ffmpeg error
    const rawCropX = parseInt(req.body.cropX) || 0;
    const rawCropY = parseInt(req.body.cropY) || 0;
    const cropX = Math.max(0, Math.min(rawCropX, Math.max(0, videoW - cropW)));
    const cropY = Math.max(0, Math.min(rawCropY, Math.max(0, videoH - cropH)));
    // Only crop when the requested region fits inside the source video
    const canCrop = cropW > 0 && cropH > 0 && cropW <= videoW && cropH <= videoH;
    if (outputWidth > 0 || outputHeight > 0 || canCrop) {
      const filters = [];
      if (canCrop) {
        filters.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
      }
      if (outputWidth > 0 || outputHeight > 0) {
        const scaleW = outputWidth  > 0 ? outputWidth  : -2;
        const scaleH = outputHeight > 0 ? outputHeight : -2;
        filters.push(`scale=${scaleW}:${scaleH}`);
      }
      const vfFilter = filters.join(',');
      if (vfFilter) {
        step4Path = mkTmp('s4.mp4');
        await runStep([
          '-i', currentInput,
          '-vf', vfFilter,
          '-map', '0:a?', '-c:a', 'copy',
          ...encodeArgs, step4Path,
        ]);
        currentInput = step4Path;
      }
    }

    if (!fs.existsSync(currentInput)) throw new Error('Processing produced no output file');
    setProgress(95);

    const dlName = outputName || 'captioned.mp4';
    res.download(currentInput, dlName, (dlErr) => {
      burnProgress.delete(jobId);
      cleanupAll(currentInput);
      if (dlErr && !res.headersSent) res.status(500).json({ error: dlErr.message });
    });

  } catch (err) {
    console.error('[burn-captions] ERROR:', err);
    burnProgress.delete(jobId);
    cleanupAll(null);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Shared burn pipeline helper (used by 28s/56s endpoints) ──────────────────
async function runBurnPipeline(inputPath, body, setProgress, rand) {
  let capPngPath = null;
  let ctaPngPath = null;
  let ptrPngPath = null;
  let step0Path  = null;
  let step1Path  = null;
  let step2Path  = null;
  let step3Path  = null;
  let step4Path  = null;

  const tempFiles = () => [capPngPath, ctaPngPath, ptrPngPath, step0Path, step1Path, step2Path, step3Path, step4Path];
  const cleanupPipeline = (keep) => {
    for (const p of tempFiles()) {
      if (p && p !== keep) try { fs.unlinkSync(p); } catch (_) {}
    }
  };

  const mkTmp = (tag) => path.join(os.tmpdir(), `vfe_lp_${Date.now()}_${rand}_${tag}`);
  const encodeArgs = ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

  function runStep(args) {
    return new Promise((resolve, reject) => {
      let done = false;
      const proc = execFile(FFMPEG_BIN, args, {}, (err, stdout, stderr) => {
        if (done) return; done = true; clearTimeout(timer);
        if (stderr) console.log('[lp] stderr:', stderr.slice(-400));
        if (err) reject(new Error(err.message + (stderr ? '\n' + stderr.slice(-300) : '')));
        else resolve();
      });
      const timer = setTimeout(() => { if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); } }, 120000);
    });
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  function wrapLines(ctx, text, maxW) {
    const saved = ctx.font; ctx.font = 'bold 32px Arial, sans-serif';
    const words = text.split(/\s+/); const lines = []; let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; }
      else { line = test; }
    }
    if (line) lines.push(line); ctx.font = saved;
    return lines.length ? lines : [''];
  }

  const {
    captionText, captionStyle, captionFontSize, captionPosX, captionPosY, captionMaxWidth,
    ctaEnabled, ctaText, ctaFontSize, ctaBgColor, ctaTextColor, ctaPosX, ctaPosY,
    pointerEnabled, pointerType, pointerSize, pointerPosX, pointerPosY,
    ctaSpeed, pointerSpeed,
    videoSpeed: videoSpeedStr, trimStart: trimStartStr, trimEnd: trimEndStr,
    outputWidth: outputWidthStr, outputHeight: outputHeightStr,
  } = body;

  // ffprobe
  setProgress(5);
  const { videoW, videoH, hasAudio, videoDuration } = await new Promise((resolve, reject) => {
    execFile(FFPROBE_BIN, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath],
      { timeout: 15000 }, (err, stdout) => {
        if (err) return reject(new Error('ffprobe: ' + err.message));
        try {
          const data = JSON.parse(stdout);
          const vs = data.streams.find(s => s.codec_type === 'video');
          if (!vs) return reject(new Error('No video stream'));
          const as = data.streams.find(s => s.codec_type === 'audio');
          const dur = parseFloat(data.format && data.format.duration) || parseFloat(vs.duration) || 0;
          resolve({ videoW: vs.width, videoH: vs.height, hasAudio: !!as, videoDuration: dur });
        } catch (e) { reject(new Error('ffprobe parse: ' + e.message)); }
      });
  });

  const hasCaption = !!(captionText && captionText.trim());
  const useCTA     = ctaEnabled === 'true' && !!(ctaText && ctaText.trim());
  const usePointer = pointerEnabled === 'true' && !!pointerType;
  let currentInput = inputPath;

  const videoSpeed = parseFloat(videoSpeedStr) || 1.0;
  const trimStart  = parseFloat(trimStartStr)  || 0;
  const trimEnd    = parseFloat(trimEndStr)    || 0;

  function buildAtempoChain(spd) {
    const parts = []; let s = spd;
    while (s < 0.499) { parts.push('atempo=0.5'); s /= 0.5; }
    while (s > 2.001) { parts.push('atempo=2.0'); s /= 2.0; }
    if (Math.abs(s - 1.0) > 0.001) parts.push(`atempo=${s.toFixed(4)}`);
    return parts;
  }

  const needsStep0 = Math.abs(videoSpeed - 1.0) > 0.001 || trimStart > 0 || (trimEnd > 0 && trimEnd > trimStart);
  if (needsStep0) {
    setProgress(8);
    const s0Args = [];
    if (trimStart > 0) s0Args.push('-ss', String(trimStart));
    if (trimEnd > 0 && trimEnd > trimStart) s0Args.push('-to', String(trimEnd));
    s0Args.push('-i', currentInput);
    const vfParts = []; const afParts = [];
    if (Math.abs(videoSpeed - 1.0) > 0.001) {
      vfParts.push(`setpts=${(1 / videoSpeed).toFixed(4)}*PTS`);
      if (hasAudio) afParts.push(...buildAtempoChain(videoSpeed));
    }
    if (vfParts.length) s0Args.push('-vf', vfParts.join(','));
    if (afParts.length) { s0Args.push('-af', afParts.join(','), '-map', '0:a?'); }
    else { s0Args.push('-map', '0:a?', '-c:a', 'copy'); }
    step0Path = mkTmp('s0.mp4');
    s0Args.push(...encodeArgs, step0Path);
    await runStep(s0Args);
    currentInput = step0Path;
  }

  setProgress(10);
  if (hasCaption) {
    const captionOverlayData = body.captionOverlayData;
    if (captionOverlayData && captionOverlayData.startsWith('data:image/png;base64,')) {
      // Use browser-rendered overlay (exact font metrics match)
      const base64 = captionOverlayData.slice('data:image/png;base64,'.length);
      capPngPath = mkTmp('cap.png');
      fs.writeFileSync(capPngPath, Buffer.from(base64, 'base64'));
    } else {
      // Fallback: render via node-canvas
      const fontSize = parseInt(captionFontSize) || 32;
      const maxWpct  = parseFloat(captionMaxWidth) || 60;
      const posX     = parseFloat(captionPosX) || 50;
      const posY     = parseFloat(captionPosY) || 75;
      const isBow    = captionStyle !== 'wob';
      const padX = 16, padY = 8;
      const maxW = videoW * (maxWpct / 100);
      const capCv = createCanvas(videoW, videoH); const capCtx = capCv.getContext('2d');
      capCtx.font = `bold ${fontSize}px Arial, sans-serif`; capCtx.textBaseline = 'middle'; capCtx.textAlign = 'center';
      const lines = wrapLines(capCtx, captionText.trim(), maxW - padX * 2);
      const pillH = fontSize + padY * 2; const blockH = lines.length * pillH;
      const centerX = videoW * (posX / 100); const blockY = videoH * (posY / 100) - blockH / 2;
      lines.forEach((ln, i) => {
        const lineW = capCtx.measureText(ln).width + padX * 2;
        const pillX = centerX - lineW / 2; const pillY = blockY + i * pillH;
        capCtx.fillStyle = isBow ? '#ffffff' : '#000000';
        roundRectPath(capCtx, pillX, pillY, lineW, pillH, 8); capCtx.fill();
        capCtx.fillStyle = isBow ? '#000000' : '#ffffff';
        capCtx.fillText(ln, centerX, pillY + pillH / 2);
      });
      capPngPath = mkTmp('cap.png');
      fs.writeFileSync(capPngPath, capCv.toBuffer('image/png'));
    }
    step1Path = mkTmp('s1.mp4');
    await runStep(['-i', currentInput, '-i', capPngPath, '-filter_complex', '[0:v][1:v]overlay=0:0', '-map', '0:a?', '-c:a', 'copy', '-shortest', ...encodeArgs, step1Path]);
    currentInput = step1Path;
  }
  setProgress(35);

  if (useCTA) {
    const fontSize = parseInt(ctaFontSize) || 28;
    const btnPadX = fontSize; const btnPadY = Math.round(fontSize * 0.5);
    const mCv = createCanvas(1, 1); const mCtx = mCv.getContext('2d');
    mCtx.font = `bold ${fontSize}px Arial, sans-serif`;
    const textW = mCtx.measureText(ctaText.trim()).width;
    const btnW = Math.ceil(textW + btnPadX * 2); const btnH = Math.ceil(fontSize + btnPadY * 2);
    const cvW = Math.ceil(btnW * 1.5 / 2) * 2; const cvH = Math.ceil(btnH * 1.5 / 2) * 2;
    const speedVal = { slow: 0.75, medium: 1.5, fast: 2.5 }[ctaSpeed] || 1.5;
    const fps = 30; const totalFrames = Math.round(fps / speedVal);
    const frameDir = path.join(os.tmpdir(), `vfe_ctaf_${Date.now()}_${rand}`);
    fs.mkdirSync(frameDir);
    try {
      for (let i = 0; i < totalFrames; i++) {
        const t = i / fps; const scale = 1 + 0.09 * (1 - Math.cos(2 * Math.PI * t * speedVal));
        const fCv = createCanvas(cvW, cvH); const fCtx = fCv.getContext('2d');
        fCtx.fillStyle = '#00ff00'; fCtx.fillRect(0, 0, cvW, cvH);
        fCtx.save(); fCtx.translate(cvW / 2, cvH / 2); fCtx.scale(scale, scale);
        fCtx.font = `bold ${fontSize}px Arial, sans-serif`; fCtx.textBaseline = 'middle'; fCtx.textAlign = 'center';
        fCtx.fillStyle = ctaBgColor || '#FFD700';
        roundRectPath(fCtx, -btnW / 2, -btnH / 2, btnW, btnH, 12); fCtx.fill();
        fCtx.fillStyle = ctaTextColor || '#000000'; fCtx.fillText(ctaText.trim(), 0, 0); fCtx.restore();
        fs.writeFileSync(path.join(frameDir, `frame_${String(i).padStart(3, '0')}.png`), fCv.toBuffer('image/png'));
      }
      const ctaAnimPath = mkTmp('cta_anim.mp4'); ctaPngPath = ctaAnimPath;
      await runStep(['-framerate', String(fps), '-i', path.join(frameDir, 'frame_%03d.png'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ctaAnimPath]);
    } finally { try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (_) {} }
    const ctaCX = Math.round((parseFloat(ctaPosX) || 50) / 100 * videoW);
    const ctaCY = Math.round((parseFloat(ctaPosY) || 88) / 100 * videoH);
    const ovX = ctaCX - Math.floor(cvW / 2); const ovY = ctaCY - Math.floor(cvH / 2);
    step2Path = mkTmp('s2.mp4');
    await runStep(['-i', currentInput, '-stream_loop', '-1', '-i', ctaPngPath, '-filter_complex', `[1:v]colorkey=0x00ff00:0.3:0.1[ctakeyed];[0:v][ctakeyed]overlay=x=${ovX}:y=${ovY}:shortest=1[out]`, '-map', '[out]', '-map', '0:a?', '-c:a', 'copy', ...encodeArgs, step2Path]);
    currentInput = step2Path;
  }
  setProgress(65);

  if (usePointer) {
    const imgFile = pointerType === 'hand' ? 'handCTA.png' : 'arrowCTA.png';
    const imgPath = path.join(__dirname, imgFile);
    if (!fs.existsSync(imgPath)) throw new Error(`Pointer image not found: ${imgFile}`);
    const ptrW = parseInt(pointerSize) || 80;
    const ptrX = Math.round((parseFloat(pointerPosX) || 35) / 100 * videoW);
    const ptrY = Math.round((parseFloat(pointerPosY) || 88) / 100 * videoH);
    const ctaX = Math.round((parseFloat(ctaPosX) || 50) / 100 * videoW);
    const ctaY = Math.round((parseFloat(ctaPosY) || 88) / 100 * videoH);
    const dur  = { slow: '1.5', medium: '0.9', fast: '0.4' }[pointerSpeed] || '0.9';
    const dx = ctaX - ptrX; const dy = ctaY - ptrY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = (dx / len).toFixed(4); const ny = (dy / len).toFixed(4);
    const srcImg = await loadImage(imgPath);
    const ratio = srcImg.naturalHeight / srcImg.naturalWidth;
    const ptrH  = Math.round(ptrW * ratio) || ptrW;
    const angle = pointerType === 'arrow' ? Math.atan2(dy, dx) : 0;
    const diag  = Math.ceil(Math.sqrt(ptrW * ptrW + ptrH * ptrH));
    const ptrCv = createCanvas(diag, diag); const pCtx = ptrCv.getContext('2d');
    pCtx.translate(diag / 2, diag / 2); pCtx.rotate(angle);
    pCtx.drawImage(srcImg, -ptrW / 2, -ptrH / 2, ptrW, ptrH);
    ptrPngPath = mkTmp('ptr.png');
    fs.writeFileSync(ptrPngPath, ptrCv.toBuffer('image/png'));
    const half = Math.floor(diag / 2);
    step3Path = mkTmp('s3.mp4');
    await runStep(['-i', currentInput, '-i', ptrPngPath, '-filter_complex', `[0:v][1:v]overlay=x='${ptrX - half}+${nx}*8*sin(2*PI*t/${dur})':y='${ptrY - half}+${ny}*8*sin(2*PI*t/${dur})':eval=frame`, '-map', '0:a?', '-c:a', 'copy', '-shortest', ...encodeArgs, step3Path]);
    currentInput = step3Path;
  }
  setProgress(90);

  const outputWidth  = parseInt(outputWidthStr)  || 0;
  const outputHeight = parseInt(outputHeightStr) || 0;
  const cropW = parseInt(body.cropW) || 0; const cropH = parseInt(body.cropH) || 0;
  const rawCropX = parseInt(body.cropX) || 0; const rawCropY = parseInt(body.cropY) || 0;
  const cropX = Math.max(0, Math.min(rawCropX, Math.max(0, videoW - cropW)));
  const cropY = Math.max(0, Math.min(rawCropY, Math.max(0, videoH - cropH)));
  const canCrop = cropW > 0 && cropH > 0 && cropW <= videoW && cropH <= videoH;
  if (outputWidth > 0 || outputHeight > 0 || canCrop) {
    const filters = [];
    if (canCrop) filters.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
    if (outputWidth > 0 || outputHeight > 0) {
      filters.push(`scale=${outputWidth > 0 ? outputWidth : -2}:${outputHeight > 0 ? outputHeight : -2}`);
    }
    const vfFilter = filters.join(',');
    if (vfFilter) {
      step4Path = mkTmp('s4.mp4');
      await runStep(['-i', currentInput, '-vf', vfFilter, '-map', '0:a?', '-c:a', 'copy', ...encodeArgs, step4Path]);
      currentInput = step4Path;
    }
  }
  setProgress(95);

  return { outputPath: currentInput, cleanup: () => cleanupPipeline(null), videoDuration };
}

// ── 10s / 28s / 56s looping endpoints ────────────────────────────────────────
async function burnLoopedEndpoint(req, res, targetDuration) {
  let inputPath  = req.file ? req.file.path : null;
  let step0Path  = null;
  let concatPath = null;
  let joinedPath = null;
  let trimmedPath = null;

  const jobId = (req.body && req.body.jobId) || Math.random().toString(36).slice(2);
  burnProgress.set(jobId, 0);
  function setProgress(pct) { burnProgress.set(jobId, pct); }

  try {
    if (!inputPath) throw new Error('No video uploaded');
    const origExt = path.extname(req.file.originalname || '').slice(1).toLowerCase() || 'mp4';
    const renamed = `${inputPath}.${origExt}`;
    fs.renameSync(inputPath, renamed);
    inputPath = renamed;

    const rand = Math.random().toString(36).slice(2, 8);
    const mkTmp = (tag) => path.join(os.tmpdir(), `vfe_lp_${Date.now()}_${rand}_${tag}`);
    const encodeArgs = ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

    function runStep(args) {
      return new Promise((resolve, reject) => {
        let done = false;
        const proc = execFile(FFMPEG_BIN, args, {}, (err, stdout, stderr) => {
          if (done) return; done = true;
          if (stderr) console.log('[loop] stderr:', stderr.slice(-400));
          if (err) reject(new Error(err.message + (stderr ? '\n' + stderr.slice(-300) : '')));
          else resolve();
        });
        setTimeout(() => { if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); } }, 300000);
      });
    }

    // ── ffprobe original video ────────────────────────────────────────────────
    setProgress(3);
    const { hasAudio, videoDuration } = await new Promise((resolve, reject) => {
      execFile(FFPROBE_BIN, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath],
        { timeout: 15000 }, (err, stdout) => {
          if (err) return reject(new Error('ffprobe: ' + err.message));
          try {
            const data = JSON.parse(stdout);
            const vs = data.streams.find(s => s.codec_type === 'video');
            const as = data.streams.find(s => s.codec_type === 'audio');
            const dur = parseFloat(data.format && data.format.duration) || parseFloat(vs && vs.duration) || 0;
            resolve({ hasAudio: !!as, videoDuration: dur });
          } catch (e) { reject(new Error('ffprobe parse: ' + e.message)); }
        });
    });

    const videoSpeed = parseFloat(req.body.videoSpeed) || 1.0;
    const trimStart  = parseFloat(req.body.trimStart)  || 0;
    const trimEnd    = parseFloat(req.body.trimEnd)    || 0;

    // ── STEP 0: trim + speed on one clip ─────────────────────────────────────
    function buildAtempoChain(spd) {
      const parts = []; let s = spd;
      while (s < 0.499) { parts.push('atempo=0.5'); s /= 0.5; }
      while (s > 2.001) { parts.push('atempo=2.0'); s /= 2.0; }
      if (Math.abs(s - 1.0) > 0.001) parts.push(`atempo=${s.toFixed(4)}`);
      return parts;
    }

    const needsStep0 = Math.abs(videoSpeed - 1.0) > 0.001 || trimStart > 0 || (trimEnd > 0 && trimEnd > trimStart);
    let clipPath = inputPath;
    if (needsStep0) {
      setProgress(8);
      const s0Args = [];
      if (trimStart > 0) s0Args.push('-ss', String(trimStart));
      if (trimEnd > 0 && trimEnd > trimStart) s0Args.push('-to', String(trimEnd));
      s0Args.push('-i', inputPath);
      const vfParts = [], afParts = [];
      if (Math.abs(videoSpeed - 1.0) > 0.001) {
        vfParts.push(`setpts=${(1 / videoSpeed).toFixed(4)}*PTS`);
        if (hasAudio) afParts.push(...buildAtempoChain(videoSpeed));
      }
      if (vfParts.length) s0Args.push('-vf', vfParts.join(','));
      if (afParts.length) s0Args.push('-af', afParts.join(','), '-map', '0:a?');
      else s0Args.push('-map', '0:a?', '-c:a', 'copy');
      step0Path = mkTmp('s0.mp4');
      s0Args.push(...encodeArgs, step0Path);
      await runStep(s0Args);
      clipPath = step0Path;
    }

    // ── Calculate how many loops needed ──────────────────────────────────────
    const rawEnd      = trimEnd > 0 ? trimEnd : videoDuration;
    const rawDuration = Math.max(0.01, rawEnd - trimStart);
    const effectiveDur = rawDuration / videoSpeed;
    if (effectiveDur <= 0) throw new Error('Cannot determine loop duration');

    setProgress(10);
    // Add 2 extra loops as a buffer so the concat is always longer than targetDuration,
    // ensuring the re-encode trim below always has enough footage to cut from.
    const loops = Math.ceil(targetDuration / effectiveDur) + 2;

    // ── Concat clips ─────────────────────────────────────────────────────────
    concatPath = path.join(os.tmpdir(), `vfe_concat_${Date.now()}_${rand}.txt`);
    const concatLines = [];
    for (let i = 0; i < loops; i++) concatLines.push(`file '${clipPath.replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(concatPath, concatLines.join('\n') + '\n');

    joinedPath = path.join(os.tmpdir(), `vfe_joined_${Date.now()}_${rand}.mp4`);
    await new Promise((resolve, reject) => {
      let done = false;
      const proc = execFile(FFMPEG_BIN, ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', joinedPath], {}, (err, stdout, stderr) => {
        if (done) return; done = true;
        if (err) reject(new Error(err.message + (stderr ? '\n' + stderr.slice(-300) : '')));
        else resolve();
      });
      setTimeout(() => { if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error('concat timed out')); } }, 300000);
    });
    setProgress(25);

    // ── Trim to exact target duration (re-encode for frame-accurate cut) ──────
    trimmedPath = path.join(os.tmpdir(), `vfe_trimmed_${Date.now()}_${rand}.mp4`);
    await runStep(['-i', joinedPath, '-t', String(targetDuration), ...encodeArgs, trimmedPath]);
    setProgress(35);

    // ── Apply overlays (caption, CTA, pointer, crop/scale) to the FULL video ─
    // Neutralise step-0 params so runBurnPipeline skips re-encoding the video.
    // CTA and pointer now animate smoothly across the entire target duration.
    const overlayBody = Object.assign({}, req.body, { videoSpeed: '1', trimStart: '0', trimEnd: '0' });
    const { outputPath: finalPath, cleanup } = await runBurnPipeline(trimmedPath, overlayBody, setProgress, rand);

    if (!fs.existsSync(finalPath)) throw new Error('Looped output not created');
    setProgress(100);

    const dlName = req.body.outputName || `looped_${targetDuration}s.mp4`;
    res.download(finalPath, dlName, () => {
      burnProgress.delete(jobId);
      cleanup();
      for (const p of [inputPath, step0Path, concatPath, joinedPath, trimmedPath]) {
        try { if (p) fs.unlinkSync(p); } catch (_) {}
      }
    });

  } catch (err) {
    console.error(`[burn-${targetDuration}s] ERROR:`, err);
    burnProgress.delete(jobId);
    for (const p of [inputPath, step0Path, concatPath, joinedPath, trimmedPath]) {
      try { if (p) fs.unlinkSync(p); } catch (_) {}
    }
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

app.post('/api/burn-10s', upload.single('video'), (req, res) => burnLoopedEndpoint(req, res, 10));
app.post('/api/burn-28s', upload.single('video'), (req, res) => burnLoopedEndpoint(req, res, 28));
app.post('/api/burn-56s', upload.single('video'), (req, res) => burnLoopedEndpoint(req, res, 56));

// ── Vertical format endpoint ──────────────────────────────────────────────────
async function burnVerticalEndpoint(req, res, targetDuration) {
  let inputPath  = req.file ? req.file.path : null;
  let step0Path  = null;
  let concatPath = null;
  let joinedPath = null;
  let trimmedPath = null;
  let composedPath = null;

  const jobId = (req.body && req.body.jobId) || Math.random().toString(36).slice(2);
  burnProgress.set(jobId, 0);
  function setProgress(pct) { burnProgress.set(jobId, pct); }

  const rand   = Math.random().toString(36).slice(2, 8);
  const mkTmp  = (tag) => path.join(os.tmpdir(), `vfe_vc_${Date.now()}_${rand}_${tag}`);
  const encodeArgs = ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

  function runStep(args) {
    return new Promise((resolve, reject) => {
      let done = false;
      const proc = execFile(FFMPEG_BIN, args, {}, (err, stdout, stderr) => {
        if (done) return; done = true;
        if (stderr) console.log('[vc] stderr:', stderr.slice(-400));
        if (err) reject(new Error(err.message + (stderr ? '\n' + stderr.slice(-300) : '')));
        else resolve();
      });
      setTimeout(() => { if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); } }, 300000);
    });
  }

  try {
    if (!inputPath) throw new Error('No video uploaded');
    const origExt = path.extname(req.file.originalname || '').slice(1).toLowerCase() || 'mp4';
    const renamed = `${inputPath}.${origExt}`;
    fs.renameSync(inputPath, renamed);
    inputPath = renamed;

    // ── ffprobe ───────────────────────────────────────────────────────────────
    setProgress(3);
    const { hasAudio, videoDuration } = await new Promise((resolve, reject) => {
      execFile(FFPROBE_BIN, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath],
        { timeout: 15000 }, (err, stdout) => {
          if (err) return reject(new Error('ffprobe: ' + err.message));
          try {
            const data = JSON.parse(stdout);
            const vs = data.streams.find(s => s.codec_type === 'video');
            const as = data.streams.find(s => s.codec_type === 'audio');
            const dur = parseFloat(data.format && data.format.duration) || parseFloat(vs && vs.duration) || 0;
            resolve({ hasAudio: !!as, videoDuration: dur });
          } catch (e) { reject(new Error('ffprobe parse: ' + e.message)); }
        });
    });

    const videoSpeed = parseFloat(req.body.videoSpeed) || 1.0;
    const trimStart  = parseFloat(req.body.trimStart)  || 0;
    const trimEnd    = parseFloat(req.body.trimEnd)    || 0;

    function buildAtempoChain(spd) {
      const parts = []; let s = spd;
      while (s < 0.499) { parts.push('atempo=0.5'); s /= 0.5; }
      while (s > 2.001) { parts.push('atempo=2.0'); s /= 2.0; }
      if (Math.abs(s - 1.0) > 0.001) parts.push(`atempo=${s.toFixed(4)}`);
      return parts;
    }

    // ── Step 0: trim + speed on one clip ─────────────────────────────────────
    const needsStep0 = Math.abs(videoSpeed - 1.0) > 0.001 || trimStart > 0 || (trimEnd > 0 && trimEnd > trimStart);
    let clipPath = inputPath;
    if (needsStep0) {
      setProgress(8);
      const s0Args = [];
      if (trimStart > 0) s0Args.push('-ss', String(trimStart));
      if (trimEnd > 0 && trimEnd > trimStart) s0Args.push('-to', String(trimEnd));
      s0Args.push('-i', inputPath);
      const vfParts = [], afParts = [];
      if (Math.abs(videoSpeed - 1.0) > 0.001) {
        vfParts.push(`setpts=${(1 / videoSpeed).toFixed(4)}*PTS`);
        if (hasAudio) afParts.push(...buildAtempoChain(videoSpeed));
      }
      if (vfParts.length) s0Args.push('-vf', vfParts.join(','));
      if (afParts.length) s0Args.push('-af', afParts.join(','), '-map', '0:a?');
      else s0Args.push('-map', '0:a?', '-c:a', 'copy');
      step0Path = mkTmp('s0.mp4');
      s0Args.push(...encodeArgs, step0Path);
      await runStep(s0Args);
      clipPath = step0Path;
    }

    // ── If looped: concat + trim to target duration ───────────────────────────
    let processPath = clipPath;
    if (targetDuration) {
      const rawEnd      = trimEnd > 0 ? trimEnd : videoDuration;
      const rawDuration = Math.max(0.01, rawEnd - trimStart);
      const effectiveDur = rawDuration / videoSpeed;
      if (effectiveDur <= 0) throw new Error('Cannot determine loop duration');
      const loops = Math.ceil(targetDuration / effectiveDur) + 2;
      setProgress(12);

      concatPath = mkTmp('concat.txt');
      const concatLines = [];
      for (let i = 0; i < loops; i++) concatLines.push(`file '${clipPath.replace(/'/g, "'\\''")}'`);
      fs.writeFileSync(concatPath, concatLines.join('\n') + '\n');

      joinedPath = mkTmp('joined.mp4');
      await new Promise((resolve, reject) => {
        let done = false;
        const proc = execFile(FFMPEG_BIN, ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', joinedPath], {}, (err, stdout, stderr) => {
          if (done) return; done = true;
          if (err) reject(new Error(err.message + (stderr ? '\n' + stderr.slice(-300) : '')));
          else resolve();
        });
        setTimeout(() => { if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error('concat timed out')); } }, 300000);
      });
      setProgress(22);

      trimmedPath = mkTmp('trimmed.mp4');
      await runStep(['-i', joinedPath, '-t', String(targetDuration), ...encodeArgs, trimmedPath]);
      setProgress(30);
      processPath = trimmedPath;
    }

    // ── Vertical composite step ───────────────────────────────────────────────
    setProgress(35);
    const outW = parseInt(req.body.outputWidth)  || 720;
    const outH = parseInt(req.body.outputHeight) || 1280;
    const stripH = Math.round(outH / 2);
    const stripY = Math.round(outH / 4);

    const vcCropX = parseInt(req.body.vcCropX) || 0;
    const vcCropY = parseInt(req.body.vcCropY) || 0;
    const vcCropW = parseInt(req.body.vcCropW) || 0;
    const vcCropH = parseInt(req.body.vcCropH) || 0;

    composedPath = mkTmp('composed.mp4');
    const filterParts = [];
    if (vcCropW > 0 && vcCropH > 0) {
      filterParts.push(`[0:v]crop=${vcCropW}:${vcCropH}:${vcCropX}:${vcCropY}[src]`);
    } else {
      filterParts.push(`[0:v]copy[src]`);
    }
    filterParts.push(
      `[src]split=2[bgraw][ctrraw]`,
      `[bgraw]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},colorlevels=romax=0.25:gomax=0.25:bomax=0.25[bg]`,
      `[ctrraw]scale=${outW}:${stripH}:flags=lanczos[ctr]`,
      `[bg][ctr]overlay=0:${stripY}[out]`
    );
    await runStep([
      '-i', processPath,
      '-filter_complex', filterParts.join(';'),
      '-map', '[out]', '-map', '0:a?', '-c:a', 'copy',
      ...encodeArgs, composedPath,
    ]);
    setProgress(50);

    // ── Apply caption + CTA + pointer overlays on composed video ─────────────
    // CTA at 50%/87.5%, pointer X from user drag, Y fixed at 87.5% (center of bottom 25%)
    const overlayBody = Object.assign({}, req.body, {
      videoSpeed: '1', trimStart: '0', trimEnd: '0',
      ctaPosX: '50', ctaPosY: '87.5',
      pointerPosX: req.body.vcPtrPosX || '35', pointerPosY: '87.5',
      outputWidth: '0', outputHeight: '0',
      cropW: '0', cropH: '0', cropX: '0', cropY: '0',
    });

    const { outputPath: finalPath, cleanup } = await runBurnPipeline(composedPath, overlayBody, setProgress, rand);

    if (!fs.existsSync(finalPath)) throw new Error('Vertical output not created');
    setProgress(100);

    const dlName = req.body.outputName || (targetDuration ? `vertical_${targetDuration}s.mp4` : 'vertical.mp4');
    res.download(finalPath, dlName, () => {
      burnProgress.delete(jobId);
      cleanup();
      for (const p of [inputPath, step0Path, concatPath, joinedPath, trimmedPath, composedPath]) {
        try { if (p) fs.unlinkSync(p); } catch (_) {}
      }
    });

  } catch (err) {
    console.error('[burn-vertical] ERROR:', err);
    burnProgress.delete(jobId);
    for (const p of [inputPath, step0Path, concatPath, joinedPath, trimmedPath, composedPath]) {
      try { if (p) fs.unlinkSync(p); } catch (_) {}
    }
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

app.post('/api/burn-vertical',     upload.single('video'), (req, res) => burnVerticalEndpoint(req, res, null));
app.post('/api/burn-vertical-10s', upload.single('video'), (req, res) => burnVerticalEndpoint(req, res, 10));
app.post('/api/burn-vertical-28s', upload.single('video'), (req, res) => burnVerticalEndpoint(req, res, 28));
app.post('/api/burn-vertical-56s', upload.single('video'), (req, res) => burnVerticalEndpoint(req, res, 56));

// ── Video Editor endpoint ─────────────────────────────────────────────────────
app.post('/api/video-editor', upload.single('video'), async (req, res) => {
  let inputPath = req.file ? req.file.path : null;
  let preConvPath = null; // GIF/WEBP → mp4 pre-conversion
  let step0Path = null, step1Path = null, step2Path = null, step3Path = null, step4Path = null;

  const jobId = (req.body && req.body.jobId) || Math.random().toString(36).slice(2);
  burnProgress.set(jobId, 0);
  function setProgress(pct) { burnProgress.set(jobId, pct); }

  function runStep(args) {
    return new Promise((resolve, reject) => {
      let done = false;
      const proc = execFile(FFMPEG_BIN, args, {}, (err, stdout, stderr) => {
        if (done) return; done = true;
        if (err) reject(new Error(err.message + (stderr ? '\n' + stderr.slice(-300) : '')));
        else resolve();
      });
      setTimeout(() => { if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }}, 300000);
    });
  }

  function cleanupAll() {
    for (const p of [inputPath, preConvPath, step0Path, step1Path, step2Path, step3Path, step4Path]) {
      if (p) try { fs.unlinkSync(p); } catch(_) {}
    }
  }

  try {
    if (!inputPath) throw new Error('No video uploaded');

    const origExt = path.extname(req.file.originalname || '').slice(1).toLowerCase() || 'mp4';
    const renamed = `${inputPath}.${origExt}`;
    fs.renameSync(inputPath, renamed);
    inputPath = renamed;

    const rand = Math.random().toString(36).slice(2, 8);
    const mkTmp = (tag) => path.join(os.tmpdir(), `vfe_ve_${Date.now()}_${rand}_${tag}`);
    const encodeArgs = ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

    const trimStart = parseFloat(req.body.trimStart) || 0;
    const trimEndRaw = parseFloat(req.body.trimEnd);
    const trimEnd   = isNaN(trimEndRaw) ? 0 : trimEndRaw;
    const targetDuration = parseFloat(req.body.targetDuration) || 0;
    const speed     = parseFloat(req.body.speed)     || 1.0;
    const outputWidth  = parseInt(req.body.outputWidth)  || 0;
    const outputHeight = parseInt(req.body.outputHeight) || 0;
    const cropX = parseInt(req.body.cropX) || 0;
    const cropY = parseInt(req.body.cropY) || 0;
    const cropW = parseInt(req.body.cropW) || 0;
    const cropH = parseInt(req.body.cropH) || 0;
    const outputName = req.body.outputName || 'edited.mp4';
    const outputFormat  = (req.body.outputFormat  || 'mp4').toLowerCase();
    const inputExtParam = (req.body.inputExt       || 'mp4').toLowerCase();
    const fpsSlider     = parseInt(req.body.fpsSlider)     || 100;
    const qualitySlider = parseInt(req.body.qualitySlider) || 100;
    const actualFps     = Math.max(1, Math.round(fpsSlider / 100 * 30));
    const qualityVal    = Math.max(1, Math.min(100, qualitySlider));

    // STEP 0: Pre-convert GIF/WEBP input → mp4 so all further steps work on video
    if (inputExtParam === 'gif' || inputExtParam === 'webp') {
      setProgress(3);
      let gifInput = inputPath;
      if (inputExtParam === 'webp') {
        // Convert WEBP → GIF via ImageMagick first
        const gifPath = inputPath + '_webp2gif.gif';
        await new Promise((resolve, reject) => {
          execFile(CONVERT_BIN, [inputPath, gifPath], { timeout: 60000 }, (err) => {
            if (err) reject(new Error('ImageMagick convert: ' + err.message));
            else resolve();
          });
        });
        try { fs.unlinkSync(inputPath); } catch(_) {} // delete original WEBP upload
        preConvPath = gifPath;
        gifInput = gifPath;
      }
      setProgress(8);
      const preMp4 = inputPath + '_pre.mp4';
      await runStep([
        '-i', gifInput,
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart',
        preMp4
      ]);
      // preConvPath = original GIF upload (or intermediate GIF for WEBP); inputPath = pre-converted mp4
      if (!preConvPath) preConvPath = inputPath;
      inputPath = preMp4;
      setProgress(12);
    }

    // ffprobe to get info
    if (inputExtParam !== 'gif' && inputExtParam !== 'webp') setProgress(5);
    const { hasAudio, videoDuration } = await new Promise((resolve, reject) => {
      execFile(FFPROBE_BIN, ['-v', 'quiet', '-print_format', 'json', '-show_streams', inputPath],
        { timeout: 15000 }, (err, stdout) => {
          if (err) return reject(new Error('ffprobe: ' + err.message));
          try {
            const data = JSON.parse(stdout);
            const as = data.streams.find(s => s.codec_type === 'audio');
            const vs = data.streams.find(s => s.codec_type === 'video');
            const dur = parseFloat((vs && (vs.duration || vs.tags && vs.tags.DURATION)) || 0);
            resolve({ hasAudio: !!as, videoDuration: dur });
          } catch(e) { reject(new Error('ffprobe parse: ' + e.message)); }
        });
    });

    let currentInput = inputPath;

    // STEP 1: Trim
    setProgress(15);
    const effectiveTrimEnd = trimEnd > trimStart ? trimEnd : (videoDuration || trimEnd);
    const needsTrim = trimStart > 0 || (effectiveTrimEnd > 0 && videoDuration > 0 && effectiveTrimEnd < videoDuration - 0.1);
    if (needsTrim) {
      step0Path = mkTmp('s0.mp4');
      // Input-side seeking (-ss before -i) for reliable stream copy
      const preArgs = trimStart > 0 ? ['-ss', String(trimStart)] : [];
      const durArgs = effectiveTrimEnd > trimStart ? ['-t', String(effectiveTrimEnd - trimStart)] : [];
      await runStep([...preArgs, '-i', currentInput, ...durArgs, '-map', '0:v', '-map', '0:a?', '-c', 'copy', step0Path]);
      currentInput = step0Path;
    }

    // STEP 2: Speed
    setProgress(35);
    if (Math.abs(speed - 1.0) > 0.001) {
      step1Path = mkTmp('s1.mp4');
      const vf = `setpts=${(1/speed).toFixed(6)}*PTS`;
      const speedArgs = ['-i', currentInput, '-vf', vf];
      if (hasAudio) {
        // Build atempo chain
        const atempoChain = [];
        let s = speed;
        while (s > 2.0) { atempoChain.push('atempo=2.0'); s /= 2.0; }
        while (s < 0.5) { atempoChain.push('atempo=0.5'); s /= 0.5; }
        atempoChain.push(`atempo=${s.toFixed(4)}`);
        speedArgs.push('-af', atempoChain.join(','));
      }
      speedArgs.push('-map', '0:v', '-map', '0:a?', ...encodeArgs, step1Path);
      await runStep(speedArgs);
      currentInput = step1Path;
    }

    // STEP 3: Crop + Scale
    setProgress(65);
    const filters = [];
    if (cropW > 0 && cropH > 0) filters.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
    if (outputWidth > 0 && outputHeight > 0) filters.push(`scale=${outputWidth}:${outputHeight}`);
    if (filters.length > 0) {
      step2Path = mkTmp('s2.mp4');
      await runStep([
        '-i', currentInput,
        '-vf', filters.join(','),
        '-map', '0:v', '-map', '0:a?', '-c:a', 'copy',
        ...encodeArgs, step2Path
      ]);
      currentInput = step2Path;
    }

    // STEP 4: Loop to target duration
    if (targetDuration > 0) {
      const clipLen = (effectiveTrimEnd - trimStart) / (Math.abs(speed - 1.0) > 0.001 ? speed : 1.0);
      if (clipLen > 0.1 && targetDuration > clipLen * 1.05) {
        const loopCount = Math.ceil(targetDuration / clipLen);
        const concatListPath = path.join(os.tmpdir(), `vfe_concat_${Date.now()}_${rand}.txt`);
        const lines = Array(loopCount).fill(`file '${currentInput.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(concatListPath, lines);
        step3Path = mkTmp('s3.mp4');
        await runStep(['-f', 'concat', '-safe', '0', '-i', concatListPath, '-t', String(targetDuration), '-c', 'copy', step3Path]);
        try { fs.unlinkSync(concatListPath); } catch(_) {}
        currentInput = step3Path;
      }
    }

    setProgress(90);
    if (!fs.existsSync(currentInput)) throw new Error('Processing produced no output');

    // STEP 5: Convert to final output format (any non-mp4)
    if (outputFormat !== 'mp4') {
      step4Path = mkTmp('s4.' + outputFormat);
      if (outputFormat === 'gif') {
        const maxColors = qualityVal >= 80 ? 256 : qualityVal >= 40 ? 128 : 64;
        const dither    = qualityVal >= 80 ? 'bayer:bayer_scale=5' : qualityVal >= 40 ? 'bayer' : 'none';
        const scaleFilter = outputWidth > 0
          ? `fps=${actualFps},scale=${outputWidth}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${maxColors}[p];[s1][p]paletteuse=dither=${dither}`
          : `fps=${actualFps},scale=trunc(iw/2)*2:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${maxColors}[p];[s1][p]paletteuse=dither=${dither}`;
        await runStep(['-i', currentInput, '-vf', scaleFilter, '-loop', '0', step4Path]);
      } else if (outputFormat === 'webp') {
        const scaleFilter = outputWidth > 0 && outputHeight > 0
          ? `fps=${actualFps},scale=${outputWidth}:${outputHeight}`
          : `fps=${actualFps}`;
        await runStep([
          '-i', currentInput,
          '-vf', scaleFilter,
          '-vcodec', 'libwebp', '-lossless', '0',
          '-compression_level', '6',
          '-q:v', String(qualityVal),
          '-loop', '0', '-preset', 'picture', '-an', '-vsync', '0',
          step4Path
        ]);
      } else if (outputFormat === 'webm') {
        await runStep([
          '-i', currentInput,
          '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
          '-c:a', 'libopus', '-b:a', '128k',
          step4Path
        ]);
      } else if (outputFormat === 'avi') {
        // Try libxvid first, fall back to mpeg4
        try {
          await runStep([
            '-i', currentInput,
            '-c:v', 'libxvid', '-q:v', '4',
            '-c:a', 'libmp3lame', '-b:a', '128k',
            step4Path
          ]);
        } catch (_) {
          await runStep([
            '-i', currentInput,
            '-c:v', 'mpeg4', '-q:v', '4',
            '-c:a', 'libmp3lame', '-b:a', '128k',
            step4Path
          ]);
        }
      } else if (outputFormat === 'mkv') {
        await runStep([
          '-i', currentInput,
          '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k',
          step4Path
        ]);
      } else {
        // mov — h264 with faststart
        await runStep([
          '-i', currentInput,
          '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
          '-c:a', 'aac', '-b:a', '128k',
          step4Path
        ]);
      }
      currentInput = step4Path;
    }

    setProgress(98);

    const mimeMap = {
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
      avi: 'video/x-msvideo', mkv: 'video/x-matroska',
      gif: 'image/gif', webp: 'image/webp'
    };
    const mime = mimeMap[outputFormat] || 'video/mp4';
    res.setHeader('Content-Type', mime);
    res.download(currentInput, outputName, (dlErr) => {
      burnProgress.delete(jobId);
      cleanupAll();
      if (dlErr && !res.headersSent) res.status(500).json({ error: dlErr.message });
    });

  } catch(err) {
    console.error('[video-editor] ERROR:', err);
    burnProgress.delete(jobId);
    cleanupAll();
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Startup: check libwebp availability ───────────────────────────────────────
try {
  const webpEncoders = execSync('ffmpeg -encoders 2>/dev/null | grep webp').toString().trim();
  console.log('  libwebp check:', webpEncoders || '(none found)');
} catch (_) {
  console.warn('  ⚠️  libwebp encoder not found. WEBP conversion will fail.');
  console.warn('     Fix: brew reinstall ffmpeg');
}

// ── Startup: check ImageMagick availability ───────────────────────────────────
try {
  const imPath = execSync('which convert').toString().trim();
  console.log('  ImageMagick check:', imPath || '(not found)');
} catch (_) {
  console.warn('  ⚠️  ImageMagick not found. WEBP→Video and WEBP→GIF will fail.');
  console.warn('     Fix: brew install imagemagick');
}

// ── Image resize (crop + scale static images) ─────────────────────────────────
app.post('/api/image-resize', upload.single('image'), async (req, res) => {
  let inputPath  = null;
  let outputPath = null;
  const cleanup  = () => {
    for (const p of [inputPath, outputPath]) { try { if (p) fs.unlinkSync(p); } catch(_) {} }
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch(_) {} }
  };
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file' });
    const inputExt    = (req.body.inputExt || 'png').toLowerCase().replace('jpeg','jpg');
    const cropX       = parseInt(req.body.cropX)       || 0;
    const cropY       = parseInt(req.body.cropY)       || 0;
    const cropW       = parseInt(req.body.cropW)       || 0;
    const cropH       = parseInt(req.body.cropH)       || 0;
    const outputWidth = parseInt(req.body.outputWidth) || 0;
    const outputHeight= parseInt(req.body.outputHeight)|| 0;
    const outputName  = req.body.outputName || ('image.' + inputExt);
    const rand        = Math.random().toString(36).slice(2, 8);

    inputPath  = path.join(os.tmpdir(), `vfe_img_in_${Date.now()}_${rand}.${inputExt}`);
    outputPath = path.join(os.tmpdir(), `vfe_img_out_${Date.now()}_${rand}.${inputExt}`);
    fs.copyFileSync(req.file.path, inputPath);

    const vfParts = [];
    if (cropW > 0 && cropH > 0) vfParts.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
    if (outputWidth > 0 && outputHeight > 0) vfParts.push(`scale=${outputWidth}:${outputHeight}`);

    const args = ['-y', '-i', inputPath];
    if (vfParts.length) args.push('-vf', vfParts.join(','));
    if (inputExt === 'jpg') args.push('-q:v', '2');
    args.push(outputPath);

    await run(FFMPEG_BIN, args, 60000);

    res.download(outputPath, outputName, () => cleanup());
  } catch(err) {
    console.error('image-resize error:', err.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Estimate output size (server-side, ffprobe bitrate) ───────────────────────
app.post('/api/estimate-size', upload.single('video'), async (req, res) => {
  let inputPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const origExt = path.extname(req.file.originalname || '').slice(1).toLowerCase() || 'mp4';
    inputPath = `${req.file.path}.${origExt}`;
    fs.renameSync(req.file.path, inputPath);

    const outputFormat = (req.body.outputFormat || 'mp4').toLowerCase();
    const outputWidth  = parseInt(req.body.outputWidth)  || 0;
    const outputHeight = parseInt(req.body.outputHeight) || 0;
    const trimStart    = parseFloat(req.body.trimStart)  || 0;
    const trimEndRaw   = parseFloat(req.body.trimEnd);
    const speed        = parseFloat(req.body.speed)      || 1.0;
    const fpsSlider    = parseInt(req.body.fpsSlider)    || 100;
    const qualitySlider= req.body.qualitySlider != null ? parseInt(req.body.qualitySlider) : 100;
    const playingTime  = parseFloat(req.body.playingTime)|| 0;

    // ffprobe: get source bitrate, dimensions, duration
    const probeData = await new Promise((resolve, reject) => {
      execFile(FFPROBE_BIN, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=bit_rate,width,height,r_frame_rate',
        '-show_entries', 'format=duration,bit_rate',
        '-of', 'json',
        inputPath,
      ], { timeout: 15000 }, (err, stdout) => {
        if (err) return reject(new Error('ffprobe: ' + err.message));
        try { resolve(JSON.parse(stdout)); } catch(e) { reject(new Error('ffprobe parse: ' + e.message)); }
      });
    });

    const stream    = (probeData.streams || [])[0] || {};
    const fmt       = probeData.format || {};
    const srcW      = parseInt(stream.width)  || outputWidth  || 1280;
    const srcH      = parseInt(stream.height) || outputHeight || 720;
    const srcBitrate= parseInt(stream.bit_rate || fmt.bit_rate) || 0;
    const srcDur    = parseFloat(fmt.duration) || 0;

    const trimEnd        = (!isNaN(trimEndRaw) && trimEndRaw > trimStart) ? trimEndRaw : srcDur;
    const rawDuration    = Math.max(0.1, trimEnd - trimStart);
    const trimmedDur     = rawDuration / speed;
    const effectiveDuration = (playingTime > 0 && playingTime > trimmedDur) ? playingTime : trimmedDur;

    const outW = outputWidth  || srcW;
    const outH = outputHeight || srcH;

    const actualFps = Math.max(1, Math.round((fpsSlider / 100) * 30));

    // WEBP: run the actual full conversion, measure real output size, then delete
    if (outputFormat === 'webp') {
      const webpPath = path.join(os.tmpdir(), `vfe_est_webp_${Date.now()}.webp`);
      const webpArgs = [];
      if (trimStart > 0) webpArgs.push('-ss', String(trimStart));
      const trimDur = (!isNaN(trimEndRaw) && trimEndRaw > trimStart) ? trimEndRaw - trimStart : (srcDur - trimStart);
      if (trimDur > 0 && trimDur < srcDur) webpArgs.push('-t', String(trimDur));
      webpArgs.push('-i', inputPath);
      const qualityVal = Math.max(1, Math.min(100, qualitySlider));
      const vfParts = [];
      if (Math.abs(speed - 1.0) > 0.001) vfParts.push(`setpts=${(1 / speed).toFixed(6)}*PTS`);
      if (outW > 0 && outH > 0) vfParts.push(`fps=${actualFps},scale=${outW}:${outH}`);
      else vfParts.push(`fps=${actualFps}`);
      webpArgs.push(
        '-vf', vfParts.join(','),
        '-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6',
        '-q:v', String(qualityVal), '-loop', '0', '-preset', 'picture', '-an', '-vsync', '0',
        webpPath, '-y'
      );
      await new Promise((resolve, reject) => {
        execFile(FFMPEG_BIN, webpArgs, { timeout: 300000 }, (err) => {
          if (err) reject(new Error('webp conversion: ' + err.message));
          else resolve();
        });
      });
      const realBytes = fs.statSync(webpPath).size;
      try { fs.unlinkSync(webpPath); } catch(_) {}
      const realMB = Math.max(0.05, realBytes / (1024 * 1024));
      return res.json({ estimatedMB: Math.round(realMB * 100) / 100, format: 'WEBP', details: 'Real size from full conversion' });
    }

    // All other formats: 1-second sample conversion + extrapolate
    const sampleStart   = Math.floor(effectiveDuration / 2);
    const sampleDuration= Math.min(1, effectiveDuration);
    const sampleExt     = outputFormat === 'gif' ? 'gif' : 'mp4';
    const samplePath    = path.join(os.tmpdir(), `vfe_est_${Date.now()}.${sampleExt}`);

    let sampleArgs;
    if (outputFormat === 'gif') {
      const maxColors = qualitySlider >= 80 ? 256 : qualitySlider >= 40 ? 128 : 64;
      sampleArgs = [
        '-ss', String(sampleStart), '-t', String(sampleDuration), '-i', inputPath,
        '-vf', `fps=${actualFps},scale=${outW}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${maxColors}[p];[s1][p]paletteuse`,
        '-loop', '0',
        samplePath, '-y'
      ];
    } else {
      sampleArgs = [
        '-ss', String(sampleStart), '-t', String(sampleDuration), '-i', inputPath,
        '-vf', `scale=${outW}:${outH}`,
        '-c:v', 'libx264', '-crf', '18',
        samplePath, '-y'
      ];
    }

    await new Promise((resolve, reject) => {
      execFile(FFMPEG_BIN, sampleArgs, { timeout: 30000 }, (err) => {
        if (err) reject(new Error('sample ffmpeg: ' + err.message));
        else resolve();
      });
    });

    const sampleBytes   = fs.statSync(samplePath).size;
    try { fs.unlinkSync(samplePath); } catch(_) {}

    const estimatedBytes= sampleBytes * (effectiveDuration / sampleDuration) * 1.05;
    const estimatedMB   = Math.max(0.05, estimatedBytes / (1024 * 1024));
    const details = `Sample: ${sampleBytes} bytes × ${(effectiveDuration / sampleDuration).toFixed(1)}x`;

    res.json({ estimatedMB: Math.round(estimatedMB * 100) / 100, format: outputFormat.toUpperCase(), details });
  } catch (err) {
    console.error('[estimate-size]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (inputPath) { try { fs.unlinkSync(inputPath); } catch(_) {} }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
