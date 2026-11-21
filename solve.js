// Fast drop-in for make.fun's csv-reader 1.0.0 (csv-reader-speed-01-run-20261121).
// Same answer as the reference on every input, faster: indexOf jumps + slice
// instead of one character at a time. Semantics mirror vendor/csv-reader/index.js
// exactly (see kit baselines/csv-reader/vendor/csv-reader/index.js):
//   - U+FEFF at the very start is dropped; empty lines are no records.
//   - Outside quotes a CR not followed by LF is dropped (stray_cr).
//   - Quoted field: "" is one quote; CRLF / lone CR inside read as LF;
//     junk after the closing quote is appended as-is (quote_junk when it ends);
//     a quote that never closes is literal and the rest re-reads unquoted
//     (unterminated_quote). A quote inside an unquoted field is literal.
//   - columns = first record when header, else null; rows padded (short_row)
//     or cut (long_row) to the first record's width.
//   - errors {code, line, row} in the order met; line = 1-based line the record
//     starts on (every LF, CRLF and lone CR inside quotes counted), row = the
//     record's index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Appends seg to value, reading each CRLF / lone CR inside quotes as one LF
  // (and counting it as one line). Fast path when the segment holds no CR/LF.
  function convertSeg(value, seg) {
    if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) return value + seg;
    let out = value;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (c === '\r') {
        out += '\n';
        line++;
        if (seg[i + 1] === '\n') i++;
      } else if (c === '\n') {
        out += '\n';
        line++;
      } else {
        out += c;
      }
    }
    return out;
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field and how it
  // ended; `added` counts the characters kept.
  function readUnquoted(value) {
    const startLen = value.length;
    while (pos < n) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      const ri = text.indexOf('\r', pos);
      let m = -1;
      let kind = 0; // 1 comma, 2 LF, 3 CR
      if (ci !== -1 && (m === -1 || ci < m)) { m = ci; kind = 1; }
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; kind = 2; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; kind = 3; }
      if (m === -1) {
        value += text.slice(pos);
        pos = n;
        break;
      }
      if (kind === 1) {
        value += text.slice(pos, m);
        pos = m + 1;
        return { value, ended: COMMA, added: value.length - startLen };
      }
      if (kind === 2) {
        value += text.slice(pos, m);
        pos = m + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added: value.length - startLen };
      }
      // CR: CRLF is a line break, a lone CR is dropped (stray_cr).
      if (text[m + 1] === '\n') {
        value += text.slice(pos, m);
        pos = m + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added: value.length - startLen };
      }
      value += text.slice(pos, m);
      error('stray_cr');
      pos = m + 1;
    }
    return { value, ended: END, added: value.length - startLen };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let segStart = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text[q + 1] === '"') {
        value = convertSeg(value, text.slice(segStart, q));
        value += '"';
        pos = q + 2;
        segStart = q + 2;
        continue;
      }
      value = convertSeg(value, text.slice(segStart, q));
      pos = q + 1;
      break;
    }
    if (pos >= n) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text[pos] === '"';
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
