// journald adds timestamps; keep lines short and greppable.
const fmt = (level: string, msg: string) => `${level} ${msg}`;

export const log = {
  info: (msg: string) => console.log(fmt("info", msg)),
  warn: (msg: string) => console.warn(fmt("warn", msg)),
  error: (msg: string) => console.error(fmt("error", msg)),
  debug: (msg: string) => {
    if (process.env.SHIPWRIGHT_DEBUG) console.log(fmt("debug", msg));
  },
};
