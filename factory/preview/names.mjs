const MAX_SLUG = 40;

const slugOf = (route) => {
	const slug = route
		.replace(/^\/+/, "")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "root" : slug.slice(0, MAX_SLUG);
};

export const shotName = ({ index, route, role, viewport }) =>
	`shots/${index}-${slugOf(route)}-${role ?? "public"}-${viewport.width}x${viewport.height}.png`;
