// Preload for the capture script. The feed reads Date.now() once per request,
// so pinning it makes the real CLI output reproducible.
const fixed = Number(process.env.OWNER_FEED_FIXED_NOW);

if (!Number.isSafeInteger(fixed))
	throw new Error("OWNER_FEED_FIXED_NOW must be an integer");

Date.now = () => fixed;
