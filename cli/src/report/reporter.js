// Reporter: how a run talks to whoever is driving it. TTY (the default) keeps the human output exactly as it was.
// JSON (global --json) writes NDJSON to stdout, one event per line, and sends the human text to stderr.
// Every event carries v: 1, so a GUI can tell the contract version.

export const PROTOCOL_VERSION = 1;

// codes a driver (the Mac app) can map to a message; anything not listed is INIT_FAILED
export const CODES = {
  MISSING_INPUT: 'a required value was not given (field names it)',
  NOT_LOGGED_IN: 'cloud mode needs a saved login',
  KEY_INVALID: 'the model key was refused',
  KEY_NO_CREDIT: 'the model key has no credit left',
  KEY_CHECK_FAILED: 'the model key could not be checked (network)',
  NODE_TOO_OLD: 'node is older than 18',
  UV_MISSING: 'uv is not on PATH',
  UV_SYNC_FAILED: 'uv sync failed',
  ENGINE_MISSING: 'the bundled server is not in the package',
  SERVER_START_FAILED: 'the memory server did not start',
  SMOKE_FAILED: 'the server or cloud did not answer',
  CLAUDE_CLI_MISSING: 'the claude command is needed for this step',
  NO_HARNESS: 'no supported app was found',
  WIRE_FAILED: 'a settings or MCP file could not be written',
  LOGIN_FAILED: 'the device login did not finish',
  USAGE: 'the command line was not valid',
  INIT_FAILED: 'the run did not finish; see the message',
};

export class JsonReporter {
  constructor(out = process.stdout, human = process.stderr) {
    this.out = out;
    this.human = human;
    this.sent = false; // a run ends with exactly one result event
  }
  emit(event) {
    this.out.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...event })}\n`);
  }
  step(id, status, label) { this.emit({ type: 'step', id, status, ...(label && { label }) }); }
  info(message) { this.emit({ type: 'info', message }); }
  warn(message) { this.emit({ type: 'warn', message }); }
  device(d) { this.emit({ type: 'device', ...d }); }
  error(code, message, hint, extra = {}) {
    this.emit({ type: 'error', code: CODES[code] ? code : 'INIT_FAILED', message, ...(hint && { hint }), ...extra });
  }
  result(ok, data = {}) { this.sent = true; this.emit({ type: 'result', ok, data }); }
  get json() { return true; }
}

// the default: nothing is emitted here; the wizard keeps writing its own human lines
export class TtyReporter {
  step() {}
  info() {}
  warn() {}
  device() {}
  error() {}
  result() {}
  get json() { return false; }
}

let active = new TtyReporter();
export const reporter = () => active;
export const setReporter = (r) => { active = r; return r; };
export const isJson = () => active.json;
