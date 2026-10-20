/**
 * 备份文件加密壳（PBKDF2 + AES-GCM）。
 *
 * 只依赖浏览器原生 Web Crypto API（crypto.subtle），无第三方依赖。
 * 加密在**前端完成**：明文备份 JSON 不经过 RPC / 日志 / 进程内存。
 *
 * 加密容器形态：
 * {
 *   format: 'dsh-codearts-auth/backup.encrypted',
 *   kdf: 'PBKDF2',
 *   hash: 'SHA-256',
 *   iterations: <PBKDF2 迭代次数>,
 *   salt: <base64>,
 *   iv: <base64>,
 *   ciphertext: <base64>
 * }
 *
 * AES-GCM 自带认证：口令错误或数据被篡改时 decrypt 必抛错，不会静默
 * 产出坏数据。
 */

const KDF_ITERATIONS = 310000;
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** 判断一份解析后的 JSON 是否是加密容器（有 kdf + ciphertext 字段）。 */
export function isEncryptedBackup(value) {
  return typeof value === 'object' && value !== null
    && typeof value.kdf === 'string' && typeof value.ciphertext === 'string';
}

/** 用口令加密明文备份载荷，返回加密容器对象（可 JSON.stringify 后下载）。 */
export async function encryptBackup(payload, passphrase) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS, ['encrypt']);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    format: 'dsh-codearts-auth/backup.encrypted',
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations: KDF_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * 用口令解密加密容器，返回解析后的备份载荷。
 * 口令错误或数据被篡改时抛错（AES-GCM 认证失败）。
 */
export async function decryptBackup(container, passphrase) {
  if (!isEncryptedBackup(container)) {
    throw new Error('不是加密备份文件');
  }
  const salt = fromBase64(container.salt);
  const iv = fromBase64(container.iv);
  const ciphertext = fromBase64(container.ciphertext);
  const iterations = Number.isSafeInteger(container.iterations) && container.iterations > 0
    ? container.iterations
    : KDF_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** PBKDF2 派生 AES-GCM 密钥。 */
async function deriveKey(passphrase, salt, iterations, usages) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    false,
    usages,
  );
}

/** Uint8Array → base64（分块处理，避免 btoa 对超大字符串的栈限制）。 */
function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → Uint8Array。 */
function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
