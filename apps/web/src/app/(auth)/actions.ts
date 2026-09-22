"use server";

import { redirect } from "next/navigation";

import { AuthCredentialsSchema, type AuthFormState } from "@/lib/auth/schema";
import { createClient } from "@/lib/supabase/server";

export async function login(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const validated = AuthCredentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(validated.data);
  if (error) {
    return { errors: { form: [error.message] } };
  }

  const redirectTo = formData.get("redirectTo");
  redirect(isSafeRedirect(redirectTo) ? redirectTo : "/documents");
}

/**
 * A `redirectTo` is only safe if it is a path on THIS site. A bare
 * `startsWith("/")` check is not enough: `//evil.example` and `/\evil.example`
 * both start with "/" yet the browser treats them as protocol-relative URLs
 * to another origin, turning a post-login redirect into an open redirect
 * (credible credential-phishing right after a real sign-in). Require a
 * single leading slash followed by a non-slash, non-backslash character —
 * so "/documents" and "/documents/abc" pass while "//evil", "/\evil", and
 * absolute "https://evil" do not.
 */
function isSafeRedirect(value: FormDataEntryValue | null): value is string {
  return typeof value === "string" && /^\/(?![/\\])/.test(value);
}

export async function signup(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const validated = AuthCredentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signUp({
    ...validated.data,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) {
    return { errors: { form: [error.message] } };
  }

  // Local dev (and most demo Supabase projects) has email confirmation
  // disabled, so signUp already returns a live session — go straight in.
  // A project with confirmation ON returns a user but no session; tell
  // the visitor to check their inbox instead of redirecting them into a
  // route the proxy will just bounce them out of.
  if (data.session) {
    redirect("/documents");
  }
  return { message: "Check your email to confirm your account before signing in." };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
