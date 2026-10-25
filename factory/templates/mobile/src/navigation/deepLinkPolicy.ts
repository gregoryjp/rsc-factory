import type { DeepLinkPolicy } from "./validateDeepLink";

export const DEEP_LINK_POLICY: DeepLinkPolicy = {
	schemes: ["{{PRODUCT_SLUG}}"],
	hosts: ["open"],
	paths: ["/"],
};
