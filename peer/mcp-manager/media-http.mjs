import fs from 'node:fs';
import path from 'node:path';
import { JOB_ID, jobDirectory } from './media-files.mjs';

export function registerMediaFiles(ctx, media) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/mcp-manager/media-file', handler(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const denied = ctx.connection.requestRejection(req); if (denied !== undefined) { res.writeHead(denied).end(); return; }
    let fd;
    try {
      const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('job'); if (!id || !JOB_ID.test(id)) { res.writeHead(404).end(); return; }
      const job = media.load(id);
      if (job.status !== 'completed' || !job.file || !/^(image\/(png|jpeg|webp)|audio\/wav|video\/mp4)$/.test(job.mimeType)) { res.writeHead(404).end(); return; }
      const directory = jobDirectory(media.home, id);
      if (path.dirname(job.file) !== directory || !/^output\.(png|jpg|webp|wav|mp4)$/.test(path.basename(job.file))) { res.writeHead(404).end(); return; }
      fd = fs.openSync(job.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd); if (!stat.isFile()) throw Error('Invalid media');
      let start = 0, end = stat.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!match || Number(match[1]) >= stat.size || match[2] && Number(match[2]) < Number(match[1])) { res.writeHead(416, { 'content-range': 'bytes */' + stat.size }).end(); return; }
        start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; status = 206;
      }
      res.writeHead(status, { 'content-type': job.mimeType, 'content-length': end - start + 1, 'accept-ranges': 'bytes',
        ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline; filename="' + path.basename(job.file) + '"' });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(job.file, { fd, autoClose: true, start, end }); fd = undefined;
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404).end(); else res.destroy(); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  } }));
}
