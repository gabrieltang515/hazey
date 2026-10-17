-- HazeMaskGoWhere refuses requests from Cloudflare's network, so the Worker no longer saves mask points; the collection
-- points ship in public/mask-sites.js instead.
DROP TABLE IF EXISTS mask_sources;
