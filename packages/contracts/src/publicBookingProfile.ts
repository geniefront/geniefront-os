import { z } from "zod";
const image = z
  .string()
  .url()
  .max(2048)
  .refine((v) => v.startsWith("https://"), "Use an HTTPS image URL");
export const publicBookingProfileSchema = z.object({
  maxPartySize: z.number().int().min(1).max(10).default(10),
  shopNotifications: z
    .object({
      email: z.boolean().default(false),
      sms: z.boolean().default(false),
    })
    .default({}),
  description: z.string().max(3000).default(""),
  arrivalInstructions: z.string().max(2000).default(""),
  logoUrl: image.or(z.literal("")).default(""),
  coverUrl: image.or(z.literal("")).default(""),
  photoUrls: z.array(image).max(8).default([]),
  services: z
    .record(
      z.string().uuid(),
      z.object({
        visible: z.boolean().optional(),
        guestCount: z.number().int().min(1).max(10).optional(),
        resourceTypeId: z.string().uuid().nullable().default(null),
        imageUrl: image.or(z.literal("")).default(""),
        description: z.string().max(5000).default(""),
        sort: z.number().int().min(0).max(10000).default(0),
      }),
    )
    .default({}),
});
export type PublicBookingProfile = z.infer<typeof publicBookingProfileSchema>;
export function readPublicBookingProfile(
  settings: Record<string, unknown>,
): PublicBookingProfile {
  const value = publicBookingProfileSchema.safeParse(
    settings["public_booking_profile"] ?? {},
  );
  return value.success ? value.data : publicBookingProfileSchema.parse({});
}
