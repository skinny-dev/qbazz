/** Asks for a line of text on the terminal without echoing it (falls back to a plain line when there is no real terminal). */
export function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    if (!stdin.isTTY) {
      let buf = '';
      const on = (d) => { buf += d; if (buf.includes('\n')) { stdin.off('data', on); stdin.pause(); resolve(buf.split('\n')[0].trim()); } };
      stdin.on('data', on);
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    const on = (c) => {
      for (const ch of c) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); resolve(value); return; }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    };
    stdin.on('data', on);
  });
}
