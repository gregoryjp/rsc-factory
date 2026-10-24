import { z } from "zod";
import { SpecOutputSchema } from "../../contracts/planning.js";

export const SpecFileSchema = z.strictObject({
	specVersion: z.number().int().positive(),
	inputHash: z.string(),
	spec: SpecOutputSchema,
});
export type SpecFile = z.infer<typeof SpecFileSchema>;

export const serializeSpecFile = (file: SpecFile): string => `${JSON.stringify(file, null, 2)}\n`;

export const parseSpecFile = (content: string): SpecFile | undefined => {
	try {
		const parsed = SpecFileSchema.safeParse(JSON.parse(content));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
};
