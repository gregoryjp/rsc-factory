import { z } from "zod";

export const TemplateManifestSchema = z.strictObject({
	id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	presetIds: z.array(z.string().min(1)).min(1),
	render: z.array(z.string().min(1)),
	provides: z.array(z.string().min(1).max(200)).max(30).optional(),
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
