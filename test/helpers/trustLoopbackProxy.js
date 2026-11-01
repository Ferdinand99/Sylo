// Import before anything that loads src/config.js: the web server then believes X-Forwarded-For
// from a peer on this machine, so a test can send requests "from" different clients and not run
// into a per-client rate limit meant for one. Assigned, so a value from a local .env does not leak in.
process.env.TRUST_PROXY = 'loopback';
