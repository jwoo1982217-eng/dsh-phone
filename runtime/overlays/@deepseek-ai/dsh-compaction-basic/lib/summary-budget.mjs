import {Buffer} from 'node:buffer';

// This is a conservative estimate, not a claim about a provider's tokenizer.
// Provider-confirmed overflow is handled by reducing the batch, never its window.
export function textTokens(text) {
  const ascii = (text.match(/[\x00-\x7f]/g) || []).length;
  return Math.ceil(ascii / 3 + (Buffer.byteLength(text) - ascii) / 2) + 16;
}

export function requestTokens(messages, tools, meter) {
  return messages.reduce((n, m) => n + Math.max(meter.estimateMessage(m), textTokens(JSON.stringify(m))), 0)
    + (tools?.length ? textTokens(JSON.stringify(tools)) : 0);
}

export function summaryBudget(info, requestedOutput, instruction) {
  const window = info.context?.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0) {
    const error = new Error('压缩模型没有声明有效上下文容量，请配置实际容量后重试；历史未替换。');
    error.code = 'COMPACTION_CAPACITY_UNKNOWN';
    throw error;
  }
  const output = Math.min(requestedOutput, info.defaultMaxTokens ?? requestedOutput);
  const input = Math.floor((window - output) * .75);
  const overhead = textTokens(instruction) + 512;
  if (input <= overhead + 256) {
    const error = new Error('压缩模型的输入预算不足，请降低摘要输出预算或使用容量足够的模型。');
    error.code = 'COMPACTION_ENVELOPE_TOO_LARGE';
    throw error;
  }
  return {window, output, input, batch: Math.min(98304, input - overhead)};
}

// No tool can execute from these transcripts. Keep a call and all of its
// results in one group; oversized groups become explicitly labelled fragments.
export function transcriptGroups(messages) {
  const groups = [];
  let current = [], pending = new Set();
  for (const message of messages) {
    current.push(JSON.stringify(message));
    for (const block of message.content || []) if (block.type === 'tool-call') pending.add(block.id);
    if (message.role === 'tool') pending.delete(message.toolCallId);
    if (pending.size === 0) { groups.push(current.join('\n')); current = []; }
  }
  if (current.length) groups.push(current.join('\n'));
  return groups;
}

export function splitText(text, limit) {
  if (textTokens(text) <= limit) return [text];
  const pieces = [];
  while (text) {
    let lo = 1, hi = Math.min(text.length, limit * 3);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (textTokens(text.slice(0, mid)) <= limit) lo = mid; else hi = mid - 1;
    }
    let end = lo;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    if (end < 1) throw new Error('Compaction fragment budget is too small');
    pieces.push(text.slice(0, end)); text = text.slice(end);
  }
  return pieces;
}

export function packGroups(groups, limit) {
  const batches = [];
  let current = '';
  for (let index = 0; index < groups.length; index++) {
    const fragments = splitText(groups[index], limit - 96);
    for (let part = 0; part < fragments.length; part++) {
      const label = fragments.length > 1 ? `[Transcript group ${index + 1}, fragment ${part + 1}/${fragments.length}; adjacent fragments belong to the same record]\n` : '';
      const value = label + fragments[part];
      if (current && textTokens(current + '\n' + value) > limit) { batches.push(current); current = ''; }
      current += (current ? '\n' : '') + value;
    }
  }
  if (current) batches.push(current);
  return batches;
}

export function isContextOverflow(error) {
  return error?.code === 'CONTEXT_WINDOW_EXCEEDED'
    || /(?:detected context overflow|context window exceeded|maximum context length|context_length_exceeded)/i.test(error?.message || '');
}
