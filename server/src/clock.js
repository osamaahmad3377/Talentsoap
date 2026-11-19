// "Today" as a YYYY-MM-DD date in the factory's time zone.
// On a computer this is the computer's own time zone; on Cloudflare (which runs
// in UTC) set APP_TZ, e.g. "Asia/Karachi", so the day changes at local midnight.
const tz = () => (typeof process !== 'undefined' && process.env && process.env.APP_TZ) || undefined;

export const today = () => {
  const zone = tz();
  return new Date().toLocaleDateString('en-CA', zone ? { timeZone: zone } : undefined);
};
