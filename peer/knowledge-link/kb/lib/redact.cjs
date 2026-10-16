'use strict';
// Search snippets may contain historical credentials unrelated to the question.
// Mask common forms in returned snippets; never rewrite source files.
function redact(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[已遮盖私钥]')
    .replace(/\b(?:sk-|hf_|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{12,}\b/g,'[已遮盖密钥]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi,'Bearer [已遮盖]')
    .replace(/^(\s*(?:cookie|set-cookie|authorization)\s*[:=]\s*).+$/gim,'$1[已遮盖]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|skey)\b(\s*[:=]\s*["']?)[A-Za-z0-9._~+\/=-]{12,}/gi,'$1$2[已遮盖]');
}
module.exports={redact};
