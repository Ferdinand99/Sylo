// Import before anything that loads src/config.js: gives the dashboard a public address, so code
// that builds links to it (the event page link in an event post) has one. Assigned, not defaulted,
// so a value from a local .env file does not leak into the test.
process.env.DASHBOARD_URL = 'https://sylo.example.test';
