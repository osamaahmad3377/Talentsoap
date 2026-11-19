// On Cloudflare the request's cookies are already parsed by worker/express.js.
export default function cookieParser() {
  return (req, res, next) => next();
}
