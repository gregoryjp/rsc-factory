import type { ProviderName, ProviderPort } from "./provider-port.js";

const DEFAULT_PROVIDER: ProviderName = "claude";

export const createRoutingProvider = (
	providers: Record<ProviderName, ProviderPort>,
): ProviderPort => ({
	invoke: (request, outputSchema) =>
		providers[request.provider ?? DEFAULT_PROVIDER].invoke(request, outputSchema),
});
