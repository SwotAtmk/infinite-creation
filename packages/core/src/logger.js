let _debug = false;

export function setDebug(v) { _debug = !!v; }

function ts() { return new Date().toISOString(); }

export const logger = {
  debug(msg, extra) {
    if (_debug) console.log('[DEBUG][' + ts() + '] ' + msg + (extra ? ' ' + JSON.stringify(extra) : ''));
  },
  info(msg, extra) {
    console.log('[INFO][' + ts() + '] ' + msg + (extra ? ' ' + JSON.stringify(extra) : ''));
  },
  warn(msg, extra) {
    console.warn('[WARN][' + ts() + '] ' + msg + (extra ? ' ' + JSON.stringify(extra) : ''));
  },
  error(msg, extra) {
    console.error('[ERROR][' + ts() + '] ' + msg + (extra ? ' ' + JSON.stringify(extra) : ''));
  },
};
