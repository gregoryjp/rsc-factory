import type { RoleConfig, RolesConfig } from "../../contracts/planning.js";

const REVIEWER_PREFIX = "reviewer-";

const labelOf = (config: RoleConfig): string => `${config.provider}/${config.model}`;

export const independenceWarnings = (roles: RolesConfig): string[] => {
	const builder = labelOf(roles.builder);
	return Object.entries(roles)
		.filter(([role, config]) => role.startsWith(REVIEWER_PREFIX) && labelOf(config) === builder)
		.map(
			([role]) =>
				`${role} uses ${builder}, the same provider and model as the builder; its review is not independent`,
		);
};

export const fallbackIndependenceWarning = (
	role: string,
	target: { provider: string; model: string },
	roles: RolesConfig,
): string | undefined => {
	const builder = labelOf(roles.builder);
	const used = `${target.provider}/${target.model}`;
	return role.startsWith(REVIEWER_PREFIX) && role !== "builder" && used === builder
		? `${role} fell back to ${used}, the same provider and model as the builder; its review is not independent`
		: undefined;
};
