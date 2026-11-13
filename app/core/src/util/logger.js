const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(scope = 'qbazz', level = 'info') {
  const threshold = LEVELS[level] ?? 2;
  const emit = (lvl, msg, meta) => {
    if ((LEVELS[lvl] ?? 2) > threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const out = lvl === 'error' ? console.error : console.log;
    if (meta === undefined) out(line);
    else out(line, meta);
  };
  return {
    error: (m, meta) => emit('error', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    info: (m, meta) => emit('info', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`, level),
  };
}
