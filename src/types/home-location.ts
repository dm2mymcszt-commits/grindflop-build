import z from "zod";

/** The place an account calls home on Grindr, which its visiting mode is measured against. */
export const homeLocationSchema = z.object({
	name: z.string(),
	lat: z.number(),
	lon: z.number(),
});

export type HomeLocation = z.infer<typeof homeLocationSchema>;
