import { z } from "zod";

export const TemplateManifestSchema = z.strictObject({
	id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	presetIds: z.array(z.string().min(1)).min(1),
	render: z.array(z.string().min(1)),
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
