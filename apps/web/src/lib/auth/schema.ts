import { z } from "zod";

// Local to apps/web, not @kb/shared: Supabase Auth handles sign-in/up
// directly (no apps/api endpoint is ever involved — see
// lib/supabase/{browser,server}.ts), so there's no cross-package contract
// to share here. Zod is still "the shared validation library" the brief's
// UX bullet means — used consistently across every form in this app,
// mirroring how @kb/shared's schemas validate everything that does cross
// the apps/web <-> apps/api boundary. See docs/DECISIONS.md.
export const AuthCredentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .pipe(z.email("Enter a valid email address.")),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export type AuthCredentials = z.infer<typeof AuthCredentialsSchema>;

export type AuthFormState = {
  errors?: {
    email?: string[];
    password?: string[];
    form?: string[];
  };
  message?: string;
} | undefined;
