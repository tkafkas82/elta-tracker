// Vercel entry point. vercel.json rewrites every path here, so the single
// handler in server.js keeps owning routing (/, /manifest.json, /sw.js).
module.exports = require('../server.js');
