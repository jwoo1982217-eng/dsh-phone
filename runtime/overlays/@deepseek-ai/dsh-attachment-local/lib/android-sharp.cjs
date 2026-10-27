// The subset of Sharp consumed by the pinned DSH attachment store, backed by
// Android's full raster decoder and encoders inside the Android app. No native
// libvips, no network, and no temporary image files.
const { createConnection } = require('node:net');
function bridge(data, options) {
  const endpoint = process.env.DSH_PHONE_IMAGE_SOCKET;
  if (!endpoint || !/^dsh-images-[a-f0-9-]+$/.test(endpoint)) return Promise.reject(Error('Android image processor is unavailable; update the APK'));
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: '\0' + endpoint });
    const chunks = []; let length = 0, settled = false;
    function finish(error, value) { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); }
    socket.setTimeout(30000, () => finish(Error('Android image processing timed out')));
    socket.on('error', error => finish(error));
    socket.on('data', bytes => {
      length += bytes.length;
      if (length > 360 * 1024 * 1024) finish(Error('Decoded image exceeds output budget'));
      else chunks.push(bytes);
    });
    socket.on('end', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString());
        if (!result.ok) throw Error(result.error || 'Android image decoding failed');
        finish(null, result);
      } catch (error) { finish(error); }
    });
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ ...options, data: data.toString('base64') }));
      const head = Buffer.alloc(4); head.writeUInt32BE(body.length); socket.write(head); socket.write(body);
    });
  });
}
class AndroidImage {
  constructor(data, options = {}) { this.data = Buffer.from(data); this.options = { ...options }; }
  metadata() { return bridge(this.data, { operation: 'metadata' }).then(value => value.metadata); }
  raw() { this.options.operation = 'raw'; return this; }
  rotate() { return this; } // ImageDecoder applies EXIF orientation at decode.
  toColourspace(space) { if (space !== 'srgb') throw Error('Only sRGB is supported'); return this; }
  resize(options) { this.options = { ...this.options, ...options }; return this; }
  clone() { return new AndroidImage(this.data, this.options); }
  jpeg(options = {}) { this.options = { ...this.options, ...options, operation: 'jpeg' }; return this; }
  webp(options = {}) { this.options = { ...this.options, ...options, operation: 'webp' }; return this; }
  png(options = {}) { this.options = { ...this.options, ...options, operation: 'png' }; return this; }
  async toBuffer({ resolveWithObject = false } = {}) {
    const result = await bridge(this.data, this.options);
    if (typeof result.data !== 'string') throw Error('Select an Android image output format');
    const data = Buffer.from(result.data, 'base64');
    return resolveWithObject ? { data, info: result.info } : data;
  }
}
module.exports = data => new AndroidImage(data);
module.exports.default = module.exports;
