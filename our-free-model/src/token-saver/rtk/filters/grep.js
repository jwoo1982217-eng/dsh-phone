/**
 * Compact `grep -rn` output ("file:lineno:content").
 *
 * The raw form repeats the full path on every match, so a symbol found 40 times
 * in one file costs 40 path repetitions. This filter groups by file, keeps the
 * first 10 matches per file with their line numbers, and says how many were
 * dropped. A model that sees "+30" knows the symbol is dense in that file and
 * can read the file; one shown all 40 lines learns nothing extra and pays for
 * the paths.
 *
 * Ported from the Rust `grep_wrapper` (splitn(3, ':') semantics).
 *
 * @module src/token-saver/rtk/filters/grep.js
 */

import { GREP_PER_FILE_MAX } from '../constants.js'

export function grep(input) {
  const byFile = new Map()
  let total = 0

  for (const line of input.split('\n')) {
    // splitn(3, ':') — only split on the first 2 colons, so a match whose
    // content contains ':' (JSON, a ternary, a URL) keeps its content intact.
    const first = line.indexOf(':')
    if (first === -1) continue
    const second = line.indexOf(':', first + 1)
    if (second === -1) continue
    const file = line.slice(0, first)
    const lineNumStr = line.slice(first + 1, second)
    const content = line.slice(second + 1)
    // Rust: parts[1].parse::<usize>().is_ok() — a non-numeric middle field
    // means this is not a grep line at all (e.g. "src/a.js: export ...").
    if (!/^\d+$/.test(lineNumStr)) continue
    total++
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push([lineNumStr, content])
  }

  // Nothing parsed: this is not grep output (or the tool used another format),
  // and a rewrite would lose matches rather than save tokens.
  if (total === 0) return input

  // Rust: files.sort_by_key(|(f, _)| *f) — stable ordering matters so the same
  // search produces the same prompt bytes twice.
  const files = Array.from(byFile.keys()).sort()
  let out = `${total} matches in ${files.length}F:\n\n`

  for (const file of files) {
    const matches = byFile.get(file)
    out += `[file] ${file} (${matches.length}):\n`
    const show = matches.slice(0, GREP_PER_FILE_MAX)
    for (const [lineNum, content] of show) {
      // Rust: format!("  {:>4}: {}", line_num, content.trim())
      out += `  ${lineNum.padStart(4)}: ${content.trim()}\n`
    }
    if (matches.length > GREP_PER_FILE_MAX) {
      out += `  +${matches.length - GREP_PER_FILE_MAX}\n`
    }
    out += '\n'
  }

  return out
}

grep.filterName = 'grep'
